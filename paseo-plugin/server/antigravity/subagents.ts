import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeCommandKey,
  type SubagentArtifactInfo,
  type SubagentDetail,
  type SubagentList,
  type SubagentOrigin,
  type SubagentState,
  type SubagentSummary,
  type ToolSummaries,
  type TranscriptEntry,
} from "../../shared/antigravity/contracts";
import type { ContextReader } from "./context";
import { REAL_CLI_DIR } from "./paths";
import type { PaseoApi } from "./types";

/**
 * agy runs subagents and `/swarm` workers as conversations of their own. Every conversation keeps
 * a JSON-lines log at `brain/<id>/.system_generated/logs/transcript.jsonl` (agy hands the same path
 * to the parent model). A parent's log holds `invoke_subagent` and `swarm` calls, while agy also
 * writes registry files under `.system_generated/subagents/*.json` and swarm metadata/board logs
 * under `.system_generated/swarm/{members.json,board.jsonl}`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CREATED_ID = /Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([0-9a-f-]{36})"/i;
const SWARM_WORKER_ROLE = /^Swarm Worker \((.+)\)$/i;
const SWARM_NUDGE_BODY = /^\[swarm\]\s+new board message\b/i;
const TIME_HEADER = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;
/** A child with no new step for this long is no longer running, whatever its last step says. */
const STALE_MS = 12 * 60_000;
const MAX_DEPTH = 3;
const MAX_ENTRIES = 300;
const MAX_LOG_CACHE = 120;
const MAX_ARTIFACT_BYTES = 256 * 1024;
/** Step states agy may still rewrite in place. */
const UNFINISHED = new Set(["RUNNING", "PENDING", "GENERATING", "WAITING", "QUEUED"]);
/** How far back an unfinished step is looked for when resuming a read. */
const RESUME_WINDOW = 64;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface Row {
  step_index: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface Child {
  id: string;
  role: string | null;
  type: string | null;
  origin: SubagentOrigin;
  task: string;
  /** Set when terminated via `manage_subagents`, `swarm kill`, `members.json`, or `subagents/*.json`. */
  killedAt: string | null;
  /** True when directly registered under the parent's own `swarm/members.json` or `subagents/*.json`. */
  trustedParent: boolean;
  /** Fallback model from `swarm/members.json` or `swarm add` output when the child log has none yet. */
  fallbackModel: string | null;
  /** Live `wake_mode` from `swarm/members.json` (e.g. `"working"`, `"waiting"`, `"mentions"`, `"all"`). */
  swarmWakeMode: string | null;
  /** Live killed state from `swarm/members.json`. */
  swarmKilled: boolean;
  /** True when `swarm/members.json` explicitly reports this conversationId as not killed. */
  authoritativeAlive: boolean;
}

interface SwarmMemberInfo {
  id: string;
  name: string;
  type: string;
  killed: boolean;
  model: string | null;
  wakeMode: string | null;
}

interface SubagentRegistryEntry {
  id: string;
  role: string | null;
  type: string | null;
  origin: SubagentOrigin;
  killed: boolean;
}

interface BoardPost {
  seq: number;
  agent: string;
  text: string;
  at: string | null;
}

interface CachedLog {
  size: number;
  mtimeMs: number;
  rows: Row[];
  /** Byte offset where each row's line starts. */
  starts: number[];
}

function brainDir(cliDir: string, conversationId: string): string {
  return path.join(cliDir, "brain", conversationId);
}

function logPath(cliDir: string, conversationId: string): string {
  return path.join(brainDir(cliDir, conversationId), ".system_generated", "logs", "transcript.jsonl");
}

function inboxDir(cliDir: string, conversationId: string): string {
  return path.join(brainDir(cliDir, conversationId), ".system_generated", "messages");
}

function swarmDir(cliDir: string, conversationId: string): string {
  return path.join(brainDir(cliDir, conversationId), ".system_generated", "swarm");
}

function subagentsDir(cliDir: string, conversationId: string): string {
  return path.join(brainDir(cliDir, conversationId), ".system_generated", "subagents");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Tool arguments are JSON-encoded strings in the log (`"Role": "\"Auditor\""`). Long values are
 * cut short by agy, which leaves an unterminated JSON string; those are decoded leniently.
 */
function argValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || !/^["[{]|^(true|false|null|-?\d)/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    if (!text.startsWith('"')) return value;
    const body = text.slice(1).replace(/\\$/, "");
    try {
      return JSON.parse(`"${body}"`);
    } catch {
      return body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
}

function argText(call: ToolCall, key: string): string | null {
  const value = argValue(call.args?.[key]);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function oneLine(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const SUMMARY_KEYS = [
  "toolSummary",
  "CommandLine",
  "Path",
  "AbsolutePath",
  "TargetFile",
  "File",
  "DirectoryPath",
  "SearchPath",
  "Query",
  "Pattern",
  "Url",
  "Role",
  "Action",
  "action",
  "name",
];

export function describeCall(call: ToolCall): string {
  const pathLike = new Set(["Path", "AbsolutePath", "TargetFile", "File", "DirectoryPath", "SearchPath"]);
  for (const key of SUMMARY_KEYS) {
    const value = argText(call, key);
    if (!value) continue;
    if (pathLike.has(key)) {
      const start = argText(call, "StartLine");
      const end = argText(call, "EndLine");
      const range = start && end ? ` ${start}–${end}` : "";
      return oneLine(`${path.basename(value)}${range}`);
    }
    return oneLine(value);
  }
  for (const value of Object.values(call.args ?? {})) {
    const parsed = argValue(value);
    if (typeof parsed === "string" && parsed.trim()) return oneLine(parsed);
  }
  return "";
}

function stripTimes(text: string): string {
  return text.replace(TIME_HEADER, "").trim();
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** The text of a message, without agy's `<SYSTEM_MESSAGE>` or `<USER_REQUEST>` wrapper. */
function messageBody(content: string): string {
  if (content.includes("<SYSTEM_MESSAGE>")) {
    const inner = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(content)?.[1];
    if (inner !== undefined) return inner.trim();
  }
  const request = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(content)?.[1];
  return (request ?? content).trim();
}

/**
 * Whether any of a conversation's initial messages came from `parentId` (agy names the sender).
 * Checks up to the first 5 `SYSTEM_MESSAGE`/`USER_INPUT` rows because swarm workers receive a
 * step-0 `sender=system` `[swarm]` notification before the step-1 `sender=<parentId>` brief.
 */
function sentBy(rows: readonly Row[], parentId: string): boolean | null {
  const initial = rows
    .filter((row) => row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT")
    .slice(0, 5);
  if (initial.length === 0) return null;
  let sawContent = false;
  for (const row of initial) {
    if (!row.content) continue;
    sawContent = true;
    if (row.content.includes(`sender=${parentId}`)) return true;
  }
  return sawContent ? false : null;
}

/** Roles and types `manage_subagents` listed, by conversation id. */
function listedRoles(content: string): Map<string, { role: string | null; type: string | null }> {
  const result = new Map<string, { role: string | null; type: string | null }>();
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start < 0 || end <= start) return result;
  try {
    const entries: unknown = JSON.parse(content.slice(start, end + 1));
    for (const entry of Array.isArray(entries) ? entries : []) {
      const record = entry as { conversationId?: unknown; role?: unknown; type?: unknown };
      if (typeof record.conversationId !== "string") continue;
      result.set(record.conversationId, {
        role: typeof record.role === "string" ? record.role : null,
        type: typeof record.type === "string" ? record.type : null,
      });
    }
  } catch {
    // Not a list.
  }
  return result;
}

function parseJsonFromText(raw: string): unknown {
  const text = stripTimes(raw);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting the outermost JSON object or array.
  }
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
  const start = useArray ? arrStart : objStart;
  const end = useArray ? text.lastIndexOf("]") : text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface SwarmAddEntry {
  id: string;
  name: string | null;
  model: string | null;
}

function extractSwarmAddEntry(entry: unknown): SwarmAddEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as {
    conversation_id?: unknown;
    conversationId?: unknown;
    id?: unknown;
    name?: unknown;
    role?: unknown;
    model?: unknown;
    applied_model?: unknown;
  };
  const id =
    nonEmptyString(record.conversation_id) ??
    nonEmptyString(record.conversationId) ??
    nonEmptyString(record.id);
  if (!id || !UUID.test(id)) return null;
  const rawName = nonEmptyString(record.name) ?? nonEmptyString(record.role);
  const name = rawName && rawName !== "worker" && rawName !== "coordinator" ? rawName : null;
  const model = nonEmptyString(record.applied_model) ?? nonEmptyString(record.model);
  return { id, name, model };
}

/** Extracts spawned worker(s) from a `swarm` `action === "add"` tool result. */
function parseSwarmAddResults(content: string, call: ToolCall): SwarmAddEntry[] {
  const defaultName = argText(call, "name");
  const defaultModel = argText(call, "model");
  const results: SwarmAddEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: SwarmAddEntry | null) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    results.push(entry);
  };

  const parsed = parseJsonFromText(content);
  if (Array.isArray(parsed)) {
    for (const item of parsed) push(extractSwarmAddEntry(item));
  } else if (parsed && typeof parsed === "object") {
    const record = parsed as {
      workers?: unknown;
      members?: unknown;
      added?: unknown;
      results?: unknown;
    };
    const direct = extractSwarmAddEntry(record);
    if (direct) push(direct);
    for (const list of [record.workers, record.members, record.added, record.results]) {
      if (Array.isArray(list)) {
        for (const item of list) push(extractSwarmAddEntry(item));
      } else if (list && typeof list === "object") {
        for (const [memberName, memberValue] of Object.entries(list as Record<string, unknown>)) {
          if (memberName === "coordinator") continue;
          const extracted = extractSwarmAddEntry(memberValue);
          if (extracted) push({ ...extracted, name: extracted.name ?? memberName });
        }
      }
    }
  }

  if (results.length === 0) {
    const matches = stripTimes(content).match(UUID_GLOBAL) ?? [];
    for (const id of matches) {
      if (UUID.test(id)) push({ id, name: null, model: null });
    }
  }

  return results.map((entry, index) => ({
    id: entry.id,
    name:
      entry.name ??
      (results.length > 1 && defaultName ? `${defaultName}-${index + 1}` : defaultName),
    model: entry.model ?? defaultModel,
  }));
}

function matchesSwarmKillTarget(role: string | null, targetName: string): boolean {
  if (!role) return false;
  if (role === targetName) return true;
  return new RegExp(`^${escapeRegExp(targetName)}-\\d+$`).test(role);
}

function mentionsAgent(text: string, name: string): boolean {
  return new RegExp(`@${escapeRegExp(name)}(?=$|[^a-zA-Z0-9_-])`, "i").test(text);
}

function stripLeadingMention(text: string, name: string): string {
  const stripped = text
    .replace(new RegExp(`^@${escapeRegExp(name)}(?=$|[^a-zA-Z0-9_-])\\s*`, "i"), "")
    .trim();
  return stripped || text.trim();
}

function parseTime(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

function normalizeTimestamp(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("T")) return trimmed;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : trimmed;
}

/** Reads `.system_generated/swarm/members.json` for a conversation. */
async function readSwarmMembers(
  cliDir: string,
  conversationId: string,
): Promise<{ title: string | null; members: SwarmMemberInfo[] }> {
  const file = path.join(swarmDir(cliDir, conversationId), "members.json");
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return { title: null, members: [] };
  try {
    const parsed = JSON.parse(raw) as {
      title?: unknown;
      members?: Record<
        string,
        {
          conversation_id?: unknown;
          conversationId?: unknown;
          role?: unknown;
          desired_state?: unknown;
          phase?: unknown;
          wake_mode?: unknown;
          killed?: unknown;
          model?: unknown;
          applied_model?: unknown;
        }
      >;
    };
    const title = nonEmptyString(parsed?.title);
    const members: SwarmMemberInfo[] = [];
    if (parsed?.members && typeof parsed.members === "object") {
      for (const [memberName, entry] of Object.entries(parsed.members)) {
        if (!entry || typeof entry !== "object") continue;
        const roleField = nonEmptyString(entry.role);
        if (roleField === "coordinator" || memberName === "coordinator") continue;
        const id = nonEmptyString(entry.conversation_id) ?? nonEmptyString(entry.conversationId);
        if (!id || !UUID.test(id) || id === conversationId) continue;
        const phase = nonEmptyString(entry.phase)?.toUpperCase() ?? "";
        const desiredState = nonEmptyString(entry.desired_state)?.toUpperCase() ?? "";
        const killed = entry.killed === true || phase === "KILLED" || desiredState === "KILLED";
        const model = nonEmptyString(entry.applied_model) ?? nonEmptyString(entry.model);
        const wakeMode = nonEmptyString(entry.wake_mode)?.toLowerCase() ?? null;
        members.push({
          id,
          name: memberName,
          type: roleField ?? "worker",
          killed,
          model,
          wakeMode,
        });
      }
    }
    return { title, members };
  } catch {
    return { title: null, members: [] };
  }
}

/** Reads `.system_generated/subagents/*.json` for a conversation. */
async function readSubagentRegistry(cliDir: string, conversationId: string): Promise<SubagentRegistryEntry[]> {
  const dir = subagentsDir(cliDir, conversationId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const entries: SubagentRegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as {
        conversationId?: unknown;
        conversation_id?: unknown;
        subagentDescriptor?: { typeName?: unknown; role?: unknown } | null;
        state?: unknown;
      };
      const id = nonEmptyString(parsed?.conversationId) ?? nonEmptyString(parsed?.conversation_id);
      if (!id || !UUID.test(id) || id === conversationId) continue;
      const typeName = nonEmptyString(parsed?.subagentDescriptor?.typeName);
      const rawRole = nonEmptyString(parsed?.subagentDescriptor?.role);
      const swarmRoleMatch = rawRole ? SWARM_WORKER_ROLE.exec(rawRole) : null;
      const isSwarm = typeName === "worker" || Boolean(swarmRoleMatch);
      const role = swarmRoleMatch ? nonEmptyString(swarmRoleMatch[1]) ?? rawRole : rawRole;
      const killed = parsed?.state === "SUBAGENT_STATE_KILLED";
      entries.push({
        id,
        role,
        type: typeName ?? (isSwarm ? "worker" : null),
        origin: isSwarm ? "swarm" : "subagent",
        killed,
      });
    } catch {
      // Ignore malformed registry files.
    }
  }
  return entries;
}

/** Reads `.system_generated/swarm/board.jsonl` for a conversation. */
async function readSwarmBoard(cliDir: string, conversationId: string): Promise<BoardPost[]> {
  const file = path.join(swarmDir(cliDir, conversationId), "board.jsonl");
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return [];
  const posts: BoardPost[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        seq?: unknown;
        agent?: unknown;
        text?: unknown;
        timestamp?: unknown;
        time?: unknown;
      };
      if (typeof parsed.agent !== "string" || typeof parsed.text !== "string") continue;
      const seq = typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : posts.length + 1;
      const at = normalizeTimestamp(nonEmptyString(parsed.timestamp) ?? nonEmptyString(parsed.time));
      posts.push({ seq, agent: parsed.agent, text: parsed.text, at });
    } catch {
      // Ignore incomplete/malformed lines.
    }
  }
  posts.sort((a, b) => a.seq - b.seq);
  return posts;
}

