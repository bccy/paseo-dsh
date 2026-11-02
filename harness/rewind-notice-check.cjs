/**
 * Offline assertions for the rewind report row and its one-shot capsule.
 *
 * The row is a **plugin** timeline item the server half appends
 * (`paseo.agents.ref(id).timeline.append`) — not a `session.notice`, which the
 * host's rewind run lock can drop. Three claims have to be true and none is
 * visible in a screenshot:
 *
 *   1. **Copy.** The success sentence carries the scope's wording and the counts
 *      taken from the bridge receipt's `restored` / `deleted` arrays. A wrong
 *      number reads like a correct sentence — that is the failure this file
 *      exists to catch. Both locales are asserted verbatim, because the daemon's
 *      `DSH_PASEO_LANG` decides which one is emitted while the client may be
 *      attached to either. A receipt whose counts cannot be read must fall back
 *      to a sentence **without** a number: `0 files` would be a false claim, not
 *      a conservative one.
 *   2. **One capsule per live arrival.** The capsule is driven by the live
 *      timeline subscription (`client/rewind-notice-live`), never by render
 *      cadence or a timestamp window: a row that arrived on the stream is
 *      toasted exactly once, a duplicate delivery or a remount adds nothing, and
 *      a row painted from a fetch (no live record) is silent. The old
 *      bulk/fresh + 6 s rules were wrong after a conversation rewind rebuilt the
 *      timeline, so their inputs are gone from this path.
 *   3. **Legacy rows are hidden.** Notices the previous delivery path wrote into
 *      the provider history are replayed by every conversation rebuild; the
 *      transformer recognises them from the copy table and removes them, so a
 *      session that predates this change stops showing stale "rewound" lines.
 *      The rewind canary is a different notice and must not match.
 *   4. **A degraded fallback notice stays visible.** When the row cannot be
 *      appended, the provider falls back to a notice with the report's own copy
 *      — the text the legacy filter removes. The marker line in its description
 *      is what keeps it out of that filter; the client and server copies of the
 *      marker are asserted identical here.
 *   5. **The report never appends blind.** A Paseo handle captured *after* the
 *      report was armed still builds the replacement subscription: the append
 *      waits for the host's rebuild instead of landing in front of it.
 *
 * Everything is the **compiled** client/shared code (`harness/plugin-build.cjs`
 * compiles the plugin to CommonJS), not a regex over the sources: the check
 * `require`s the same modules the bundle loads, so a change in behaviour has to
 * move these assertions.
 *
 * Run (from the repo root):
 *   node harness/rewind-notice-check.cjs [compiled-plugin-dir]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const here = __dirname;
const { resolvePluginBuild } = require(path.join(here, "plugin-build.cjs"));

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label} — ${detail === undefined ? String(condition) : detail}`);
  }
}
function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-p17-client");
console.log(`plugin build: ${buildDir}`);

// The report module reads its replacement timeout at load; a short one lets the
// race and timeout assertions below run without waiting out the production bound.
process.env.DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS = "50";
const appendModule = require(path.join(buildDir, "server", "rewind-notice-append.js"));

const {
  REWIND_COPY,
  REWIND_NOTICE_KIND,
  REWIND_NOTICE_ITEM_ID,
  REWIND_NOTICE_VERSION,
  rewindFileCounts,
  rewindNoticeHeadline,
  rewindNoticePayloadSchema,
  rewindNoticeTone,
  rewindSuccessText,
} = require(path.join(buildDir, "shared", "rewind-notice.js"));
const {
  isLegacyRewindNotice,
  rewindToastMessage,
} = require(path.join(buildDir, "client", "rewind-notice-data.js"));
const {
  MAX_WATCHED_AGENTS,
  REWIND_LIVE_HANDOFF_MS,
  RewindLiveMonitor,
  WATCH_RECENT_MS,
} = require(path.join(buildDir, "client", "rewind-notice-live.js"));
const { rewindCanaryNotice } = require(path.join(buildDir, "server", "rewind-canary.js"));
const { PROVIDER_ID } = require(path.join(buildDir, "shared", "provider.js"));

const base = Date.UTC(2026, 0, 2, 3, 4, 5);

/** A fake Paseo API exposing only what the monitor uses. */
function makeFakePaseo(options = {}) {
  const subscriptions = new Map();
  const releasedIds = new Set();
  const failingAgents = new Set(options.failingAgents ?? []);
  const directory = { handlers: null, released: false, entries: [] };
  return {
    paseo: {
      agents: {
        async list(options) {
          if (options === undefined || options.subscribe === undefined) {
            throw new Error("the monitor must subscribe to the directory");
          }
          return {
            entries: directory.entries,
            subscriptionId: "dir-sim",
            subscription: {
              async release() {
                directory.released = true;
              },
              subscribe(handlers) {
                directory.handlers = handlers;
                return () => {};
              },
            },
          };
        },
        ref(agentId) {
          return {
            timeline: {
              subscribe(handler) {
                if (failingAgents.has(agentId)) throw new Error("permission denied");
                subscriptions.set(agentId, { handler });
                const unsubscribe = () => {
                  releasedIds.add(agentId);
                  subscriptions.delete(agentId);
                };
                unsubscribe.ready = Promise.resolve();
                unsubscribe.subscriptionId = `sim-${agentId}`;
                unsubscribe.release = async () => {
                  releasedIds.add(agentId);
                  subscriptions.delete(agentId);
                };
                return unsubscribe;
              },
              async append() {
                throw new Error("the client half must not append");
              },
              async refetch() {
                return { entries: [] };
              },
            },
          };
        },
      },
    },
    /** Deliver one live timeline event to the agent's subscription. */
    deliver(agentId, event) {
      subscriptions.get(agentId)?.handler({ agentId, event });
    },
    subscribed: (agentId) => subscriptions.has(agentId),
    released: (agentId) => releasedIds.has(agentId),
    directory,
  };
}

