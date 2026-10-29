/**
 * First-token time of one durable assistant stream, read the way DSH reads it.
 *
 * `assistant/message` carries its own compact, timed chunk list (`data.stream`),
 * so both ends of the decode window — the first token and the settled message —
 * arrive in a single event. This module exists because the plugin has no runtime
 * dependencies (its only package.json entry is a peer on `@getpaseo/plugin`), so
 * it cannot import `assistantStreamFirstTokenTime` from `@deepseek-ai/dsh-llm`
 * the way the bridge can. The logic below is a **verbatim port** of DSH's own
 * reader, so the number this plugin shows is the number DSH's own
 * `dsh-session-stats` computes:
 *
 *   - `isTokenDelta`      — text and reasoning count when non-empty; a tool-call
 *                           delta counts when it carries arguments or a name
 *   - `runFirstTokenTime` — a name-bearing tool-call run starts at `time0`,
 *                           otherwise at the first non-empty fragment
 *   - `firstRunMemberTime`— reconstructs each fragment's time from `time0` + `dt`
 *
 * Ported from `@deepseek-ai/dsh-llm` (`lib/index.js` `assistantStreamFirstTokenTime`
 * and friends). Keep in sync with that file: if DSH changes what counts as a
 * token, the rate would silently drift from the host's own readout.
 *
 * @module dsh-paseo/server/first-token
 */

/** One packed delta run inside a compact stream record. */
interface PackedRun {
  type: string;
  time0: number;
  dt: number[];
  texts?: string[];
  args?: string[];
  name?: unknown;
}

/** One record of a compact assistant stream. */
type StreamRecord =
  | { type: "chunk"; time: number; chunk: Record<string, unknown> }
  | (PackedRun & Record<string, unknown>);

/** Whether one raw chunk is a token delta, per DSH's `isTokenDelta`. */
function isTokenDelta(chunk: Record<string, unknown>): boolean {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta":
      return chunk.text !== "";
    case "tool-call-delta":
      return chunk.argumentsDelta !== "" || chunk.name !== undefined;
    default:
      return false;
  }
}

/** Time of the first member of one packed run that `predicate` accepts. */
function firstRunMemberTime(run: PackedRun, predicate: (fragment: string) => boolean): number | undefined {
  const fragments = run.type === "tool-call-chunks" ? (run.args ?? []) : (run.texts ?? []);
  let time = run.time0;
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) time += run.dt[index - 1] ?? 0;
    if (predicate(fragments[index])) return time;
  }
  return undefined;
}

/** Time of the first member of one packed run, per DSH's `runFirstTokenTime`. */
function runFirstTokenTime(run: PackedRun): number | undefined {
  if (run.type === "tool-call-chunks" && run.name !== undefined) return run.time0;
  return firstRunMemberTime(run, (fragment) => fragment !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackedRun(record: Record<string, unknown>): record is PackedRun & Record<string, unknown> {
  return typeof record.type === "string" && typeof record.time0 === "number" && Array.isArray(record.dt);
}

/**
 * Time of the first token in one compact stream, per DSH's
 * `assistantStreamFirstTokenTime`.
 *
 * @param stream - `assistant/message`'s `data.stream` (compact records from one
 *   durable settlement).
 * @returns the first token's time, or undefined when the stream carries no token
 *   (or is absent/malformed — never a fabricated time).
 */
export function assistantStreamFirstTokenTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined;
  for (const candidate of stream) {
    if (!isRecord(candidate)) continue;
    if (candidate.type === "chunk") {
      if (typeof candidate.time !== "number") continue;
      if (isRecord(candidate.chunk) && isTokenDelta(candidate.chunk)) return candidate.time;
      continue;
    }
    if (!isPackedRun(candidate)) continue;
    const time = runFirstTokenTime(candidate);
    if (time !== undefined) return time;
  }
  return undefined;
}
