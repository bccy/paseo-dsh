/**
 * Offline check for the bridge's inbound frame splitter.
 *
 * `dsh-bridge/lib/transport.js` `#onData` is the entry point for every frame
 * Paseo sends into the one bridge process that serves **all** sessions, and the
 * bug this file exists for is invisible in ordinary use: the previous reader
 * re-`split("\n")` the whole accumulated buffer on every stdin chunk, so a frame
 * that arrived in thousands of 16 KB pieces scanned its own length thousands of
 * times. A phone photo in a prompt is ~13 MiB of base64 in one frame, measured
 * at 2223 ms of blocked event loop — during which every other session's events
 * and stdin reads are stalled too. The plugin's side of the same pipe had the
 * same defect and the same fix (`paseo-plugin/server/frame-reader.ts`, 56 s ->
 * 294 ms on a 39 MB frame).
 *
 * A rewrite here is dangerous in a way a rewrite of most code is not: the bugs
 * live at chunk boundaries, which the kernel chooses and no test can construct
 * on a live system. So this script drives the real transport with fake streams,
 * puts chunk boundaries at every position that matters, and compares the result
 * against the **old** algorithm as an oracle — equality, not "close enough".
 *
 * What is pinned:
 *   1. a 20 MiB frame spread over thousands of 16 KB chunks is reassembled
 *      byte-exact and delivered once
 *   2. several complete frames inside one chunk all arrive, in order
 *   3. a frame cut in the middle by a chunk boundary is reassembled, and a
 *      complete line that has not seen its newline yet is *not* emitted early
 *   4. blank lines (`\n\n`, whitespace-only) are skipped and are not reported as
 *      parse failures — the two are different outcomes
 *   5. `\r\n` terminators parse, and the `\r` is still part of the retained text
 *      (proved by joining a following chunk onto it: a stripped `\r` changes the
 *      malformed line that gets logged)
 *   6. a trailing partial line emits nothing and is still pending
 *   7. a malformed line is reported on stderr and the lines after it still
 *      arrive
 *   8. randomized chunkings produce exactly the old algorithm's outcomes
 *   9. the incremental scan is not quadratic: same 20 MiB input, same 16 KB
 *      chunks, measured against the old algorithm
 *
 * Pure module: no `dsh`, no profile, no daemon, no child process. `transport.js`
 * imports nothing but `node:string_decoder`, so it is required as-is rather than
 * transcribed — a copy in this file would keep passing after the real one was
 * edited.
 *
 * Usage: node harness/transport-frame-check.mjs
 */
import { EventEmitter } from 'node:events';
import { PaseoTransport } from '../dsh-bridge/lib/transport.js';

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

/** An output stream that accepts frames and never blocks. */
const fakeOutput = () => ({
  write(_chunk, callback) {
    if (typeof callback === 'function') callback();
    return true;
  },
});

/**
 * Drive one transport over `chunks` and collect what it dispatched, in order.
 *
 * The transport's only observable output for an inbound frame is either a
 * server-bound request (a frame with a method and an id) or the stderr line for
 * a line that would not parse; both are recorded here so a test can assert
 * *which* bucket a line landed in, not just that nothing threw.
 */
function drive(chunks) {
  const input = new EventEmitter();
  // The transport calls `setEncoding` only when the caller wired a stream; here
  // chunks are handed over as strings directly, exactly like a decoded stream.
  input.setEncoding = () => {};
  const requests = [];
  const stderr = [];
  const transport = new PaseoTransport(input, fakeOutput());
  transport.onRequest((method, params) => {
    requests.push({ method, params });
    return { ok: true };
  });
  transport.start();
  const originalWrite = process.stderr.write;
  process.stderr.write = (text) => {
    stderr.push(String(text));
    return true;
  };
  try {
    for (const chunk of chunks) input.emit('data', chunk);
  } finally {
    process.stderr.write = originalWrite;
    transport.close();
  }
  return { requests, stderr };
}

/**
 * Reference implementation: the **old** reader, verbatim in shape.
 *
 * Kept as the oracle for the equivalence checks. It is the algorithm being
 * replaced, so it must not be "fixed" here — it is what production did before
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
    get pending() {
      return buffer;
    },
  };
}

/**
 * Turn the old reader's raw lines into the same observable outcomes `drive`
 * records: parsed frames (a method+id line) and malformed lines.
 *
 * Blank handling is the caller's, so it is reproduced here rather than in the
 * oracle: `#dispatchLine` trims and skips an empty result.
 */
function oldOutcomes(chunks) {
  const reader = oldReader();
  const requests = [];
  const stderr = [];
  for (const chunk of chunks) {
    for (const line of reader.push(chunk)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        stderr.push(trimmed);
        continue;
      }
      if (typeof frame?.method === 'string' && frame.id !== undefined && frame.id !== null) {
        // The transport hands its handler `frame.params ?? {}`, so the oracle
        // records the same normalized value.
        requests.push({ method: frame.method, params: frame.params ?? {} });
      }
    }
  }
  return { requests, stderr };
}

