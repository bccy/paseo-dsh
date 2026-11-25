/**
 * Shared subagent timeline metadata and status-chip parsers.
 *
 * Lives in `shared/` with zero Node-only or third-party runtime imports so both
 * the server half (`server/timeline.ts`, `server/session.ts`) and the
 * platform-neutral React Native client bundle (`client/tool-call-data.ts`,
 * Phase 4 subagent card & chip renderers) can import the exact same contract
 * without drift or bundler stubs.
 *
 * Design invariants:
 * - **Facts only — never fabricate metrics.** `steps`, `durationMs`, and
 *   `outputTokens` are populated strictly from observed runtime/log data and
 *   omitted whenever absent.
 * - **Metadata-only enrichment.** Paseo's `ProviderEventSchema` strips unknown
 *   keys on `detail` (`toolCallDetailSchema` members are `.strip()`), so all
 *   enriched subagent facts ride under `item.metadata[DSH_SUBAGENT_METADATA_KEY]`
 *   while `detail` keeps its exact protocol shape (`{ type: "sub_agent", … }`
 *   for `subagent`, `{ type: "unknown", … }` for `subagent_fork`).
 * - **Fail closed on malformed tool outputs.** `parseListAgentsOutput` and
 *   `parseArchiveSubagentsOutput` return `null` for failed calls or shapes they
 *   do not recognize, so the client cleanly falls back to the raw body.
 *
 * @module dsh-paseo/shared/subagent-card
 */

/** Namespaced `item.metadata` key carrying structured subagent facts. */
export const DSH_SUBAGENT_METADATA_KEY = "dshSubagent" as const;

/** Delegation tools that spawn/fork a subagent card row. */
export const SUBAGENT_TOOL_NAMES = ["subagent", "subagent_fork"] as const;
export type SubagentKind = (typeof SUBAGENT_TOOL_NAMES)[number];

/** Subagent inspection/maintenance tools that render inline status chips. */
export const SUBAGENT_STATUS_TOOL_NAMES = ["list_agents", "archive_subagents"] as const;
export type SubagentStatusToolName = (typeof SUBAGENT_STATUS_TOOL_NAMES)[number];

/** Observed subagent lifecycle states. */
export const SUBAGENT_STATUSES = ["running", "completed", "failed", "canceled"] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