/** One live plugin-row event, shaped like `PaseoAgentTimelineEvent`. */
function liveReportEvent(noticeId, message = REWIND_COPY["zh-CN"].conversation) {
  return {
    type: "timeline",
    provider: "fake",
    item: {
      type: "plugin",
      id: `${PROVIDER_ID}/rewind-notice`,
      pluginId: PROVIDER_ID,
      kind: REWIND_NOTICE_KIND,
      version: REWIND_NOTICE_VERSION,
      data: { message, tone: "success", noticeId },
    },
  };
}

function agentEntry(id, overrides = {}) {
  return {
    agent: {
      id,
      provider: PROVIDER_ID,
      status: "idle",
      updatedAt: new Date(base).toISOString(),
      workspaceId: "ws-1",
      ...overrides,
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Let a delivery's async chain (await replacement → append) finish. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("copy — both locales");
  {
    const zh = REWIND_COPY["zh-CN"];
    const en = REWIND_COPY.en;
    equal("zh conversation", rewindSuccessText(zh, "conversation", undefined), "已撤回到这条消息");
    equal(
      "zh both counts",
      rewindSuccessText(zh, "both", { restored: ["a", "b"], deleted: ["c"] }),
      "已撤回对话，并恢复 2 个文件（删除 1 个）",
    );
    equal("zh both no files", rewindSuccessText(zh, "both", undefined), "已撤回对话，这条消息之后没有改动文件");
    equal(
      "zh files counts",
      rewindSuccessText(zh, "files", { restored: ["a", "b"], deleted: ["c"] }),
      "已恢复 2 个文件（删除 1 个）",
    );
    equal("zh files no files", rewindSuccessText(zh, "files", undefined), "这条消息之后没有改动文件，无需恢复");
    equal("zh both unreadable counts", rewindSuccessText(zh, "both", { restored: "2" }), "已撤回对话");
    equal("zh files unreadable counts", rewindSuccessText(zh, "files", {}), "文件已恢复");
    check(
      "zh numberless fallbacks carry no digit",
      !/\d/u.test(rewindSuccessText(zh, "both", { restored: null }))
        && !/\d/u.test(rewindSuccessText(zh, "files", { deleted: 1 })),
      "a number was invented",
    );

    equal("en conversation", rewindSuccessText(en, "conversation", undefined), "Rewound to this message");
    equal(
      "en both counts",
      rewindSuccessText(en, "both", { restored: ["a", "b"], deleted: ["c"] }),
      "Conversation rewound; restored 2 files (deleted 1 file)",
    );
    equal(
      "en files counts",
      rewindSuccessText(en, "files", { restored: [], deleted: ["c"] }),
      "Restored 0 files (deleted 1 file)",
    );
    equal("en files no files", rewindSuccessText(en, "files", undefined), "No files changed after this message; nothing to restore");
    equal("en both unreadable counts", rewindSuccessText(en, "both", { restored: "x" }), "Conversation rewound");
  }

  console.log("receipt counts");
  {
    equal(
      "counts are array lengths, not a count field",
      JSON.stringify(rewindFileCounts({ restored: ["a", "b", "c"], deleted: ["d"] })),
      JSON.stringify({ restored: 3, deleted: 1 }),
    );
    equal("a missing receipt has no counts", rewindFileCounts(undefined), undefined);
    equal("an unreadable receipt has no counts", rewindFileCounts({ restored: "3", deleted: [] }), undefined);
  }

  console.log("recognition — the report copy, and the legacy notice path");
  {
    for (const locale of ["en", "zh-CN"]) {
      const copy = REWIND_COPY[locale];
      equal(`${locale} conversation is success`, rewindNoticeTone(copy.conversation), "success");
      equal(`${locale} both counts is success`, rewindNoticeTone(copy.bothCounts({ restored: 2, deleted: 1 })), "success");
      equal(`${locale} files no files is success`, rewindNoticeTone(copy.filesNoFiles), "success");
      equal(
        `${locale} failure row is warning`,
        rewindNoticeTone(`${copy.failureTitle}\n/work/a.txt 恢复失败`),
        "warning",
      );
    }
    const canary = rewindCanaryNotice({ at: new Date(base), seq: 1, files: false });
    equal("the canary is not a completion report", rewindNoticeTone(canary.message), undefined);
    equal("the canary is not hidden as a legacy row", isLegacyRewindNotice(canary.message), false);
    equal(
      "a legacy completion notice is recognised for hiding",
      isLegacyRewindNotice(REWIND_COPY["zh-CN"].conversation),
      true,
    );
    equal(
      "a legacy failure notice is recognised too",
      isLegacyRewindNotice(`${REWIND_COPY["zh-CN"].failureTitle}\n/path 未能恢复`),
      true,
    );
    equal("an unrelated notification is left alone", isLegacyRewindNotice("工作区读取失败：permission denied"), false);
    equal("an empty message is left alone", isLegacyRewindNotice(""), false);
    equal("the failure capsule is one line", rewindNoticeHeadline("文件回退未完成\n第一行详情"), "文件回退未完成");
    equal("the toast repeats the headline", rewindToastMessage({ message: "文件回退未完成\n详情", tone: "warning", noticeId: "n" }), "文件回退未完成");
  }

  console.log("degraded fallback — visible, and still not a legacy row");
  {
    const clientData = require(path.join(buildDir, "client", "rewind-notice-data.js"));
    // The client keeps its own copy of the marker strings (it cannot import a
    // server module: `process` is read at load there). A drift would silently
    // hide the fallback failure report again.
    equal(
      "the client and server agree on the fallback markers",
      JSON.stringify(clientData.REWIND_FALLBACK_MARKERS),
      JSON.stringify(appendModule.REWIND_FALLBACK_MARKERS),
    );
    for (const locale of ["en", "zh-CN"]) {
      const copy = REWIND_COPY[locale];
      const marker = appendModule.REWIND_FALLBACK_MARKERS[locale];
      equal(
        `${locale} the fallback description starts with the marker`,
        appendModule.fallbackNoticeDescription(locale, ""),
        marker,
      );
      equal(
        `${locale} the fallback keeps the report's detail after the marker`,
        appendModule.fallbackNoticeDescription(locale, "detail line"),
        `${marker}\ndetail line`,
      );
      // What the host joins for a notice: title + "\n" + description.
      equal(
        `${locale} a degraded success report is not hidden as a legacy row`,
        clientData.isLegacyRewindNotice(
          `${copy.conversation}\n${appendModule.fallbackNoticeDescription(locale, "")}`,
        ),
        false,
      );
      equal(
        `${locale} a degraded failure report is not hidden as a legacy row`,
        clientData.isLegacyRewindNotice(
          `${copy.failureTitle}\n${appendModule.fallbackNoticeDescription(locale, "/work/a.txt 恢复失败")}`,
        ),
        false,
      );
      // …and the old rows are still removed, marker or not.
      equal(
        `${locale} a legacy success row is still hidden`,
        clientData.isLegacyRewindNotice(copy.conversation),
        true,
      );
      equal(
        `${locale} a legacy failure row is still hidden`,
        clientData.isLegacyRewindNotice(`${copy.failureTitle}\n/work/a.txt 恢复失败`),
        true,
      );
    }
    check(
      "the timeout path re-checks the row more than once, after a delay",
      appendModule.REWIND_REPLACEMENT_VERIFY_ATTEMPTS > 1 && appendModule.REWIND_REPLACEMENT_VERIFY_DELAY_MS > 0,
      `${String(appendModule.REWIND_REPLACEMENT_VERIFY_ATTEMPTS)} attempt(s), `
        + `${String(appendModule.REWIND_REPLACEMENT_VERIFY_DELAY_MS)}ms apart`,
    );
  }

  console.log("handle captured mid-rewind — the report never appends blind");
  {
    const appended = [];
    const subscriptions = [];
    const fakePaseo = {
      agents: {
        ref(agentId) {
          return {
            timeline: {
              async append(item) {
                appended.push({ agentId, item, at: Date.now() });
                return { seq: appended.length };
              },
              async refetch() {
                return { entries: [] };
              },
              subscribe(handler) {
                const subscription = { agentId, handler };
                subscriptions.push(subscription);
                const release = () => {
                  const index = subscriptions.indexOf(subscription);
                  if (index >= 0) subscriptions.splice(index, 1);
                };
                release.ready = Promise.resolve();
                release.subscriptionId = "sim";
                release.release = async () => release();
                return release;
              },
            },
          };
        },
      },
    };
    check("the report module starts without a Paseo API handle", appendModule.hasPaseoHandle() === false);
    const delivery = appendModule.beginRewindReport("agent-race", "conversation");
    check("…so arming the report creates no timeline subscription yet", subscriptions.length === 0);
    appendModule.capturePaseo(fakePaseo);
    check("the handle capture is what arms the report", appendModule.hasPaseoHandle() === true);
    delivery.deliver({ message: REWIND_COPY["zh-CN"].conversation, tone: "success" });
    await sleep(20);
    check(
      "the report does not append before the replacement arrives",
      appended.length === 0,
      JSON.stringify(appended.map((entry) => entry.item.data)),
    );
    check(
      "…it subscribed to the agent's timeline first",
      subscriptions.length === 1,
      `${subscriptions.length} subscription(s)`,
    );
    subscriptions[0].handler({ agentId: "agent-race", event: { type: "replacement", epoch: "e1" } });
    await sleep(20);
    check(
      "the report appends once the replacement arrives",
      appended.length === 1 && appended[0].agentId === "agent-race",
      JSON.stringify(appended.map((entry) => entry.item.data)),
    );
  }

  console.log("replacement timeout — the report is appended, never dropped");
  {
    const appended = [];
    const fakePaseo = {
      agents: {
        ref(agentId) {
          return {
            timeline: {
              async append(item) {
                appended.push({ agentId, item, at: Date.now() });
                return { seq: appended.length };
              },
              async refetch() {
                return { entries: [] };
              },
              subscribe() {
                const release = () => {};
                release.ready = Promise.resolve();
                release.subscriptionId = "sim";
                release.release = async () => {};
                return release;
              },
            },
          };
        },
      },
    };
    appendModule.capturePaseo(fakePaseo);
    const delivery = appendModule.beginRewindReport("agent-timeout", "conversation");
    delivery.deliver({ message: REWIND_COPY["zh-CN"].conversation, tone: "success" });
    await sleep(20);
    check(
      "the report waits for the replacement instead of appending immediately",
      appended.length === 0,
      JSON.stringify(appended.map((entry) => entry.item.data)),
    );
    await sleep(120);
    check(
      "…and appends after the bounded replacement timeout",
      appended.length === 1,
      JSON.stringify(appended.map((entry) => entry.item.data)),
    );
  }

  console.log("payload schema — the row carries its own identity");
  {
    const valid = rewindNoticePayloadSchema.safeParse({
      message: "已撤回到这条消息",
      tone: "success",
      noticeId: "a-1",
    });
    check("a complete payload parses", valid.success === true, JSON.stringify(valid.error?.issues ?? null));
    const noId = rewindNoticePayloadSchema.safeParse({ message: "x", tone: "success" });
    check("a payload without a noticeId is rejected", noId.success === false);
    const noTone = rewindNoticePayloadSchema.safeParse({ message: "x", noticeId: "a" });
    check("a payload without a tone is rejected", noTone.success === false);
    check(
      "the item id is the stable one a later report replaces",
      REWIND_NOTICE_ITEM_ID === "rewind-notice",
      REWIND_NOTICE_ITEM_ID,
    );
  }

  console.log("live monitor — the capsule is a live-stream fact");
  {
    const fake = makeFakePaseo();
    let now = base;
    const monitor = new RewindLiveMonitor(fake.paseo, { now: () => now });
    monitor.watch("agent-a");
    check("watching an agent subscribes to its live timeline", fake.subscribed("agent-a") === true);
    monitor.watch("agent-a");
    check("watching twice keeps one subscription", monitor.watchedAgents().length === 1);

    fake.deliver("agent-a", liveReportEvent("notice-1"));
    equal("a live report row is taken once", monitor.take("agent-a", "notice-1"), true);
    equal("…and a remount does not raise a second capsule", monitor.take("agent-a", "notice-1"), false);

    fake.deliver("agent-a", liveReportEvent("notice-2"));
    fake.deliver("agent-a", liveReportEvent("notice-2"));
    equal("a duplicated live delivery still raises one capsule", monitor.take("agent-a", "notice-2"), true);
    equal("…and the duplicate is not a second one", monitor.take("agent-a", "notice-2"), false);

    fake.deliver("agent-a", liveReportEvent("notice-3"));
    now = base + REWIND_LIVE_HANDOFF_MS + 1;
    equal(
      "a row the app paints long after the event does not pop a stale capsule",
      monitor.take("agent-a", "notice-3"),
      false,
    );
    now = base;

    // Replay/refetch shape: the row exists but was never on the stream.
    equal("a replayed row raises no capsule", monitor.take("agent-a", "notice-replayed"), false);

    // Other plugin rows and other agents' events must not count.
    fake.deliver("agent-a", {
      type: "timeline",
      provider: "fake",
      item: { type: "plugin", id: "x", pluginId: PROVIDER_ID, kind: "dsh-tool", version: 1, data: {} },
    });
    equal("a different plugin row is ignored", monitor.take("agent-a", "undefined"), false);
    fake.deliver("agent-b", liveReportEvent("notice-b"));
    equal("an event for an unwatched agent records nothing", monitor.take("agent-b", "notice-b"), false);

    // Subscription errors are reported, and the agent can be watched again.
    const errors = [];
    const failing = makeFakePaseo({ failingAgents: ["agent-d"] });
    const failingMonitor = new RewindLiveMonitor(failing.paseo, {
      now: () => now,
      onError: (message) => errors.push(message),
    });
    failingMonitor.watch("agent-c");
    failingMonitor.watch("agent-d");
    check(
      "a failed subscription is reported, not swallowed",
      errors.some((message) => message.includes("agent-d")),
      JSON.stringify(errors),
    );
    check(
      "…and it does not leave a dead subscription behind",
      failingMonitor.watchedAgents().includes("agent-d") === false,
      JSON.stringify(failingMonitor.watchedAgents()),
    );
    failingMonitor.dispose();

    monitor.dispose();
    check("dispose releases the live subscriptions", fake.released("agent-a") === true);
  }

  console.log("live monitor — the directory watch bound");
  {
    const fake = makeFakePaseo();
    const recent = new Date(base - 60_000).toISOString();
    const old = new Date(base - WATCH_RECENT_MS - 60_000).toISOString();
    fake.directory.entries = [
      agentEntry("recent-dsh", { updatedAt: recent }),
      agentEntry("old-dsh", { updatedAt: old }),
      agentEntry("recent-other", { updatedAt: recent, provider: "claude" }),
      agentEntry("recent-closed", { updatedAt: recent, status: "closed" }),
      agentEntry("recent-archived", { updatedAt: recent, archivedAt: recent }),
      agentEntry("recent-internal", { updatedAt: recent, internal: true }),
    ];
    const monitor = new RewindLiveMonitor(fake.paseo, { now: () => base });
    await monitor.start();
    const watched = monitor.watchedAgents();
    check(
      "a recently active agent of this provider is watched",
      watched.includes("recent-dsh"),
      JSON.stringify(watched),
    );
    check(
      "an old agent is not watched up front",
      !watched.includes("old-dsh"),
      JSON.stringify(watched),
    );
    check(
      "other providers' agents, closed, archived and internal agents are skipped",
      !watched.includes("recent-other")
        && !watched.includes("recent-closed")
        && !watched.includes("recent-archived")
        && !watched.includes("recent-internal"),
      JSON.stringify(watched),
    );
    // The bound: many recent agents cannot create a subscription per agent.
    fake.directory.entries = Array.from({ length: MAX_WATCHED_AGENTS + 10 }, (_, index) =>
      agentEntry(`many-${String(index)}`, { updatedAt: recent }),
    );
    fake.directory.handlers?.snapshot({ entries: fake.directory.entries, subscriptionId: "dir-sim" });
    check(
      "the directory watch set is bounded",
      monitor.watchedAgents().length <= MAX_WATCHED_AGENTS + 1,
      `${monitor.watchedAgents().length} watched`,
    );
    fake.directory.handlers?.update({
      type: "agent_update",
      payload: { kind: "remove", agentId: "recent-dsh" },
    });
    check(
      "an agent removed from the directory is unwatched",
      monitor.watchedAgents().includes("recent-dsh") === false,
      JSON.stringify(monitor.watchedAgents()),
    );
    monitor.dispose();
    await settle();
    check("dispose releases the directory observation", fake.directory.released === true);
  }

  console.log("wiring — the bundle registers the report path, not the notice path");
  {
    const indexClient = fs.readFileSync(path.join(here, "..", "paseo-plugin", "index.client.tsx"), "utf8");
    check(
      "the notification transformer removes legacy rewind notices",
      /itemType:\s*"notification"[\s\S]*?isLegacyRewindNotice\(item\.message\)\s*\?\s*\{\s*items:\s*\[\]\s*\}/u.test(indexClient),
      "the legacy-notice transformer is missing",
    );
    check(
      "the renderer is registered under the shared kind and version",
      indexClient.includes("kind: REWIND_NOTICE_KIND") && indexClient.includes("Component: RewindNotice"),
      "renderer registration missing",
    );
    check(
      "the live monitor is started with the arm RPC",
      indexClient.includes("startRewindLiveMonitor(client.paseo") && indexClient.includes("client.rpc(rewindNoticeArm, {})"),
      "monitor/arm wiring missing",
    );
    const row = fs.readFileSync(path.join(here, "..", "paseo-plugin", "client", "rewind-notice.tsx"), "utf8");
    check(
      "the capsule asks the live monitor, not the render-cadence pulse",
      row.includes("activeRewindLiveMonitor()") && row.includes("monitor.take(agentId, data.noticeId)"),
      "the row still uses the old pulse gate",
    );
    check(
      "…and the row no longer imports the bulk/fresh rule",
      row.includes("useRowPulse") === false,
      "client/newest is still in the capsule path",
    );
    const indexServer = fs.readFileSync(path.join(here, "..", "paseo-plugin", "index.server.ts"), "utf8");
    check(
      "the server registers the arm RPC",
      indexServer.includes("server.handle(rewindNoticeArm"),
      "arm RPC registration missing",
    );
    check(
      "the server captures the handle from allowed hooks only",
      indexServer.includes('"agent.turn_started"') && indexServer.includes('"agent.turn_ended"'),
      "capture hooks missing",
    );
    check(
      "the server never registers before(agent.session_open)",
      // A call, not a mention: the file's own comment names the forbidden hook.
      !/\.before\(\s*["']agent\.session_open["']/.test(indexServer),
      "the forbidden before-hook is registered",
    );
  }

  console.log(`\n  ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log(`  ${failed} FAILED`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`threw: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
