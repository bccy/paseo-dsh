/**
 * Offline assertions for the plugin's attachment-block translation.
 *
 * Paseo's `ProviderContent` is wider than DSH's prompt block set: an uploaded
 * file, a review, a forge change request or issue all ride in on the same
 * prompt. `toDshContent` used to accept only `text`/`image` and throw for
 * everything else, so attaching a zip on iOS failed the whole prompt with
 * `unsupported prompt content type "uploaded_file"` — even though the daemon
 * had already written the file to disk.
 *
 * The fix mirrors Paseo's own providers (Claude, Codex, …): those blocks render
 * to a **text** block via `@getpaseo/server@0.12.0`
 * (`dist/server/server/agent/prompt-attachments.js`,
 * `renderPromptAttachmentAsText`), and the wording, field order and diff-line
 * layout below are reproduced from it verbatim. `text` and `image` keep their
 * exact previous shapes, and a genuinely unknown type still throws instead of
 * being dropped.
 *
 * The plugin is TypeScript, so compile it first — into a repo-internal
 * directory, because the compiled file must still resolve the plugin's own
 * `node_modules` upward:
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg-attach --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg-attach/package.json
 *   cp ../harness/uploaded-file-check.cjs .dbg-attach/
 *   cd .dbg-attach && node uploaded-file-check.cjs
 *   rm -rf ../.dbg-attach
 *
 * The type errors tsc prints under `--moduleResolution node` are expected (the
 * `@getpaseo/plugin` types need the project's bundler resolution); the emitted
 * JavaScript is what runs.
 */
const { renderPromptAttachmentAsText, toDshContent } = require("./server/session.js");

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** Exact-shape comparison: key order and extra keys both count. */
const json = (value) => JSON.stringify(value);

// ---------------------------------------------------------------------------
// uploaded_file — the block iOS sends for an attachment.
// ---------------------------------------------------------------------------

const uploadedFile = {
  type: "uploaded_file",
  id: "up-1",
  fileName: "报表.zip",
  mimeType: "application/zip",
  size: 12345,
  path: "/home/agent/.paseo/uploads/up-1/报表.zip",
};

check(
  "uploaded_file renders Paseo's four lines, in order",
  renderPromptAttachmentAsText(uploadedFile) ===
    [
      "Uploaded file: 报表.zip",
      "Path: /home/agent/.paseo/uploads/up-1/报表.zip",
      "MIME: application/zip",
      "Size: 12345 bytes",
    ].join("\n"),
  json(renderPromptAttachmentAsText(uploadedFile)),
);

check(
  "a zero-byte upload still says `0 bytes`",
  renderPromptAttachmentAsText({ ...uploadedFile, size: 0 }) ===
    [
      "Uploaded file: 报表.zip",
      "Path: /home/agent/.paseo/uploads/up-1/报表.zip",
      "MIME: application/zip",
      "Size: 0 bytes",
    ].join("\n"),
  json(renderPromptAttachmentAsText({ ...uploadedFile, size: 0 })),
);

check(
  "uploaded_file becomes one plain text block (no extra fields)",
  json(toDshContent(uploadedFile)) ===
    json({
      type: "text",
      text: [
        "Uploaded file: 报表.zip",
        "Path: /home/agent/.paseo/uploads/up-1/报表.zip",
        "MIME: application/zip",
        "Size: 12345 bytes",
      ].join("\n"),
    }),
  json(toDshContent(uploadedFile)),
);

// ---------------------------------------------------------------------------
// review — code-review comments with their diff context.
// ---------------------------------------------------------------------------

const review = {
  type: "review",
  mimeType: "application/paseo-review",
  cwd: "/work/repo",
  mode: "base",
  baseRef: "main",
  comments: [
    {
      filePath: "src/a.ts",
      side: "new",
      lineNumber: 12,
      body: "这里应该判空",
      context: {
        hunkHeader: "@@ -10,3 +10,4 @@",
        targetLine: { oldLineNumber: 11, newLineNumber: 12, type: "add", content: "const x = 1;" },
        lines: [
          { oldLineNumber: 10, newLineNumber: 10, type: "context", content: "function f() {" },
          { oldLineNumber: 11, newLineNumber: 12, type: "add", content: "const x = 1;" },
          { oldLineNumber: null, newLineNumber: 13, type: "add", content: "return x;" },
          { oldLineNumber: 1, newLineNumber: null, type: "remove", content: "old();" },
        ],
      },
    },
    {
      filePath: "src/b.ts",
      side: "old",
      lineNumber: 3,
      body: "删掉",
      context: {
        hunkHeader: "@@ -1,2 +1,1 @@",
        targetLine: { oldLineNumber: 3, newLineNumber: null, type: "remove", content: "legacy();" },
        lines: [{ oldLineNumber: 2, newLineNumber: 1, type: "context", content: "ok();" }],
      },
    },
  ],
};

check(
  "review renders header, each comment, and its diff lines",
  renderPromptAttachmentAsText(review) ===
    [
      "Paseo review attachment (base)",
      "CWD: /work/repo",
      "Base: main",
      "",
      "Comment 1: src/a.ts:new:12",
      "这里应该判空",
      "@@ -10,3 +10,4 @@",
      "  10 10  function f() {",
      "> 11 12 +const x = 1;",
      "   - 13 +return x;",
      "   1  - -old();",
      "",
      "Comment 2: src/b.ts:old:3",
      "删掉",
      "@@ -1,2 +1,1 @@",
      "   2  1  ok();",
    ].join("\n"),
  json(renderPromptAttachmentAsText(review)),
);