/** DSH subagent lifecycle modes. */
export const SUBAGENT_MODES = ["continuable", "one-shot"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

/**
 * Enriched, observed-only facts attached to `subagent` and `subagent_fork`
 * tool-call items under `item.metadata[DSH_SUBAGENT_METADATA_KEY]`.
 *
 * Optional keys are omitted (never set to `undefined`, `NaN`, or guessed
 * placeholder values) so the payload passes Paseo's `ProviderEventSchema`
 * (`jsonValueSchema`) untouched and the client can tell "not measured" from `0`.
 */
export interface DshSubagentMetadata {
  /** Which delegation tool launched this subagent (`"subagent"` vs `"subagent_fork"`). */
  kind: SubagentKind;
  /** Observed subagent lifecycle status. */
  status: SubagentStatus;
  /** Observed role / name (`args.name`, `args.agent_preset`, runtime `meta.name`, or catalog `name`). */
  role?: string;
  /** Short task title (`args.description`, catalog `label`, or descriptor `label`). */
  title?: string;
  /** Full delegated task instruction (`args.prompt` / `args.task`). */
  task?: string;
  /** Observed final closing report/output (never an async `"started subagent …"` ack). */
  report?: string;
  /** Correlated DSH child session id when known from `subagent/catalog` or settlement. */
  childSessionId?: string;
  /** Observed DSH subagent lifecycle mode (`"continuable"` | `"one-shot"`). */
  mode?: SubagentMode;
  /** Observed child agent preset (`args.agent_preset` or `subagent/descriptor.agentPreset`). */
  preset?: string;
  /** Observed child model route (`provider/model` or `model`) when explicitly recorded. */
  model?: string;
  /** Real measured count of assistant steps in the child's own suffix. Omitted when unmeasured. */
  steps?: number;
  /** Real measured execution duration in milliseconds. Omitted when unmeasured. */
  durationMs?: number;
  /** Real measured output tokens summed across the child's own steps. Omitted when unmeasured. */
  outputTokens?: number;
}

/**
 * Real measured execution telemetry extracted from a child session's own events
 * (past any fork-inherited prefix). Every field is optional and omitted unless
 * genuinely observed.
 */
export interface SubagentTelemetry {
  status?: SubagentStatus;
  report?: string;
  mode?: SubagentMode;
  preset?: string;
  model?: string;
  label?: string;
  steps?: number;
  durationMs?: number;
  outputTokens?: number;
}

/** Parsed activation receipt from DSH 0.2.2-rc.2+ async `subagent` / `subagent_fork`. */
export interface SubagentActivationReceipt {
  kind: "activation";
  name: string;
}

/** Parsed `user/message` settlement notice (`source.kind === "subagent-settled"`). */
export interface SubagentSettlementNotice {
  senderSessionId: string;
  status?: SubagentStatus;
  report?: string;
  /** True when DSH omitted the closing message because the child sent an `agent-message` right before finishing. */
  omittedForAgentMessage: boolean;
}

/** Normalized status bucket for `list_agents` summary chips. */
export type ListAgentsStatusBucket =
  | "running"
  | "inactive"
  | "completed"
  | "failed"
  | "canceled"
  | "archived"
  | "diagnostic"
  | "other";

/** One parsed row from a `list_agents` tool result. */
export interface ListAgentsEntry {
  name: string;
  status: string;
  bucket: ListAgentsStatusBucket;
  isLead: boolean;
  role?: string;
  description?: string;
}

/** Subagent-only (lead-excluded) status count breakdown for `list_agents`. */
export interface ListAgentsCounts {
  total: number;
  running: number;
  inactive: number;
  completed: number;
  failed: number;
  canceled: number;
  archived: number;
  diagnostic: number;
  other: number;
}

/** Structured summary parsed from a `list_agents` tool output. */
export interface ListAgentsSummary {
  format: "text" | "tree-json" | "roster-json" | "empty";
  entries: ListAgentsEntry[];
  /** Status counts over subagents only (excludes the root `lead` row). */
  counts: ListAgentsCounts;
  /** Raw lower-cased status counts over subagents only. */
  byStatus: Record<string, number>;
  /** True when only the root `lead` row was listed (0 subagents). */
  leadOnly: boolean;
  /** Observed status of the root `lead` row, when present. */
  leadStatus?: string;
}

/** Structured summary parsed from an `archive_subagents` tool output. */
export interface ArchiveSubagentsSummary {
  scope: "session" | "all";
  dryRun: boolean;
  total: number;
  /** Count archived now, or count that would be archived when `dryRun` is true. */
  archived: number;
  alreadyArchived: number;
  /** Running children skipped so active work is not interrupted. */
  running: number;
  failed: number;
}

/** Unified chip-summary payload for `list_agents` and `archive_subagents`. */
export type SubagentStatusChipSummary =
  | { kind: "list_agents"; list: ListAgentsSummary }
  | { kind: "archive_subagents"; archive: ArchiveSubagentsSummary };

/** Minimal event shape read by {@link extractSubagentTelemetryFromEvents}. */
export interface SubagentLogEventLike {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function rawNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Format an explicit provider/model pair into a display route string, or undefined. */
export function formatSubagentModel(provider: unknown, model: unknown): string | undefined {
  const m = nonEmptyString(model);
  if (m === undefined) return undefined;
  const p = nonEmptyString(provider);
  return p === undefined ? m : `${p}/${m}`;
}

/** Whether `name` is one of the delegation tools (`subagent` or `subagent_fork`). */
export function isSubagentToolName(name: string): name is SubagentKind {
  return name === "subagent" || name === "subagent_fork";
}

/** Whether `name` is one of the status-chip tools (`list_agents` or `archive_subagents`). */
export function isSubagentStatusToolName(name: string): name is SubagentStatusToolName {
  return name === "list_agents" || name === "archive_subagents";
}

/**
 * Map a DSH `turn/end` `reason` object (`{ kind }`) or a `subagent-settled`
 * `stopReason` string onto {@link SubagentStatus}.
 *
 * Returns `undefined` when the input carries no stop reason, so callers never
 * invent a status from an absent field.
 */
export function mapSubagentStopReason(reason: unknown): SubagentStatus | undefined {
  const kind = typeof reason === "string"
    ? reason
    : isRecord(reason) && typeof reason.kind === "string"
      ? reason.kind
      : undefined;
  if (kind === undefined || kind === "") return undefined;
  if (kind === "completed") return "completed";
  if (kind === "aborted" || kind === "abandoned" || kind === "canceled" || kind === "cancelled") {
    return "canceled";
  }
  return "failed";
}

/**
 * Text rendering of `@deepseek-ai/dsh-tool-subagent`'s activation receipt:
 * `started subagent <name>`.
 */
const ACTIVATION_TEXT_PATTERN = /^started subagent ([A-Za-z0-9][A-Za-z0-9._/-]*)$/u;

/**
 * Detect whether a `subagent` / `subagent_fork` `tool/result` is an async
 * activation receipt (DSH 0.2.2-rc.2+) rather than a synchronous final answer.
 *
 * Authoritative source is `data.meta` (`{ kind: "activation", name }`); the
 * rendered text line (`"started subagent <name>"`) is accepted as fallback when
 * `data.meta` is absent.
 */
export function parseSubagentActivation(
  meta: unknown,
  output?: string,
): SubagentActivationReceipt | null {
  if (isRecord(meta) && meta.kind === "activation") {
    const name = nonEmptyString(meta.name);
    if (name !== undefined) return { kind: "activation", name };
  }
  if (typeof output === "string") {
    const match = ACTIVATION_TEXT_PATTERN.exec(output.trim());
    if (match !== null) return { kind: "activation", name: match[1] };
  }
  return null;
}

const CLOSING_MESSAGE_MARKER = "Its closing message:";
const OMITTED_FOR_AGENT_MESSAGE_MARKER =
  "It sent you a message just before finishing, so its closing message is omitted.";
const NO_CLOSING_MESSAGE_MARKER = "It left no closing message.";
const AGENT_MESSAGE_PREFIX = /^Agent [^\s]+ sent a message:\s*/u;

function textBlockStrings(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    parts.push(block.text);
  }
  return parts;
}

/**
 * Parse a parent-log `user/message` whose `source.kind === "subagent-settled"`.
 *
 * Matches the exact structure produced by `@deepseek-ai/dsh-subagent`'s
 * `createSettlementMessage`:
 * - `source.senderSessionId` names the child session;
 * - `source.stopReason` names the terminal outcome;
 * - `content` carries the opening summary followed by either
 *   `"Its closing message:"` + closing text blocks, `"It sent you a message…"`,
 *   or `"It left no closing message."` (plus optional `"Structured result: …"`).
 */
export function parseSubagentSettlementMessage(data: unknown): SubagentSettlementNotice | null {
  if (!isRecord(data)) return null;
  const source = isRecord(data.source) ? data.source : undefined;
  if (source === undefined || source.kind !== "subagent-settled") return null;
  const senderSessionId = nonEmptyString(source.senderSessionId);
  if (senderSessionId === undefined) return null;
  const status = mapSubagentStopReason(source.stopReason);
  const blocks = textBlockStrings(data.content);

  let omittedForAgentMessage = false;
  let report: string | undefined;

  const closingIndex = blocks.findIndex((text) => text.trim() === CLOSING_MESSAGE_MARKER);
  if (closingIndex >= 0) {
    const joined = blocks.slice(closingIndex + 1).join("\n").trim();
    if (joined !== "") report = joined;
  } else {
    for (const block of blocks) {
      const trimmed = block.trim();
      if (trimmed === OMITTED_FOR_AGENT_MESSAGE_MARKER) {
        omittedForAgentMessage = true;
      } else if (trimmed.startsWith("Structured result:") && report === undefined) {
        report = trimmed;
      }
    }
    // Single-block fallback if a transport concatenated the blocks together.
    if (report === undefined && !omittedForAgentMessage && blocks.length === 1) {
      const text = blocks[0];
      const markerAt = text.indexOf(CLOSING_MESSAGE_MARKER);
      if (markerAt >= 0) {
        const after = text.slice(markerAt + CLOSING_MESSAGE_MARKER.length).trim();
        if (after !== "") report = after;
      } else if (text.includes(OMITTED_FOR_AGENT_MESSAGE_MARKER)) {
        omittedForAgentMessage = true;
      } else if (text.includes(NO_CLOSING_MESSAGE_MARKER)) {
        report = undefined;
      }
    }
  }

  return {
    senderSessionId,
    ...(status === undefined ? {} : { status }),
    ...(report === undefined ? {} : { report }),
    omittedForAgentMessage,
  };
}

/**
 * Parse a parent-log `user/message` whose `source.kind === "agent-message"`.
 *
 * Used to recover a subagent's closing report when DSH's `subagent-settled`
 * notice omits the closing message because the child messaged the parent right
 * before finishing.
 */
export function parseRelayedAgentMessage(
  data: unknown,
): { senderSessionId: string; text: string } | null {
  if (!isRecord(data)) return null;
  const source = isRecord(data.source) ? data.source : undefined;
  if (source === undefined || source.kind !== "agent-message") return null;
  const senderSessionId = nonEmptyString(source.senderSessionId);
  if (senderSessionId === undefined) return null;
  const blocks = textBlockStrings(data.content);
  if (blocks.length === 0) return null;
  let body: string;
  if (blocks.length > 1 && AGENT_MESSAGE_PREFIX.test(blocks[0])) {
    body = blocks.slice(1).join("\n").trim();
  } else {
    body = blocks.join("\n").replace(AGENT_MESSAGE_PREFIX, "").trim();
  }
  if (body === "") return null;
  return { senderSessionId, text: body };
}

/**
 * Extract real measured {@link SubagentTelemetry} from a child session's event
 * stream, strictly past `inheritedEventCount` so forked children never count
 * parent turns, steps, tokens, or timestamps as their own.
 *
 * Every metric is omitted unless directly observed in the events.
 */
export function extractSubagentTelemetryFromEvents(
  events: ReadonlyArray<SubagentLogEventLike>,
  inheritedEventCount = 0,
): SubagentTelemetry {
  const seenSteps = new Set<string>();
  let fallbackSeq = 0;
  let anonStep = 0;
  let outputTokensTotal = 0;
  let hasOutputTokens = false;
  let activeTurnStart: number | undefined;
  let durationTotal = 0;
  let hasDuration = false;
  let turnOpen = false;
  let lastTurnStatus: SubagentStatus | undefined;
  let report: string | undefined;
  let mode: SubagentMode | undefined;
  let preset: string | undefined;
  let model: string | undefined;
  let label: string | undefined;

  for (const event of events) {
    const seq = typeof event.seq === "number" ? event.seq : fallbackSeq++;
    const data = isRecord(event.data) ? event.data : {};

    // `subagent/descriptor` can sit at seq 0 (before or at inheritedEventCount)
    // and describes the child itself rather than parent conversation history.
    if (event.type === "subagent/descriptor") {
      if (data.mode === "continuable" || data.mode === "one-shot") mode = data.mode;
      const descPreset = nonEmptyString(data.agentPreset);
      if (descPreset !== undefined) preset = descPreset;
      const descModel = formatSubagentModel(data.agentProvider, data.agentModel);
      if (descModel !== undefined) model = descModel;
      const descLabel = nonEmptyString(data.label);
      if (descLabel !== undefined) label = descLabel;
      continue;
    }

    if (seq < inheritedEventCount) continue;

    if (event.type === "turn/start") {
      turnOpen = true;
      activeTurnStart = nonNegativeFiniteNumber(event.time);
      continue;
    }

    if (event.type === "turn/end") {
      turnOpen = false;
      const endTime = nonNegativeFiniteNumber(event.time);
      if (activeTurnStart !== undefined && endTime !== undefined && endTime >= activeTurnStart) {
        durationTotal += endTime - activeTurnStart;
        hasDuration = true;
      }
      activeTurnStart = undefined;
      lastTurnStatus = mapSubagentStopReason(data.reason) ?? "failed";
      continue;
    }

    if (event.type === "assistant/message") {
      const turn = typeof data.turn === "number" ? data.turn : undefined;
      const step = typeof data.step === "number" ? data.step : undefined;
      if (turn !== undefined && step !== undefined) {
        seenSteps.add(`${turn}:${step}`);
      } else {
        anonStep += 1;
        seenSteps.add(`anon:${anonStep}`);
      }
      if (isRecord(data.usage)) {
        const out = nonNegativeFiniteNumber(data.usage.outputTokens);
        if (out !== undefined) {
          outputTokensTotal += out;
          hasOutputTokens = true;
        }
      }
      const message = isRecord(data.message) ? data.message : undefined;
      if (message !== undefined) {
        const text = textBlockStrings(message.content).join("").trim();
        if (text !== "") report = text;
      }
    }
  }

  return {
    ...(!turnOpen && lastTurnStatus !== undefined ? { status: lastTurnStatus } : {}),
    ...(report === undefined ? {} : { report }),
    ...(mode === undefined ? {} : { mode }),
    ...(preset === undefined ? {} : { preset }),
    ...(model === undefined ? {} : { model }),
    ...(label === undefined ? {} : { label }),
    ...(seenSteps.size > 0 ? { steps: seenSteps.size } : {}),
    ...(hasDuration ? { durationMs: Math.round(durationTotal) } : {}),
    ...(hasOutputTokens ? { outputTokens: Math.round(outputTokensTotal) } : {}),
  };
}

/**
 * Validate an untrusted object (such as `item.metadata.dshSubagent` read by the
 * client) into a clean {@link DshSubagentMetadata}, dropping malformed fields
 * and returning `null` when required identity fields are missing or invalid.
 */
export function sanitizeSubagentMetadata(raw: unknown): DshSubagentMetadata | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "subagent" && raw.kind !== "subagent_fork") return null;
  if (
    raw.status !== "running" &&
    raw.status !== "completed" &&
    raw.status !== "failed" &&
    raw.status !== "canceled"
  ) {
    return null;
  }
  const role = nonEmptyString(raw.role);
  const title = nonEmptyString(raw.title);
  const task = rawNonEmptyString(raw.task);
  const report = rawNonEmptyString(raw.report);
  const childSessionId = nonEmptyString(raw.childSessionId);
  const mode = raw.mode === "continuable" || raw.mode === "one-shot" ? raw.mode : undefined;
  const preset = nonEmptyString(raw.preset);
  const model = nonEmptyString(raw.model);
  const steps = nonNegativeInt(raw.steps);
  const durationMs = nonNegativeFiniteNumber(raw.durationMs);
  const outputTokens = nonNegativeInt(raw.outputTokens);

  return {
    kind: raw.kind,
    status: raw.status,
    ...(role === undefined ? {} : { role }),
    ...(title === undefined ? {} : { title }),
    ...(task === undefined ? {} : { task }),
    ...(report === undefined ? {} : { report }),
    ...(childSessionId === undefined ? {} : { childSessionId }),
    ...(mode === undefined ? {} : { mode }),
    ...(preset === undefined ? {} : { preset }),
    ...(model === undefined ? {} : { model }),
    ...(steps === undefined ? {} : { steps }),
    ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** Read and validate `metadata[DSH_SUBAGENT_METADATA_KEY]`, or return `null`. */
export function subagentMetadataFromItemMetadata(metadata: unknown): DshSubagentMetadata | null {
  if (!isRecord(metadata)) return null;
  return sanitizeSubagentMetadata(metadata[DSH_SUBAGENT_METADATA_KEY]);
}

function coerceStatus(raw: unknown): SubagentStatus {
  if (raw === "running" || raw === "completed" || raw === "failed" || raw === "canceled") {
    return raw;
  }
  return "completed";
}

/**
 * Resolve subagent card metadata for a timeline `tool_call` item.
 *
 * Prefers server-attached `item.metadata.dshSubagent` (which carries child
 * telemetry, settled status, and full prompt even on `subagent` rows whose
 * `detail` omits `prompt`). Falls back cleanly to observed fields on `detail`
 * for historical pre-upgrade rows, omitting unmeasured metrics.
 */
export function resolveSubagentCardMetadata(item: {
  name: string;
  status?: unknown;
  detail?: unknown;
  metadata?: unknown;
}): DshSubagentMetadata | null {
  if (!isSubagentToolName(item.name)) return null;
  const fromMeta = subagentMetadataFromItemMetadata(item.metadata);
  if (fromMeta !== null) return fromMeta;

  const detail = isRecord(item.detail) ? item.detail : undefined;
  const status = coerceStatus(item.status);
  const presentationMeta = isRecord(item.metadata) ? item.metadata.presentationMeta : undefined;

  if (detail?.type === "sub_agent") {
    const log = rawNonEmptyString(detail.log);
    const activation = parseSubagentActivation(presentationMeta, log);
    const role = nonEmptyString(detail.subAgentType) ?? activation?.name;
    const title = nonEmptyString(detail.description);
    const report = status !== "failed" && activation === null ? log : undefined;
    return {
      kind: item.name,
      status: status === "completed" && activation !== null ? "running" : status,
      ...(role === undefined ? {} : { role }),
      ...(title === undefined ? {} : { title }),
      ...(report === undefined ? {} : { report }),
    };
  }

  if (detail?.type === "unknown") {
    const input = isRecord(detail.input) ? detail.input : {};
    const output = rawNonEmptyString(detail.output);
    const activation = parseSubagentActivation(presentationMeta, output);
    const role =
      nonEmptyString(input.name) ??
      nonEmptyString(input.role) ??
      nonEmptyString(input.subagent_type) ??
      nonEmptyString(input.subAgentType) ??
      nonEmptyString(input.agent_preset) ??
      activation?.name;
    const title = nonEmptyString(input.description);
    const task = rawNonEmptyString(input.prompt) ?? rawNonEmptyString(input.task);
    const preset = nonEmptyString(input.agent_preset);
    const model = formatSubagentModel(input.provider, input.model);
    const report = status !== "failed" && activation === null ? output : undefined;
    return {
      kind: item.name,
      status: status === "completed" && activation !== null ? "running" : status,
      ...(role === undefined ? {} : { role }),
      ...(title === undefined ? {} : { title }),
      ...(task === undefined ? {} : { task }),
      ...(report === undefined ? {} : { report }),
      ...(preset === undefined ? {} : { preset }),
      ...(model === undefined ? {} : { model }),
    };
  }

  return { kind: item.name, status };
}

/** Normalize one `list_agents` status token into a chip bucket. */
export function classifyListAgentStatus(status: string): ListAgentsStatusBucket {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "active":
    case "working":
    case "in_progress":
      return "running";
    case "inactive":
    case "idle":
    case "ready":
      return "inactive";
    case "completed":
    case "done":
    case "finished":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "canceled":
    case "cancelled":
    case "aborted":
    case "stopped":
      return "canceled";
    case "archived":
      return "archived";
    case "corrupt":
    case "unsupported":
    case "unavailable":
      return "diagnostic";
    default:
      return "other";
  }
}

