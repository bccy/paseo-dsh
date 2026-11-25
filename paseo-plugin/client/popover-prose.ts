/**
 * Zero-dependency structured prose parser for native Paseo popovers (team task
 * details, goal objectives, background job details).
 *
 * Intentionally free of React / React Native imports so plain Node test runners
 * can require and assert it directly, and free of regex lookbehind so it stays
 * safe under Hermes.
 *
 * @module dsh-paseo/client/popover-prose
 */

export type ProseSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "code"; readonly text: string };

export interface ProseListItem {
  readonly marker: string;
  readonly lead?: string;
  readonly spans: readonly ProseSpan[];
}

export type ProseBlock =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "kicker"; readonly text: string }
  | {
      readonly kind: "paragraph";
      readonly spans: readonly ProseSpan[];
      readonly muted?: boolean;
      readonly rail?: boolean;
    }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly ProseListItem[];
    };

const KICKER_MIN_LEN = 1;
const KICKER_MAX_LEN = 28;
const LEAD_MIN_LEN = 2;
const LEAD_MAX_LEN = 24;

const SENTENCE_PUNCTUATION = /[。！？;；]|[.!?]\s/;

function pushText(spans: ProseSpan[], chunk: string): void {
  if (chunk.length === 0) return;
  const last = spans[spans.length - 1];
  if (last && last.kind === "text") {
    spans[spans.length - 1] = { kind: "text", text: last.text + chunk };
  } else {
    spans.push({ kind: "text", text: chunk });
  }
}

/**
 * Parse inline `` `code` `` and `**strong**` spans.
 * Unmatched or empty delimiters are preserved literally as plain text so no
 * character is ever silently dropped.
 */
