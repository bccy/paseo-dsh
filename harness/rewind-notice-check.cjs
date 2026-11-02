/**
 * Offline assertions for the rewind completion row and its one-shot capsule.
 *
 * The row is a plugin timeline item produced from Paseo's `notification` item
 * (the host projects `session.notice` to that shape), so two claims have to be
 * true and neither is visible in a screenshot:
 *
 *   1. **Copy.** The success sentence carries the scope's wording and the counts
 *      taken from the bridge receipt's `restored` / `deleted` arrays. A wrong
 *      number reads like a correct sentence — that is the failure this file
 *      exists to catch. Both locales are asserted verbatim, because the daemon's
 *      `DSH_PASEO_LANG` decides which one is emitted while the client may be
 *      attached to either. A receipt whose counts cannot be read must fall back
 *      to a sentence **without** a number: `0 files` would be a false claim, not
 *      a conservative one.
 *   2. **One capsule per live arrival.** The gate is driven by the window and
 *      the batch rules the client already uses for pulses (`client/newest.ts`):
 *      a replayed burst cannot produce a fresh commit, a history row painted
 *      after the fact is too old, and the same notice row remounting must not
 *      repeat the capsule. Asserting the gate alone would not prove the replay
 *      half, so the relevant `newest` calls are driven here too.
 *
 * Everything is the **compiled** client/shared code (`tsc` to CommonJS), not a
 * regex over the sources: the check `require`s the same modules the bundle
 * loads, so a change in behaviour has to move these assertions.
 *
 * Run (from paseo-plugin):
 *   npx tsc shared/rewind-notice.ts client/rewind-notice-data.ts client/newest.ts \
 *     server/rewind-canary.ts \
 *     --outDir .dbg-p14-notice --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg-p14-notice/package.json
 *   cp ../harness/rewind-notice-check.cjs .dbg-p14-notice/
 *   cd .dbg-p14-notice && node rewind-notice-check.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  REWIND_COPY,
  rewindFileCounts,
  rewindNoticeHeadline,
  rewindNoticeTone,
  rewindSuccessText,
} = require("./shared/rewind-notice.js");
const {
  REWIND_NOTICE_KIND,
  REWIND_NOTICE_VERSION,
  REWIND_TOAST_MAX_AGE_MS,
  RewindToastGate,
  rewindNoticeItem,
  rewindToastMessage,
} = require("./client/rewind-notice-data.js");
const { isPulsing, noteCommit, noteRender } = require("./client/newest.js");
const { rewindCanaryNotice } = require("./server/rewind-canary.js");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} — ${detail === undefined ? String(condition) : detail}`);
  }
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Locate a repo source from a build dir (documented one level down, scratch deeper). */
function findRepoFile(relative, levels = 4) {
  let dir = __dirname;
  for (let i = 0; i < levels; i += 1) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const base = Date.UTC(2026, 0, 2, 3, 4, 5);

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
    equal(
      "zh both no files",
      rewindSuccessText(zh, "both", undefined),
      "已撤回对话，这条消息之后没有改动文件",
    );
    equal(
      "zh both zero receipt",
      rewindSuccessText(zh, "both", { restored: [], deleted: [] }),
      "已撤回对话，这条消息之后没有改动文件",
    );
    equal(
      "zh files counts",
      rewindSuccessText(zh, "files", { restored: ["a", "b"], deleted: ["c"] }),
      "已恢复 2 个文件（删除 1 个）",
    );
    equal(
      "zh files no files",
      rewindSuccessText(zh, "files", undefined),
      "这条消息之后没有改动文件，无需恢复",
    );
    equal(
      "zh files zero receipt",
      rewindSuccessText(zh, "files", { restored: [], deleted: [] }),
      "这条消息之后没有改动文件，无需恢复",
    );
    // Counts that cannot be read must not become a number, and must not claim
    // "nothing changed" either: the receipt exists, so files may have changed.
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
    equal(
      "en both no files",
      rewindSuccessText(en, "both", undefined),
      "Conversation rewound; no files changed after this message",
    );
    equal(
      "en files no files",
      rewindSuccessText(en, "files", undefined),
      "No files changed after this message; nothing to restore",
    );
    equal("en both unreadable counts", rewindSuccessText(en, "both", { restored: "x" }), "Conversation rewound");
    equal("en files unreadable counts", rewindSuccessText(en, "files", { restored: ["a"], deleted: undefined }), "Files restored");
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

  console.log("recognition");
  {
    for (const locale of ["en", "zh-CN"]) {
      const copy = REWIND_COPY[locale];
      equal(`${locale} conversation is success`, rewindNoticeTone(copy.conversation), "success");
      equal(`${locale} both counts is success`, rewindNoticeTone(copy.bothCounts({ restored: 2, deleted: 1 })), "success");
      equal(`${locale} both no files is success`, rewindNoticeTone(copy.bothNoFiles), "success");
      equal(`${locale} files counts is success`, rewindNoticeTone(copy.filesCounts({ restored: 2, deleted: 1 })), "success");
      equal(`${locale} files no files is success`, rewindNoticeTone(copy.filesNoFiles), "success");
      equal(
        `${locale} failure row is warning`,
        rewindNoticeTone(`${copy.failureTitle}\n/work/a.txt 恢复失败`),
        "warning",
      );
    }
    const canary = rewindCanaryNotice({ at: new Date(base), seq: 1, files: false });
    equal("the canary is not a completion report", rewindNoticeTone(canary.message), undefined);
    equal("an unrelated notification is left alone", rewindNoticeTone("子代理历史读取失败"), undefined);
    equal("an open warning is left alone", rewindNoticeTone("工作区读取失败：permission denied"), undefined);
    equal("an empty message is left alone", rewindNoticeTone(""), undefined);
    equal("the failure capsule is one line", rewindNoticeHeadline("文件回退未完成\n第一行详情"), "文件回退未完成");
  }

  console.log("transform");
  {
    const item = rewindNoticeItem(REWIND_COPY["zh-CN"].conversation);
    check("a success notice becomes a plugin item", item !== undefined && item.kind === REWIND_NOTICE_KIND && item.version === REWIND_NOTICE_VERSION);
    equal("…carrying the message verbatim", item?.data.message, "已撤回到这条消息");
    equal("…and the success tone", item?.data.tone, "success");
    equal(
      "…the failure row keeps its detail",
      rewindNoticeItem("文件回退未完成\n/path 未能恢复")?.data.message,
      "文件回退未完成\n/path 未能恢复",
    );
    equal("the canary is not transformed", rewindNoticeItem(rewindCanaryNotice({ at: new Date(base), seq: 1, files: false }).message), undefined);
    equal("a random notification is not transformed", rewindNoticeItem("工作区读取失败"), undefined);
    equal("the failure capsule says the headline", rewindToastMessage({ message: "文件回退未完成\n详情", tone: "warning" }), "文件回退未完成");
  }

  console.log("capsule gate");
  {
    const gate = new RewindToastGate();
    const live = {
      agentId: "agent-a",
      timestamp: new Date(base),
      message: "已撤回到这条消息",
      fresh: true,
      now: base,
    };
    equal("a live arrival raises the capsule", gate.shouldToast(live), true);
    equal("the same row remounting does not", gate.shouldToast({ ...live, now: base + 100 }), false);
    equal("a replay commit does not", gate.shouldToast({ ...live, agentId: "agent-b", fresh: false }), false);
    equal("a stale history row does not", gate.shouldToast({ ...live, agentId: "agent-c", now: base + REWIND_TOAST_MAX_AGE_MS + 1 }), false);
    equal("an unparsable timestamp does not", gate.shouldToast({ ...live, agentId: "agent-d", timestamp: "not-a-date" }), false);
    equal(
      "a different agent's identical notice does",
      gate.shouldToast({ ...live, agentId: "agent-e" }),
      true,
    );
    equal(
      "a different rewind later does",
      gate.shouldToast({ ...live, agentId: "agent-a", timestamp: new Date(base + 60_000), now: base + 60_000 }),
      true,
    );
  }

  console.log("newest integration — the replay rule actually feeds the gate");
  {
    // A live single-row arrival: one first paint, a fresh commit, inside the
    // age window. This is the shape a real rewind has.
    const liveAgent = "live-rewind";
    noteRender(liveAgent, base, true);
    await settle();
    const liveCommit = noteCommit(liveAgent, base);
    const livePulse = isPulsing(liveAgent, liveCommit, base + 10);
    equal("a live row is fresh", livePulse, true);
    const liveGate = new RewindToastGate();
    equal(
      "…and the gate lets that row raise one capsule",
      liveGate.shouldToast({
        agentId: liveAgent,
        timestamp: new Date(base),
        message: REWIND_COPY["zh-CN"].conversation,
        fresh: livePulse,
        now: base + 10,
      }),
      true,
    );

    // A replay burst: several rows painted in one pass, then committed in the
    // same microtask batch. `newest.ts` marks them replay/bulk, so the gate must
    // refuse them even though every row is "new" to the component.
    const replayAgent = "replayed-rewind";
    const stamps = [base, base + 10, base + 20];
    for (const at of stamps) noteRender(replayAgent, at, true);
    await settle();
    const replayCommits = stamps.map((at) => noteCommit(replayAgent, base));
    const anyFresh = replayCommits.some((commit) => isPulsing(replayAgent, commit, base + 5));
    equal("a replayed history is not fresh", anyFresh, false);
    const replayGate = new RewindToastGate();
    equal(
      "…so its notice raises no capsule",
      replayGate.shouldToast({
        agentId: replayAgent,
        timestamp: new Date(base + 20),
        message: REWIND_COPY["zh-CN"].conversation,
        fresh: anyFresh,
        now: base + 5,
      }),
      false,
    );

    // A burst of many commits is also a batch (the path a longer history takes
    // when its rows commit one by one rather than all in the first pass).
    const bulkAgent = "bulk-rewind";
    for (let index = 0; index < 6; index += 1) {
      noteRender(bulkAgent, base + index, true);
      await settle();
      noteCommit(bulkAgent, base + index * 10);
    }
    const bulkCommit = noteCommit(bulkAgent, base + 100);
    equal("a commit burst is not fresh", isPulsing(bulkAgent, bulkCommit, base + 110), false);
  }

  console.log("wiring — index.client.tsx registers both halves");
  {
    const sourcePath = findRepoFile("index.client.tsx");
    check("index.client.tsx is readable", sourcePath !== undefined, `looked above ${__dirname}`);
    const source = sourcePath === undefined ? "" : fs.readFileSync(sourcePath, "utf8");
    check(
      "the transformer queries notification items",
      /id:\s*"dsh-rewind-notice"[\s\S]*?itemType:\s*"notification"/u.test(source),
      "query.itemType is not notification",
    );
    check(
      "the renderer is registered under the shared kind",
      source.includes("kind: REWIND_NOTICE_KIND") && source.includes("Component: RewindNotice"),
      "renderer registration missing",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`threw: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
