/**
 * Offline assertions for the server's pill feed (`server/pill-feed`): the shared
 * read that replaced three client-side poll timers.
 *
 * The module is pure — no dsh, no Paseo, no filesystem — so this drives it with a
 * fake clock, a fake `read` and fake subscribers. That is the only way to assert
 * the properties the 0.16 port depends on:
 *
 * - **the first snapshot is pushed**, not discovered one interval later;
 * - **one read per agent**, however many clients watch it (the second window
 *   costs a push, not a read);
 * - **only changes are pushed** (an identical answer must not repaint the
 *   composer);
 * - **nothing runs without a subscriber** — the last release clears the timer,
 *   and a released agent is never read again;
 * - **a failed read is loud**: a returned `available: false` is pushed like any
 *   answer, a read that *throws* is reported and retried with backoff;
 * - **a terminal answer stops the feed** after one push;
 * - **`refresh` re-reads now** (the goal pill's control action), without stacking
 *   a second read on an in-flight one;
 * - **an abort is honoured** even while a read is in flight.
 *
 * The timing policy (4 s base, 4 → 8 → 16 → 30 s backoff, jitter added) used to
 * be asserted in `harness/jobs-poll-check.cjs` against the client poller; it moved
 * here with the code.
 *
 * Run (from paseo-plugin):
 *   npx tsc -p ../harness/pill-feed.tsconfig.json
 *   echo '{"type":"commonjs"}' > .dbg-feed/package.json
 *   cp ../harness/pill-feed-check.cjs .dbg-feed/
 *   cd .dbg-feed && node pill-feed-check.cjs
 */

"use strict";

const {
  createPillFeed,
  nextFeedDelayMs,
  FEED_INTERVAL_MS,
  FEED_MAX_INTERVAL_MS,
  FEED_MAX_JITTER_MS,
} = require("./server/pill-feed.js");

