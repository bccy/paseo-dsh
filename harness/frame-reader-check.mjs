/**
 * Offline check for the bridge's stdout frame splitter.
 *
 * `paseo-plugin/server/frame-reader.ts` is the entry point for every frame a
 * shared `dsh` child emits, and the reason it exists is a performance bug whose
 * failure mode is invisible in normal use: the previous reader re-`split` the
 * whole accumulated buffer on every stdout chunk, which is O(n²) in the length
 * of one response. Replaying a big conversation makes the bridge emit a single
 * ~39 MB `paseo/history` frame in ~2400 chunks, so that reader burned whole
 * seconds just reading — the reported "rewind takes 7–12 s".
 *
 * A rewrite of this code is dangerous in a way that a rewrite of most code is
 * not: the bugs live at chunk boundaries, which are chosen by the kernel and
 * therefore cannot be constructed reliably on a live system. So the splitter was
 * extracted into a pure module and this script drives it directly, with chunk
 * boundaries at every position that matters and with a randomized comparison
 * against a reference implementation of the **old** reader.
 *
 * What is pinned:
 *   1. a 20 MB frame spread over thousands of 16 KB chunks comes back byte-exact
 *   2. several complete frames inside one chunk all arrive, in order
 *   3. a frame cut in the middle by a chunk boundary is reassembled
 *   4. blank lines (`\n\n`) are skipped, and *skipped*, not reported as parse
 *      errors — the two outcomes are different log lines in `#consume`
 *   5. `\r\n` terminators: the line parses (measured, `JSON.parse` accepts a
 *      trailing `\r`) and the text handed on keeps the `\r`, exactly as before
 *   6. a trailing partial line stays pending and emits nothing
 *   7. a chunk that ends exactly on a newline leaves nothing pending
 *   8. a malformed line is reported and the lines after it still arrive
 *  10. randomized chunkings produce exactly the old reader's output (equality,
 *      not "close enough"), including multi-byte text split anywhere
 *  11. the incremental scan is not quadratic: same 20 MB input, same 16 KB
 *      chunks, measured against the old algorithm
 *  12. an unterminated frame is bounded: past the limit it is discarded whole,
 *      reported exactly once, and parsing resumes at the next newline
 *
 * Pure module: no `dsh`, no profile, no daemon, no bridge. It compiles just
 * `server/frame-reader.ts` (which imports nothing) to CommonJS in a scratch
 * directory under the plugin and deletes it on exit.
 *
 * Usage:
 *   node harness/frame-reader-check.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname);
const pluginDir = resolve(here, '..', 'paseo-plugin');

let passed = 0;
let failed = 0;
function check(name, pass, detail) {
  if (pass) {
    passed += 1;
    console.log(`  PASS  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
  }
}

/**
 * Compile `frame-reader.ts` alone and require the result.
 *
 * Compiled rather than transcribed: a handwritten copy of the module in this
 * script would keep passing after someone edited the real one, which is the one
 * failure mode that matters here. The scratch directory must sit inside
 * `paseo-plugin/` so `tsc` resolves `types: ["node"]` from its `node_modules`.
 */