check(
  "a review with no base ref and no comments is just its two header lines",
  renderPromptAttachmentAsText({ ...review, mode: "uncommitted", baseRef: null, comments: [] }) ===
    ["Paseo review attachment (uncommitted)", "CWD: /work/repo"].join("\n"),
  json(renderPromptAttachmentAsText({ ...review, mode: "uncommitted", baseRef: null, comments: [] })),
);

// ---------------------------------------------------------------------------
// forge change requests and issues (including the legacy wire kinds).
// ---------------------------------------------------------------------------

check(
  "forge_change_request brands the forge and orders Project/Base/Head/body",
  renderPromptAttachmentAsText({
    type: "forge_change_request",
    mimeType: "application/paseo-forge-change-request",
    forge: "gitlab",
    number: 42,
    title: "Add retry",
    url: "https://gitlab.com/x/y/-/merge_requests/42",
    body: "Body text",
    projectPath: "/work",
    baseRefName: "main",
    headRefName: "feat",
  }) ===
    [
      "GitLab MR !42: Add retry",
      "https://gitlab.com/x/y/-/merge_requests/42",
      "Project: /work",
      "Base: main",
      "Head: feat",
      "",
      "Body text",
    ].join("\n"),
  "gitlab uses MR and `!`",
);

check(
  "legacy github_pr renders as GitHub PR",
  renderPromptAttachmentAsText({
    type: "github_pr",
    mimeType: "application/github-pr",
    number: 7,
    title: "Fix bug",
    url: "https://github.com/x/y/pull/7",
    body: null,
    baseRefName: "main",
    headRefName: null,
  }) === ["GitHub PR #7: Fix bug", "https://github.com/x/y/pull/7", "Base: main"].join("\n"),
  "legacy wire kind keeps the github branding",
);

check(
  "forge_issue renders Project and body",
  renderPromptAttachmentAsText({
    type: "forge_issue",
    mimeType: "application/paseo-forge-issue",
    forge: "gitea",
    number: 5,
    title: "Crash",
    url: "https://gitea/5",
    body: "steps",
    projectPath: "/w",
  }) === ["Gitea Issue #5: Crash", "https://gitea/5", "Project: /w", "", "steps"].join("\n"),
  "gitea issue",
);

check(
  "legacy github_issue renders as GitHub Issue",
  renderPromptAttachmentAsText({
    type: "github_issue",
    mimeType: "application/github-issue",
    number: 9,
    title: "Docs",
    url: "https://github.com/x/y/issues/9",
    body: null,
  }) === ["GitHub Issue #9: Docs", "https://github.com/x/y/issues/9"].join("\n"),
  "legacy wire kind",
);

check(
  "an unknown forge id falls back to Paseo's neutral presentation",
  renderPromptAttachmentAsText({
    type: "forge_change_request",
    mimeType: "application/paseo-forge-change-request",
    forge: "selfhosted",
    number: 8,
    title: "T",
    url: "https://sh/8",
  }) === ["selfhosted PR #8: T", "https://sh/8"].join("\n"),
  "self-hosted forge a newer daemon reports",
);

check(
  "a forge-less change request keeps Paseo's neutral label (parity, not our format)",
  renderPromptAttachmentAsText({
    type: "forge_change_request",
    mimeType: "application/paseo-forge-change-request",
    number: 3,
    title: "T",
    url: "https://forge/3",
    body: null,
  }) === ["undefined PR #3: T", "https://forge/3"].join("\n"),
  "mirrors getForgeDefinitionOrNeutral(undefined) exactly",
);

// ---------------------------------------------------------------------------
// text and image blocks must be untouched, and text attachments stay text.
// ---------------------------------------------------------------------------

check(
  "a text block is passed through with exactly its two fields",
  json(toDshContent({ type: "text", text: "hi" })) === json({ type: "text", text: "hi" }),
  json(toDshContent({ type: "text", text: "hi" })),
);

check(
  "a text attachment block still reaches DSH as its text, with no extra fields",
  json(toDshContent({ type: "text", mimeType: "text/plain", text: "hello attachment", title: "T", contextKind: "chat_history" })) ===
    json({ type: "text", text: "hello attachment" }),
  "Paseo's own adapters take the `type === \"text\"` branch first too",
);

check(
  "the renderer's own text case returns the attachment text",
  renderPromptAttachmentAsText({ type: "text", mimeType: "text/plain", text: "hello attachment" }) === "hello attachment",
  "mirrors the upstream switch case",
);

check(
  "an image block is passed through with exactly its three fields",
  json(toDshContent({ type: "image", data: "QUJD", mimeType: "image/png" })) ===
    json({ type: "image", data: "QUJD", mimeType: "image/png" }),
  "images keep their native DSH block; Paseo never inlines an attachment as image",
);

// ---------------------------------------------------------------------------
// A truly unknown type must still fail loudly, never silently vanish.
// ---------------------------------------------------------------------------

check(
  "an unknown content type throws, naming the wire type",
  (() => {
    try {
      toDshContent({ type: "mystery_block" });
      return false;
    } catch (error) {
      return error instanceof Error && error.message === 'unsupported prompt content type "mystery_block"';
    }
  })(),
  "the model must not receive a prompt silently missing a block",
);

check(
  "an unknown type is never downgraded to an empty text block",
  (() => {
    try {
      const translated = toDshContent({ type: "browser_element", tag: "div" });
      return json(translated) === json({ type: "text", text: "" });
    } catch {
      return false;
    }
  })() === false,
  "no silent drop and no empty block",
);

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`  ${result.pass ? "PASS" : "FAIL"}  ${result.name}${result.pass ? "" : `  — ${result.detail}`}`);
}
console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
