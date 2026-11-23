/**
 * Lightweight syntax tokenizer using strictly Paseo's 11 semantic theme colours.
 *
 * Colour palette 1 ("strict semantic"): zero hardcoded hex/rgb values and zero
 * third-party dependencies. Every token kind maps onto an existing field of
 * {@link TokenColors} so light, dark, and custom Paseo themes stay coherent.
 *
 * Deliberately free of React and React Native imports so offline harnesses can
 * compile and `require` this module directly with plain `node`.
 *
 * Invariants:
 * - Lossless: `tokens.map((t) => t.text).join("") === line` holds for every
 *   possible input (Unicode, CJK, tabs, unterminated quotes, trailing backslash).
 * - Coalesced: adjacent tokens sharing the same {@link CodeTokenKind} are
 *   merged to keep rendered `<Text>` node counts minimal.
 * - Bounded: lines longer than {@link HIGHLIGHT_MAX_LINE_CHARS} and documents
 *   longer than {@link HIGHLIGHT_MAX_TOTAL_CHARS} degrade cleanly to `"plain"`.
 *
 * @module dsh-paseo/client/code-highlight
 */
import type { TokenColors } from "./tokens";

export type CodeTokenKind =
  | "plain"
  | "comment"
  | "keyword"
  | "string"
  | "number"
  | "punctuation";

export interface CodeToken {
  readonly kind: CodeTokenKind;
  readonly text: string;
}

export type HighlightMode = "code" | "json" | "shell" | "plain";

export const HIGHLIGHT_MAX_LINE_CHARS = 400;
export const HIGHLIGHT_MAX_TOTAL_CHARS = 24_000;

/* -------------------------------------------------------------------------- */
/* Language -> HighlightMode                                                  */
/* -------------------------------------------------------------------------- */

const PLAIN_LANGS = new Set([
  "text",
  "plain",
  "plaintext",
  "txt",
  "log",
  "markdown",
  "md",
  "diff",
  "patch",
]);

const JSON_LANGS = new Set(["json", "jsonc", "json5"]);

const SHELL_LANGS = new Set([
  "sh",
  "bash",
  "zsh",
  "shell",
  "shellscript",
  "fish",
  "powershell",
  "pwsh",
  "cmd",
  "bat",
]);

const CODE_LANGS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "typescript",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "javascript",
  "py",
  "python",
  "rs",
  "rust",
  "go",
  "golang",
  "java",
  "c",
  "cpp",
  "cc",
  "cxx",
  "c++",
  "h",
  "hpp",
  "hh",
  "hxx",
  "cs",
  "csharp",
  "rb",
  "ruby",
  "php",
  "swift",
  "kt",
  "kts",
  "kotlin",
  "scala",
  "sql",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "dockerfile",
  "docker",
  "makefile",
  "make",
  "mk",
  "lua",
  "perl",
  "pl",
  "r",
  "dart",
  "zig",
  "nim",
  "elixir",
  "ex",
  "exs",
  "erl",
  "erlang",
  "haskell",
  "hs",
  "ocaml",
  "ml",
  "clojure",
  "clj",
  "groovy",
  "gradle",
  "graphql",
  "gql",
  "proto",
  "protobuf",
  "prisma",
  "vue",
  "svelte",
  "astro",
  "nix",
  "hcl",
  "tf",
  "terraform",
  "cmake",
  "objc",
  "objective-c",
  "solidity",
  "sol",
]);

/**
 * Resolve a language identifier or file extension into a tokenizer mode.
 *
 * Unknown languages fall back to `"plain"` so unformatted logs and arbitrary
 * text are never spuriously highlighted.
 */
export function highlightModeFor(lang?: string): HighlightMode {
  if (!lang) return "plain";
  let key = lang.trim().toLowerCase();
  if (key.startsWith("language-")) key = key.slice("language-".length);
  if (key.startsWith(".")) key = key.slice(1);
  if (key.length === 0 || PLAIN_LANGS.has(key)) return "plain";
  if (JSON_LANGS.has(key)) return "json";
  if (SHELL_LANGS.has(key)) return "shell";
  if (CODE_LANGS.has(key)) return "code";
  return "plain";
}