function emptyListCounts(): ListAgentsCounts {
  return {
    total: 0,
    running: 0,
    inactive: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    archived: 0,
    diagnostic: 0,
    other: 0,
  };
}

function summarizeListEntries(
  format: ListAgentsSummary["format"],
  entries: ListAgentsEntry[],
): ListAgentsSummary {
  const counts = emptyListCounts();
  const byStatus: Record<string, number> = {};
  let hasLead = false;
  let leadStatus: string | undefined;

  for (const entry of entries) {
    if (entry.isLead) {
      hasLead = true;
      if (leadStatus === undefined) leadStatus = entry.status;
      continue;
    }
    counts.total += 1;
    counts[entry.bucket] += 1;
    const key = entry.status.trim().toLowerCase();
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  return {
    format,
    entries,
    counts,
    byStatus,
    leadOnly: hasLead && counts.total === 0,
    ...(leadStatus === undefined ? {} : { leadStatus }),
  };
}

/**
 * Line shape emitted by DSH 0.2.2-rc.3+'s `list_agents` tool
 * (`@deepseek-ai/dsh-tool-subagent-control/lib/index.js:64`):
 * `<name> [<status>]` or `<name> [<status>] — <description>` (also tolerating `-`).
 */
const LIST_AGENTS_TEXT_LINE = /^([^\s[\]]+)\s+\[([^\]]+)\](?:\s+(?:—|--|-)\s+(.*))?$/u;

