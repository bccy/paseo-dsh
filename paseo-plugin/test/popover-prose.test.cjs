require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseInlineSpans, parseProseBlocks } = require("../client/popover-prose.ts");

test("parseInlineSpans parses code and strong spans without dropping text", () => {
  assert.deepEqual(parseInlineSpans(""), []);
  assert.deepEqual(parseInlineSpans("纯文本 plain text"), [
    { kind: "text", text: "纯文本 plain text" },
  ]);
  assert.deepEqual(parseInlineSpans("改写 `popover-ui.tsx` 并保持 **原生无框** 风格"), [
    { kind: "text", text: "改写 " },
    { kind: "code", text: "popover-ui.tsx" },
    { kind: "text", text: " 并保持 " },
    { kind: "strong", text: "原生无框" },
    { kind: "text", text: " 风格" },
  ]);
  // Strong markers inside inline code stay literal.
  assert.deepEqual(parseInlineSpans("代码 `**not bold**` 结束"), [
    { kind: "text", text: "代码 " },
    { kind: "code", text: "**not bold**" },
    { kind: "text", text: " 结束" },
  ]);
});

test("parseInlineSpans preserves unmatched and empty delimiters literally", () => {
  assert.deepEqual(parseInlineSpans("未闭合 `code 和 **strong"), [
    { kind: "text", text: "未闭合 `code 和 **strong" },
  ]);
  // An unmatched strong marker does not block a later code span.
  assert.deepEqual(parseInlineSpans("注意 **未闭合 但 `tint()` 正常"), [
    { kind: "text", text: "注意 **未闭合 但 " },
    { kind: "code", text: "tint()" },
    { kind: "text", text: " 正常" },
  ]);
  // Empty delimiters are preserved rather than silently dropped.
  assert.deepEqual(parseInlineSpans("空 `` 和 **** 保留"), [
    { kind: "text", text: "空 `` 和 **** 保留" },
  ]);
});

test("parseProseBlocks handles multi-section Chinese brief with background rail, intro + 1)..6) list, and delivery kicker", () => {
  const input = [
    "背景 (Lead 提供，勿改动): 当前 team/goal/jobs 三个 popover 的详情页各自拼接文案，样式不统一。",
    "",
    "任务目标：抽离共享原语并让长文本具备清晰排版。",
    "要求覆盖：",
    "1) 视觉统一：坚持 Paseo 原生无框 `surface0` 风格，禁止 `surface1` 卡片",
    "2) 分层标题：识别 **背景** 与普通 kicker",
    "3) 列表缩进：悬挂缩进且编号使用等宽数字",
    "4) 主题适配: 深浅色均通过 `tint()` 派生",
    "5) 无依赖解析：纯 TS 实现，不引入 React Native",
    "6) 单元测试：覆盖中英文与边界用例",
    "",
    "交付与验收：运行 `node paseo-plugin/test/popover-prose.test.cjs` 与 `tsc --noEmit` 全绿。",
  ].join("\r\n");

  const blocks = parseProseBlocks(input);
  assert.deepEqual(blocks, [
    { kind: "kicker", text: "背景 (Lead 提供，勿改动)" },
    {
      kind: "paragraph",
      spans: [
        {
          kind: "text",
          text: "当前 team/goal/jobs 三个 popover 的详情页各自拼接文案，样式不统一。",
        },
      ],
      muted: true,
      rail: true,
    },
    { kind: "kicker", text: "任务目标" },
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "抽离共享原语并让长文本具备清晰排版。" }],
    },
    { kind: "kicker", text: "要求覆盖" },
    {
      kind: "list",
      ordered: true,
      items: [
        {
          marker: "1.",
          lead: "视觉统一：",
          spans: [
            { kind: "text", text: "坚持 Paseo 原生无框 " },
            { kind: "code", text: "surface0" },
            { kind: "text", text: " 风格，禁止 " },
            { kind: "code", text: "surface1" },
            { kind: "text", text: " 卡片" },
          ],
        },
        {
          marker: "2.",
          lead: "分层标题：",
          spans: [
            { kind: "text", text: "识别 " },
            { kind: "strong", text: "背景" },
            { kind: "text", text: " 与普通 kicker" },
          ],
        },
        {
          marker: "3.",
          lead: "列表缩进：",
          spans: [{ kind: "text", text: "悬挂缩进且编号使用等宽数字" }],
        },
        {
          marker: "4.",
          lead: "主题适配:",
          spans: [
            { kind: "text", text: "深浅色均通过 " },
            { kind: "code", text: "tint()" },
            { kind: "text", text: " 派生" },
          ],
        },
        {
          marker: "5.",
          lead: "无依赖解析：",
          spans: [{ kind: "text", text: "纯 TS 实现，不引入 React Native" }],
        },
        {
          marker: "6.",
          lead: "单元测试：",
          spans: [{ kind: "text", text: "覆盖中英文与边界用例" }],
        },
      ],
    },
    { kind: "kicker", text: "交付与验收" },
    {
      kind: "paragraph",
      spans: [
        { kind: "text", text: "运行 " },
        { kind: "code", text: "node paseo-plugin/test/popover-prose.test.cjs" },
        { kind: "text", text: " 与 " },
        { kind: "code", text: "tsc --noEmit" },
        { kind: "text", text: " 全绿。" },
      ],
    },
  ]);
});