/* -------------------------------------------------------------------------- */
/* Semantic colour mapping                                                    */
/* -------------------------------------------------------------------------- */

/** Map a syntax token kind strictly to one of Paseo's semantic theme colours. */
export function tokenColor(kind: CodeTokenKind, colors: TokenColors): string {
  switch (kind) {
    case "plain":
      return colors.foreground;
    case "comment":
      return colors.foregroundMuted;
    case "keyword":
      return colors.accent;
    case "string":
      return colors.statusSuccess;
    case "number":
      return colors.statusWarning;
    case "punctuation":
      return colors.foregroundMuted;
  }
}

/* -------------------------------------------------------------------------- */
/* Keyword & literal tables                                                   */
/* -------------------------------------------------------------------------- */

const CODE_VALUE_LITERALS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "None",
  "True",
  "False",
  "nil",
  "NaN",
  "Infinity",
]);

const CODE_KEYWORDS = new Set([
  // JS / TS
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "module",
  "namespace",
  "new",
  "of",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "type",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  // Python
  "and",
  "assert",
  "def",
  "del",
  "elif",
  "except",
  "global",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  // Rust / Go / C / C++ / Java / Swift / Kotlin / Ruby / PHP
  "auto",
  "bool",
  "chan",
  "char",
  "consteval",
  "constexpr",
  "crate",
  "defer",
  "double",
  "dyn",
  "end",
  "extern",
  "fallthrough",
  "final",
  "float",
  "fn",
  "func",
  "go",
  "goto",
  "guard",
  "impl",
  "inline",
  "int",
  "internal",
  "long",
  "loop",
  "map",
  "match",
  "mod",
  "move",
  "mut",
  "noexcept",
  "operator",
  "pub",
  "range",
  "ref",
  "register",
  "repeat",
  "require",
  "sealed",
  "select",
  "self",
  "Self",
  "short",
  "signed",
  "sizeof",
  "struct",
  "synchronized",
  "template",
  "then",
  "throws",
  "trait",
  "typedef",
  "typename",
  "union",
  "unsafe",
  "unsigned",
  "use",
  "using",
  "val",
  "virtual",
  "volatile",
  "when",
  "where",
  // SQL (both upper and lower common clauses)
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "ON",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "ALTER",
  "DROP",
  "TABLE",
  "INDEX",
  "ORDER",
  "GROUP",
  "BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "DISTINCT",
  "UNION",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
]);

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "select",
  "function",
  "return",
  "exit",
  "export",
  "local",
  "readonly",
  "declare",
  "typeset",
  "unset",
  "shift",
  "source",
  "alias",
  "unalias",
  "sudo",
  "eval",
  "exec",
  "trap",
  "break",
  "continue",
]);

/** Shell keywords after which the next bare word is still a command name. */
const SHELL_COMMAND_PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "sudo",
  "exec",
  "eval",
]);

const JSON_LITERALS = new Set(["true", "false", "null"]);

const CODE_PUNCTUATION = new Set(["{", "}", "[", "]", "(", ")", ";", ",", ":", "."]);
const JSON_PUNCTUATION = new Set(["{", "}", "[", "]", ",", ":"]);

const SHELL_ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_FLAG_RE = /^--?[A-Za-z0-9][A-Za-z0-9_-]*/;
const SHELL_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const CODE_HASH_HEX_RE = /^#[0-9a-fA-F]{3,8}(?![A-Za-z0-9_])/;
const CODE_C_PREPROC_RE =
  /^#\s*(?:include|define|ifdef|ifndef|endif|pragma|undef|if|elif|else|error|warning|line)\b/;

/* -------------------------------------------------------------------------- */
/* Low-level helpers                                                          */
/* -------------------------------------------------------------------------- */

interface MutableToken {
  kind: CodeTokenKind;
  text: string;
}

interface LineResult {
  readonly tokens: readonly CodeToken[];
  readonly inBlockComment: boolean;
}

function pushToken(out: MutableToken[], kind: CodeTokenKind, text: string): void {
  if (text.length === 0) return;
  const last = out[out.length - 1];
  if (last !== undefined && last.kind === kind) {
    last.text += text;
    return;
  }
  out.push({ kind, text });
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}

function isIdentStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "$"
  );
}