/** Split `text` into fixed-size chunks, the way a pipe delivers it. */
function chunked(text, size) {
  const chunks = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

console.log('transport: incremental NDJSON splitting\n');

// --- 1. one very large frame, thousands of chunks --------------------------
{
  // ~20 MB of base64 filler inside the frame, deliberately not a multiple of the
  // chunk size so the last chunk is a partial one.
  const filler = 'A'.repeat(20 * 1024 * 1024);
  const frame = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/prompt',
    params: { sessionId: 's', contentBlocks: [{ type: 'image', mimeType: 'image/png', data: filler }] },
  });
  const chunks = chunked(`${frame}\n`, 16 * 1024);
  const started = process.hrtime.bigint();
  const { requests, stderr } = drive(chunks);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  check(
    '20 MiB frame across 16 KB chunks is delivered exactly once',
    requests.length === 1 && stderr.length === 0,
    `${chunks.length} chunks -> ${requests.length} request(s), ${elapsedMs.toFixed(0)} ms`,
  );
  const data = requests[0]?.params?.contentBlocks?.[0]?.data;
  check(
    '20 MiB frame payload is byte-exact',
    data?.length === filler.length && data === filler,
    `payload length ${data?.length ?? 'n/a'}`,
  );
  check('20 MiB frame completes in under a second', elapsedMs < 1000, `${elapsedMs.toFixed(0)} ms`);
}

// --- 2. several complete frames in one chunk ------------------------------
{
  const { requests, stderr } = drive(['{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n{"jsonrpc":"2.0","id":3,"method":"c"}\n']);
  check(
    'three frames in one chunk all arrive in order',
    requests.length === 3 && requests.map((r) => r.method).join(',') === 'a,b,c' && stderr.length === 0,
    requests.map((r) => r.method).join(','),
  );
}

// --- 3. a frame cut by a chunk boundary -----------------------------------
{
  const { requests } = drive(['{"jsonrpc":"2.0","id":1,"meth', 'od":"hello","params":{"wor', 'ld":true}}\n']);
  check(
    'a frame split across three chunks is reassembled',
    requests.length === 1 && requests[0].method === 'hello' && requests[0].params?.world === true,
    JSON.stringify(requests[0] ?? null),
  );
  // A boundary exactly between the frame text and its newline is its own case:
  // the line is complete but has no terminator yet, so it must still wait.
  const held = drive(['{"jsonrpc":"2.0","id":1,"method":"held"}']);
  check('a complete line without its newline yet is not emitted early', held.requests.length === 0);
  const released = drive(['{"jsonrpc":"2.0","id":1,"method":"held"}', '\n']);
  check(
    'the held line is emitted when the newline arrives',
    released.requests.length === 1 && released.requests[0].method === 'held',
    JSON.stringify(released.requests),
  );
}

// --- 4. blank lines are skipped, not reported -----------------------------
{
  const { requests, stderr } = drive(['{"jsonrpc":"2.0","id":1,"method":"a"}\n\n{"jsonrpc":"2.0","id":2,"method":"b"}\n']);
  check(
    'a blank line between frames is skipped, not reported as malformed',
    requests.length === 2 && stderr.length === 0,
    `requests ${requests.length}, stderr ${stderr.length}`,
  );
  // Whitespace-only must take the same path: the rule is `trim() === ""`.
  const spaced = drive(['   \n\t\n{"jsonrpc":"2.0","id":3,"method":"c"}\n']);
  check(
    'whitespace-only lines are skipped, not reported as malformed',
    spaced.requests.length === 1 && spaced.stderr.length === 0,
    `requests ${spaced.requests.length}, stderr ${spaced.stderr.length}`,
  );
}

// --- 5. CRLF terminators --------------------------------------------------
{
  // Measured, not assumed: JSON.parse tolerates trailing whitespace and `\r` is
  // whitespace, so a CRLF frame parses exactly like an LF one.
  const crlf = drive(['{"jsonrpc":"2.0","id":1,"method":"a"}\r\n{"jsonrpc":"2.0","id":2,"method":"b"}\r\n']);
  check(
    'CRLF-terminated frames parse',
    crlf.requests.length === 2 && crlf.stderr.length === 0,
    `requests ${crlf.requests.length}, stderr ${crlf.stderr.length}`,
  );
  const blank = drive(['\r\n', '{"jsonrpc":"2.0","id":9,"method":"c"}\n']);
  check(
    'a blank CRLF line is skipped (trim covers \\r\\n)',
    blank.requests.length === 1 && blank.stderr.length === 0,
    `requests ${blank.requests.length}, stderr ${blank.stderr.length}`,
  );
  // The `\r` is retained, not stripped: joining the next chunk onto a line that
  // ends in `\r` must produce `…\rx`, and a stripped `\r` would log `…x` here.
  const retained = drive(['{"a":1}\r', 'x\n']);
  check(
    'the carriage return is not stripped from the retained text',
    retained.stderr.length === 1 && retained.stderr[0].includes('{"a":1}\rx'),
    JSON.stringify(retained.stderr[0] ?? null),
  );
}

