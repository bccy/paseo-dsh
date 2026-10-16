#!/usr/bin/env node
/**
 * What did the model actually send?
 *
 * The transcript the model reads back and the card the user sees are both
 * *renderings* of a tool call. Neither is evidence about the bytes that went out.
 * This reads the record DSH wrote to disk, and diffs every call's argument keys
 * against the schema DSH actually handed the model in that same session.
 *
 *   node harness/session-calls.mjs --list
 *   node harness/session-calls.mjs --latest
 *   node harness/session-calls.mjs --latest --tool ask_user_question
 *   node harness/session-calls.mjs --session b9a2b365 --raw
 *
 * Exit code is 1 when any call carried keys the schema never declared, so this
 * can gate a script.
 *
 * Why this exists
 * ---------------
 * A run of `ask_user_question` produced question cards with no choices. The cards
 * were rendering correctly: the calls really did omit `options` and instead
 * carried a runaway cascade of key names (`options_list`, `optionsList`,
 * `options_list_multi_select_options_list…`) that validation accepted, because
 * `additionalProperties: true` makes unknown keys legal and `options` is
 * optional. Nothing errored, so nothing surfaced. This is the missing detector.
 *
 * Two traps it deliberately avoids, each of which produced a wrong answer once:
 *
 * 1. The session log is a *multi-frame* zstd stream, one frame per flush.
 *    `zlib.zstdDecompressSync` returns only the first frame and discards the
 *    rest, so a 1.6 MB session reads as its 172-byte header — four
 *    `ask_user_question` calls become "0 calls found". The CLI `zstd -dc`
 *    decodes every frame, and the fallback drives the stream API for the same
 *    reason. A decoder that silently truncates is worse than no decoder.
 * 2. A file it cannot decode is *reported*, never skipped. A `catch { continue }`
 *    in the first draft of this investigation turned 209 readable sessions into
 *    "0 calls found" — the silent-degradation failure `docs/FIELD-NOTES.md`
 *    documents, reproduced inside the tool meant to detect it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const SESSION_FILE = "session.v4.jsonl.zstd";

/** Feedbacks that must never be swallowed. */
const warnings = [];

// ---------------------------------------------------------------- locating