function isIdentContinue(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * Scan a quoted string starting at `start` (whose char is `quote`).
 * Returns the exclusive end index; handles backslash escapes and terminates at
 * line end when unterminated.
 */
function scanQuoted(line: string, start: number, quote: string, allowEscape: boolean): number {
  const len = line.length;
  let i = start + 1;
  while (i < len) {
    const ch = line[i];
    if (allowEscape && ch === "\\") {
      i += i + 1 < len ? 2 : 1;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return len;
}

/** Scan a numeric literal in `code` mode starting at a digit. */
function scanCodeNumber(line: string, start: number): number {
  const len = line.length;
  let i = start;
  if (line[i] === "0" && i + 1 < len) {
    const next = line[i + 1];
    if (next === "x" || next === "X") {
      i += 2;
      while (i < len && (isHexDigit(line[i]) || line[i] === "_")) i += 1;
      if (i < len && line[i] === "n") i += 1;
      return i;
    }
    if (next === "b" || next === "B") {
      i += 2;
      while (i < len && (line[i] === "0" || line[i] === "1" || line[i] === "_")) i += 1;
      if (i < len && line[i] === "n") i += 1;
      return i;
    }
    if (next === "o" || next === "O") {
      i += 2;
      while (i < len && ((line[i] >= "0" && line[i] <= "7") || line[i] === "_")) i += 1;
      if (i < len && line[i] === "n") i += 1;
      return i;
    }
  }
  while (i < len && (isDigit(line[i]) || line[i] === "_")) i += 1;
  if (i + 1 < len && line[i] === "." && isDigit(line[i + 1])) {
    i += 1;
    while (i < len && (isDigit(line[i]) || line[i] === "_")) i += 1;
  }
  if (i < len && (line[i] === "e" || line[i] === "E")) {
    let exp = i + 1;
    if (exp < len && (line[exp] === "+" || line[exp] === "-")) exp += 1;
    if (exp < len && isDigit(line[exp])) {
      i = exp + 1;
      while (i < len && (isDigit(line[i]) || line[i] === "_")) i += 1;
    }
  }
  if (i < len && line[i] === "n") i += 1;
  return i;
}

/** Scan a JSON numeric literal starting at `-` (followed by a digit) or a digit. */
function scanJsonNumber(line: string, start: number): number {
  const len = line.length;
  let i = start;
  if (line[i] === "-") i += 1;
  while (i < len && isDigit(line[i])) i += 1;
  if (i + 1 < len && line[i] === "." && isDigit(line[i + 1])) {
    i += 1;
    while (i < len && isDigit(line[i])) i += 1;
  }
  if (i < len && (line[i] === "e" || line[i] === "E")) {
    let exp = i + 1;
    if (exp < len && (line[exp] === "+" || line[exp] === "-")) exp += 1;
    if (exp < len && isDigit(line[exp])) {
      i = exp + 1;
      while (i < len && isDigit(line[i])) i += 1;
    }
  }
  return i;
}

/* -------------------------------------------------------------------------- */
/* Per-mode tokenizers                                                        */
/* -------------------------------------------------------------------------- */

function tokenizeJsonLine(line: string, startInBlockComment: boolean): LineResult {
  const out: MutableToken[] = [];
  const len = line.length;
  let i = 0;
  let inBlockComment = startInBlockComment;

  if (inBlockComment) {
    const closeIdx = line.indexOf("*/");
    if (closeIdx === -1) {
      pushToken(out, "comment", line);
      return { tokens: out, inBlockComment: true };
    }
    pushToken(out, "comment", line.slice(0, closeIdx + 2));
    i = closeIdx + 2;
    inBlockComment = false;
  }

  while (i < len) {
    const ch = line[i];

    // Line comment (JSONC)
    if (ch === "/" && i + 1 < len && line[i + 1] === "/") {
      pushToken(out, "comment", line.slice(i));
      break;
    }

    // Block comment (JSONC)
    if (ch === "/" && i + 1 < len && line[i + 1] === "*") {
      const closeIdx = line.indexOf("*/", i + 2);
      if (closeIdx === -1) {
        pushToken(out, "comment", line.slice(i));
        inBlockComment = true;
        break;
      }
      pushToken(out, "comment", line.slice(i, closeIdx + 2));
      i = closeIdx + 2;
      continue;
    }

    // String or object key ("key" followed by optional whitespace + ':')
    if (ch === '"') {
      const end = scanQuoted(line, i, '"', true);
      let look = end;
      while (look < len && isWhitespace(line[look])) look += 1;
      const isKey = look < len && line[look] === ":";
      pushToken(out, isKey ? "keyword" : "string", line.slice(i, end));
      i = end;
      continue;
    }

    // Number (including optional leading '-')
    if (isDigit(ch) || (ch === "-" && i + 1 < len && isDigit(line[i + 1]))) {
      const end = scanJsonNumber(line, i);
      pushToken(out, "number", line.slice(i, end));
      i = end;
      continue;
    }

    // Boolean / null literals
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && isIdentContinue(line[end])) end += 1;
      const word = line.slice(i, end);
      pushToken(out, JSON_LITERALS.has(word) ? "number" : "plain", word);
      i = end;
      continue;
    }

    // Structural punctuation
    if (JSON_PUNCTUATION.has(ch)) {
      pushToken(out, "punctuation", ch);
      i += 1;
      continue;
    }

    // Plain (whitespace and anything else)
    pushToken(out, "plain", ch);
    i += 1;
  }

  return { tokens: out, inBlockComment };
}

function isShellDelimiter(ch: string): boolean {
  return (
    isWhitespace(ch) ||
    ch === "|" ||
    ch === "&" ||
    ch === ";" ||
    ch === ">" ||
    ch === "<" ||
    ch === "(" ||
    ch === ")" ||
    ch === '"' ||
    ch === "'" ||
    ch === "`"
  );
}

function isShellWordBoundaryBefore(line: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = line[idx - 1];
  return (
    isWhitespace(prev) ||
    prev === ";" ||
    prev === "|" ||
    prev === "&" ||
    prev === "(" ||
    prev === "="
  );
}

function matchShellOperator(line: string, i: number): { readonly text: string; readonly startsCommand: boolean } | undefined {
  const rest = line.slice(i);
  if (rest.startsWith("2>&1") || rest.startsWith("1>&2")) {
    return { text: rest.slice(0, 4), startsCommand: false };
  }
  if (rest.startsWith("&>>") || rest.startsWith("<<<")) {
    return { text: rest.slice(0, 3), startsCommand: false };
  }
  if (rest.startsWith("&&") || rest.startsWith("||") || rest.startsWith("$(")) {
    return { text: rest.slice(0, 2), startsCommand: true };
  }
  if (
    rest.startsWith(">>") ||
    rest.startsWith("<<") ||
    rest.startsWith(">&") ||
    rest.startsWith("<&") ||
    rest.startsWith("&>")
  ) {
    return { text: rest.slice(0, 2), startsCommand: false };
  }
  const ch = line[i];
  if (ch === "|" || ch === ";" || ch === "(" || ch === "&") {
    return { text: ch, startsCommand: true };
  }
  if (ch === ">" || ch === "<" || ch === ")") {
    return { text: ch, startsCommand: false };
  }
  return undefined;
}

function tokenizeShellLine(line: string): LineResult {
  const out: MutableToken[] = [];
  const len = line.length;
  let i = 0;
  let expectCommand = true;

  while (i < len) {
    const ch = line[i];

    // Whitespace preserves command expectation
    if (isWhitespace(ch)) {
      let end = i + 1;
      while (end < len && isWhitespace(line[end])) end += 1;
      pushToken(out, "plain", line.slice(i, end));
      i = end;
      continue;
    }

    // Comment: '#' at start of line or after a word/command boundary
    if (ch === "#" && isShellWordBoundaryBefore(line, i) && (i === 0 || line[i - 1] !== "=")) {
      pushToken(out, "comment", line.slice(i));
      break;
    }

    // Quoted strings (single quotes have no backslash escapes in POSIX shell)
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = scanQuoted(line, i, ch, ch !== "'");
      pushToken(out, "string", line.slice(i, end));
      i = end;
      expectCommand = false;
      continue;
    }

    // Shell operators & redirections
    const op = matchShellOperator(line, i);
    if (op !== undefined) {
      pushToken(out, "punctuation", op.text);
      i += op.text.length;
      expectCommand = op.startsCommand;
      continue;
    }

    // Leading environment variable assignment: FOO=bar before a command
    if (expectCommand) {
      const envMatch = SHELL_ENV_PREFIX_RE.exec(line.slice(i));
      if (envMatch !== null) {
        const eqPos = i + envMatch[0].length - 1;
        pushToken(out, "plain", line.slice(i, eqPos));
        pushToken(out, "punctuation", "=");
        i = eqPos + 1;
        // Consume the assignment value up to the next unquoted whitespace/delimiter
        while (i < len) {
          const vc = line[i];
          if (vc === "'" || vc === '"' || vc === "`") {
            const end = scanQuoted(line, i, vc, vc !== "'");
            pushToken(out, "string", line.slice(i, end));
            i = end;
            continue;
          }
          if (isShellDelimiter(vc)) break;
          let end = i + 1;
          while (end < len && !isShellDelimiter(line[end])) end += 1;
          pushToken(out, "plain", line.slice(i, end));
          i = end;
        }
        // Keep expectCommand = true so the command after FOO=bar gets highlighted
        continue;
      }
    }

    // Option flag (--flag, -f, --key=val) in argument position
    if (!expectCommand && ch === "-" && isShellWordBoundaryBefore(line, i) && (i === 0 || line[i - 1] !== "=")) {
      const flagMatch = SHELL_FLAG_RE.exec(line.slice(i));
      if (flagMatch !== null) {
        const end = i + flagMatch[0].length;
        const after = end < len ? line[end] : "";
        if (after === "" || after === "=" || isShellDelimiter(after)) {
          pushToken(out, "number", flagMatch[0]);
          i = end;
          if (after === "=") {
            pushToken(out, "punctuation", "=");
            i += 1;
          }
          continue;
        }
      }
    }

    // Bare word up to the next shell delimiter
    let end = i;
    while (end < len) {
      if (line[end] === "\\" && end + 1 < len) {
        end += 2;
        continue;
      }
      if (isShellDelimiter(line[end])) break;
      end += 1;
    }
    if (end === i) end = i + 1;
    const word = line.slice(i, end);

    if (SHELL_KEYWORDS.has(word)) {
      pushToken(out, "keyword", word);
      expectCommand = SHELL_COMMAND_PREFIX_KEYWORDS.has(word);
    } else if (expectCommand) {
      pushToken(out, "keyword", word);
      expectCommand = false;
    } else if (SHELL_NUMBER_RE.test(word) && isShellWordBoundaryBefore(line, i)) {
      pushToken(out, "number", word);
    } else {
      pushToken(out, "plain", word);
    }
    i = end;
  }

  return { tokens: out, inBlockComment: false };
}