function parseListAgentsArray(value: unknown[]): ListAgentsSummary | null {
  if (value.length === 0) return summarizeListEntries("empty", []);
  const items: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    items.push(item);
  }
  const rosterShaped = items.every(
    (item) => typeof item.target === "string" && item.target !== "" && typeof item.role === "string" && typeof item.status === "string" && item.status !== "",
  );
  const treeShaped = items.every(
    (item) =>
      item.target === undefined &&
      item.role === undefined &&
      typeof item.name === "string" &&
      item.name !== "" &&
      typeof item.status === "string" &&
      item.status !== "",
  );
  // Mixed arrays are neither generation — fail closed so raw JSON fallback runs.
  if (!rosterShaped && !treeShaped) return null;

  if (treeShaped) {
    const entries: ListAgentsEntry[] = items.map((item) => {
      const name = String(item.name);
      const status = String(item.status);
      const description = nonEmptyString(item.description);
      return {
        name,
        status,
        bucket: classifyListAgentStatus(status),
        isLead: name === "lead",
        ...(description === undefined ? {} : { description }),
      };
    });
    return summarizeListEntries("tree-json", entries);
  }

  const entries: ListAgentsEntry[] = items.map((item) => {
    const name = String(item.target);
    const role = String(item.role);
    const status = String(item.status);
    const description = nonEmptyString(item.description);
    return {
      name,
      role,
      status,
      bucket: classifyListAgentStatus(status),
      isLead: role === "lead" || name === "lead",
      ...(description === undefined ? {} : { description }),
    };
  });
  return summarizeListEntries("roster-json", entries);
}