function findBoardBrief(posts: readonly BoardPost[], workerName: string | null): string | null {
  if (!workerName || posts.length === 0) return null;
  for (const post of posts) {
    if (mentionsAgent(post.text, workerName)) {
      return stripLeadingMention(post.text, workerName);
    }
  }
  return null;
}

function findBoardReport(
  posts: readonly BoardPost[],
  workerName: string | null,
): { at: string | null; content: string } | null {
  if (!workerName || posts.length === 0) return null;
  const byAgent = posts.filter((post) => post.agent === workerName);
  if (byAgent.length === 0) return null;
  const preferred = byAgent.filter(
    (post) => mentionsAgent(post.text, "coordinator") || /\[done\]/i.test(post.text),
  );
  const chosen = preferred.length > 0 ? preferred[preferred.length - 1]! : byAgent[byAgent.length - 1]!;
  return { at: chosen.at, content: chosen.text };
}

function summarySortTime(summary: SubagentSummary): number {
  const ts = parseTime(summary.updatedAt ?? summary.startedAt);
  return Number.isFinite(ts) ? ts : -Infinity;
}

/** Lists user-facing artifact files saved directly under a subagent's brain directory. */
async function listArtifacts(cliDir: string, conversationId: string): Promise<SubagentArtifactInfo[]> {
  const root = brainDir(cliDir, conversationId);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return [];
  const found: SubagentArtifactInfo[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".metadata.json") || entry.name.endsWith(".resolved")) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      found.push({
        path: rel,
        name: entry.name,
        size: stat.size,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        isMarkdown: /\.(md|markdown)$/i.test(entry.name),
      });
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 40);
}

