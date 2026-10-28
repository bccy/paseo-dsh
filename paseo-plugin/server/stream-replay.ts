/**
 * Turn DSH's per-message stream metadata into incremental timeline snapshots.
 *
 * DSH publishes a model step as one `assistant/message` event, but carries the
 * pacing of the text it produced in `data.stream`:
 *
 *   { type: "text-chunks", texts: string[], dt: number[] }
 *
 * The DSH client replays those chunks, so text appears as it is generated.
 * Paseo renders timeline snapshots, so without a replay the whole answer pops
 * in at once. This module derives the cumulative frames; the session decides
 * when to emit them.
 *
 * @module dsh-paseo/server/stream-replay
 */

export interface StreamFrame {
  /** Milliseconds after the first frame at which this frame becomes visible. */
  at: number;
  /** Cumulative text visible from this frame on. */
  text: string;
}

/** Frames closer together than this are merged; avoids timer storms. */
const MIN_FRAME_GAP_MS = 40;
/** Never stretch a finished step longer than this. */
const MAX_TOTAL_MS = 2500;
/** Below this the reveal would be imperceptible; show the text at once instead. */
const MIN_TOTAL_MS = 120;
/** The smallest message is not worth animating. */
const MIN_REPLAY_CHARS = 16;
/** Hard cap on scheduled frames. */
const MAX_FRAMES = 120;
/** Long answers re-render more markdown per frame, so they get fewer frames. */
function frameBudget(characters: number): number {
  if (characters > 12000) return 16;
  if (characters > 4000) return 40;
  return MAX_FRAMES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textOf(content: unknown[]): string {
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/**
 * Build the replay frames for one `assistant/message` payload.
 *
 * Returns undefined when the payload cannot be replayed faithfully — no stream
 * metadata, a single chunk, an empty message, or a message that also carries a
 * tool call (those are followed by tool events, and stretching the text would
 * show the tool card before the text that introduced it).
 */
export function buildStreamFrames(data: unknown): StreamFrame[] | undefined {
  if (!isRecord(data)) return undefined;
  const message = isRecord(data.message) ? data.message : undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => isRecord(block) && block.type === "tool-call")) return undefined;

  const fullText = textOf(content);
  if (fullText.length < MIN_REPLAY_CHARS) return undefined;

  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;

  const texts: string[] = [];
  const delays: number[] = [];
  for (const part of stream) {
    if (!isRecord(part) || part.type !== "text-chunks") continue;
    if (!Array.isArray(part.texts)) continue;
    const dt = Array.isArray(part.dt) ? part.dt : [];
    for (let index = 0; index < part.texts.length; index += 1) {
      texts.push(typeof part.texts[index] === "string" ? (part.texts[index] as string) : "");
      const gap = dt[index];
      delays.push(typeof gap === "number" && Number.isFinite(gap) && gap > 0 ? gap : 0);
    }
  }
  if (texts.length < 2) return undefined;

  const frames: StreamFrame[] = [];
  let at = 0;
  let text = "";
  let lastEmittedAt = -MIN_FRAME_GAP_MS;
  for (let index = 0; index < texts.length; index += 1) {
    at += delays[index] ?? 0;
    text += texts[index] ?? "";
    const isLast = index === texts.length - 1;
    if (!isLast && at - lastEmittedAt < MIN_FRAME_GAP_MS) continue;
    // An empty or repeated chunk changes nothing on screen.
    if (text === (frames[frames.length - 1]?.text ?? "")) continue;
    frames.push({ at, text });
    lastEmittedAt = at;
  }

  // Metadata and the folded message can disagree (truncated stream, dropped
  // chunk): the message content is authoritative, so the last frame is it.
  const last = frames[frames.length - 1];
  if (last === undefined) return undefined;
  last.text = fullText;
  // The final chunk can be empty, leaving a duplicate of the previous frame.
  if (frames.length >= 2 && frames[frames.length - 2]?.text === fullText) frames.pop();
  if (frames.length < 2) return undefined;

  const total = last.at;
  if (total < MIN_TOTAL_MS) return undefined;
  if (total > MAX_TOTAL_MS) {
    for (const frame of frames) frame.at = Math.round((frame.at * MAX_TOTAL_MS) / total);
  }

  const budget = frameBudget(fullText.length);
  if (frames.length > budget) {
    const stride = Math.ceil(frames.length / budget);
    const reduced: StreamFrame[] = [];
    for (let index = 0; index < frames.length; index += stride) reduced.push(frames[index] as StreamFrame);
    const lastFrame = frames[frames.length - 1] as StreamFrame;
    if (reduced[reduced.length - 1] !== lastFrame) reduced.push(lastFrame);
    return reduced;
  }
  return frames;
}