/**
 * Parse a `list_agents` tool result into structured entries and status counts
 * for inline status chips.
 *
 * Supports all observed DSH generations:
 * 1. DSH 0.2.2-rc.3+ plain-text lines (`lead [running] — root agent`);
 * 2. DSH 0.2.2-rc.2 JSON tree (`[{ name, status, description? }]`);
 * 3. DSH <= 0.2.1 JSON roster (`[{ target, role, status, description? }]`);
 * 4. Empty output (`"[]"` or `"(no subagents)"`).
 *
 * Returns `null` on failed calls or unrecognized/mixed shapes.
 */
export function parseListAgentsOutput(output: unknown, failed = false): ListAgentsSummary | null {
  if (failed || output === undefined || output === null) return null;

  if (Array.isArray(output)) {
    return parseListAgentsArray(output);
  }

  if (typeof output !== "string") return null;
  const trimmed = output.trim();
  if (trimmed === "") return null;
  if (trimmed === "(no subagents)") return summarizeListEntries("empty", []);

  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parseListAgentsArray(parsed);
    } catch {
      return null;
    }
    return null;
  }

  const lines = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return null;
  const entries: ListAgentsEntry[] = [];
  for (const line of lines) {
    const match = LIST_AGENTS_TEXT_LINE.exec(line);
    if (match === null) return null;
    const name = match[1];
    const status = match[2].trim();
    if (status === "") return null;
    const description = nonEmptyString(match[3]);
    entries.push({
      name,
      status,
      bucket: classifyListAgentStatus(status),
      isLead: name === "lead",
      ...(description === undefined ? {} : { description }),
    });
  }
  return summarizeListEntries("text", entries);
}