function loadFrameReader() {
  const outDir = mkdtempSync(join(pluginDir, '.dbg-frame-reader-'));
  const tsc = join(pluginDir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error(`typescript missing at ${tsc}; run npm install in paseo-plugin`);
    process.exit(2);
  }
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      join('server', 'frame-reader.ts'),
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--lib', 'ES2023',
      '--types', 'node',
      '--strict',
      '--declaration', 'false',
    ],
    { cwd: pluginDir, encoding: 'utf8' },
  );
  const emitted = join(outDir, 'frame-reader.js');
  if (!existsSync(emitted)) {
    console.error(`frame-reader.ts did not compile:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.exit(2);
  }
  // The scratch dir is CommonJS even though the plugin package is not.
  writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}\n');
  const mod = require(emitted);
  return { mod, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
}

const { mod: frames, cleanup } = loadFrameReader();
process.on('exit', cleanup);
const { createFrameReader, parseFrame, splitFrames } = frames;

/**
 * Reference implementation: the **old** reader, verbatim in shape.
 *
 * Kept as the oracle for the equivalence checks. It is the algorithm being
 * replaced, so it must not be "fixed" here — it is what production did until
 * this change, and any input that behaves differently is a regression.
 */
function oldReader() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return lines;
    },
    // The old reader's retained tail, exposed so the equivalence check can
    // compare it: a difference here is invisible until the *next* chunk, so
    // comparing only the emitted lines would let a boundary bug through.
    get pending() {
      return buffer;
    },
  };
}

/**
 * Drive a reader through `chunks` and collect what `#consume` would do with it.
 *
 * Mirrors `DshProcess#consume`'s rules through the exported `splitFrames`: blank
 * lines are its own outcome, malformed lines another, frames another. Returned as
 * three arrays so a test can assert *which* bucket a line went to, not just that
 * nothing threw.
 */
function drive(reader, chunks) {
  const parsed = [];
  const malformed = [];
  const blank = [];
  for (const chunk of chunks) {
    splitFrames(reader, chunk, {
      onFrame: (frame) => parsed.push(frame),
      onMalformed: (line) => malformed.push(line),
      onBlank: (line) => blank.push(line),
    });
  }
  return { parsed, malformed, blank };
}

/** Split `text` into fixed-size chunks, the way a pipe delivers it. */
function chunked(text, size) {
  const chunks = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

console.log('frame-reader: incremental NDJSON splitting\n');

// --- 1. one very large frame, thousands of chunks ---------------------------
{
  // ~20 MB, deliberately not a multiple of the chunk size so the last chunk is
  // a partial one. The payload is filler because what is being tested is byte
  // accounting, not JSON: a 20 MB object would cost more to build than to check.
  const filler = 'x'.repeat(20 * 1024 * 1024);
  const line = `{"id":1,"method":"paseo/history","params":{"blob":"${filler}"}}`;
  const chunks = chunked(`${line}\n`, 16 * 1024);
  const reader = createFrameReader();
  const started = process.hrtime.bigint();
  const { parsed, malformed, blank } = drive(reader, chunks);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  check(
    '20 MB frame across 16 KB chunks is reassembled exactly once',
    parsed.length === 1 && malformed.length === 0 && blank.length === 0,
    `${chunks.length} chunks -> ${parsed.length} frame(s), ${elapsedMs.toFixed(1)} ms`,
  );
  check(
    '20 MB frame payload is byte-exact',
    parsed[0]?.params?.blob?.length === filler.length && parsed[0]?.params?.blob === filler,
    `blob length ${parsed[0]?.params?.blob?.length ?? 'n/a'}`,
  );
  check('20 MB frame leaves nothing pending', reader.pending === '', JSON.stringify(reader.pending.slice(0, 20)));
  check('reader counted exactly one line', reader.lines === 1, String(reader.lines));
}

// --- 2. several complete frames in one chunk -------------------------------
{
  const reader = createFrameReader();
  const { parsed, blank } = drive(reader, ['{"a":1}\n{"a":2}\n{"a":3}\n']);
  check(
    'three frames in one chunk all arrive in order',
    parsed.length === 3 && parsed.map((f) => f.a).join(',') === '1,2,3',
    JSON.stringify(parsed),
  );
  check('nothing is pending after complete frames', reader.pending === '' && blank.length === 0);
}

// --- 3. a frame cut by a chunk boundary ------------------------------------
{
  const reader = createFrameReader();
  const { parsed, malformed } = drive(reader, ['{"hel', 'lo":"wor', 'ld"}\n']);
  check(
    'a frame split across three chunks is reassembled',
    parsed.length === 1 && parsed[0].hello === 'world' && malformed.length === 0,
    JSON.stringify(parsed),
  );
  // A boundary exactly between the frame text and its newline is its own case:
  // the line is complete but has no terminator yet, so it must still wait.
  const reader2 = createFrameReader();
  const first = drive(reader2, ['{"a":1}']);
  check(
    'a complete line without its newline yet is not emitted early',
    first.parsed.length === 0 && reader2.pending === '{"a":1}',
    `pending ${JSON.stringify(reader2.pending)}`,
  );
  const second = drive(reader2, ['\n']);
  check(
    'the held line is emitted when the newline arrives',
    second.parsed.length === 1 && second.parsed[0].a === 1 && reader2.pending === '',
    JSON.stringify(second.parsed),
  );
}

// --- 4. blank lines are skipped, not reported ----------------------------
{
  const reader = createFrameReader();
  const { parsed, malformed, blank } = drive(reader, ['{"a":1}\n\n{"a":2}\n']);
  check(
    'a blank line between frames is skipped',
    parsed.length === 2 && malformed.length === 0 && blank.length === 1,
    `parsed ${parsed.length}, blank ${blank.length}, malformed ${malformed.length}`,
  );
  // Whitespace-only must take the same path: the old rule was `trim() === ""`,
  // and `#consume` keeps it verbatim, so a line of spaces is blank, not bad JSON.
  const reader2 = createFrameReader();
  const second = drive(reader2, ['   \n\t\n{"a":3}\n']);
  check(
    'whitespace-only lines are skipped as blank, not reported as malformed',
    second.parsed.length === 1 && second.malformed.length === 0 && second.blank.length === 2,
    `blank ${second.blank.length}, malformed ${second.malformed.length}`,
  );
}

// --- 5. CRLF terminators --------------------------------------------------
{
  // Measured, not assumed: JSON.parse tolerates trailing whitespace, and `\r` is
  // whitespace, so `{"a":1}\r` parses. The old reader kept the `\r` (it split on
  // `\n` only) and the new one must too, so the parse result is identical either
  // way — the check exists so that a future "helpful" strip is caught.
  check('JSON.parse accepts a trailing carriage return', JSON.parse('{"a":1}\r').a === 1);
  const reader = createFrameReader();
  const { parsed, malformed, blank } = drive(reader, ['{"a":1}\r\n{"a":2}\r\n']);
  check(
    'CRLF-terminated frames parse',
    parsed.length === 2 && malformed.length === 0 && blank.length === 0,
    `parsed ${parsed.length}, malformed ${malformed.length}`,
  );
  // And the `\r` is still in the text handed on: `pending` shows it for a line
  // that has not terminated yet, which is the same code path a malformed-line
  // log would take.
  const reader2 = createFrameReader();
  reader2.push('{"a":1}\r');
  check('the carriage return is not stripped from the retained text', reader2.pending === '{"a":1}\r', JSON.stringify(reader2.pending));
  check(
    'a blank CRLF line is skipped (trim covers \\r\\n)',
    (() => {
      const r = createFrameReader();
      const out = drive(r, ['\r\n', '{"a":9}\n']);
      return out.parsed.length === 1 && out.blank.length === 1 && out.malformed.length === 0;
    })(),
  );
}

// --- 6/7. trailing partial line, and a chunk ending exactly on a newline ---
{
  const reader = createFrameReader();
  const out = drive(reader, ['{"a":1}\n{"partial":']);
  check(
    'a trailing partial line emits nothing and stays pending',
    out.parsed.length === 1 && out.malformed.length === 0 && reader.pending === '{"partial":',
    `pending ${JSON.stringify(reader.pending)}`,
  );
  const exact = createFrameReader();
  const done = drive(exact, ['{"a":1}\n']);
  check(
    'a chunk ending exactly on a newline leaves nothing pending',
    done.parsed.length === 1 && exact.pending === '',
    `pending ${JSON.stringify(exact.pending)}`,
  );
  // An empty chunk must be a no-op — `data` never fires empty, but a caller that
  // flushes on exit would pass one, and it must not invent a line.
  const empty = createFrameReader();
  const none = drive(empty, ['']);
  check('an empty chunk yields nothing', none.parsed.length === 0 && none.malformed.length === 0 && empty.pending === '');
}

// --- 8. a malformed line does not cost the lines behind it ----------------
{
  const reader = createFrameReader();
  const out = drive(reader, ['{"a":1}\nthis is not json\n{"a":2}\n']);
  check(
    'a malformed line is reported and the frames after it still arrive',
    out.parsed.length === 2 && out.malformed.length === 1 && out.malformed[0] === 'this is not json',
    `parsed ${out.parsed.length}, malformed ${JSON.stringify(out.malformed)}`,
  );
  check('parseFrame returns undefined for garbage and the object for JSON', parseFrame('nope') === undefined && parseFrame('{"a":1}')?.a === 1);
  // Partial JSON at a chunk boundary must NOT be reported: it is only malformed
  // if the newline arrives and it still does not parse.
  const late = createFrameReader();
  const split = drive(late, ['{"a":', '1}\n']);
  check(
    'JSON split across a boundary is not reported as malformed',
    split.parsed.length === 1 && split.malformed.length === 0,
    `malformed ${JSON.stringify(split.malformed)}`,
  );
}

// --- 9. multi-byte text ---------------------------------------------------
{
  // `setEncoding("utf8")` hands over decoded strings, so a multi-byte character
  // is never split by this code — but the *string* indices still have to be
  // right, and a frame reassembled from pieces must not lose a surrogate pair.
  const text = '{"text":"撤回很慢：夵𠀋"}\n{"text":"第二行"}\n';
  const reader = createFrameReader();
  const out = drive(reader, chunked(text, 3));
  check(
    'multi-byte frames survive 3-character chunking',
    out.parsed.length === 2 && out.parsed[0].text === '撤回很慢：夵𠀋' && out.parsed[1].text === '第二行',
    JSON.stringify(out.parsed),
  );
}

// --- 10. equivalence with the old algorithm under random chunkings ---------
{
  let mismatches = 0;
  let compared = 0;
  let seed = 0x5eed;
  const rand = () => {
    // xorshift32, deterministic: a failing run is reproducible.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  for (let round = 0; round < 200; round += 1) {
    const lines = [];
    const lineCount = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < lineCount; i += 1) {
      const kind = rand();
      if (kind < 0.15) lines.push(''); // blank
      else if (kind < 0.25) lines.push('   '); // whitespace-only
      else if (kind < 0.35) lines.push('{oops'); // malformed
      else if (kind < 0.45) lines.push(`{"i":${String(i)}}`); // ordinary
      else lines.push(`{"i":${String(i)},"pad":"${'p'.repeat(Math.floor(rand() * 400))}"}`); // big enough to span chunks
    }
    const eol = rand() < 0.25 ? '\r\n' : '\n';
    // Half the rounds end with a trailing newline, half with a dangling partial
    // line, because the old reader's `pop()` behavior differs between them.
    const tail = rand() < 0.5 ? '' : '{"dangling":';
    const input = lines.map((line) => line + eol).join('') + tail;
    const cuts = [];
    let at = 0;
    while (at < input.length) {
      const size = 1 + Math.floor(rand() * 64);
      cuts.push(input.slice(at, at + size));
      at += size;
    }
    const oldOut = [];
    const old = oldReader();
    for (const chunk of cuts) oldOut.push(...old.push(chunk));
    const fresh = createFrameReader();
    const newOut = [];
    for (const chunk of cuts) newOut.push(...fresh.push(chunk));
    compared += 1;
    if (oldOut.length !== newOut.length || oldOut.some((line, i) => line !== newOut[i])) {
      mismatches += 1;
      if (mismatches === 1) {
        console.log(`    first mismatch on round ${round}: ${JSON.stringify({ oldOut, newOut, cuts })}`);
      }
    }
    // The retained tail must agree too: it is what the next chunk is prepended
    // to, so a difference here would only show up one frame later.
    if (fresh.pending !== old.pending) {
      mismatches += 1;
      if (mismatches === 1) console.log(`    pending mismatch on round ${round}`);
    }
  }
  check(
    `random chunkings match the old reader exactly (${compared} rounds, 1-64 char chunks)`,
    mismatches === 0,
    `${mismatches} mismatch(es)`,
  );
}

// --- 11. the incremental scan is not quadratic ----------------------------
{
  // Same input, same chunk size, both algorithms. The point is not the exact
  // ratio (it depends on the machine) but that it is large and in the right
  // direction: the old algorithm rescans everything per chunk, so ~20 MB in
  // 1280 chunks is ~24 GB of scanning and lands in the tens of seconds.
  const filler = 'y'.repeat(20 * 1024 * 1024);
  const input = `{"blob":"${filler}"}\n`;
  const chunks = chunked(input, 16 * 1024);

  const runOld = () => {
    const reader = oldReader();
    for (const chunk of chunks) reader.push(chunk);
  };
  const runNew = () => {
    const reader = createFrameReader();
    for (const chunk of chunks) reader.push(chunk);
  };

  // Warm up both so the comparison is not measuring JIT compilation.
  runNew();
  const tOld = process.hrtime.bigint();
  runOld();
  const oldMs = Number(process.hrtime.bigint() - tOld) / 1e6;
  const tNew = process.hrtime.bigint();
  runNew();
  const newMs = Number(process.hrtime.bigint() - tNew) / 1e6;
  const ratio = oldMs / Math.max(newMs, 0.001);
  check(
    'the incremental scan beats the old split by a wide margin',
    ratio >= 5,
    `old ${oldMs.toFixed(0)} ms vs new ${newMs.toFixed(0)} ms on 20 MB / ${chunks.length} chunks (${ratio.toFixed(0)}x)`,
  );
  check(
    'the incremental scan stays under a second for 20 MB',
    newMs < 1000,
    `${newMs.toFixed(0)} ms`,
  );
}

// --- 12. an unterminated frame is bounded --------------------------------
{
  // A frame that never ends must not grow the retained buffer forever: the
  // bridge writes one line per frame, so a line that never terminates is either
  // malformed output or a child that was killed mid-write. Both leave `parts`
  // accumulating, and `pending` re-joins it on every read.
  //
  // The limit is a constructor parameter so this check can use a small one
  // instead of allocating 256 MB. What is asserted is the whole contract of the
  // overflow path: one report (not one per chunk), the buffer is gone, and the
  // *next* line still parses — the frames behind a bad line must not be lost.
  const reports = [];
  const limited = createFrameReader({
    maxPendingBytes: 1024,
    onOverflow: (info) => reports.push(info),
  });
  const chunk = "z".repeat(300);
  let seenBefore = 0;
  for (let i = 0; i < 10; i += 1) {
    seenBefore += limited.push(chunk).length;
  }
  check(
    'an unterminated frame past the limit is reported exactly once',
    reports.length === 1,
    `${reports.length} report(s)`,
  );
  check(
    '…the overflow report says how much was discarded and under which limit',
    typeof reports[0]?.dropped === 'number' && reports[0].dropped >= 1024 && reports[0]?.limit === 1024,
    JSON.stringify(reports[0] ?? null),
  );
  check(
    '…and the pending buffer is cleared instead of growing',
    limited.pending === '',
    `${limited.pending.length} byte(s) still pending`,
  );
  check('no line was emitted for the discarded frame', seenBefore === 0, `${seenBefore} line(s)`);
  // The rest of the stream must still be readable: the reader discards the
  // overflowing frame *up to its terminator*, and resumes at the newline. So the
  // tail of the bad frame emits nothing and the next complete line arrives —
  // asserted on the emitted lines themselves, because "it parsed" would also be
  // true for an implementation that glued the tail onto the next frame.
  const after = [];
  after.push(...limited.push("tail-of-the-bad-line\n"));
  after.push(...limited.push('{"ok":1}\n'));
  check(
    'parsing resumes at the newline after the discarded frame',
    after.length === 1 && after[0] === '{"ok":1}',
    `${after.length} line(s): ${JSON.stringify(after.map((line) => line.slice(0, 24)))}`,
  );
  check(
    'the discarded frame is not reported a second time',
    reports.length === 1,
    `${reports.length} report(s)`,
  );

  // The default limit must exist and be far above any real frame: the biggest
  // one this bridge produces is a ~39 MB `paseo/history` replay (see the module
  // comment), so 256 MB is ~6x headroom. Pinned as a value because a missing
  // default is the same bug as no limit at all, and a small default would start
  // dropping real replays.
  const unbounded = createFrameReader();
  check(
    'the default limit is the documented 256 MiB',
    unbounded.maxPendingBytes === 256 * 1024 * 1024,
    String(unbounded.maxPendingBytes),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
