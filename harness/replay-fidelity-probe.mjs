/**
 * Replay-fidelity probe on a real DSH session log.
 *
 * The offline `surface-check.mjs` pins the fold's contract on synthetic events.
 * This probe runs the same fold on a real, multi-frame-zstd session log — the
 * shape that actually matters — and asserts the property that a compaction fold
 * would violate: the human transcript must be preserved (every append-origin
 * user message still replays), while this bridge's rewind seams (if any) drop
 * exactly their span.
 *
 * Usage:
 *   node harness/replay-fidelity-probe.mjs <session.v4.jsonl.zstd>
 *   node harness/replay-fidelity-probe.mjs            # newest log under $DSH_HOME/sessions
 *
 * The log is read-only; nothing is written. A log that cannot be decoded is
 * reported, never silently treated as empty.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { visibleEvents } from '../dsh-bridge/lib/surface.js';

const argv = process.argv.slice(2);

/** Decode every zstd frame: the CLI handles multi-frame logs; zlib is a fallback. */
async function decode(file) {
  const cli = spawnSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 });
  if (cli.error === undefined && cli.status === 0) return cli.stdout.toString('utf8');
  const chunks = [];
  await new Promise((resolve, reject) => {
    const stream = zlib.createZstdDecompress();
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
    fs.createReadStream(file).pipe(stream);
  });
  return Buffer.concat(chunks).toString('utf8');
}

function newestLog() {
  const root = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions');
  let newest;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'session.v4.jsonl.zstd') {
        const info = fs.statSync(full);
        if (newest === undefined || info.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: info.mtimeMs };
      }
    }
  }
  return newest?.file;
}

const isHumanUser = (event) => event?.type === 'user/message' && event?.data?.source?.kind === 'user';
const isAppendOrigin = (event) => isHumanUser(event) && event?.surfaceOp === 'append';
const isRewindSeam = (event) => event?.type === 'user/message'
  && event?.surfaceOp !== undefined
  && typeof event.surfaceOp === 'object'
  && event?.data?.source?.kind === 'paseo-rewind';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const file = argv[0] ?? newestLog();
if (file === undefined) {
  console.log('SKIP  no session log found under $DSH_HOME/sessions');
  process.exit(0);
}
console.log(`session log: ${file}`);

let events;
try {
  events = await decode(file)
    .then((text) => text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line)));
} catch (error) {
  console.log(`FAIL  cannot decode/parse the session log: ${error.message}`);
  process.exit(1);
}
console.log(`events: ${events.length}`);

const appendUser = events.filter(isAppendOrigin);
const seams = events.filter(isRewindSeam);
const kept = visibleEvents(events);
const keptAppendUser = kept.filter(isAppendOrigin);
console.log(`human user messages: ${appendUser.length} (append-origin); rewind markers: ${seams.length}; replayed events: ${kept.length}`);

check(
  'an old log without this bridge\'s rewind markers replays verbatim',
  seams.length > 0 || kept.length === events.length,
  `${kept.length}/${events.length}`,
);
check(
  'compaction does not delete the transcript on an old log',
  seams.length > 0 || keptAppendUser.length === appendUser.length,
  `${keptAppendUser.length}/${appendUser.length}`,
);

// The realistic future: append one rewind marker over the tail of this real log,
// then fold. It must drop exactly the tail span it replaced, and nothing else.
if (events.length > 10) {
  const surfaceOps = events.filter((event) => event?.surfaceOp !== undefined);
  const nodes = [];
  for (const event of events) {
    if (event?.surfaceOp === 'append') nodes.push(event.seq);
    else if (event?.surfaceOp?.op === 'replace') {
      const from = nodes.indexOf(event.surfaceOp.startSeq);
      const to = nodes.indexOf(event.surfaceOp.endSeq);
      if (from !== -1 && to !== -1 && to >= from) nodes.splice(from, to - from + 1, event.seq);
    }
  }
  const stateText = events.at(-1)?.seq;
  const target = (() => {
    // Pick the last human user message that is still a surface node.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (isHumanUser(event) && nodes.includes(event.seq)) return event;
    }
    return undefined;
  })();
  if (target !== undefined) {
    const targetIndex = nodes.indexOf(target.seq);
    const shadowed = nodes.slice(targetIndex);
    const marker = {
      seq: stateText + 1,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) },
      sourceEventSeqs: shadowed,
      data: { id: 'probe-marker', role: 'user', content: [{ type: 'text', text: '(empty message)' }], source: { kind: 'paseo-rewind' } },
    };
    const folded = visibleEvents([...events, marker]);
    // The log may already carry this bridge's own seams (a real rewind happened
    // in it). Build the expectation INDEPENDENTLY from the raw log: a rewind
    // marker drops every seq from its `surfaceOp.startSeq` through its own
    // `seq - 1` (`surface.js`), so the kept set is the raw events minus those
    // spans, then minus everything the synthetic seam withdraws. Deriving it
    // from the surfaceOps (not from `visibleEvents` output) keeps this a real
    // check even when prior seams exist.
    const priorSpans = seams
      .filter((event) => typeof event.surfaceOp?.startSeq === 'number')
      .map((event) => [event.surfaceOp.startSeq, event.seq - 1]);
    const droppedByPriorSeam = (seq) => seq !== undefined
      && priorSpans.some(([from, to]) => seq >= from && seq <= to);
    // Lines without a seq are the log header/format marker, not events of the
    // span; they always survive the fold.
    const expected = [
      ...events.filter((event) => !droppedByPriorSeam(event.seq)
        && (event.seq === undefined || event.seq < shadowed[0])),
      marker,
    ];
    check(
      'a rewind seam drops exactly the span it replaced',
      JSON.stringify(folded.map((event) => event.seq)) === JSON.stringify(expected.map((event) => event.seq)),
      `${folded.length} kept vs ${expected.length} expected`,
    );
    const expectedHumans = expected.filter(isHumanUser).length;
    check(
      'the span before the rewind target is untouched',
      folded.filter(isHumanUser).length === expectedHumans,
      `${folded.filter(isHumanUser).length} vs ${expectedHumans}`,
    );
  } else {
    console.log('SKIP  no human user message on the surface to build a probe rewind from');
  }
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
