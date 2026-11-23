/**
 * Offline assertions for the strict semantic-colour code highlighter.
 *
 * Verifies palette 1 invariants on `client/code-highlight.ts` and static guards
 * on `client/highlighted-code.tsx`:
 *   1. Lossless tokenization across TS/JS/Python/Rust/SQL/JSON/Shell/CJK/edge cases.
 *   2. Adjacent token coalescing (no two consecutive tokens share the same kind).
 *   3. Accurate token classification per mode (`json`, `shell`, `code`, `plain`)
 *      and cross-line block comments.
 *   4. Safe degradation on long lines (>400 chars) and long snippets (>24000 chars).
 *   5. Strict `TokenColors` semantic mapping with zero hardcoded colour literals
 *      and zero React/React Native imports in `code-highlight.ts`.
 *
 * Run (from repo root, auto-builds into a temporary dir and cleans up):
 *   node harness/code-highlight-check.cjs
 *
 * Or inside a `plugin-build.cjs` compiled directory (same as `offline-checks.cjs`
 * `compiledChecks`):
 *   cp harness/code-highlight-check.cjs paseo-plugin/.dbg/
 *   cd paseo-plugin/.dbg && node code-highlight-check.cjs
 */
"use strict";

const { existsSync, readFileSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

function loadHighlightModule() {
  const localCompiled = resolve(__dirname, "client", "code-highlight.js");
  if (existsSync(localCompiled)) {
    return { mod: require(localCompiled), cleanup: () => {} };
  }
  const envBuild = process.env.PASEO_PLUGIN_BUILD;
  if (envBuild && existsSync(join(envBuild, "client", "code-highlight.js"))) {
    return { mod: require(join(envBuild, "client", "code-highlight.js")), cleanup: () => {} };
  }
  const { buildPlugin } = require(resolve(__dirname, "plugin-build.cjs"));
  const dirName = `.dbg-code-highlight-check-${process.pid}`;
  const outDir = buildPlugin({ dir: dirName });
  return {
    mod: require(join(outDir, "client", "code-highlight.js")),
    cleanup: () => {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

function locateSource(relFromPlugin) {
  const candidates = [
    resolve(__dirname, "..", "paseo-plugin", relFromPlugin),
    resolve(__dirname, "..", relFromPlugin),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate source file ${relFromPlugin}`);
}

const { mod: highlight, cleanup } = loadHighlightModule();
const {
  HIGHLIGHT_MAX_LINE_CHARS,
  HIGHLIGHT_MAX_TOTAL_CHARS,
  highlightModeFor,
  tokenColor,
  tokenizeCode,
  tokenizeLine,
} = highlight;

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(label, actual, expected) {
  check(
    label,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertLineInvariants(label, line, tokens) {
  const rejoined = tokens.map((t) => t.text).join("");
  equal(`${label}: lossless rejoin`, rejoined, line);
  const allNonEmpty = tokens.every((t) => typeof t.text === "string" && t.text.length > 0);
  check(`${label}: no empty token text`, allNonEmpty, JSON.stringify(tokens));
  let adjacentDup = false;
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].kind === tokens[i - 1].kind) {
      adjacentDup = true;
      break;
    }
  }
  check(`${label}: adjacent tokens coalesced`, !adjacentDup, JSON.stringify(tokens));
}

function assertCodeInvariants(label, text, rows) {
  const expectedLines = text.split("\n");
  equal(`${label}: line count matches`, rows.length, expectedLines.length);
  for (let i = 0; i < expectedLines.length; i += 1) {
    assertLineInvariants(`${label}[line ${i}]`, expectedLines[i], rows[i]);
  }
  const full = rows.map((row) => row.map((t) => t.text).join("")).join("\n");
  equal(`${label}: full text lossless`, full, text);
}

function hasToken(tokens, kind, text) {
  return tokens.some((t) => t.kind === kind && t.text === text);
}

function findTokenCovering(tokens, substring) {
  return tokens.find((t) => t.text.includes(substring));
}

try {
  console.log("1. highlightModeFor mapping");
  {
    for (const lang of [undefined, "", "   ", "text", "plain", "txt", "log", "markdown", "md", "diff"]) {
      equal(`plain lang ${JSON.stringify(lang)}`, highlightModeFor(lang), "plain");
    }
    for (const lang of ["json", "jsonc", "json5", "JSON", ".json", "language-json"]) {
      equal(`json lang ${JSON.stringify(lang)}`, highlightModeFor(lang), "json");
    }
    for (const lang of ["sh", "bash", "zsh", "shell", "shellscript", "fish", "powershell", "pwsh", "cmd"]) {
      equal(`shell lang ${JSON.stringify(lang)}`, highlightModeFor(lang), "shell");
    }
    for (const lang of [
      "ts", "tsx", "js", "jsx", "typescript", "javascript", "py", "python",
      "rs", "rust", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php",
      "swift", "kt", "sql", "css", "scss", "html", "xml", "yaml", "yml",
      "toml", "ini", "dockerfile", "makefile", ".tsx", "language-typescript",
    ]) {
      equal(`code lang ${JSON.stringify(lang)}`, highlightModeFor(lang), "code");
    }
    for (const lang of ["unknownlang", "my-custom-log", "foo_bar"]) {
      equal(`unknown lang ${JSON.stringify(lang)} falls back to plain`, highlightModeFor(lang), "plain");
    }
  }

  console.log("2. lossless & coalescing invariants across edge cases");
  {
    const edgeSamples = [
      { lang: "ts", text: "" },
      { lang: "ts", text: "\n\n" },
      { lang: "ts", text: 'const msg = "你好，世界\\n\\t\\"quoted\\""; // 中文注释 🚀' },
      { lang: "ts", text: 'const unterminated = "missing quote at eol' },
      { lang: "ts", text: 'const trailingSlash = "abc\\' },
      { lang: "ts", text: "const tpl = `template \\`escaped\\` \t end" },
      { lang: "py", text: "def f(x):\n\treturn '中文' + \"unterminated\\" },
      { lang: "json", text: '{\n  "键": "值\\"\\t",\n  "unterminated": "abc\\\n}' },
      { lang: "sh", text: "echo 'single \\' \"unterminated\t中文 # 注释" },
      { lang: "plain", text: "plain\tline\n\n中文内容 123" },
    ];
    for (let i = 0; i < edgeSamples.length; i += 1) {
      const sample = edgeSamples[i];
      const rows = tokenizeCode(sample.text, sample.lang);
      assertCodeInvariants(`edge#${i}(${sample.lang})`, sample.text, rows);
    }

    const emptyTokens = tokenizeLine("", "code");
    equal("empty line yields []", emptyTokens.length, 0);
  }

  console.log("3. JSON mode classification");
  {
    const line = '{"key" : "value", "neg": -3.14e+2, "ok": true, "bad": false, "nil": null, "arr": ["a", 42]} // trailing';
    const tokens = tokenizeLine(line, "json");
    assertLineInvariants("json-full", line, tokens);
    check('json key "key" -> keyword', hasToken(tokens, "keyword", '"key"'), JSON.stringify(tokens));
    check('json key "neg" -> keyword', hasToken(tokens, "keyword", '"neg"'), JSON.stringify(tokens));
    check('json value "value" -> string', hasToken(tokens, "string", '"value"'), JSON.stringify(tokens));
    check('json array elem "a" -> string', hasToken(tokens, "string", '"a"'), JSON.stringify(tokens));
    check("json number -3.14e+2 -> number", hasToken(tokens, "number", "-3.14e+2"), JSON.stringify(tokens));
    check("json integer 42 -> number", hasToken(tokens, "number", "42"), JSON.stringify(tokens));
    check("json true -> number", hasToken(tokens, "number", "true"), JSON.stringify(tokens));
    check("json false -> number", hasToken(tokens, "number", "false"), JSON.stringify(tokens));
    check("json null -> number", hasToken(tokens, "number", "null"), JSON.stringify(tokens));
    check("json // comment -> comment", hasToken(tokens, "comment", "// trailing"), JSON.stringify(tokens));
    check("json punctuation includes {", tokens.some((t) => t.kind === "punctuation" && t.text.includes("{")), JSON.stringify(tokens));
  }

  console.log("4. Shell mode classification");
  {
    const cmd = 'FOO=bar BAZ="hello # world" npm run test --watch -j 4 | grep "ok" > out.log 2>&1 # run';
    const tokens = tokenizeLine(cmd, "shell");
    assertLineInvariants("shell-pipeline", cmd, tokens);
    check("shell command after env assign -> keyword (npm)", hasToken(tokens, "keyword", "npm"), JSON.stringify(tokens));
    check("shell command after pipe -> keyword (grep)", hasToken(tokens, "keyword", "grep"), JSON.stringify(tokens));
    check("shell env quoted string -> string", hasToken(tokens, "string", '"hello # world"'), JSON.stringify(tokens));
    check("shell arg string -> string", hasToken(tokens, "string", '"ok"'), JSON.stringify(tokens));
    check("shell long flag --watch -> number", hasToken(tokens, "number", "--watch"), JSON.stringify(tokens));
    check("shell short flag -j -> number", hasToken(tokens, "number", "-j"), JSON.stringify(tokens));
    check("shell numeric arg 4 -> number", hasToken(tokens, "number", "4"), JSON.stringify(tokens));
    check("shell pipe | -> punctuation", hasToken(tokens, "punctuation", "|"), JSON.stringify(tokens));
    check("shell redirect 2>&1 -> punctuation", hasToken(tokens, "punctuation", "2>&1"), JSON.stringify(tokens));
    check("shell trailing comment -> comment", hasToken(tokens, "comment", "# run"), JSON.stringify(tokens));

    const ctrl = "if [ -f 'a.txt' ]; then sudo git status && echo $(date); fi";
    const ctrlTokens = tokenizeLine(ctrl, "shell");
    assertLineInvariants("shell-control", ctrl, ctrlTokens);
    for (const kw of ["if", "then", "sudo", "git", "echo", "date", "fi"]) {
      check(`shell keyword/cmd ${kw}`, hasToken(ctrlTokens, "keyword", kw), JSON.stringify(ctrlTokens));
    }
    check("shell flag -f -> number", hasToken(ctrlTokens, "number", "-f"), JSON.stringify(ctrlTokens));
    check("shell single quoted -> string", hasToken(ctrlTokens, "string", "'a.txt'"), JSON.stringify(ctrlTokens));
    check("shell && -> punctuation", hasToken(ctrlTokens, "punctuation", "&&"), JSON.stringify(ctrlTokens));
    check("shell $( -> punctuation", hasToken(ctrlTokens, "punctuation", "$("), JSON.stringify(ctrlTokens));

    const flagEq = 'node cli.js --msg="hello" --count=42';
    const flagEqTokens = tokenizeLine(flagEq, "shell");
    assertLineInvariants("shell-flag-eq", flagEq, flagEqTokens);
    check("shell --msg -> number", hasToken(flagEqTokens, "number", "--msg"), JSON.stringify(flagEqTokens));
    check('shell "hello" -> string', hasToken(flagEqTokens, "string", '"hello"'), JSON.stringify(flagEqTokens));
    check("shell --count -> number", hasToken(flagEqTokens, "number", "--count"), JSON.stringify(flagEqTokens));
    check("shell 42 -> number", hasToken(flagEqTokens, "number", "42"), JSON.stringify(flagEqTokens));

    // Leading escaped quote in bare word must not split into an unterminated string
    const escapedQuote = 'echo \\"hi\\" && echo ok';
    const eqTokens = tokenizeLine(escapedQuote, "shell");
    assertLineInvariants("shell-escaped-quote", escapedQuote, eqTokens);
    check(
      'shell echo \\"hi\\" does not misparse as string',
      !eqTokens.some((t) => t.kind === "string"),
      JSON.stringify(eqTokens),
    );
    check(
      'shell echo \\"hi\\" preserves following && operator',
      hasToken(eqTokens, "punctuation", "&&"),
      JSON.stringify(eqTokens),
    );
    check(
      'shell echo \\"hi\\" preserves following echo command',
      eqTokens.filter((t) => t.kind === "keyword" && t.text === "echo").length === 2,
      JSON.stringify(eqTokens),
    );
  }

  console.log("5. Code mode classification & multi-line block comments");
  {
    const tsLine = 'export const limit = 0xff + 3.14; // 限制';
    const tsTokens = tokenizeLine(tsLine, "code");
    assertLineInvariants("code-ts", tsLine, tsTokens);
    check("ts export -> keyword", hasToken(tsTokens, "keyword", "export"), JSON.stringify(tsTokens));
    check("ts const -> keyword", hasToken(tsTokens, "keyword", "const"), JSON.stringify(tsTokens));
    check("ts 0xff -> number", hasToken(tsTokens, "number", "0xff"), JSON.stringify(tsTokens));
    check("ts 3.14 -> number", hasToken(tsTokens, "number", "3.14"), JSON.stringify(tsTokens));
    check("ts // comment -> comment", hasToken(tsTokens, "comment", "// 限制"), JSON.stringify(tsTokens));
    check("ts ; -> punctuation", hasToken(tsTokens, "punctuation", ";"), JSON.stringify(tsTokens));

    const pySnippet = [
      'def greet(name):  # python comment',
      '    return "hello # inside string", None, True',
    ].join("\n");
    const pyRows = tokenizeCode(pySnippet, "python");
    assertCodeInvariants("code-py", pySnippet, pyRows);
    check("py def -> keyword", hasToken(pyRows[0], "keyword", "def"), JSON.stringify(pyRows[0]));
    check("py # comment -> comment", hasToken(pyRows[0], "comment", "# python comment"), JSON.stringify(pyRows[0]));
    check('py string keeps # intact', hasToken(pyRows[1], "string", '"hello # inside string"'), JSON.stringify(pyRows[1]));
    check("py None -> number", hasToken(pyRows[1], "number", "None"), JSON.stringify(pyRows[1]));
    check("py True -> number", hasToken(pyRows[1], "number", "True"), JSON.stringify(pyRows[1]));

    const sqlLine = "SELECT id FROM users WHERE active = true -- active rows";
    const sqlTokens = tokenizeLine(sqlLine, "code");
    assertLineInvariants("code-sql", sqlLine, sqlTokens);
    check("sql SELECT -> keyword", hasToken(sqlTokens, "keyword", "SELECT"), JSON.stringify(sqlTokens));
    check("sql FROM -> keyword", hasToken(sqlTokens, "keyword", "FROM"), JSON.stringify(sqlTokens));
    check("sql -- comment -> comment", hasToken(sqlTokens, "comment", "-- active rows"), JSON.stringify(sqlTokens));

    const decLine = "for (let i = 10; i > 0; i--) { sum += i; }";
    const decTokens = tokenizeLine(decLine, "code");
    assertLineInvariants("code-decrement", decLine, decTokens);
    check("i-- is not treated as SQL comment", !decTokens.some((t) => t.kind === "comment"), JSON.stringify(decTokens));

    const preprocLine = "#include <stdio.h>";
    const preprocTokens = tokenizeLine(preprocLine, "code");
    assertLineInvariants("code-c-preproc", preprocLine, preprocTokens);
    check("C #include is not treated as comment", !preprocTokens.some((t) => t.kind === "comment"), JSON.stringify(preprocTokens));

    const rustAttrLine = "#[derive(Debug)]";
    const rustAttrTokens = tokenizeLine(rustAttrLine, "code");
    assertLineInvariants("code-rust-attr", rustAttrLine, rustAttrTokens);
    check("Rust #[derive] is not treated as comment", !rustAttrTokens.some((t) => t.kind === "comment"), JSON.stringify(rustAttrTokens));

    const multiComment = [
      "const a = 1; /* start comment",
      "still inside comment with const and 123",
      "",
      "end comment */ const b = 2;",
    ].join("\n");
    const mcRows = tokenizeCode(multiComment, "ts");
    assertCodeInvariants("code-multiline-block-comment", multiComment, mcRows);
    check("line 0 opens block comment", hasToken(mcRows[0], "comment", "/* start comment"), JSON.stringify(mcRows[0]));
    equal("line 1 is single comment token", mcRows[1].length, 1);
    equal("line 1 kind is comment", mcRows[1][0].kind, "comment");
    equal("line 2 empty inside comment stays []", mcRows[2].length, 0);
    check("line 3 closes block comment", hasToken(mcRows[3], "comment", "end comment */"), JSON.stringify(mcRows[3]));
    check("line 3 resumes code after */ (const)", hasToken(mcRows[3], "keyword", "const"), JSON.stringify(mcRows[3]));
    check("line 3 resumes code after */ (2)", hasToken(mcRows[3], "number", "2"), JSON.stringify(mcRows[3]));
  }

  console.log("6. length degradation guards (>400 line, >24000 total)");
  {
    equal("HIGHLIGHT_MAX_LINE_CHARS is 400", HIGHLIGHT_MAX_LINE_CHARS, 400);
    equal("HIGHLIGHT_MAX_TOTAL_CHARS is 24000", HIGHLIGHT_MAX_TOTAL_CHARS, 24_000);

    const exact400 = "const x = " + "a".repeat(HIGHLIGHT_MAX_LINE_CHARS - 10);
    equal("exact400 length", exact400.length, 400);
    const exactTokens = tokenizeLine(exact400, "code");
    assertLineInvariants("line-400", exact400, exactTokens);
    check("400-char line still highlights keyword", hasToken(exactTokens, "keyword", "const"), JSON.stringify(exactTokens));

    const over400 = "const x = " + "a".repeat(HIGHLIGHT_MAX_LINE_CHARS - 9);
    equal("over400 length", over400.length, 401);
    const overTokens = tokenizeLine(over400, "code");
    assertLineInvariants("line-401", over400, overTokens);
    equal("401-char line degrades to 1 plain token", overTokens.length, 1);
    equal("401-char line token kind is plain", overTokens[0].kind, "plain");

    // Block comment closed inside an overlong line must not trap subsequent lines
    const longClose = [
      "/* open",
      "x".repeat(HIGHLIGHT_MAX_LINE_CHARS + 5) + " */",
      "const ok = 1;",
    ].join("\n");
    const lcRows = tokenizeCode(longClose, "ts");
    assertCodeInvariants("long-line-closes-comment", longClose, lcRows);
    equal("overlong line itself degrades to plain", lcRows[1][0].kind, "plain");
    check("line after overlong comment close recovers keyword", hasToken(lcRows[2], "keyword", "const"), JSON.stringify(lcRows[2]));

    // Block comment opened inside an overlong line must propagate comment state to the next line
    const longOpen = [
      "const a = 1; /* " + "y".repeat(HIGHLIGHT_MAX_LINE_CHARS),
      "still inside comment with const 123",
      "close */ const b = 2;",
    ].join("\n");
    const loRows = tokenizeCode(longOpen, "ts");
    assertCodeInvariants("long-line-opens-comment", longOpen, loRows);
    equal("overlong line opening /* degrades to plain", loRows[0][0].kind, "plain");
    equal("line after overlong unclosed /* is comment", loRows[1].length, 1);
    equal("line after overlong unclosed /* has comment kind", loRows[1][0].kind, "comment");
    check("closing line recovers keyword after */", hasToken(loRows[2], "keyword", "const"), JSON.stringify(loRows[2]));

    // Overlong line that closes one comment and re-opens another must stay in comment
    const longReopen = [
      "/* first",
      "z".repeat(HIGHLIGHT_MAX_LINE_CHARS) + " */ code /* second",
      "still commented",
    ].join("\n");
    const lrRows = tokenizeCode(longReopen, "ts");
    assertCodeInvariants("long-line-reopens-comment", longReopen, lrRows);
    equal("line after overlong */ ... /* stays comment", lrRows[2][0].kind, "comment");

    // >24000 total chars degrades entire snippet to plain
    const unit = "const value = 42;\n";
    const repeats = Math.ceil((HIGHLIGHT_MAX_TOTAL_CHARS + 100) / unit.length);
    const huge = unit.repeat(repeats) + "\n";
    check("huge text exceeds HIGHLIGHT_MAX_TOTAL_CHARS", huge.length > HIGHLIGHT_MAX_TOTAL_CHARS);
    const hugeRows = tokenizeCode(huge, "ts");
    assertCodeInvariants("total-over-24000", huge, hugeRows);
    const allDegraded = hugeRows.every((row) => row.length === 0 || (row.length === 1 && row[0].kind === "plain"));
    check("over-24000 text degrades every non-empty line to plain", allDegraded);
  }

  console.log("7. tokenColor semantic mapping & static zero-hardcoded-color guards");
  {
    // Sentinel tokens (non-hex) prove tokenColor returns the caller's TokenColors fields verbatim.
    const SENTINEL_COLORS = {
      surface0: "token:surface0",
      surface1: "token:surface1",
      surface2: "token:surface2",
      border: "token:border",
      foreground: "token:foreground",
      foregroundMuted: "token:foregroundMuted",
      accent: "token:accent",
      statusSuccess: "token:statusSuccess",
      statusWarning: "token:statusWarning",
      statusDanger: "token:statusDanger",
    };
    equal("plain -> foreground", tokenColor("plain", SENTINEL_COLORS), SENTINEL_COLORS.foreground);
    equal("comment -> foregroundMuted", tokenColor("comment", SENTINEL_COLORS), SENTINEL_COLORS.foregroundMuted);
    equal("keyword -> accent", tokenColor("keyword", SENTINEL_COLORS), SENTINEL_COLORS.accent);
    equal("string -> statusSuccess", tokenColor("string", SENTINEL_COLORS), SENTINEL_COLORS.statusSuccess);
    equal("number -> statusWarning", tokenColor("number", SENTINEL_COLORS), SENTINEL_COLORS.statusWarning);
    equal("punctuation -> foregroundMuted", tokenColor("punctuation", SENTINEL_COLORS), SENTINEL_COLORS.foregroundMuted);

    const hlSrc = readFileSync(locateSource("client/code-highlight.ts"), "utf8");
    const rnSrc = readFileSync(locateSource("client/highlighted-code.tsx"), "utf8");
    const hexColorRe = /#[0-9a-fA-F]{3,8}\b/;
    const fnColorRe = /\b(?:rgba?|hsla?)\s*\(/i;

    check("code-highlight.ts has zero hex colour literals", !hexColorRe.test(hlSrc));
    check("code-highlight.ts has zero rgb/hsl colour calls", !fnColorRe.test(hlSrc));
    check("highlighted-code.tsx has zero hex colour literals", !hexColorRe.test(rnSrc));
    check("highlighted-code.tsx has zero rgb/hsl colour calls", !fnColorRe.test(rnSrc));
    check(
      "code-highlight.ts has zero React / React Native imports",
      !/from\s+["']react(?:-native)?["']/.test(hlSrc),
    );
    const rnImports = Array.from(rnSrc.matchAll(/from\s+["']([^"']+)["']/g), (m) => m[1]).sort();
    equal(
      "highlighted-code.tsx imports only allowed modules",
      JSON.stringify(rnImports),
      JSON.stringify(["./code-highlight", "./tokens", "react", "react-native"]),
    );
    check(
      "findTokenCovering sanity",
      findTokenCovering(tokenizeLine('const a = "hi"', "code"), '"hi"')?.kind === "string",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  cleanup();
}
