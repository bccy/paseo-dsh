import type { AskQuestionEntry } from "../../shared/antigravity/contracts";

export const SKIPPED_REPLY = "User Skipped";
const RECOMMENDED_PREFIX = /^(?:\(recommended\)|\[recommended\]|（推荐）|【推荐】)\s*/i;

export interface ParsedOption {
  raw: string;
  label: string;
  recommended: boolean;
}

export type QuestionResolution =
  | { state: "pending" }
  | { state: "loading" }
  | { state: "skipped" }
  | { state: "settled" }
  | { state: "answered"; perQuestion: Array<string | null>; fallbackText: string | null };

export function normalizeEchoText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Exact chat fallback text `agy acp` emits in `askQuestionInChat` when the client lacks form elicitation. */
export function formatQuestionEcho(questions: readonly AskQuestionEntry[]): string {
  return normalizeEchoText(
    questions
      .map((entry) => {
        if (entry.options.length === 0) return entry.question;
        const lines = entry.options.map((option, index) => `- [${index + 1}] ${option}`);
        return `${entry.question}\n${lines.join("\n")}`;
      })
      .join("\n\n"),
  );
}

export function parseOption(raw: string): ParsedOption {
  const trimmed = raw.trim();
  const match = RECOMMENDED_PREFIX.exec(trimmed);
  if (match) {
    const rest = trimmed.slice(match[0].length).trim();
    if (rest.length > 0) return { raw: trimmed, label: rest, recommended: true };
  }
  return { raw: trimmed, label: trimmed, recommended: false };
}

export function cleanOptionLabel(raw: string): string {
  return parseOption(raw).label;
}

/** Maps a numeric reply like `"1"` or `"1, 2"` back to the option labels when possible. */
export function humanizeAnswer(entry: AskQuestionEntry, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    if (idx >= 0 && idx < entry.options.length) {
      return cleanOptionLabel(entry.options[idx]!);
    }
  }
  if (entry.multiSelect && /^\d+(?:\s*[,，、\s]\s*\d+)+$/.test(trimmed)) {
    const parts = trimmed
      .split(/[,，、\s]+/)
      .filter(Boolean)
      .map((part) => Number(part) - 1);
    if (parts.length > 0 && parts.every((idx) => idx >= 0 && idx < entry.options.length)) {
      return parts.map((idx) => cleanOptionLabel(entry.options[idx]!)).join(" · ");
    }
  }
  if (entry.multiSelect && trimmed.includes("; ")) {
    const parts = trimmed
      .split("; ")
      .map((part) => cleanOptionLabel(part))
      .filter(Boolean);
    if (parts.length > 1) return parts.join(" · ");
  }
  return cleanOptionLabel(trimmed);
}

/** Parses `agy`'s `AskQuestionTool` output (`A1: ...\nA2: ...`) when replayed from history. */
export function resolutionFromToolOutput(
  questions: readonly AskQuestionEntry[],
  output: string | null,
): QuestionResolution | null {
  const trimmed = (output ?? "").trim();
  if (!trimmed) return null;
  const blocks = trimmed.split(/\n(?=A\d+:\s*)/);
  const byIndex = new Map<number, string>();
  for (const block of blocks) {
    const match = /^A(\d+):\s*([\s\S]*)$/.exec(block.trim());
    if (!match) continue;
    byIndex.set(Number(match[1]) - 1, (match[2] ?? "").trim());
  }
  if (byIndex.size === 0) {
    if (trimmed.toLowerCase() === SKIPPED_REPLY.toLowerCase()) return { state: "skipped" };
    return {
      state: "answered",
      perQuestion: questions.length === 1 ? [humanizeAnswer(questions[0]!, trimmed)] : questions.map(() => null),
      fallbackText: questions.length === 1 ? null : trimmed,
    };
  }
  const values = [...byIndex.values()];
  if (values.length > 0 && values.every((value) => value.toLowerCase() === SKIPPED_REPLY.toLowerCase())) {
    return { state: "skipped" };
  }
  // When agy answered in chat mode for multiple questions, every entry received the same WriteInResponse.
  const allSame = values.length > 1 && values.every((value) => value === values[0]);
  if (allSame && values[0]) {
    const parsed = resolutionFromUserReply(questions, values[0]);
    if (
      parsed.state === "skipped" ||
      (parsed.state === "answered" && parsed.perQuestion.some((answer) => answer !== null))
    ) {
      return parsed;
    }
  }
  return {
    state: "answered",
    perQuestion: questions.map((entry, idx) => {
      const val = byIndex.get(idx);
      if (!val || val.toLowerCase() === SKIPPED_REPLY.toLowerCase()) return null;
      return humanizeAnswer(entry, val);
    }),
    fallbackText: null,
  };
}