/** Every `session.v4.jsonl.zstd` under the sessions root, newest first. */
function findSessionFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // An unreadable directory is a fact about the run, not a reason to pretend
      // it held nothing. Report it and keep going.
      warnings.push(`cannot read directory ${dir}: ${error.message}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === SESSION_FILE) found.push(full);
    }
  }
  return found
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
}

// ---------------------------------------------------------------- decoding

/**
 * Decode every zstd frame in the file.
 *
 * `zstd -dc` handles concatenated frames natively. The stream fallback exists
 * because `zstdDecompressSync` does not, and silently returning a prefix is the
 * failure this whole script is about.
 */
async function decode(file) {
  const cli = spawnSync("zstd", ["-dc", file], { maxBuffer: 1 << 30 });
  if (cli.error === undefined && cli.status === 0) return cli.stdout.toString("utf8");
  const why = cli.error === undefined ? `zstd exited ${cli.status}` : cli.error.message;

  const chunks = [];
  await new Promise((resolve, reject) => {
    const stream = zlib.createZstdDecompress();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
    fs.createReadStream(file).pipe(stream);
  }).catch((error) => {
    throw new Error(`cannot decode ${file}: ${why}; fallback also failed: ${error.message}`);
  });
  warnings.push(`decoded ${path.basename(path.dirname(file))} with the zlib fallback (${why})`);
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse JSONL without dropping a single unreadable line. */
function parseEvents(text, file) {
  const events = [];
  let unparsed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      unparsed++;
    }
  }
  if (unparsed > 0) warnings.push(`${file}: ${unparsed} line(s) failed to parse as JSON`);
  return { events, unparsed };
}

// ---------------------------------------------------------------- schema

/**
 * The schemas DSH actually sent the model, keyed by tool name.
 *
 * Reading them from the session rather than from a source tree is the point: a
 * call can only be judged against the schema that was really in front of the
 * model at the time.
 */
function schemasFrom(events) {
  const byTool = new Map();
  for (const event of events) {
    if (event.type !== "request/header") continue;
    const tools = event.data?.header?.tools;
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      const name = tool?.name ?? tool?.function?.name;
      const parameters = tool?.parameters ?? tool?.function?.parameters;
      if (typeof name === "string" && parameters !== undefined) byTool.set(name, parameters);
    }
  }
  return byTool;
}

/**
 * Walk a value against a JSON schema, collecting undeclared keys.
 *
 * Only the structural half of the schema is enforced here — `properties`,
 * `items`, `required` — because that is what catches a misspelled key. `oneOf`
 * and friends are ignored on purpose: this is a typo detector, not a validator.
 */
function audit(schema, value, at, problems) {
  if (schema === null || typeof schema !== "object") return;

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      value.forEach((item, index) => audit(schema.items, item, `${at}[${index}]`, problems));
    }
    return;
  }
  if (value === null || typeof value !== "object") return;

  const properties = schema.properties;
  if (properties === undefined) return;

  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) audit(properties[key], value[key], `${at}.${key}`, problems);
    else problems.unknown.push(`${at}.${key}`);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) problems.missing.push(`${at}.${key}`);
  }
  // A declared-but-absent optional key is only worth mentioning next to an
  // unknown one: that pairing is exactly what a renamed key looks like.
  if (problems.unknown.length > 0) {
    for (const key of Object.keys(properties)) {
      if (!Object.hasOwn(value, key)) problems.absent.push(`${at}.${key}`);
    }
  }
}

// ---------------------------------------------------------------- reading

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const SESSIONS_ROOT = path.join(HOME, "sessions");

if (!fs.existsSync(SESSIONS_ROOT)) {
  console.error(`no DSH sessions at ${SESSIONS_ROOT} (set DSH_HOME to override)`);
  process.exit(2);
}

const files = findSessionFiles(SESSIONS_ROOT);
if (files.length === 0) {
  console.error(`no ${SESSION_FILE} under ${SESSIONS_ROOT}`);
  process.exit(2);
}

/** Label a session by its directory name, which carries the id or the cwd slug. */
const labelOf = (file) => path.basename(path.dirname(file));

if (has("--list") || argv.length === 0) {
  for (const { file, mtime } of files.slice(0, Number(valueOf("--limit", "40")))) {
    const { events } = parseEvents(await decode(file), file);
    const calls = events.filter((event) => event.type === "tool/call").length;
    const bytes = fs.statSync(file).size;
    console.log(
      `${new Date(mtime).toISOString().slice(0, 19)}  ${String(calls).padStart(4)} calls  ` +
        `${String(bytes).padStart(9)} B  ${labelOf(file)}`,
    );
  }
  for (const warning of warnings) console.error(`warning: ${warning}`);
  process.exit(0);
}

const wanted = valueOf("--session", null);
const selected = wanted === null
  ? [files[0]]
  : files.filter(({ file }) => labelOf(file).startsWith(wanted));

if (selected.length === 0) {
  console.error(`no session matches ${JSON.stringify(wanted)}`);
  process.exit(2);
}

// ---------------------------------------------------------------- reporting

const toolFilter = valueOf("--tool", null);
const showRaw = has("--raw");
let invalidCalls = 0;

for (const { file } of selected) {
  const { events } = parseEvents(await decode(file), file);
  const schemas = schemasFrom(events);
  const calls = events.filter((event) => event.type === "tool/call");
  const shown = toolFilter === null
    ? calls
    : calls.filter((event) => event.data?.name === toolFilter);

  console.log(`\n### ${labelOf(file)} — ${calls.length} tool call(s), showing ${shown.length}`);
  if (schemas.size === 0) {
    warnings.push(`${labelOf(file)}: no request/header, so calls cannot be diffed against a schema`);
  }

  for (const [index, event] of shown.entries()) {
    const data = event.data ?? {};
    const raw = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(`${labelOf(file)}: call ${index + 1} (${data.name}) arguments are not JSON`);
      continue;
    }

    const schema = schemas.get(data.name);
    const problems = { unknown: [], missing: [], absent: [] };
    if (schema !== undefined) audit(schema, parsed, "", problems);

    const clean = problems.unknown.length === 0 && problems.missing.length === 0;
    if (!clean) invalidCalls++;
    const verdict = schema === undefined ? "no schema" : clean ? "ok" : "INVALID";

    console.log(`\n--- [${verdict}] ${data.name} (${raw.length} B) ---`);
    console.log(`keys: ${Object.keys(parsed).join(", ")}`);
    for (const key of problems.unknown.slice(0, 12)) console.log(`  UNDECLARED ${key}`);
    if (problems.unknown.length > 12) console.log(`  … ${problems.unknown.length - 12} more undeclared`);
    for (const key of problems.missing) console.log(`  MISSING    ${key}`);
    for (const key of problems.absent.slice(0, 12)) console.log(`  declared-but-absent ${key}`);
    if (showRaw) console.log(raw);
  }
}

for (const warning of warnings) console.error(`warning: ${warning}`);
if (invalidCalls > 0) {
  console.error(`\n${invalidCalls} call(s) carried keys their schema never declared`);
  process.exit(1);
}
