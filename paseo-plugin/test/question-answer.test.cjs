/**
 * Regressions for the question card's two answer channels and for the
 * "deny and stop" flag a permission response can carry.
 *
 * Paseo's question card returns one string per question in
 * `updatedInput.answers[<header>]`: a single-select answer is the chosen label
 * or, when the user typed in "Other", that text in its place; a multi-select one
 * joins the chosen labels and then any typed text with ", ". DSH keeps the two
 * apart — option labels in `selected`, typed text in `custom` — and does not
 * check labels against the question, so a mis-read answer is silently wrong
 * rather than a failure. That is what these tests pin:
 *
 *   - a label may itself contain ", ", so a multi-select string must be read
 *     against the question's own labels, never split on commas;
 *   - typed text reaches DSH as `custom`, never as a fake label;
 *   - a question with no options is always typed text;
 *   - a denial still answers every question, carrying the dismissal note in
 *     `custom` and no labels.
 *
 * A denial sent with `interrupt: true` ("拒绝并停止") also cancels the turn that
 * asked. Paseo's card answers through the provider's permission request rather
 * than a prompt, so without this the model kept running after the user stopped
 * it. The integration half drives the real provider over the scripted fake
 * bridge (`harness/fake-dsh-bridge.mjs`), whose `live` scenario raises one root
 * question and one child question that share a tool-call id:
 *
 *   - a plain denial only answers the card, with no cancel;
 *   - deny-and-stop on a card promoted from a native child cancels that child
 *     and only that child;
 *   - deny-and-stop on a root card cancels the root turn.
 *
 * The fake bridge logs every request frame it receives, which is where the
 * `session/cancel` assertion is made — the same protocol boundary the real
 * bridge sees.
 *
 * A pending card must also never replace an identical one: `#pendingPermissions`
 * is keyed by id, so a duplicate would leave the earlier reply waiting on a
 * promise nothing resolves and DSH would wait for its own timeout. The id
 * helper is unit-tested here; the question/plan id derivation that uses it is
 * exercised end to end by the cases above (root and child share a tool-call id).
 *
 * Run from `paseo-plugin` after `npm ci`:
 *
 *   node --test test/question-answer.test.cjs
 *
 * The provider is loaded straight from `server/provider.ts` (no build step)
 * through `register-typescript.cjs`, and the fake bridge is the scripted
 * stand-in: no real DSH, no profile, no model. `DSH_HOME` is pointed at a
 * throwaway directory for the length of the file.
 */
require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const REPO = path.join(__dirname, "..", "..");
const FAKE_BRIDGE = path.join(REPO, "harness", "fake-dsh-bridge.mjs");
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-question-answers-")));
const MODE_FILE = path.join(HOME, "fake-dsh-mode");
const LOG_FILE = path.join(HOME, "rpc.jsonl");