export function parseInlineSpans(input: string): ProseSpan[] {
  if (input.length === 0) return [];
  const spans: ProseSpan[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === "`") {
      const close = input.indexOf("`", i + 1);
      if (close > i + 1) {
        spans.push({ kind: "code", text: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      if (close === i + 1) {
        pushText(spans, "``");
        i += 2;
        continue;
      }
      pushText(spans, "`");
      i += 1;
      continue;
    }

    if (ch === "*" && input[i + 1] === "*") {
      const close = input.indexOf("**", i + 2);
      if (close > i + 2) {
        spans.push({ kind: "strong", text: input.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
      if (close === i + 2) {
        pushText(spans, "****");
        i += 4;
        continue;
      }
      pushText(spans, "**");
      i += 2;
      continue;
    }

    let next = i + 1;
    while (next < input.length) {
      const c = input[next];
      if (c === "`" || (c === "*" && input[next + 1] === "*")) break;
      next += 1;
    }
    pushText(spans, input.slice(i, next));
    i = next;
  }

  return spans;
}

interface ColonSplit {
  readonly index: number;
  readonly end: number;
  readonly colon: ":" | "：";
}

function findFirstColonSeparator(text: string, allowTrailingAsciiColon: boolean): ColonSplit | null {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "：") {
      let end = i + 1;
      while (end < text.length && (text[end] === " " || text[end] === "\t")) end += 1;
      return { index: i, end, colon: "：" };
    }
    if (ch === ":") {
      if (text[i + 1] === "/" && text[i + 2] === "/") {
        return null;
      }
      if (text[i + 1] === " " || text[i + 1] === "\t") {
        let end = i + 1;
        while (end < text.length && (text[end] === " " || text[end] === "\t")) end += 1;
        return { index: i, end, colon: ":" };
      }
      if (allowTrailingAsciiColon && i === text.length - 1) {
        return { index: i, end: i + 1, colon: ":" };
      }
    }
  }
  return null;
}

function unwrapOuterStrong(raw: string): string {
  if (raw.length > 4 && raw.startsWith("**") && raw.endsWith("**")) {
    const inner = raw.slice(2, -2);
    if (!inner.includes("**")) return inner.trim();
  }
  return raw;
}

function isBackgroundKicker(label: string): boolean {
  if (label.startsWith("背景")) return true;
  const lower = label.toLowerCase();
  return lower.startsWith("background") || lower.startsWith("context");
}

function parseKicker(trimmedLine: string): { label: string; body: string; background: boolean } | null {
  if (/^https?:\/\//i.test(trimmedLine)) return null;
  const sep = findFirstColonSeparator(trimmedLine, true);
  if (!sep) return null;

  const rawPrefix = trimmedLine.slice(0, sep.index).trim();
  if (rawPrefix.length === 0 || rawPrefix.includes("`") || rawPrefix.includes("://")) return null;

  const label = unwrapOuterStrong(rawPrefix);
  if (label.length < KICKER_MIN_LEN || label.length > KICKER_MAX_LEN) return null;
  if (label.includes("**") || SENTENCE_PUNCTUATION.test(label)) return null;

  const body = trimmedLine.slice(sep.end).trim();
  return { label, body, background: isBackgroundKicker(label) };
}

function parseListItem(marker: string, rawBody: string): ProseListItem {
  const body = rawBody.trim();
  const sep = findFirstColonSeparator(body, false);
  if (sep) {
    const rawPrefix = body.slice(0, sep.index).trim();
    const rest = body.slice(sep.end).trim();
    if (
      rest.length > 0 &&
      !rawPrefix.includes("`") &&
      !rawPrefix.includes("://") &&
      !rawPrefix.includes("\n")
    ) {
      const label = unwrapOuterStrong(rawPrefix);
      if (
        label.length >= LEAD_MIN_LEN &&
        label.length <= LEAD_MAX_LEN &&
        !label.includes("**") &&
        !SENTENCE_PUNCTUATION.test(label)
      ) {
        return {
          marker,
          lead: `${label}${sep.colon}`,
          spans: parseInlineSpans(rest),
        };
      }
    }
  }
  return {
    marker,
    spans: parseInlineSpans(body),
  };
}

function matchListLine(line: string): { ordered: boolean; marker: string; body: string; indent: number } | null {
  const ordered = /^(\s*)(\d+)(?:[.)]\s+|、\s*)(.+)$/.exec(line);
  if (ordered) {
    return {
      ordered: true,
      marker: `${ordered[2]}.`,
      body: ordered[3],
      indent: ordered[1].length,
    };
  }
  const unordered = /^(\s*)[-*•]\s+(.+)$/.exec(line);
  if (unordered) {
    return {
      ordered: false,
      marker: "•",
      body: unordered[2],
      indent: unordered[1].length,
    };
  }
  return null;
}

/**
 * Parse plain or lightly structured prose (task descriptions, objectives,
 * release notes, handoff briefs) into typed blocks for `PopoverProse`.
 */
export function parseProseBlocks(input: string): ProseBlock[] {
  const normalized = input.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: ProseBlock[] = [];

  let paragraphLines: string[] = [];
  let paragraphBackground = false;
  let pendingBackgroundKicker = false;

  let listOrdered: boolean | null = null;
  let listItems: { marker: string; rawBody: string; indent: number }[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    const text = paragraphLines.join("\n").trim();
    paragraphLines = [];
    const background = paragraphBackground;
    paragraphBackground = false;
    if (text.length === 0) return;
    const spans = parseInlineSpans(text);
    if (background) {
      blocks.push({ kind: "paragraph", spans, muted: true, rail: true });
    } else {
      blocks.push({ kind: "paragraph", spans });
    }
  };

  const flushList = (): void => {
    if (listOrdered === null || listItems.length === 0) {
      listOrdered = null;
      listItems = [];
      return;
    }
    blocks.push({
      kind: "list",
      ordered: listOrdered,
      items: listItems.map((item) => parseListItem(item.marker, item.rawBody)),
    });
    listOrdered = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^#{1,3}\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      pendingBackgroundKicker = false;
      blocks.push({ kind: "heading", text: heading[1].trim() });
      continue;
    }

    const listMatch = matchListLine(rawLine);
    if (listMatch) {
      flushParagraph();
      pendingBackgroundKicker = false;
      if (listOrdered !== null && listOrdered !== listMatch.ordered) {
        flushList();
      }
      listOrdered = listMatch.ordered;
      listItems.push({
        marker: listMatch.marker,
        rawBody: listMatch.body.trim(),
        indent: listMatch.indent,
      });
      continue;
    }

    // Indented continuation of the previous list item (strictly deeper indent).
    if (listOrdered !== null && listItems.length > 0) {
      const leadingSpaces = rawLine.length - rawLine.trimStart().length;
      const prev = listItems[listItems.length - 1];
      if (leadingSpaces >= prev.indent + 2 && !parseKicker(trimmed)) {
        prev.rawBody = `${prev.rawBody}\n${trimmed}`;
        continue;
      }
      flushList();
    }

    const kicker = parseKicker(trimmed);
    if (kicker) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "kicker", text: kicker.label });
      if (kicker.body.length > 0) {
        paragraphLines = [kicker.body];
        paragraphBackground = kicker.background;
        pendingBackgroundKicker = false;
      } else {
        pendingBackgroundKicker = kicker.background;
      }
      continue;
    }

    if (paragraphLines.length === 0 && pendingBackgroundKicker) {
      paragraphBackground = true;
      pendingBackgroundKicker = false;
    }
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();

  return blocks;
}