const ARCHIVE_HEADER_LINE = /^(all stored subagent sessions|children of this session):\s*(\d+)\s+candidate\(s\)$/u;
const ARCHIVE_COUNT_LINE = /^(\[dry run\] would archive|archived)\s+(\d+):/u;
const ALREADY_ARCHIVED_LINE = /^already archived\s+(\d+):/u;
const RUNNING_SKIPPED_LINE = /^running \(skipped\)\s+(\d+):/u;
const FAILED_NONE_LINE = /^failed:\s*none$/u;
const FAILED_COUNT_LINE = /^failed\s+(\d+):/u;

function parseArchiveSubagentsObject(value: Record<string, unknown>): ArchiveSubagentsSummary | null {
  const scope = value.scope === "all" || value.scope === "session" ? value.scope : undefined;
  const dryRun = typeof value.dryRun === "boolean" ? value.dryRun : undefined;
  const total = nonNegativeInt(value.total);
  if (scope === undefined || dryRun === undefined || total === undefined) return null;
  if (
    !Array.isArray(value.archived) ||
    !Array.isArray(value.alreadyArchived) ||
    !Array.isArray(value.running) ||
    !Array.isArray(value.failed)
  ) {
    return null;
  }
  return {
    scope,
    dryRun,
    total,
    archived: value.archived.length,
    alreadyArchived: value.alreadyArchived.length,
    running: value.running.length,
    failed: value.failed.length,
  };
}