fs.chmodSync(FAKE_BRIDGE, 0o755);
fs.writeFileSync(MODE_FILE, "live\n");
process.env.DSH_HOME = HOME;
process.env.DSH_BINARY = FAKE_BRIDGE;
process.env.DSH_FAKE_MODE = "live";
process.env.DSH_FAKE_MODE_FILE = MODE_FILE;
process.env.DSH_FAKE_LOG = LOG_FILE;
process.on("exit", () => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// `export`ed from the session layer on purpose: these are the two judgements the
// bug was in (how one answer string is read, and how a pending-card id is made
// unique), and they are pure functions, so the cases can be written directly
// instead of only through a scripted bridge.
const { selectAnswer, uniqueCardId } = require("../server/session.ts");
const { createDshProvider } = require("../server/provider.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the answer string, read the way Paseo builds it ------------------------

/** Answer one question the way the card submits it, returning DSH's two channels. */
function answer(question, raw, header = question.header ?? "Header") {
  return selectAnswer(question, header, {
    behavior: "allow",
    updatedInput: { answers: { [header]: raw } },
  });
}

test("a single-select label is one selection, and typed text is custom, not a label", () => {
  const question = {
    id: "chosen",
    question: "Keep the file?",
    header: "Chosen",
    options: [{ label: "Keep it" }, { label: "Drop it" }],
  };
  assert.deepEqual(answer(question, "Keep it"), { selected: ["Keep it"] });
  assert.deepEqual(answer(question, "Neither, ask me later"), {
    selected: [],
    custom: "Neither, ask me later",
  });
  // A typed answer that merely starts with a label is still typed text: DSH is
  // told the model's own option, not a label the user never picked.
  assert.deepEqual(answer(question, "Keep it but rename the file"), {
    selected: [],
    custom: "Keep it but rename the file",
  });
});

test("a multi-select answer matches the question's own labels, so a label containing ', ' is not split", () => {
  const question = {
    id: "labels",
    question: "Which colours?",
    header: "Labels",
    multiSelect: true,
    options: [{ label: "Red" }, { label: "Red, warm" }, { label: "Blue" }],
  };
  // "Red, warm" ends exactly at a label boundary, so it is one option.
  assert.deepEqual(answer(question, "Red, warm, Blue"), { selected: ["Red, warm", "Blue"] });
  // Longest label first at each position: "Red, warm" wins over "Red".
  assert.deepEqual(answer(question, "Red, warm"), { selected: ["Red, warm"] });
  // Order the labels as the picker joined them, not the option list order.
  assert.deepEqual(answer(question, "Blue, Red"), { selected: ["Blue", "Red"] });
});

test("a multi-select answer keeps what no label accounts for as custom text", () => {
  const question = {
    id: "mixed",
    question: "Which colours?",
    header: "Mixed",
    multiSelect: true,
    options: [{ label: "Red" }, { label: "Red, warm" }, { label: "Blue" }],
  };
  assert.deepEqual(answer(question, "Blue, Red, and also green"), {
    selected: ["Blue", "Red"],
    custom: "and also green",
  });
  // "Other" with no label picked is entirely typed text — including a phrase
  // that contains ", ".
  assert.deepEqual(answer(question, "none of these, really"), {
    selected: [],
    custom: "none of these, really",
  });
});

test("a question with no options always answers as typed text", () => {
  const question = { id: "free", question: "Anything else?", header: "Free", options: [] };
  assert.deepEqual(answer(question, "ship it"), { selected: [], custom: "ship it" });
  const multi = { ...question, multiSelect: true };
  assert.deepEqual(answer(multi, "ship it"), { selected: [], custom: "ship it" });
});

test("a denial answers every question with the note and no labels", () => {
  const question = {
    id: "denied",
    question: "Keep the file?",
    header: "Denied",
    options: [{ label: "Keep it" }],
  };
  assert.deepEqual(
    selectAnswer(question, "Denied", { behavior: "deny", message: "Not now" }),
    { selected: [], custom: "Not now" },
  );
  assert.deepEqual(selectAnswer(question, "Denied", { behavior: "deny" }), { selected: [] });
});

test("a button-style resolution with no answer map falls back to the option index", () => {
  const question = {
    id: "button",
    question: "Keep the file?",
    header: "Button",
    options: [{ label: "Keep it" }, { label: "Drop it" }],
  };
  assert.deepEqual(selectAnswer(question, "Button", { behavior: "allow", selectedActionId: "1" }), {
    selected: ["Drop it"],
  });
  assert.deepEqual(selectAnswer(question, "Button", { behavior: "allow" }), { selected: [] });
});

// ---- a pending card always gets an id nothing else holds -------------------

test("a duplicate pending-card id gets a suffix instead of replacing the earlier card", () => {
  // Free id: returned unchanged so ordinary cards keep their readable id.
  assert.deepEqual(uniqueCardId("session:Q1", new Set(), 0), { id: "session:Q1", seq: 0 });
  // The shared literal a question without a call id falls back to collides; the
  // replacement takes a numeric suffix and the counter moves past it.
  const first = uniqueCardId("session:question", new Set(["session:question"]), 0);
  assert.deepEqual(first, { id: "session:question:0", seq: 1 });
  // A third card must skip the suffix already in use, not repeat it.
  const second = uniqueCardId("session:question", new Set(["session:question", first.id]), first.seq);
  assert.deepEqual(second, { id: "session:question:1", seq: 2 });
  // An id that already looks suffixed is still made unique as a whole.
  assert.deepEqual(uniqueCardId("session:q:0", new Set(["session:q:0"]), 0), {
    id: "session:q:0:0",
    seq: 1,
  });
});

// ---- the interrupt flag, driven through the real provider ------------------

const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.persistence",
  "session.list",
  "session.subsession",
  "permission",
];

function settle(predicate, label, ms = 8000) {
  const started = Date.now();
  return (async () => {
    while (Date.now() - started < ms) {
      const hit = predicate();
      if (hit !== undefined) return hit;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${label}`);
  })();
}

/** Request frames the fake bridge received, in arrival order. */
function frames() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter((line) => line !== "");
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A half-written line from the child's append: the next poll sees the whole one.
    }
  }
  return parsed;
}

/**
 * Open one root session against the fake bridge, prompt it once, and return the
 * root and child question cards the `live` scenario raises.
 */
async function openWithQuestions(t) {
  fs.writeFileSync(LOG_FILE, "");
  fs.writeFileSync(MODE_FILE, "live\n");
  const events = [];
  const conn = await createDshProvider().connect({ capabilities: CAPABILITIES });
  t.after(async () => {
    await conn.close().catch(() => undefined);
  });
  conn.onEvent((event) => events.push(event));
  const root = `answers-${Math.random().toString(36).slice(2, 10)}`;
  await conn.send({
    type: "session.open",
    sessionId: root,
    config: { cwd: HOME, mode: "build" },
    history: "skip",
  });
  await settle(() => events.find((e) => e.type === "session.ready" && e.sessionId === root), "session.ready");
  await conn.send({
    type: "session.prompt",
    sessionId: root,
    prompt: { clientMessageId: "prompt-1", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });
  const rootCard = await settle(
    () => events.find((e) => e.type === "session.permission" && e.sessionId === root && e.request.kind === "question"),
    "root question card",
  );
  const childScoped = `${root}:sub:child-A`;
  const childCard = await settle(
    () =>
      events.find(
        (e) => e.type === "session.permission" && e.sessionId === childScoped && e.request.kind === "question",
      ),
    "child question card",
  );
  return { conn, events, root, childScoped, rootCard, childCard };
}

const cancels = () => frames().filter((frame) => frame.method === "session/cancel");

test("a plain denial answers only its card; deny-and-stop on a child card cancels that child alone", async (t) => {
  const { conn, events, root, childScoped, rootCard, childCard } = await openWithQuestions(t);

  // The two cards share tool-call id "Q1" in the fake scenario; they must still
  // be distinct because each is scoped to the session that asked.
  assert.notEqual(rootCard.request.id, childCard.request.id);
  assert.equal(rootCard.request.id, `${root}:Q1`);
  assert.equal(childCard.request.id, `${childScoped}:Q1`);

  // A plain denial carries no interrupt: the card is answered, nothing is canceled.
  await conn.send({
    type: "session.permission",
    sessionId: root,
    permissionId: rootCard.request.id,
    response: { behavior: "deny", message: "Not now" },
  });
  await settle(
    () => events.find((e) => e.type === "session.permission_resolved" && e.permissionId === rootCard.request.id),
    "root card resolved",
  );
  await sleep(300);
  assert.deepEqual(cancels(), [], "a denial without `interrupt` must not cancel the turn");

  // Deny-and-stop on the promoted child card: only that child's turn is canceled,
  // by its own native session id.
  await conn.send({
    type: "session.permission",
    sessionId: childScoped,
    permissionId: childCard.request.id,
    response: { behavior: "deny", interrupt: true },
  });
  const cancel = await settle(() => cancels()[0], "session/cancel for the child", 8000);
  await sleep(300);
  assert.deepEqual(
    cancels().map((frame) => frame.params.sessionId),
    ["child-A"],
    "the child card's deny-and-stop cancels the asking child and nothing else",
  );
  assert.equal(cancel.params.sessionId, "child-A");
  // The child's own card resolves on the child, not the parent.
  assert(events.some((e) => e.type === "session.permission_resolved" && e.permissionId === childCard.request.id));
});

test("deny-and-stop on a root card cancels the root turn", async (t) => {
  const { conn, events, root, childCard, rootCard } = await openWithQuestions(t);

  await conn.send({
    type: "session.permission",
    sessionId: root,
    permissionId: rootCard.request.id,
    response: { behavior: "deny", interrupt: true },
  });
  await settle(() => cancels()[0], "session/cancel for the root", 8000);
  await sleep(300);
  assert.deepEqual(
    cancels().map((frame) => frame.params.sessionId),
    [root],
    "the root card's deny-and-stop cancels the root turn",
  );
  // The interruption abandons the cards still waiting on that turn: the child's
  // question has no answer left to receive, so it is denied rather than dropped.
  await settle(
    () => events.find((e) => e.type === "session.permission_resolved" && e.permissionId === childCard.request.id),
    "child card denied after the root interrupt",
  );
});