function isCodeHashComment(line: string, i: number): boolean {
  if (i > 0 && !isWhitespace(line[i - 1])) return false;
  if (i + 1 < line.length && line[i + 1] === "[") return false;
  const rest = line.slice(i);
  if (CODE_HASH_HEX_RE.test(rest)) return false;
  if (CODE_C_PREPROC_RE.test(rest)) return false;
  return true;
}

function tokenizeCodeLine(line: string, startInBlockComment: boolean): LineResult {
  const out: MutableToken[] = [];
  const len = line.length;
  let i = 0;
  let inBlockComment = startInBlockComment;

  if (inBlockComment) {
    const closeIdx = line.indexOf("*/");
    if (closeIdx === -1) {
      pushToken(out, "comment", line);
      return { tokens: out, inBlockComment: true };
    }
    pushToken(out, "comment", line.slice(0, closeIdx + 2));
    i = closeIdx + 2;
    inBlockComment = false;
  }

  while (i < len) {
    const ch = line[i];

    // '//' line comment
    if (ch === "/" && i + 1 < len && line[i + 1] === "/") {
      pushToken(out, "comment", line.slice(i));
      break;
    }

    // '/* ... */' inline or multi-line block comment
    if (ch === "/" && i + 1 < len && line[i + 1] === "*") {
      const closeIdx = line.indexOf("*/", i + 2);
      if (closeIdx === -1) {
        pushToken(out, "comment", line.slice(i));
        inBlockComment = true;
        break;
      }
      pushToken(out, "comment", line.slice(i, closeIdx + 2));
      i = closeIdx + 2;
      continue;
    }

    // '-- ' or '--' at EOL (SQL / Lua / Haskell line comment), avoiding 'x--'
    if (
      ch === "-" &&
      i + 1 < len &&
      line[i + 1] === "-" &&
      (i === 0 || isWhitespace(line[i - 1])) &&
      (i + 2 === len || isWhitespace(line[i + 2]))
    ) {
      pushToken(out, "comment", line.slice(i));
      break;
    }

    // '#' line comment (Python / Ruby / YAML / TOML / Makefile), avoiding hex/preproc/attrs
    if (ch === "#" && isCodeHashComment(line, i)) {
      pushToken(out, "comment", line.slice(i));
      break;
    }

    // Quoted strings (single, double, template backtick)
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = scanQuoted(line, i, ch, true);
      pushToken(out, "string", line.slice(i, end));
      i = end;
      continue;
    }

    // Numeric literal
    if (isDigit(ch)) {
      const end = scanCodeNumber(line, i);
      pushToken(out, "number", line.slice(i, end));
      i = end;
      continue;
    }

    // Identifier, value literal, or keyword
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && isIdentContinue(line[end])) end += 1;
      const word = line.slice(i, end);
      if (CODE_VALUE_LITERALS.has(word)) {
        pushToken(out, "number", word);
      } else if (CODE_KEYWORDS.has(word)) {
        pushToken(out, "keyword", word);
      } else {
        pushToken(out, "plain", word);
      }
      i = end;
      continue;
    }

    // Punctuation
    if (CODE_PUNCTUATION.has(ch)) {
      pushToken(out, "punctuation", ch);
      i += 1;
      continue;
    }

    // Plain (whitespace, operators, Unicode, etc.)
    pushToken(out, "plain", ch);
    i += 1;
  }

  return { tokens: out, inBlockComment };
}