/**
 * Parse an `archive_subagents` tool result into structured counts for inline
 * status chips.
 *
 * Accepts both the bridge's rendered 5-line report (`dsh-bridge/lib/subagent-archive.js`)
 * and the underlying structured JSON object. Returns `null` on failed calls or
 * unrecognized shapes.
 */
export function parseArchiveSubagentsOutput(
  output: unknown,
  failed = false,
): ArchiveSubagentsSummary | null {
  if (failed || output === undefined || output === null) return null;

  if (isRecord(output)) return parseArchiveSubagentsObject(output);
  if (typeof output !== "string") return null;
  const trimmed = output.trim();
  if (trimmed === "") return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return parseArchiveSubagentsObject(parsed);
    } catch {
      return null;
    }
    return null;
  }

  const lines = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length < 5) return null;

  const header = ARCHIVE_HEADER_LINE.exec(lines[0]);
  const archivedLine = ARCHIVE_COUNT_LINE.exec(lines[1]);
  const alreadyLine = ALREADY_ARCHIVED_LINE.exec(lines[2]);
  const runningLine = RUNNING_SKIPPED_LINE.exec(lines[3]);
  if (header === null || archivedLine === null || alreadyLine === null || runningLine === null) {
    return null;
  }

  let failedCount: number | undefined;
  if (FAILED_NONE_LINE.test(lines[4])) {
    failedCount = 0;
  } else {
    const failedMatch = FAILED_COUNT_LINE.exec(lines[4]);
    if (failedMatch !== null) failedCount = Number(failedMatch[1]);
  }
  if (failedCount === undefined) return null;

  return {
    scope: header[1] === "all stored subagent sessions" ? "all" : "session",
    dryRun: archivedLine[1].startsWith("[dry run]"),
    total: Number(header[2]),
    archived: Number(archivedLine[2]),
    alreadyArchived: Number(alreadyLine[1]),
    running: Number(runningLine[1]),
    failed: failedCount,
  };
}

/** Unified parser for `list_agents` and `archive_subagents` inline status chips. */
export function parseSubagentStatusChips(
  name: string,
  output: unknown,
  failed = false,
): SubagentStatusChipSummary | null {
  if (name === "list_agents") {
    const list = parseListAgentsOutput(output, failed);
    return list === null ? null : { kind: "list_agents", list };
  }
  if (name === "archive_subagents") {
    const archive = parseArchiveSubagentsOutput(output, failed);
    return archive === null ? null : { kind: "archive_subagents", archive };
  }
  return null;
}