export class SubagentReader {
  private readonly logs = new Map<string, CachedLog>();
  private readonly listCache = new Map<string, { at: number; value: SubagentList }>();

  constructor(
    private readonly agents: ContextReader,
    private readonly cliDir: string = REAL_CLI_DIR,
  ) {}

  private rememberLog(file: string, entry: CachedLog): void {
    this.logs.delete(file);
    this.logs.set(file, entry);
    if (this.logs.size > MAX_LOG_CACHE) {
      const oldest = this.logs.keys().next().value;
      if (oldest) this.logs.delete(oldest);
    }
  }

  /**
   * Reads a conversation log incrementally. agy appends a line per step and rewrites a step's line
   * while it runs, so reading resumes at the earliest step that may still change.
   */
  private async rows(conversationId: string): Promise<{ rows: Row[]; mtimeMs: number } | null> {
    const file = logPath(this.cliDir, conversationId);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    const cached = this.logs.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      this.rememberLog(file, cached);
      return { rows: cached.rows, mtimeMs: stat.mtimeMs };
    }
    let keep = 0;
    if (cached?.rows.length) {
      keep = cached.rows.length - 1;
      for (let index = Math.max(0, cached.rows.length - RESUME_WINDOW); index < cached.rows.length; index += 1) {
        if (UNFINISHED.has(cached.rows[index]!.status ?? "")) {
          keep = index;
          break;
        }
      }
    }
    const offset = cached?.rows.length ? cached.starts[keep]! : 0;
    const parsed = await readRows(file, offset, stat.size);
    // The first line read must be the step it resumes at; anything else means the file was rewritten.
    const aligned =
      !cached?.rows.length || (parsed !== null && parsed.rows[0]?.step_index === cached.rows[keep]!.step_index);
    const next: CachedLog = aligned && parsed
      ? {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          rows: [...(cached?.rows.slice(0, keep) ?? []), ...parsed.rows],
          starts: [...(cached?.starts.slice(0, keep) ?? []), ...parsed.starts],
        }
      : { size: stat.size, mtimeMs: stat.mtimeMs, ...((await readRows(file, 0, stat.size)) ?? { rows: [], starts: [] }) };
    dedupe(next);
    this.rememberLog(file, next);
    return { rows: next.rows, mtimeMs: stat.mtimeMs };
  }

  /**
   * Multi-source child discovery for a conversation:
   * 1. `transcript.jsonl` (`invoke_subagent`, `manage_subagents`, `swarm` `add` & `kill`),
   * 2. `.system_generated/swarm/members.json`,
   * 3. `.system_generated/subagents/*.json`.
   * Deduplicated by conversation id while preserving the richest metadata across sources.
   */
  private async discoverChildren(conversationId: string): Promise<{ children: Child[]; swarmTitle: string | null }> {
    const [log, swarmMembers, registry] = await Promise.all([
      this.rows(conversationId),
      readSwarmMembers(this.cliDir, conversationId),
      readSubagentRegistry(this.cliDir, conversationId),
    ]);

    const byId = new Map<string, Child>();
    const killedIds = new Map<string, string>();
    const killedSwarmNames = new Map<string, string>();
    const listed = new Map<string, { role: string | null; type: string | null }>();

    const upsert = (incoming: {
      id: string;
      role?: string | null;
      type?: string | null;
      origin: SubagentOrigin;
      task?: string;
      killedAt?: string | null;
      trustedParent?: boolean;
      fallbackModel?: string | null;
      swarmWakeMode?: string | null;
      swarmKilled?: boolean;
      authoritativeAlive?: boolean;
      preferRole?: boolean;
    }) => {
      const existing = byId.get(incoming.id);
      if (!existing) {
        byId.set(incoming.id, {
          id: incoming.id,
          role: incoming.role ?? null,
          type: incoming.type ?? null,
          origin: incoming.origin,
          task: incoming.task ?? "",
          killedAt: incoming.killedAt ?? null,
          trustedParent: Boolean(incoming.trustedParent),
          fallbackModel: incoming.fallbackModel ?? null,
          swarmWakeMode: incoming.swarmWakeMode ?? null,
          swarmKilled: Boolean(incoming.swarmKilled),
          authoritativeAlive: Boolean(incoming.authoritativeAlive),
        });
        return;
      }
      if (incoming.origin === "swarm") existing.origin = "swarm";
      if (incoming.role && (incoming.preferRole || !existing.role)) existing.role = incoming.role;
      if (incoming.type && !existing.type) existing.type = incoming.type;
      if (incoming.task && !existing.task) existing.task = incoming.task;
      if (incoming.killedAt !== undefined && incoming.killedAt !== null) {
        if (existing.killedAt === null || (!existing.killedAt && incoming.killedAt)) {
          existing.killedAt = incoming.killedAt;
        }
      }
      if (incoming.trustedParent) existing.trustedParent = true;
      if (incoming.fallbackModel) existing.fallbackModel = incoming.fallbackModel;
      if (incoming.swarmWakeMode !== undefined && incoming.swarmWakeMode !== null) {
        existing.swarmWakeMode = incoming.swarmWakeMode;
      }
      if (incoming.swarmKilled) {
        existing.swarmKilled = true;
        existing.authoritativeAlive = false;
      } else if (incoming.authoritativeAlive) {
        existing.authoritativeAlive = true;
      }
    };

    if (log) {
      let queue: ToolCall[] = [];
      for (const row of log.rows) {
        if (row.type === "PLANNER_RESPONSE") {
          // A result that never arrived must not shift the next response's pairing.
          queue = [...(row.tool_calls ?? [])];
          const at = row.created_at ?? "";
          for (const call of queue) {
            if (call.name === "manage_subagents") {
              const action = argText(call, "Action");
              if (action === "kill") {
                const ids = argValue(call.args?.ConversationIds);
                for (const id of Array.isArray(ids) ? ids : []) {
                  if (typeof id === "string") killedIds.set(id, at);
                }
              } else if (action === "kill_all") {
                // Every subagent spawned before this `kill_all` call was terminated.
                for (const child of byId.values()) {
                  if (!killedIds.has(child.id)) killedIds.set(child.id, at);
                }
              }
            } else if (call.name === "swarm") {
              const action = argText(call, "action");
              if (action === "kill") {
                const targetName = argText(call, "name");
                if (targetName) {
                  killedSwarmNames.set(targetName, at);
                  // Apply immediately only to swarm workers already spawned before this `kill` step,
                  // so a newer worker re-added later under the same role name is not marked killed.
                  for (const child of byId.values()) {
                    if (child.origin === "swarm" && matchesSwarmKillTarget(child.role, targetName) && !killedIds.has(child.id)) {
                      killedIds.set(child.id, at);
                    }
                  }
                }
              }
            }
          }
          continue;
        }
        if (row.type !== "GENERIC") continue;
        const call = queue.shift();
        if (!call || !row.content) continue;
        if (call.name === "manage_subagents") {
          for (const [id, entry] of listedRoles(row.content)) listed.set(id, entry);
          continue;
        }
        if (call.name === "invoke_subagent") {
          const id = CREATED_ID.exec(row.content)?.[1];
          if (!id || !UUID.test(id) || id === conversationId) continue;
          upsert({
            id,
            role: argText(call, "Role"),
            type: argText(call, "TypeName"),
            origin: "subagent",
            task: argText(call, "Prompt") ?? "",
          });
          continue;
        }
        if (call.name === "swarm") {
          const action = argText(call, "action");
          if (action !== "add") continue;
          const brief = argText(call, "brief") ?? "";
          const spawned = parseSwarmAddResults(row.content, call);
          for (const entry of spawned) {
            if (entry.id === conversationId) continue;
            upsert({
              id: entry.id,
              role: entry.name,
              type: "worker",
              origin: "swarm",
              task: brief,
              fallbackModel: entry.model,
              preferRole: Boolean(entry.name),
            });
          }
        }
      }
    }

    // Merge `.system_generated/swarm/members.json` (authoritative swarm roster & live wake_mode).
    for (const member of swarmMembers.members) {
      upsert({
        id: member.id,
        role: member.name,
        type: member.type,
        origin: "swarm",
        killedAt: member.killed ? "" : null,
        trustedParent: true,
        fallbackModel: member.model,
        swarmWakeMode: member.wakeMode,
        swarmKilled: member.killed,
        authoritativeAlive: !member.killed,
        preferRole: true,
      });
    }

    // Merge `.system_generated/subagents/*.json` (authoritative agy subagent/worker registry).
    for (const entry of registry) {
      upsert({
        id: entry.id,
        role: entry.role,
        type: entry.type,
        origin: entry.origin,
        killedAt: entry.killed ? "" : null,
        trustedParent: true,
      });
    }

    // Apply `manage_subagents` roles/kills and `swarm kill` timestamps across discovered children.
    for (const child of byId.values()) {
      if (killedIds.has(child.id) && !child.authoritativeAlive) {
        const at = killedIds.get(child.id) ?? "";
        if (child.killedAt === null || (!child.killedAt && at)) child.killedAt = at;
      }
      // Name-based `swarm kill` fallback only fills timestamps for workers already marked killed in
      // authoritative registries (or absent from `members.json` and not spawned after the kill).
      if (child.origin === "swarm" && !child.authoritativeAlive && child.swarmKilled && killedSwarmNames.size > 0) {
        for (const [targetName, at] of killedSwarmNames) {
          if (matchesSwarmKillTarget(child.role, targetName)) {
            if (child.killedAt === null || (!child.killedAt && at)) child.killedAt = at;
            break;
          }
        }
      }
      const entry = listed.get(child.id);
      if (entry) {
        child.role ??= entry.role;
        child.type ??= entry.type;
      }
    }

    return { children: [...byId.values()], swarmTitle: swarmMembers.title };
  }

  /** Messages a conversation received, by sender. */
  private async reports(conversationId: string): Promise<Map<string, { at: string | null; content: string }>> {
    const result = new Map<string, { at: string | null; content: string }>();
    const dir = inboxDir(this.cliDir, conversationId);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json") || name === "read.json") continue;
      try {
        const message = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as {
          sender?: unknown;
          timestamp?: unknown;
          content?: unknown;
        };
        if (typeof message.sender !== "string" || typeof message.content !== "string") continue;
        const at = typeof message.timestamp === "string" ? message.timestamp : null;
        const previous = result.get(message.sender);
        if (!previous || (at && (!previous.at || at > previous.at))) {
          result.set(message.sender, { at, content: message.content });
        }
      } catch {
        // Not a message file.
      }
    }
    return result;
  }

  private async summarize(
    child: Child,
    parentId: string,
    depth: number,
    reported: { at: string | null; content: string } | undefined,
    boardBrief: string | null,
    parentClosed: boolean,
  ): Promise<SubagentSummary> {
    const log = await this.rows(child.id);
    const rows = log?.rows ?? [];
    let tools = 0;
    let input = 0;
    let output = 0;
    let cached = 0;
    let model: string | null = null;
    let lastCall: ToolCall | null = null;
    let lastInputTime = NaN;
    for (const row of rows) {
      tools += row.tool_calls?.length ?? 0;
      input += row.input_tokens ?? 0;
      output += row.output_tokens ?? 0;
      cached += row.cache_read_tokens ?? 0;
      if (row.model) model = row.model;
      if (row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT") {
        const at = parseTime(row.created_at);
        if (Number.isFinite(at)) lastInputTime = at;
      }
      const calls = row.tool_calls ?? [];
      if (calls.length) lastCall = calls[calls.length - 1]!;
    }
    const last = rows[rows.length - 1];
    const dbStat = await fs
      .stat(path.join(this.cliDir, "conversations", `${child.id}.db-wal`))
      .catch(() => fs.stat(path.join(this.cliDir, "conversations", `${child.id}.db`)).catch(() => null));
    const touched = Math.max(log?.mtimeMs ?? 0, dbStat?.mtimeMs ?? 0);
    const finalAnswer = last?.type === "PLANNER_RESPONSE" && last.status === "DONE" && !(last.tool_calls?.length);
    // A report only covers the latest turn if it was sent after (or alongside) the latest input to the subagent.
    const reportedMs = parseTime(reported?.at);
    const reportedCurrentTurn = Boolean(
      reported && (!Number.isFinite(lastInputTime) || !Number.isFinite(reportedMs) || reportedMs >= lastInputTime - 2000),
    );
    // A tool error is routine; an error in the model's own step ends the run.
    const failed = Boolean(last && (last.type?.includes("ERROR") || (last.status === "ERROR" && last.type !== "GENERIC")));

    const isKilled = child.killedAt !== null || child.swarmKilled;
    const wakeMode = child.swarmWakeMode;
    const isSwarmWaiting =
      child.origin === "swarm" &&
      !isKilled &&
      (wakeMode === "waiting" || wakeMode === "mentions" || wakeMode === "all");
    const parkedOnSwarmWait =
      child.origin === "swarm" &&
      lastCall?.name === "swarm_wait" &&
      last?.type === "GENERIC" &&
      last.status === "DONE";
    const settledTurn = finalAnswer || parkedOnSwarmWait;
    const isSwarmWorking =
      child.origin === "swarm" &&
      !isKilled &&
      wakeMode === "working" &&
      !parentClosed &&
      (touched === 0 || Date.now() - touched <= STALE_MS);

    let state: SubagentState;
    let phase: "thinking" | "tool" | null = null;
    if (isKilled && !(settledTurn && reportedCurrentTurn)) {
      state = "stopped";
    } else if (isKilled) {
      state = "done";
    } else if (!last) {
      if (isSwarmWaiting) state = reportedCurrentTurn ? "done" : parentClosed ? "stopped" : "idle";
      else state = parentClosed ? "stopped" : "running";
      if (state === "running") phase = "thinking";
    } else if (last.status === "CANCELED" || last.status === "INTERRUPTED") {
      state = "stopped";
    } else if (failed) {
      state = "failed";
    } else if (isSwarmWorking) {
      state = "running";
      phase =
        (last.type === "PLANNER_RESPONSE" && last.tool_calls?.length && last.status === "DONE") ||
        (last.type === "GENERIC" && last.status === "RUNNING")
          ? "tool"
          : "thinking";
    } else if (isSwarmWaiting || parkedOnSwarmWait) {
      state = reportedCurrentTurn ? "done" : parentClosed ? "stopped" : "idle";
    } else if (finalAnswer) {
      state = reportedCurrentTurn ? "done" : parentClosed ? "stopped" : "idle";
    } else {
      state = "running";
      phase = last.type === "PLANNER_RESPONSE" && last.tool_calls?.length && last.status === "DONE" ? "tool" : "thinking";
      if (last.type === "GENERIC" && last.status === "RUNNING") phase = "tool";
    }
    if (state === "running" && (parentClosed || (touched > 0 && Date.now() - touched > STALE_MS))) {
      state = "stopped";
      phase = null;
    }

    const activity =
      state === "running" && phase === "thinking"
        ? null
        : lastCall
          ? `${lastCall.name}${describeCall(lastCall) ? ` · ${describeCall(lastCall)}` : ""}`
          : null;
    const updatedAt = last?.created_at ?? (touched ? new Date(touched).toISOString() : null);

    let taskText: string;
    if (child.origin === "swarm") {
      const initialBodies = rows
        .filter((row) => row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT")
        .slice(0, 5)
        .map((row) => messageBody(row.content ?? ""))
        .filter(Boolean);
      const substantiveInitial = initialBodies.find((body) => !SWARM_NUDGE_BODY.test(body)) ?? initialBodies[0] ?? "";
      taskText = boardBrief || child.task || substantiveInitial;
    } else {
      // The child's own first message holds the whole task; the parent's call may be cut short.
      taskText = messageBody(rows.find((row) => row.type === "SYSTEM_MESSAGE")?.content ?? "") || child.task;
    }

    return {
      id: child.id,
      parentId,
      depth,
      role: child.role,
      type: child.type,
      origin: child.origin,
      task: oneLine(taskText, 600),
      state,
      phase,
      activity,
      steps: rows.length,
      tools,
      model: model ?? child.fallbackModel,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      startedAt: rows[0]?.created_at ?? null,
      updatedAt,
      reportedAt: reportedCurrentTurn ? (reported?.at ?? null) : null,
    };
  }

  private async collect(
    conversationId: string,
    depth: number,
    parentClosed: boolean,
  ): Promise<{ summaries: SubagentSummary[]; swarmTitle: string | null }> {
    if (depth > MAX_DEPTH) return { summaries: [], swarmTitle: null };
    const { children, swarmTitle } = await this.discoverChildren(conversationId);
    if (!children.length) return { summaries: [], swarmTitle };
    const hasSwarm = children.some((child) => child.origin === "swarm");
    const [inbox, boardPosts] = await Promise.all([
      this.reports(conversationId),
      hasSwarm ? readSwarmBoard(this.cliDir, conversationId) : Promise.resolve([] as BoardPost[]),
    ]);

    const nodes: Array<{ summary: SubagentSummary; descendants: SubagentSummary[]; index: number }> = [];
    for (const [index, child] of children.entries()) {
      // Only a conversation whose initial messages came from this parent is its child,
      // unless directly registered in the parent's own `swarm/members.json` or `subagents/*.json`.
      if (!child.trustedParent) {
        const own = await this.rows(child.id);
        if (own && sentBy(own.rows, conversationId) === false) continue;
      }
      const boardReport = child.origin === "swarm" ? findBoardReport(boardPosts, child.role) : null;
      const boardBrief = child.origin === "swarm" ? findBoardBrief(boardPosts, child.role) : null;
      const reported = boardReport ?? inbox.get(child.id);
      const summary = await this.summarize(child, conversationId, depth, reported, boardBrief, parentClosed);
      const nested = await this.collect(child.id, depth + 1, parentClosed || summary.state === "stopped");
      nodes.push({ summary, descendants: nested.summaries, index });
    }

    // Running first, then reverse-chronological (`updatedAt ?? startedAt` descending), keeping nested children grouped.
    nodes.sort((a, b) => {
      const runningDelta = (a.summary.state === "running" ? 0 : 1) - (b.summary.state === "running" ? 0 : 1);
      if (runningDelta !== 0) return runningDelta;
      const timeDelta = summarySortTime(b.summary) - summarySortTime(a.summary);
      if (timeDelta !== 0 && Number.isFinite(timeDelta)) return timeDelta;
      return a.index - b.index;
    });

    const summaries: SubagentSummary[] = [];
    for (const node of nodes) {
      summaries.push(node.summary, ...node.descendants);
    }
    return { summaries, swarmTitle };
  }

  async list(paseo: PaseoApi, agentId: string): Promise<SubagentList> {
    const cached = this.listCache.get(agentId);
    if (cached && Date.now() - cached.at < 1500) return cached.value;
    const info = await this.agents.conversationOf(paseo, agentId);
    const value: SubagentList = {
      conversationId: info?.conversationId ?? null,
      swarmTitle: null,
      subagents: [],
    };
    if (info?.conversationId) {
      const collected = await this.collect(info.conversationId, 1, info.closed);
      value.subagents = collected.summaries;
      value.swarmTitle = collected.swarmTitle;
    }
    this.listCache.set(agentId, { at: Date.now(), value });
    return value;
  }

  async counts(
    paseo: PaseoApi,
    agentIds: readonly string[],
  ): Promise<Record<string, { total: number; running: number; failed: number }>> {
    const result: Record<string, { total: number; running: number; failed: number }> = {};
    await Promise.all(
      [...new Set(agentIds)].map(async (agentId) => {
        const list = await this.list(paseo, agentId).catch(() => null);
        if (!list) return;
        result[agentId] = {
          total: list.subagents.length,
          running: list.subagents.filter((subagent) => subagent.state === "running").length,
          failed: list.subagents.filter((subagent) => subagent.state === "failed").length,
        };
      }),
    );
    return result;
  }

  async detail(paseo: PaseoApi, agentId: string, subagentId: string): Promise<SubagentDetail> {
    const list = await this.list(paseo, agentId);
    const summary = list.subagents.find((subagent) => subagent.id === subagentId) ?? null;
    // Only conversations this agent created can be read through it.
    if (!summary) return { summary: null, entries: [], report: null, artifacts: [], truncated: false };
    const [log, inbox, artifacts, boardPosts] = await Promise.all([
      this.rows(subagentId),
      this.reports(summary.parentId),
      listArtifacts(this.cliDir, subagentId),
      summary.origin === "swarm" ? readSwarmBoard(this.cliDir, summary.parentId) : Promise.resolve([] as BoardPost[]),
    ]);
    const rows = log?.rows ?? [];
    const entries: TranscriptEntry[] = [];
    const open: TranscriptEntry["tools"] = [];
    let sendMessageReport: string | null = null;
    let postMessageReport: string | null = null;
    for (const row of rows) {
      if (row.type === "SYSTEM_MESSAGE" || row.type === "USER_INPUT") {
        entries.push({
          index: row.step_index,
          kind: entries.length === 0 ? "task" : "message",
          at: row.created_at ?? null,
          text: clip(messageBody(row.content ?? ""), 4000),
          thinking: null,
          tools: [],
          model: null,
        });
        continue;
      }
      if (row.type === "PLANNER_RESPONSE") {
        const tools = (row.tool_calls ?? []).map((call) => {
          const recipient = argText(call, "Recipient");
          if (call.name === "send_message" && (!recipient || recipient === summary.parentId)) {
            sendMessageReport = argText(call, "Message") ?? sendMessageReport;
          }
          if (call.name === "post_message") {
            const text = argText(call, "text");
            if (text) postMessageReport = text;
          }
          return { name: call.name, summary: describeCall(call), output: null, failed: false };
        });
        // Results of an interrupted response never arrive; they must not shift this one's.
        open.length = 0;
        open.push(...tools);
        entries.push({
          index: row.step_index,
          kind: row.status === "ERROR" ? "error" : "response",
          at: row.created_at ?? null,
          text: clip(row.content, 4000),
          thinking: clip(row.thinking, 1500),
          tools,
          model: row.model ?? null,
        });
        continue;
      }
      if (row.type === "GENERIC") {
        const tool = open.shift();
        if (tool) {
          tool.output = clip(stripTimes(row.content ?? ""), 1200);
          tool.failed = row.status === "ERROR";
        }
        continue;
      }
      if (row.type?.includes("ERROR") || row.status === "ERROR") {
        entries.push({
          index: row.step_index,
          kind: "error",
          at: row.created_at ?? null,
          text: clip(row.content, 1200),
          thinking: null,
          tools: [],
          model: null,
        });
      }
    }
    const boardReport = summary.origin === "swarm" ? findBoardReport(boardPosts, summary.role)?.content ?? null : null;
    const inboxReport = inbox.get(subagentId)?.content ?? null;
    const truncated = entries.length > MAX_ENTRIES;
    const task = entries[0]?.kind === "task" ? entries[0] : null;
    return {
      summary,
      // Keep the task when only the latest steps fit.
      entries: truncated ? [...(task ? [task] : []), ...entries.slice(-(MAX_ENTRIES - 1))] : entries,
      report: boardReport ?? inboxReport ?? sendMessageReport ?? postMessageReport,
      artifacts,
      truncated,
    };
  }

  /** Reads a text artifact written by a subagent inside its own brain folder (never follows symlinks). */
  async artifact(
    paseo: PaseoApi,
    agentId: string,
    subagentId: string,
    relativePath: string,
  ): Promise<{ path: string; content: string; truncated: boolean; isMarkdown: boolean }> {
    const list = await this.list(paseo, agentId);
    if (!list.subagents.some((subagent) => subagent.id === subagentId)) {
      throw new Error("That subagent does not belong to this agent.");
    }
    const root = brainDir(this.cliDir, subagentId);
    const rootStat = await fs.lstat(root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new Error("Artifact could not be read.");
    const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = cleaned.split("/");
    if (!cleaned || parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
      throw new Error("Invalid artifact path.");
    }
    const target = path.resolve(root, cleaned);
    if (!target.startsWith(root + path.sep)) throw new Error("Invalid artifact path.");
    // Verify every segment from root to target is a real directory or file, never a symlink.
    let current = root;
    for (let i = 0; i < parts.length; i += 1) {
      current = path.join(current, parts[i]!);
      const entryStat = await fs.lstat(current).catch(() => null);
      if (!entryStat || entryStat.isSymbolicLink()) throw new Error("Artifact could not be read.");
      if (i < parts.length - 1 ? !entryStat.isDirectory() : !entryStat.isFile()) {
        throw new Error(i < parts.length - 1 ? "Artifact could not be read." : "Artifact is not a file.");
      }
    }
    const handle = await fs.open(target, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Artifact is not a file.");
      const toRead = Math.min(stat.size, MAX_ARTIFACT_BYTES);
      const buffer = Buffer.alloc(toRead);
      let filled = 0;
      while (filled < toRead) {
        const { bytesRead } = await handle.read(buffer, filled, toRead - filled, filled);
        if (bytesRead <= 0) break;
        filled += bytesRead;
      }
      return {
        path: cleaned,
        content: buffer.subarray(0, filled).toString("utf8"),
        truncated: stat.size > MAX_ARTIFACT_BYTES,
        isMarkdown: /\.(md|markdown)$/i.test(cleaned),
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Maps `run_command` CommandLine values from the parent conversation's `transcript.jsonl`
   * back to their model-written `toolSummary` labels, since Paseo's ACP adapter does not
   * forward `toolSummary` into `metadata.description`.
   */
  async toolSummaries(paseo: PaseoApi, agentId: string): Promise<ToolSummaries> {
    const conversationId = await this.agents.conversationId(paseo, agentId);
    if (!conversationId) return { byCommand: {}, prefixes: [] };
    const log = await this.rows(conversationId);
    if (!log) return { byCommand: {}, prefixes: [] };
    const { rows } = log;
    const byCommand: Record<string, string> = {};
    const prefixMap = new Map<string, string>();
    for (const row of rows) {
      if (!row.tool_calls?.length) continue;
      for (const call of row.tool_calls) {
        if (call.name !== "run_command") continue;
        const summary = argText(call, "toolSummary");
        const rawCmd = argText(call, "CommandLine");
        if (!summary || !rawCmd) continue;
        const rawArg = call.args?.CommandLine;
        const truncated =
          typeof rawArg === "string" &&
          rawArg.trim().startsWith('"') &&
          !rawArg.trim().endsWith('"');
        const cleaned = normalizeCommandKey(rawCmd);
        if (!cleaned) continue;
        if (truncated) {
          const prefix = cleaned.replace(/(?:\.\.\.|…)+$/, "").trim();
          if (prefix.length >= 16) prefixMap.set(prefix, summary);
        } else {
          byCommand[cleaned] = summary;
          if (cleaned.length >= 48) {
            prefixMap.set(cleaned.slice(0, 96), summary);
          }
        }
      }
    }
    const entries = [...prefixMap.entries()].slice(-200).map(([prefix, summary]) => ({ prefix, summary }));
    return { byCommand, prefixes: entries };
  }

  forget(agentId: string): void {
    const cached = this.listCache.get(agentId);
    if (cached) {
      if (cached.value.conversationId) this.logs.delete(logPath(this.cliDir, cached.value.conversationId));
      for (const subagent of cached.value.subagents) this.logs.delete(logPath(this.cliDir, subagent.id));
    }
    this.listCache.delete(agentId);
  }
}

/** Parses the complete lines of `file` between `from` and `to`, with each line's start offset. */
async function readRows(file: string, from: number, to: number): Promise<{ rows: Row[]; starts: number[] } | null> {
  const length = Math.max(0, to - from);
  const buffer = Buffer.alloc(length);
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  let totalRead = 0;
  try {
    while (totalRead < length) {
      const { bytesRead } = await handle.read(buffer, totalRead, length - totalRead, from + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const view = buffer.subarray(0, totalRead);
  const rows: Row[] = [];
  const starts: number[] = [];
  let start = 0;
  for (;;) {
    const newline = view.indexOf(0x0a, start);
    // A line without its newline is still being written: leave it for the next read.
    if (newline < 0) break;
    const line = view.subarray(start, newline).toString("utf8").trim();
    if (line) {
      try {
        const row = JSON.parse(line) as Row;
        if (typeof row.step_index === "number") {
          rows.push(row);
          starts.push(from + start);
        }
      } catch {
        if (rows.length === 0 && from > 0) return null;
      }
    }
    start = newline + 1;
  }
  return { rows, starts };
}

/** Keeps the newest line of a step that agy wrote more than once. */
function dedupe(log: CachedLog): void {
  const seen = new Set<number>();
  let duplicate = false;
  for (const row of log.rows) {
    if (seen.has(row.step_index)) duplicate = true;
    seen.add(row.step_index);
  }
  if (!duplicate) return;
  const rows: Row[] = [];
  const starts: number[] = [];
  const kept = new Set<number>();
  for (let index = log.rows.length - 1; index >= 0; index -= 1) {
    const row = log.rows[index]!;
    if (kept.has(row.step_index)) continue;
    kept.add(row.step_index);
    rows.unshift(row);
    starts.unshift(log.starts[index]!);
  }
  log.rows = rows;
  log.starts = starts;
}
