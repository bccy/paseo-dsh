/**
 * Zero-dependency language detection and chunking helpers for thinking
 * translation. Kept free of `@getpaseo/plugin` and `zod` so isolated harness
 * tests (`harness/thinking-check.cjs`) can import client thinking modules
 * without stubbing RPC helpers.
 *
 * @module dsh-paseo/shared/translate-text
 */

/** Maximum source text length accepted by `thinking.translate` RPC (keeps client & server aligned). */
export const MAX_TRANSLATE_TEXT_LENGTH = 20_000;

/**
 * Returns true when `text` is predominantly non-Chinese prose that benefits
 * from Chinese translation. Already-Chinese thoughts (even with English code
 * identifiers, file paths, or URLs) return false so zero requests are wasted.
 */
export function needsChineseTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  const prose = trimmed
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:\/[\w.-]+){2,}/g, " ");
  const cjkCount = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinCount = (prose.match(/[A-Za-z]/g) ?? []).length;
  if (latinCount < 8) return false;
  return cjkCount < latinCount * 0.25;
}

const ENGLISH_PROSE_STARTER_RE =
  /^(?:the|this|that|these|those|let(?:'s)?|i(?:'ll|'m|'ve|'d)?|we(?:'ll|'re|'ve|'d)?|first|next|now|here|wait|okay|ok|sure|well|looking|checking|reading|inspecting|analyzing|thinking|reviewing|need|should|could|would|actually|however|since|because|before|after|when|while|user|hmm|alright)\b/i;

/**
 * Detects the first few ASCII characters of an English streaming thought before
 * it reaches `needsChineseTranslation`'s 8-letter threshold, so the UI can show
 * a smooth placeholder instead of briefly flashing `"The"` / `"Let's"` and then
 * jumping to Chinese.
 *
 * Deliberately rejects code spans, paths, filenames, camelCase/snake_case
 * identifiers, and short ALL-CAPS acronyms (e.g. `"DSH"`, `"iOS"`,
 * `"inline-thinking.tsx"`) so Chinese DSH thoughts starting with a symbol never
 * flash `"推理中…"`.
 */
export function isLikelyStartingEnglish(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length >= 24) return false;
  if (/[\u4e00-\u9fff]/.test(trimmed)) return false;
  const stripped = trimmed
    .replace(/^(?:[#>*+-]|\d+\.)+\s*/u, "")
    .replace(/^\*+\s*/u, "")
    .replace(/```[\s\S]*$/g, " ")
    .replace(/`[^`\n]*`?/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:~|\.{1,2})?(?:\/[\w.-]+)+/g, " ")
    .trim();
  if (!stripped) return false;
  const firstToken = stripped.split(/\s+/)[0] ?? "";
  if (/[_/.\\]/.test(firstToken)) return false;
  if (/[a-z][A-Z]/.test(firstToken)) return false;
  if (/^[A-Za-z']+\s+[A-Za-z']{2,}/.test(stripped)) return true;
  if (ENGLISH_PROSE_STARTER_RE.test(stripped)) return true;
  if (/^[A-Za-z']{4,}[,:;!?]?$/.test(firstToken) && firstToken !== firstToken.toUpperCase()) {
    return true;
  }
  return false;
}

/**
 * Decides whether a thought's first-line summary (`preview`) is stable enough
 * to translate right now:
 * - On `complete`: always ready immediately (no 300ms debounce wait).
 * - While `streaming`: ready as soon as the first line/sentence has closed
 *   (a newline after the preview, or a complete >=24-char sentence ending in
 *   punctuation), so the collapsed summary is already cached when thinking ends.
 */
export function isPreviewReadyForTranslation(
  rawText: string,
  preview: string,
  phase: "streaming" | "complete",
): boolean {
  const cleanPreview = preview.trim();
  if (!cleanPreview) return false;
  if (phase === "complete") return true;
  if (rawText.includes("\n") && cleanPreview.length >= 12) return true;
  return cleanPreview.length >= 24 && /[.!?。！？]$/.test(cleanPreview);
}

export interface TranslationChunkPlan {
  pieces: string[];
  seps: string[];
}

/**
 * Splits text into paragraph-preserving chunks bounded by `maxLen` characters
 * so free HTTP translation endpoints with per-request length caps (e.g.
 * MyMemory's 500-char query limit) translate long thoughts without truncation.
 */
export function splitTranslationChunks(text: string, maxLen = 420): TranslationChunkPlan {
  const pieces: string[] = [];
  const seps: string[] = [];
  const paragraphs = text.split(/(\n{2,})/);

  for (let i = 0; i < paragraphs.length; i += 2) {
    const para = paragraphs[i] ?? "";
    const trailingSep = paragraphs[i + 1] ?? "";
    if (!para.trim()) {
      if (seps.length > 0) {
        seps[seps.length - 1] += para + trailingSep;
      }
      continue;
    }

    const subChunks = splitLongParagraph(para, maxLen);
    for (let j = 0; j < subChunks.length; j += 1) {
      pieces.push(subChunks[j]!);
      seps.push(j < subChunks.length - 1 ? " " : trailingSep);
    }
  }

  return { pieces, seps };
}

export interface StreamingThinkingSegment {
  /** Exact source text of this segment (sentence, line, or code block). */
  text: string;
  /** Exact trailing separator (`\n`, `\r\n`, spaces, or `""`) after `text`. */
  sep: string;
  /** True once this segment is closed and safe to translate & lock in cache. */
  closed: boolean;
  /** True for fenced code blocks (closed or still streaming) that must never be translated. */
  isCode?: boolean;
}

/**
 * Splits a single line into Hermes-safe sentence segments while keeping exact
 * inter-sentence whitespace in `sep`.
 */
function splitLineSentencesWithSeps(
  line: string,
  lineClosed: boolean,
): StreamingThinkingSegment[] {
  if (!line) return [];
  const out: StreamingThinkingSegment[] = [];
  const boundaryRe = /[.!?。！？](\s+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(line)) !== null) {
    const endOfSentence = match.index + 1;
    const whitespace = match[1] ?? " ";
    const piece = line.slice(lastIndex, endOfSentence);
    if (piece) {
      out.push({ text: piece, sep: whitespace, closed: true });
    } else if (out.length > 0) {
      out[out.length - 1]!.sep += whitespace;
    }
    lastIndex = endOfSentence + whitespace.length;
  }
  const tail = line.slice(lastIndex);
  if (tail) {
    const trimmedTail = tail.trim();
    const tailClosed =
      lineClosed || (trimmedTail.length >= 12 && /[.!?。！？]$/.test(trimmedTail));
    out.push({ text: tail, sep: "", closed: tailClosed });
  }
  return out;
}

/**
 * Splits streaming or completed thinking text into stable closed segments plus
 * an optional live trailing fragment so each finished sentence/line translates
 * once and never flickers as newer tokens arrive.
 */
export function splitStreamingThinkingSegments(
  text: string,
  phase: "streaming" | "complete",
): StreamingThinkingSegment[] {
  if (!text) return [];
  const segments: StreamingThinkingSegment[] = [];
  const lineRe = /\r?\n/g;
  let cursor = 0;
  let inFence = false;
  let fenceStart = -1;

  const pushLine = (line: string, lineSep: string, isLastLine: boolean) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      if (!inFence) {
        inFence = true;
        fenceStart = cursor;
        if (isLastLine) {
          segments.push({
            text: text.slice(fenceStart),
            sep: "",
            closed: phase === "complete",
            isCode: true,
          });
        }
        return;
      }
      const blockEnd = cursor + line.length;
      segments.push({
        text: text.slice(fenceStart, blockEnd),
        sep: lineSep,
        closed: true,
        isCode: true,
      });
      inFence = false;
      fenceStart = -1;
      return;
    }
    if (inFence) {
      if (isLastLine) {
        segments.push({
          text: text.slice(fenceStart),
          sep: "",
          closed: phase === "complete",
          isCode: true,
        });
      }
      return;
    }
    if (!line) {
      if (segments.length > 0) {
        segments[segments.length - 1]!.sep += lineSep;
      } else {
        segments.push({ text: "", sep: lineSep, closed: true });
      }
      return;
    }
    const lineClosed = phase === "complete" || !isLastLine;
    const parts = splitLineSentencesWithSeps(line, lineClosed);
    if (parts.length > 0) {
      parts[parts.length - 1]!.sep += lineSep;
      segments.push(...parts);
    }
  };

  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(text)) !== null) {
    const line = text.slice(cursor, match.index);
    const sep = match[0];
    pushLine(line, sep, false);
    cursor = match.index + sep.length;
  }
  if (cursor < text.length) {
    pushLine(text.slice(cursor), "", true);
  } else if (inFence && fenceStart >= 0) {
    segments.push({
      text: text.slice(fenceStart),
      sep: "",
      closed: phase === "complete",
      isCode: true,
    });
  }
  return segments;
}