// --- 6/7. trailing partial line, malformed line, empty chunk --------------
{
  const partial = drive(['{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,']);
  check(
    'a trailing partial line emits nothing',
    partial.requests.length === 1 && partial.stderr.length === 0,
    `requests ${partial.requests.length}, stderr ${partial.stderr.length}`,
  );
  const exact = drive(['{"jsonrpc":"2.0","id":1,"method":"a"}\n']);
  check('a chunk ending exactly on a newline emits its line', exact.requests.length === 1);
  const empty = drive(['']);
  check('an empty chunk yields nothing', empty.requests.length === 0 && empty.stderr.length === 0);

  const malformed = drive(['{"jsonrpc":"2.0","id":1,"method":"a"}\nthis is not json\n{"jsonrpc":"2.0","id":2,"method":"b"}\n']);
  check(
    'a malformed line is reported and the frames after it still arrive',
    malformed.requests.length === 2 && malformed.stderr.length === 1 && malformed.stderr[0].includes('this is not json'),
    `requests ${malformed.requests.length}, stderr ${JSON.stringify(malformed.stderr)}`,
  );
  // Partial JSON at a chunk boundary must NOT be reported: it is only malformed
  // if the newline arrives and it still does not parse.
  const split = drive(['{"jsonrpc":"2.0","id":1,"meth', 'od":"late"}\n']);
  check(
    'JSON split across a boundary is not reported as malformed',
    split.requests.length === 1 && split.stderr.length === 0,
    `requests ${split.requests.length}, stderr ${split.stderr.length}`,
  );
}

// --- 8. equivalence with the old algorithm under random chunkings ---------
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
      else if (kind < 0.45) lines.push(`{"jsonrpc":"2.0","id":${String(i)},"method":"m${String(i)}"}`);
      // Big enough to span several chunks once the cuts are small.
      else lines.push(`{"jsonrpc":"2.0","id":${String(i)},"method":"m${String(i)}","params":{"pad":"${'p'.repeat(Math.floor(rand() * 400))}"}}`);
    }
    const eol = rand() < 0.25 ? '\r\n' : '\n';
    // Half the rounds end with a trailing newline, half with a dangling partial
    // line, because the old reader's `pop()` behaves differently between them.
    const tail = rand() < 0.5 ? '' : '{"jsonrpc":"2.0","id":99,';
    const input = lines.map((line) => line + eol).join('') + tail;
    const cuts = [];
    let at = 0;
    while (at < input.length) {
      const size = 1 + Math.floor(rand() * 64);
      cuts.push(input.slice(at, at + size));
      at += size;
    }
    const fresh = drive(cuts);
    const old = oldOutcomes(cuts);
    compared += 1;
    const sameFrames = JSON.stringify(fresh.requests) === JSON.stringify(old.requests);
    const sameBad = fresh.stderr.length === old.stderr.length
      && fresh.stderr.every((line, i) => line.includes(old.stderr[i]));
    if (!sameFrames || !sameBad) {
      mismatches += 1;
      if (mismatches === 1) {
        console.log(`    first mismatch on round ${round}: ${JSON.stringify({ fresh, old })}`);
      }
    }
    // The retained tail must agree too: it is what the next chunk is appended
    // to, so a difference here only shows up one frame later. The transport does
    // not expose it, so the behavioral equivalent is used — appending a newline
    // must yield the same line in both.
    const freshTail = drive([...cuts, '\n']);
    const oldTail = oldOutcomes([...cuts, '\n']);
    if (JSON.stringify(freshTail.requests) !== JSON.stringify(oldTail.requests)
      || freshTail.stderr.length !== oldTail.stderr.length) {
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

// --- 9. the incremental scan is not quadratic ----------------------------
{
  // Same input, same chunk size, both algorithms. The point is not the exact
  // ratio (it depends on the machine) but that it is large and in the right
  // direction: the old algorithm rescans everything per chunk, so ~20 MB in
  // ~1280 chunks is ~13 GB of scanning.
  const filler = 'A'.repeat(20 * 1024 * 1024);
  const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { data: filler } })}\n`;
  const chunks = chunked(input, 16 * 1024);

  const runOld = () => {
    const reader = oldReader();
    for (const chunk of chunks) reader.push(chunk);
  };
  const runNew = () => {
    const input2 = new EventEmitter();
    input2.setEncoding = () => {};
    const transport = new PaseoTransport(input2, fakeOutput());
    transport.onRequest(() => ({ ok: true }));
    transport.start();
    for (const chunk of chunks) input2.emit('data', chunk);
    transport.close();
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
  check('the incremental scan stays under a second for 20 MB', newMs < 1000, `${newMs.toFixed(0)} ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
