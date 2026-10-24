/**
 * Split the bridge's stdout into newline-delimited JSON frames, incrementally.
 *
 * The bridge speaks NDJSON: one JSON object per line, written to a pipe. Node
 * hands that pipe over in arbitrary chunks (16 KB and 64 KB are the sizes that
 * show up in practice), so a frame routinely arrives split across two or three
 * `data` events — and a big one is split across thousands.
 *
 * This module exists because the obvious reader is quadratic and the sessions
 * that pay for it are the biggest ones. It used to keep the accumulated text in
 * a field and re-`split("\n")` all of it on every chunk:
 *
 * ```ts
 * this.#buffer += chunk;
 * const lines = this.#buffer.split("\n");     // scans the WHOLE buffer
 * this.#buffer = lines.pop() ?? "";
 * ```
 *
 * Replaying a large conversation makes the bridge emit one `paseo/history` frame
 * of ~39 MB in ~2400 chunks, so that reader scanned ~47 GB to produce a single
 * line: measured at 56 s of pure read versus 294 ms for this one (same response,
 * same chunking).
 *
 * The fix is to never look at a byte twice. Two mechanics, and both are needed:
 *
 * 1. **Scan only the new chunk.** By invariant (below) the retained partial line
 *    contains no `\n`, so `indexOf` from the new chunk's first byte is sufficient.
 * 2. **Keep the partial line as an array of the chunks it arrived in**, not as a
 *    growing string. `buffer += chunk` plus `indexOf` on the result looks linear
 *    but is not: `+=` builds a V8 rope, and every `indexOf` begins with
 *    `String::Flatten`, which copies the whole rope back into a flat string. For
 *    one 39 MB frame that is another O(n²) with a smaller constant. An array is
 *    joined exactly once, when the frame completes.
 *
 * Behavior is otherwise identical to the previous reader, and these details are
 * load-bearing: this is the frame entry point for a process every session shares.
 *
 * - **Blank lines are skipped**, decided by the *caller* (see {@link splitFrames}
 *   and `DshProcess#consume`): they are returned like any other line so the
 *   caller can `trim()` them, because a blank line must not be reported as a
 *   parse failure. `trim()` also covers `\r\n`, matching the old reader.
 * - **A `\r` before the `\n` is kept.** Measured, not assumed: `JSON.parse`
 *   accepts trailing `\r` (and `\t`, and spaces), so a CRLF terminator parses
 *   fine, and stripping one would change the text logged for a malformed line.
 * - **A trailing line without a newline stays pending forever.** Exactly as
 *   before — the old reader's final `lines.pop()` never reached `#dispatch`
 *   either, and flushing on exit would be a new behavior, not a preserved one.
 * - **An unparsable line is handed back**, never swallowed: one malformed line
 *   must not cost the frames behind it.
 *
 * @module dsh-paseo/server/frame-reader
 */

/**
 * The frame splitter: one instance per stream.
 *
 * Not reentrant. `push` is synchronous and meant to run from a single `data`
 * listener, which is how the child's stdout is wired.
 */
export interface FrameReader {
  /**
   * Add one chunk and return every line it completed.
   *
   * Returned lines are complete — the `\n` is stripped — and may include blank
   * ones; filtering belongs to the caller because blank and unparsable are
   * different outcomes. An empty array means the chunk only extended a partial
   * line.
   *
   * @param chunk - a UTF-8-decoded chunk (`setEncoding("utf8")` is already set on
   *   the stream), so a multibyte character split across chunks has been rejoined
   *   upstream and this is plain string work.
   */
  push(chunk: string): string[];

  /**
   * Bytes received after the last newline: a frame still in flight.
   *
   * For diagnostics only. Nothing in production reads it — flushing it on child
   * exit would change behavior (the old reader dropped it too).
   */
  readonly pending: string;

  /** Complete lines returned so far. Used by the timing probes and log lines. */
  readonly lines: number;
}

/** The minimum shape of one frame. */
type Frame = Record<string, unknown>;

/**
 * Create an incremental newline tracker for one stream.
 */
export function createFrameReader(): FrameReader {
  /**
   * The chunks of the one line currently being received, in order.
   *
   * Invariant: their concatenation contains no `\n`, so a new chunk is the only
   * place a terminator can be hiding. Joined once, when that line completes.
   */
  const parts: string[] = [];
  let lineCount = 0;

  return {
    push(chunk: string): string[] {
      const lines: string[] = [];
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline === -1) break;
        const piece = chunk.slice(start, newline);
        if (parts.length === 0) {
          // The common case: the whole frame was inside this one chunk.
          lines.push(piece);
        } else {
          parts.push(piece);
          lines.push(parts.join(""));
          parts.length = 0;
        }
        lineCount += 1;
        start = newline + 1;
      }
      // Whatever follows the last newline is the start of the next frame. Note
      // the deliberate absence of a trailing-`\r` strip: see the module comment.
      if (start < chunk.length) parts.push(chunk.slice(start));
      return lines;
    },
    get pending(): string {
      return parts.length === 1 ? (parts[0] ?? "") : parts.join("");
    },
    get lines(): number {
      return lineCount;
    },
  };
}

/**
 * Parse one non-blank line, distinguishing "not JSON" from "JSON".
 *
 * Returns `undefined` when the text is not JSON, which the caller turns into a
 * log line. Kept here so the offline check can pin the two things that matter:
 * an unparsable line is *reported*, and the lines after it still arrive.
 *
 * @param line - one complete line, terminator already removed.
 */
export function parseFrame(line: string): Frame | undefined {
  try {
    // The old reader cast blindly and `#dispatch` type-checks every field it
    // reads, so a non-object frame simply routes nowhere. Validating the shape
    // here would not preserve behavior, it would add a rejection path.
    return JSON.parse(line) as Frame;
  } catch {
    return undefined;
  }
}

/**
 * Feed one chunk through {@link createFrameReader} and dispatch what it yields.
 *
 * The composition `DshProcess#consume` uses, extracted so the *whole* entry path
 * can be exercised offline (including the blank-line and parse-failure rules,
 * which live on this side of the reader) without a child process:
 *
 * ```ts
 * reader.push(chunk) -> lines -> trim() -> skip blanks
 *                                  -> parseFrame() ?? onLog(line)
 * ```
 *
 * @param reader - the stream's reader, reused across calls.
 * @param chunk - one decoded stdout chunk.
 * @param onBlank - called for a blank line; the caller usually does nothing.
 *   Present so "blank lines are skipped, not logged as failures" is observable.
 * @param onFrame - called with each parsed frame, in order.
 * @param onMalformed - called with the raw text of a line that was not JSON.
 */
export function splitFrames(
  reader: FrameReader,
  chunk: string,
  handlers: {
    onFrame(frame: Frame): void;
    onMalformed(line: string): void;
    onBlank?(line: string): void;
  },
): void {
  for (const line of reader.push(chunk)) {
    if (line.trim() === "") {
      handlers.onBlank?.(line);
      continue;
    }
    const frame = parseFrame(line);
    if (frame === undefined) {
      handlers.onMalformed(line);
      continue;
    }
    handlers.onFrame(frame);
  }
}