/**
 * Hermes-safe sentence splitter (no regex lookbehind, which fails to parse on
 * React Native Hermes engines). Splits after `.`, `!`, or `?` followed by
 * whitespace while preserving the trailing punctuation on each sentence.
 */
function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  const boundaryRe = /[.!?]\s+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(paragraph)) !== null) {
    const sentenceEnd = match.index + 1;
    const chunk = paragraph.slice(lastIndex, sentenceEnd);
    if (chunk) out.push(chunk);
    lastIndex = match.index + match[0].length;
  }
  const tail = paragraph.slice(lastIndex);
  if (tail) out.push(tail);
  return out.length > 0 ? out : [paragraph];
}

function splitLongParagraph(paragraph: string, maxLen: number): string[] {
  if (paragraph.length <= maxLen) return [paragraph];
  const sentences = splitSentences(paragraph);
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      out.push(current);
      current = "";
    }
  };

  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      flush();
      const words = sentence.split(/\s+/);
      let part = "";
      for (const word of words) {
        if (!word) continue;
        if (word.length > maxLen) {
          if (part) {
            out.push(part);
            part = "";
          }
          for (let offset = 0; offset < word.length; offset += maxLen) {
            out.push(word.slice(offset, offset + maxLen));
          }
          continue;
        }
        if (part && part.length + 1 + word.length > maxLen) {
          out.push(part);
          part = word;
        } else {
          part = part ? `${part} ${word}` : word;
        }
      }
      if (part) {
        out.push(part);
      }
      continue;
    }

    if (current && current.length + 1 + sentence.length > maxLen) {
      flush();
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();
  return out;
}
