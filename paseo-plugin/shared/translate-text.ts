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
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:\/[\w.-]+){2,}/g, " ");
  const cjkCount = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinCount = (prose.match(/[A-Za-z]/g) ?? []).length;
  if (latinCount < 8) return false;
  return cjkCount < latinCount * 0.25;
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