test("parseProseBlocks marks English Background and Context kickers with muted + rail", () => {
  const input = [
    "Background: Popovers share one native visual language.",
    "",
    "context (from ticket):",
    "Keep Hermes compatibility and avoid CSS.",
    "",
    "Scope: Only touch the three shared files.",
  ].join("\n");

  const blocks = parseProseBlocks(input);
  assert.deepEqual(blocks, [
    { kind: "kicker", text: "Background" },
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "Popovers share one native visual language." }],
      muted: true,
      rail: true,
    },
    { kind: "kicker", text: "context (from ticket)" },
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "Keep Hermes compatibility and avoid CSS." }],
      muted: true,
      rail: true,
    },
    { kind: "kicker", text: "Scope" },
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "Only touch the three shared files." }],
    },
  ]);
});

test("parseProseBlocks parses Markdown headings, unordered lists, Chinese 、 lists, and inline formatting", () => {
  const input = [
    "# Level 1",
    "## Level 2",
    "### Acceptance",
    "- **API stability**: keep exact exports",
    "* `popover-prose.ts`: zero react imports",
    "• Dark & light theme support",
    "1、 第一项",
    "2、第二项",
  ].join("\n");

  const blocks = parseProseBlocks(input);
  assert.deepEqual(blocks, [
    { kind: "heading", text: "Level 1" },
    { kind: "heading", text: "Level 2" },
    { kind: "heading", text: "Acceptance" },
    {
      kind: "list",
      ordered: false,
      items: [
        {
          marker: "•",
          lead: "API stability:",
          spans: [{ kind: "text", text: "keep exact exports" }],
        },
        {
          marker: "•",
          spans: [
            { kind: "code", text: "popover-prose.ts" },
            { kind: "text", text: ": zero react imports" },
          ],
        },
        {
          marker: "•",
          spans: [{ kind: "text", text: "Dark & light theme support" }],
        },
      ],
    },
    {
      kind: "list",
      ordered: true,
      items: [
        { marker: "1.", spans: [{ kind: "text", text: "第一项" }] },
        { marker: "2.", spans: [{ kind: "text", text: "第二项" }] },
      ],
    },
  ]);
});

test("parseProseBlocks does not misclassify URLs, file:line refs, or overlong prefixes as kickers or list leads", () => {
  const input = [
    "https://example.com/docs",
    "",
    "http://localhost:3000/api: status check",
    "",
    "server/provider.ts:42 threw an error",
    "",
    "This prefix is definitely longer than twenty-eight characters: keep as paragraph",
    "",
    "- https://example.com: link description",
    "- A: one char is too short for lead",
    "- This lead phrase exceeds twenty-four characters: keep in spans",
  ].join("\n");

  const blocks = parseProseBlocks(input);
  assert.deepEqual(blocks, [
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "https://example.com/docs" }],
    },
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "http://localhost:3000/api: status check" }],
    },
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "server/provider.ts:42 threw an error" }],
    },
    {
      kind: "paragraph",
      spans: [
        {
          kind: "text",
          text: "This prefix is definitely longer than twenty-eight characters: keep as paragraph",
        },
      ],
    },
    {
      kind: "list",
      ordered: false,
      items: [
        {
          marker: "•",
          spans: [{ kind: "text", text: "https://example.com: link description" }],
        },
        {
          marker: "•",
          spans: [{ kind: "text", text: "A: one char is too short for lead" }],
        },
        {
          marker: "•",
          spans: [
            {
              kind: "text",
              text: "This lead phrase exceeds twenty-four characters: keep in spans",
            },
          ],
        },
      ],
    },
  ]);
});

test("parseProseBlocks preserves ordinary multi-line paragraphs and empty input", () => {
  assert.deepEqual(parseProseBlocks("   \n\r\n  "), []);

  const blocks = parseProseBlocks("第一行普通说明\n第二行继续说明\n\nPlain line one\nPlain line two");
  assert.deepEqual(blocks, [
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "第一行普通说明\n第二行继续说明" }],
    },
    {
      kind: "paragraph",
      spans: [{ kind: "text", text: "Plain line one\nPlain line two" }],
    },
  ]);
});