function tokenizeLineWithState(
  line: string,
  mode: HighlightMode,
  inBlockComment: boolean,
): LineResult {
  if (line === "") {
    return { tokens: [], inBlockComment };
  }
  if (mode === "plain" || line.length > HIGHLIGHT_MAX_LINE_CHARS) {
    let nextBlock = inBlockComment;
    if (mode === "code" || mode === "json") {
      const openIdx = line.lastIndexOf("/*");
      const closeIdx = line.lastIndexOf("*/");
      if (openIdx !== -1 && openIdx > closeIdx) {
        nextBlock = true;
      } else if (closeIdx !== -1 && closeIdx > openIdx) {
        nextBlock = false;
      }
    }
    return { tokens: [{ kind: "plain", text: line }], inBlockComment: nextBlock };
  }
  switch (mode) {
    case "json":
      return tokenizeJsonLine(line, inBlockComment);
    case "shell":
      return tokenizeShellLine(line);
    case "code":
      return tokenizeCodeLine(line, inBlockComment);
    default:
      return { tokens: [{ kind: "plain", text: line }], inBlockComment };
  }
}

/* -------------------------------------------------------------------------- */
/* Public tokenization API                                                    */
/* -------------------------------------------------------------------------- */

/** Tokenize a single line of code without cross-line state. */
export function tokenizeLine(line: string, mode: HighlightMode): readonly CodeToken[] {
  return tokenizeLineWithState(line, mode, false).tokens;
}

/**
 * Tokenize a multi-line code snippet, preserving multi-line `/* ... *\/` block
 * comment state across lines.
 */
export function tokenizeCode(text: string, lang?: string): readonly (readonly CodeToken[])[] {
  const mode = highlightModeFor(lang);
  const lines = text.split("\n");
  if (text.length > HIGHLIGHT_MAX_TOTAL_CHARS || mode === "plain") {
    return lines.map((line) => (line === "" ? [] : [{ kind: "plain", text: line }]));
  }
  const result: (readonly CodeToken[])[] = [];
  let inBlockComment = false;
  for (const line of lines) {
    const step = tokenizeLineWithState(line, mode, inBlockComment);
    result.push(step.tokens);
    inBlockComment = step.inBlockComment;
  }
  return result;
}