/** Parses the user's follow-up message in the timeline into per-question answers. */
export function resolutionFromUserReply(
  questions: readonly AskQuestionEntry[],
  reply: string,
): QuestionResolution {
  const trimmed = reply.trim();
  if (!trimmed) return { state: "settled" };
  if (trimmed.toLowerCase() === SKIPPED_REPLY.toLowerCase()) return { state: "skipped" };
  if (questions.length === 1) {
    return {
      state: "answered",
      perQuestion: [humanizeAnswer(questions[0]!, trimmed)],
      fallbackText: null,
    };
  }
  const numbered = new Map<number, string>();
  for (const block of trimmed.split(/\n(?=(?:Q)?\d+[.:：)]\s*)/i)) {
    const match = /^(?:Q)?(\d+)[.:：)]\s*([\s\S]+)$/i.exec(block.trim());
    if (!match) continue;
    const idx = Number(match[1]) - 1;
    if (idx >= 0 && idx < questions.length) {
      numbered.set(idx, (match[2] ?? "").trim());
    }
  }
  if (numbered.size > 0) {
    return {
      state: "answered",
      perQuestion: questions.map((entry, idx) => {
        const raw = numbered.get(idx);
        return raw ? humanizeAnswer(entry, raw) : null;
      }),
      fallbackText: null,
    };
  }
  return {
    state: "answered",
    perQuestion: questions.map(() => null),
    fallbackText: trimmed,
  };
}

export function isQuestionAnswered(
  _entry: AskQuestionEntry,
  selected: ReadonlySet<number> | undefined,
  custom: string | undefined,
): boolean {
  if (selected && selected.size > 0) return true;
  return (custom ?? "").trim().length > 0;
}

export function formatQuestionAnswer(
  entry: AskQuestionEntry,
  selected: ReadonlySet<number> | undefined,
  custom: string | undefined,
): { wire: string; display: string } {
  const chosen = [...(selected ?? [])]
    .sort((a, b) => a - b)
    .map((idx) => entry.options[idx])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const free = (custom ?? "").trim();
  if (!entry.multiSelect) {
    if (free.length > 0) return { wire: free, display: free };
    const pick = chosen[0] ?? "";
    return { wire: pick, display: cleanOptionLabel(pick) };
  }
  const wireParts = [...chosen, ...(free ? [free] : [])];
  const displayParts = [...chosen.map(cleanOptionLabel), ...(free ? [free] : [])];
  return {
    wire: wireParts.join("; "),
    display: displayParts.join(" · "),
  };
}

export function buildSubmission(
  questions: readonly AskQuestionEntry[],
  selections: Readonly<Record<number, ReadonlySet<number>>>,
  customTexts: Readonly<Record<number, string>>,
): { wireText: string; perQuestionDisplay: string[] } {
  const built = questions.map((entry, idx) => formatQuestionAnswer(entry, selections[idx], customTexts[idx]));
  const perQuestionDisplay = built.map((item) => item.display);
  if (questions.length === 1) {
    return { wireText: built[0]?.wire ?? "", perQuestionDisplay };
  }
  const wireText = built.map((item, idx) => `${idx + 1}. ${item.wire}`).join("\n");
  return { wireText, perQuestionDisplay };
}

/** Parses Antigravity's `ask_question` input (`{ questions: [{ question, options, is_multi_select }] }`). */
export function parseAskQuestions(input: unknown): AskQuestionEntry[] | null {
  if (!input || typeof input !== "object") return null;
  const record = input as { questions?: unknown };
  let rawList: unknown = record.questions;
  if (typeof rawList === "string") {
    try {
      rawList = JSON.parse(rawList);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(rawList) || rawList.length === 0) return null;
  const entries: AskQuestionEntry[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      is_multi_select?: unknown;
      isMultiSelect?: unknown;
      multiSelect?: unknown;
    };
    // Other providers pass `header` + object options; Antigravity passes `question` + string options.
    if (typeof candidate.header === "string") return null;
    if (typeof candidate.question !== "string" || !candidate.question.trim()) return null;
    const rawOptions = Array.isArray(candidate.options) ? candidate.options : [];
    const options: string[] = [];
    for (const option of rawOptions) {
      if (typeof option !== "string") return null;
      if (option.trim()) options.push(option.trim());
    }
    entries.push({
      question: candidate.question.trim(),
      options,
      multiSelect:
        candidate.is_multi_select === true ||
        candidate.isMultiSelect === true ||
        candidate.multiSelect === true,
    });
  }
  return entries.length > 0 ? entries : null;
}

export function extractToolOutput(output: unknown): string | null {
  if (typeof output === "string") return output.trim() || null;
  if (output && typeof output === "object" && "output" in output) {
    const inner = (output as { output?: unknown }).output;
    if (typeof inner === "string") return inner.trim() || null;
  }
  return null;
}