let failures = 0;
let checks = 0;
function check(what, actual, expected) {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function equal(what, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${e}, got ${a}`);
}
function assert(what, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

/** A clock the test advances by hand; `pendingDelays()` is the scheduler's own. */
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pendingDelays() {
      return [...timers.values()].map((timer) => timer.at - now).sort((left, right) => left - right);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) due = { id, at: timer.at, fn: timer.fn };
        }
        if (due === null) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
        // Let the read's promise chain and the next schedule land before looking
        // for the next due timer.
        for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
    },
  };
}

/**
 * One harness: a fake agent whose answer the test controls, plus subscribers that
 * record what they were pushed.
 */
function createHarness(overrides = {}) {
  const clock = createFakeClock();
  const calls = { reads: [], errors: [] };
  const answer = { agentId: "a", available: true, data: 1 };
  /** The answer the next read returns; a scenario may replace it. */
  let next = answer;
  /** When set, the next read rejects with it (and is consumed). */
  let throwNext = null;
  const subscribers = [];
  const feed = createPillFeed({
    read: async (agentId) => {
      calls.reads.push(agentId);
      if (throwNext !== null) {
        const error = throwNext;
        throwNext = null;
        throw error;
      }
      return overrides.read ? overrides.read(agentId, calls, next) : next;
    },
    isTerminal: overrides.isTerminal ?? (() => false),
    onError: (message, error) => {
      calls.errors.push([message, error instanceof Error ? error.message : error]);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: overrides.random ?? (() => 0),
    ...(overrides.intervalMs === undefined ? {} : { intervalMs: overrides.intervalMs }),
    ...(overrides.maxIntervalMs === undefined ? {} : { maxIntervalMs: overrides.maxIntervalMs }),
  });

  /** One subscriber: a controller, an abort signal and everything it received. */
  const subscribe = () => {
    const controller = new AbortController();
    const received = [];
    const record = { pushed: received, thrown: undefined, failNext: false, failAsync: false };
    feed.subscribe(
      "a",
      (event) => {
        received.push(event);
        if (record.failNext) {
          record.failNext = false;
          throw new Error("subscriber went away");
        }
        if (record.failAsync) {
          record.failAsync = false;
          // The real `context.push` is async: it parses the event against the
          // contract and **rejects** when the shape is not the contract's.
          return Promise.reject(new Error("subscriber rejected the event"));
        }
        return undefined;
      },
      controller.signal,
    );
    subscribers.push(record);
    return { controller, received, record };
  };

  return {
    clock,
    calls,
    subscribers,
    feed,
    subscribe,
    setAnswer(next_) {
      next = next_;
    },
    /** Make the next read reject; a read that *throws* is the feed's failure path. */
    failNextRead(error = new Error("read exploded")) {
      throwNext = error;
    },
    /** Let the first read settle (or any pending microtask chain). */
    async settle() {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function main() {
/**
 * CJ-02 moved here from `jobs-poll-check`: base rate, backoff, cap, jitter.
 *
 * The pure function is asserted without a clock; the timer behaviour is asserted
 * through the fake clock below it.
 */
console.log("the feed's timing policy");
{
  check("a readable answer is read at the base interval", nextFeedDelayMs(0, () => 0), FEED_INTERVAL_MS);
  check("the first failed read doubles the base", nextFeedDelayMs(1, () => 0), FEED_INTERVAL_MS * 2);
  check("the second failed read doubles again", nextFeedDelayMs(2, () => 0), FEED_INTERVAL_MS * 4);
  check("failure backoff is capped", nextFeedDelayMs(8, () => 0), FEED_MAX_INTERVAL_MS);
  const jittered = nextFeedDelayMs(0, () => 0.99);
  assert("jitter is added, never subtracted", jittered > FEED_INTERVAL_MS, String(jittered));
  assert("jitter is capped", jittered <= FEED_INTERVAL_MS + FEED_MAX_JITTER_MS, String(jittered));
  assert(
    "two agents with different random draws do not share an interval",
    nextFeedDelayMs(0, () => 0.1) !== nextFeedDelayMs(0, () => 0.9),
  );
}

/** The subscription lifecycle: first push, sharing, change-only, release. */
console.log("\nthe first snapshot and one read per agent");
{
  const harness = createHarness();
  const first = harness.subscribe();
  await harness.settle();
  equal("the first subscriber triggers one read", harness.calls.reads, ["a"]);
  equal("…and is pushed the answer immediately", first.received, [{ agentId: "a", available: true, data: 1 }]);
  assert("…and the next read is scheduled", harness.clock.pendingDelays().length === 1);

  // The second window on the same host: it must not cost another read.
  const second = harness.subscribe();
  await harness.settle();
  equal("a second subscriber costs no read", harness.calls.reads, ["a"]);
  equal("…it receives the current answer at once", second.received, first.received);

  // A change reaches every subscriber, an identical answer reaches none.
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("the changed answer is read once", harness.calls.reads.length, 2);
  equal("…and pushed to every subscriber", [first.received.length, second.received.length], [2, 2]);
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("an identical answer is not pushed", [first.received.length, second.received.length], [2, 2]);
  harness.feed.dispose();
}

console.log("\nnothing runs without a subscriber");
{
  const harness = createHarness();
  const first = harness.subscribe();
  await harness.settle();
  const second = harness.subscribe();
  await harness.settle();
  equal("two subscribers, one read so far", harness.calls.reads.length, 1);

  first.controller.abort();
  await harness.settle();
  assert("the surviving subscriber keeps the schedule", harness.clock.pendingDelays().length === 1);
  // A changed answer, because an unchanged one is deliberately not pushed (the
  // next block pins that); the assertion is that the *read* still serves this
  // subscriber.
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("…and the surviving subscriber is still served", second.received.length, 2);

  second.controller.abort();
  await harness.settle();
  equal("the last release clears the timer", harness.clock.pendingDelays(), []);
  await harness.clock.advance(FEED_INTERVAL_MS * 10);
  equal("a released agent is never read again", harness.calls.reads.length, 2);

  // A new subscription starts a fresh read: the terminal flag and the last answer
  // died with the entry.
  const third = harness.subscribe();
  await harness.settle();
  equal("a new subscriber re-reads", harness.calls.reads.length, 3);
  equal("…and gets its own first snapshot", third.received.length, 1);
  harness.feed.dispose();
}

console.log("\na failed read is an answer, a throwing read is reported");
{
  // `available: false` is a real answer: it is pushed as a change, and the feed
  // keeps reading (the client decides what the failure means for its pill).
  const harness = createHarness();
  const subscriber = harness.subscribe();
  await harness.settle();
  harness.setAnswer({ agentId: "a", available: false, error: { message: "registry exploded", code: "rpc_failed" } });
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("a failed answer is pushed", subscriber.received.length, 2);
  equal("…with its message intact", subscriber.received[1].error.message, "registry exploded");
  equal("a returned failure reports nothing to the log", harness.calls.errors, []);
  assert("…and the feed keeps its schedule", harness.clock.pendingDelays().length === 1);
  harness.feed.dispose();
}
{
  // A read that throws has no answer to push: it is reported, retried with
  // backoff, and nothing reaches the subscriber until an answer exists.
  const harness = createHarness();
  const subscriber = harness.subscribe();
  await harness.settle();
  harness.failNextRead(new Error("dsh went away"));
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("a throwing read is reported", harness.calls.errors.length, 1);
  equal("…with the feed's own sentence", harness.calls.errors[0][0], "pill feed: reading a threw; retrying");
  equal("…and the underlying message", harness.calls.errors[0][1], "dsh went away");
  equal("…nothing is pushed for a throw", subscriber.received.length, 1);
  equal("the first failure backs off to 8 s", harness.clock.pendingDelays(), [FEED_INTERVAL_MS * 2]);
  harness.failNextRead();
  await harness.clock.advance(FEED_INTERVAL_MS * 2);
  equal("the second failure backs off to 16 s", harness.clock.pendingDelays(), [FEED_INTERVAL_MS * 4]);
  harness.failNextRead();
  await harness.clock.advance(FEED_INTERVAL_MS * 4);
  equal("the third failure is capped", harness.clock.pendingDelays(), [FEED_MAX_INTERVAL_MS]);
  await harness.clock.advance(FEED_MAX_INTERVAL_MS);
  equal("a recovery resets the backoff", harness.clock.pendingDelays(), [FEED_INTERVAL_MS]);
  harness.feed.dispose();
}

console.log("\na terminal answer stops the feed after one push");
{
  const harness = createHarness({ isTerminal: (answer) => answer.available === false && answer.error?.code === "bridge_too_old" });
  const subscriber = harness.subscribe();
  await harness.settle();
  harness.setAnswer({
    agentId: "a",
    available: false,
    error: { message: "reload the plugin", code: "bridge_too_old" },
  });
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("the terminal answer is pushed once", subscriber.received.length, 2);
  equal("…and the timer stops", harness.clock.pendingDelays(), []);
  await harness.clock.advance(FEED_INTERVAL_MS * 10);
  equal("…and it is never re-read", harness.calls.reads.length, 2);

  // A second window while the first is still attached gets that answer without a
  // read: the terminal state is the truth until the feed is released.
  const second = harness.subscribe();
  await harness.settle();
  equal("a late subscriber costs no read", harness.calls.reads.length, 2);
  equal("…it is handed the terminal answer", second.received.length, 1);

  // Once everyone has released, the entry is gone and a new subscription is a
  // fresh attempt (a plugin reload is the other way out, as the client's removal
  // is what releases this stream).
  subscriber.controller.abort();
  second.controller.abort();
  await harness.settle();
  const third = harness.subscribe();
  await harness.settle();
  equal("a release ends the terminal entry", harness.calls.reads.length, 3);
  equal("…and the fresh attempt is pushed", third.received.length, 1);
  harness.feed.dispose();
}

console.log("\nrefresh (a control action changed the data)");
{
  const harness = createHarness();
  const subscriber = harness.subscribe();
  await harness.settle();
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  harness.feed.refresh("a");
  await harness.settle();
  equal("refresh reads immediately", harness.calls.reads.length, 2);
  equal("…and pushes the change now, not on the next interval", subscriber.received.length, 2);
  equal("…leaving exactly one scheduled read behind", harness.calls.reads.length + harness.clock.pendingDelays().length, 3);
  harness.feed.dispose();
}
{
  // Two button presses in a row: the second must not run a read on top of the
  // first one; it is remembered and runs when the first settles.
  let gate;
  const blocked = new Promise((resolve) => {
    gate = resolve;
  });
  const harness = createHarness({
    read: async (agentId, calls, answer) => {
      if (calls.reads.length === 2) await blocked;
      return answer;
    },
  });
  const subscriber = harness.subscribe();
  await harness.settle();
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  harness.feed.refresh("a");
  harness.feed.refresh("a");
  await harness.settle();
  equal("two refreshes do not stack on an in-flight read", harness.calls.reads.length, 2);
  gate();
  await harness.settle();
  equal("the queued refresh runs once the read settles", harness.calls.reads.length, 3);
  equal("…and its answer reaches the subscriber", subscriber.received.length, 2);
  harness.feed.dispose();
}

console.log("\nan abort is honoured during an in-flight read");
{
  let gate;
  const blocked = new Promise((resolve) => {
    gate = resolve;
  });
  const harness = createHarness({
    read: async (agentId, calls, answer) => {
      if (calls.reads.length === 1) await blocked;
      return answer;
    },
  });
  const subscriber = harness.subscribe();
  await harness.settle();
  equal("the first read is in flight", harness.calls.reads.length, 1);
  subscriber.controller.abort();
  await harness.settle();
  gate();
  await harness.settle();
  equal("the released subscription receives nothing", subscriber.received.length, 0);
  equal("…and no timer is armed for an agent nobody watches", harness.clock.pendingDelays(), []);
  harness.feed.dispose();
}

console.log("\na subscriber that cannot take an answer is dropped — and says so");
{
  // The host parses the event against the contract before delivering it, so a
  // refusal arrives as a rejection. It used to be swallowed: the subscriber
  // disappeared, and when it was the last one the pill froze with an empty log
  // (review P2-1). One line per entry per transition, never one per answer.
  const harness = createHarness();
  const bad = harness.subscribe();
  const good = harness.subscribe();
  await harness.settle();
  bad.record.failNext = true;
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("the healthy subscriber still gets the change", good.received.length, 2);
  equal("the refused push is reported, exactly once", harness.calls.errors.length, 1);
  equal(
    "…with the feed's own sentence",
    harness.calls.errors[0][0],
    "pill feed: pushing to a subscriber failed",
  );
  equal("…and the subscriber's own reason", harness.calls.errors[0][1], "subscriber went away");
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("…the feed keeps reading for the rest", harness.calls.reads.length, 3);
  equal("…and still logs nothing more for that entry", harness.calls.errors.length, 1);
  harness.feed.dispose();
}
{
  // Two subscribers refusing **the same** answer: one line, not two. The flag is
  // per entry, which is what keeps a spent host from printing a line per answer.
  const harness = createHarness();
  const first = harness.subscribe();
  const second = harness.subscribe();
  const good = harness.subscribe();
  await harness.settle();
  first.record.failNext = true;
  second.record.failAsync = true;
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  await harness.settle();
  equal("two refusals in one broadcast log one line", harness.calls.errors.length, 1);
  equal(
    "…the synchronous one reaches the sentence first",
    harness.calls.errors[0][0],
    "pill feed: pushing to a subscriber failed",
  );
  equal("the healthy subscriber still gets the change", good.received.length, 2);
  harness.feed.dispose();
}
{
  // An async refusal is the shape a real `context.push` takes: the `.catch` branch
  // reports too (a sync-only fix would leave the actual host path silent).
  const harness = createHarness();
  const bad = harness.subscribe();
  await harness.settle();
  bad.record.failAsync = true;
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  await harness.settle();
  equal("a rejected push is reported", harness.calls.errors.length, 1);
  equal(
    "…with the rejected reason",
    harness.calls.errors[0][1],
    "subscriber rejected the event",
  );
  equal("…and no timer is left for an entry nobody watches", harness.clock.pendingDelays(), []);
  harness.feed.dispose();
}
{
  // The transition resets on an accepted push, so a *later* failure is news again
  // — the line is per transition, not once per entry lifetime.
  const harness = createHarness();
  const first = harness.subscribe();
  const good = harness.subscribe();
  await harness.settle();
  first.record.failNext = true;
  harness.setAnswer({ agentId: "a", available: true, data: 2 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("the first failure is reported", harness.calls.errors.length, 1);
  // An accepted push (the healthy subscriber takes it) clears the flag.
  harness.setAnswer({ agentId: "a", available: true, data: 3 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  const late = harness.subscribe();
  late.record.failNext = true;
  await harness.settle();
  // A new subscriber's first snapshot is pushed now; its refusal is a new transition.
  harness.setAnswer({ agentId: "a", available: true, data: 4 });
  await harness.clock.advance(FEED_INTERVAL_MS);
  equal("a later refusal is reported again (the transition reset)", harness.calls.errors.length, 2);
  equal("the healthy subscriber is still served", good.received.length > 2, true);
  harness.feed.dispose();
}

console.log("\ndispose");
{
  const harness = createHarness();
  harness.subscribe();
  await harness.settle();
  harness.feed.dispose();
  equal("dispose clears every timer", harness.clock.pendingDelays(), []);
  await harness.clock.advance(FEED_INTERVAL_MS * 5);
  equal("…and nothing is read afterwards", harness.calls.reads.length, 1);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
}

main().catch((error) => {
  console.error("pill-feed checks crashed:", error);
  process.exit(1);
});