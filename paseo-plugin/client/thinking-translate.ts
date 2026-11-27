/**
 * Client-side hook and cache for automatic Chinese translation of settled
 * English thinking rows (`InlineThinking`).
 *
 * Deliberately imports zero `@getpaseo/plugin` or `@tanstack/react-query`
 * modules so `InlineThinking` keeps running cleanly under isolated Node harness
 * stubs (`harness/thinking-check.cjs`) when no live translator is registered.
 *
 * @module dsh-paseo/client/thinking-translate
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_TRANSLATE_TEXT_LENGTH,
  isLikelyStartingEnglish,
  needsChineseTranslation,
  splitStreamingThinkingSegments,
  splitTranslationChunks,
} from "../shared/translate-text";

export type ThinkingTranslatorFn = (text: string, target: "zh-CN") => Promise<string>;

const MAX_CLIENT_CACHE = 400;
const MAX_PERSISTED_CACHE = 240;
const MAX_PERSISTED_BYTES = 180_000;
const MAX_FAILURE_COOLDOWN = 200;
const FAILURE_COOLDOWN_MS = 60_000;
const LIVE_TAIL_MIN_CHARS = 14;
/** Once earlier sentences are already visible, only live-translate genuinely long unclosed tails. */
const LIVE_TAIL_MIN_CHARS_SUBSEQUENT = 48;
const LIVE_TAIL_TRAILING_MS = 180;
const LIVE_TAIL_MAX_WAIT_MS = 320;
const PENDING_FALLBACK_STREAMING_MS = 6_000;
const PENDING_FALLBACK_SETTLED_MS = 2_200;
/** Settled thoughts up to this length translate in full while collapsed so tapping open is instant (0ms). */
export const EAGER_FULL_TRANSLATE_MAX_CHARS = 1_500;
/** Long historical thoughts (>1200 chars) split into parallel paragraph chunks for progressive display. */
const PROGRESSIVE_COMPLETE_THRESHOLD_CHARS = 1_200;
const PROGRESSIVE_COMPLETE_CHUNK_CHARS = 750;
const STORAGE_KEY = "dsh-paseo:thinking-zh:v2";

let activeTranslator: ThinkingTranslatorFn | null = null;
const clientCache = new Map<string, string>();
const clientInflight = new Map<string, Promise<string>>();
const failureCooldown = new Map<string, number>();
let storageLoaded = false;
let storageSaveTimer: ReturnType<typeof setTimeout> | null = null;

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): MinimalStorage | null {
  try {
    const storage = (globalThis as { localStorage?: unknown }).localStorage as MinimalStorage | undefined;
    if (storage && typeof storage.getItem === "function" && typeof storage.setItem === "function") {
      return storage;
    }
  } catch {
    // Restricted storage environment (e.g. private browsing / sandbox).
  }
  return null;
}

function ensureStorageHydrated(): void {
  if (storageLoaded) return;
  storageLoaded = true;
  const storage = getBrowserStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string" &&
        entry[0] &&
        entry[1]
      ) {
        clientCache.set(entry[0], entry[1]);
      }
    }
  } catch {
    // Ignore malformed persisted cache.
  }
}

function scheduleStoragePersist(): void {
  const storage = getBrowserStorage();
  if (!storage || storageSaveTimer !== null) return;
  storageSaveTimer = setTimeout(() => {
    storageSaveTimer = null;
    try {
      const entries = [...clientCache.entries()].slice(-MAX_PERSISTED_CACHE);
      const bounded: Array<[string, string]> = [];
      let approxBytes = 2;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const pair = entries[i]!;
        const pairBytes = pair[0].length + pair[1].length + 12;
        if (approxBytes + pairBytes > MAX_PERSISTED_BYTES) break;
        bounded.push(pair);
        approxBytes += pairBytes;
      }
      bounded.reverse();
      storage.setItem(STORAGE_KEY, JSON.stringify(bounded));
    } catch {
      // Ignore quota or serialization errors.
    }
  }, 600);
  (storageSaveTimer as { unref?: () => void } | null)?.unref?.();
}

export function registerThinkingTranslator(fn: ThinkingTranslatorFn): () => void {
  ensureStorageHydrated();
  activeTranslator = fn;
  return () => {
    if (activeTranslator === fn) {
      activeTranslator = null;
      if (storageSaveTimer !== null) {
        clearTimeout(storageSaveTimer);
        storageSaveTimer = null;
      }
    }
  };
}

function rememberClientTranslation(source: string, translated: string): void {
  clientCache.delete(source);
  clientCache.set(source, translated);
  while (clientCache.size > MAX_CLIENT_CACHE) {
    const oldest = clientCache.keys().next().value;
    if (oldest === undefined) break;
    clientCache.delete(oldest);
  }
  scheduleStoragePersist();
}

function rememberFailureCooldown(source: string, now = Date.now()): void {
  // Evict expired cooldown entries before inserting so failed texts never accumulate unboundedly.
  for (const [key, failedAt] of failureCooldown.entries()) {
    if (now - failedAt >= FAILURE_COOLDOWN_MS) {
      failureCooldown.delete(key);
    }
  }
  failureCooldown.delete(source);
  failureCooldown.set(source, now);
  while (failureCooldown.size > MAX_FAILURE_COOLDOWN) {
    const oldest = failureCooldown.keys().next().value;
    if (oldest === undefined) break;
    failureCooldown.delete(oldest);
  }
}

/**
 * Returns the cached or fetched Chinese translation of `text` when `enabled` is
 * true and a live translator is registered; returns `""` otherwise so callers
 * fall back cleanly to the original text with zero flicker.
 */
export function useTranslatedThinking(text: string, enabled: boolean): string {
  const translator = activeTranslator;
  const eligible =
    enabled &&
    translator !== null &&
    text.length <= MAX_TRANSLATE_TEXT_LENGTH &&
    needsChineseTranslation(text);
  const cached = eligible ? clientCache.get(text) ?? "" : "";
  const [resolved, setResolved] = useState<{ source: string; translated: string }>(() => ({
    source: text,
    translated: cached,
  }));

  useEffect(() => {
    if (!eligible || translator === null) return;
    const hit = clientCache.get(text);
    if (hit !== undefined) {
      setResolved((prev) =>
        prev.source === text && prev.translated === hit ? prev : { source: text, translated: hit },
      );
      return;
    }
    const failedAt = failureCooldown.get(text);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < FAILURE_COOLDOWN_MS) {
        return;
      }
      failureCooldown.delete(text);
    }

    let cancelled = false;
    let request = clientInflight.get(text);
    if (!request) {
      request = translator(text, "zh-CN")
        .then((out) => {
          const clean = typeof out === "string" ? out.trim() : "";
          if (clean && clean !== text) {
            rememberClientTranslation(text, clean);
            failureCooldown.delete(text);
            return clean;
          }
          // Empty or unchanged responses (e.g. untranslated echo) enter cooldown so
          // virtualized list remounts do not repeatedly fire duplicate RPCs.
          rememberFailureCooldown(text);
          return "";
        })
        .catch(() => {
          rememberFailureCooldown(text);
          return "";
        })
        .finally(() => {
          clientInflight.delete(text);
        });
      clientInflight.set(text, request);
    }

    void request.then((translated) => {
      if (cancelled || !translated) return;
      setResolved((prev) =>
        prev.source === text && prev.translated === translated
          ? prev
          : { source: text, translated },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [eligible, translator, text]);

  if (!eligible) return "";
  if (cached !== "") return cached;
  return resolved.source === text ? resolved.translated : "";
}

function isInFailureCooldown(source: string, now = Date.now()): boolean {
  const failedAt = failureCooldown.get(source);
  if (failedAt === undefined) return false;
  if (now - failedAt < FAILURE_COOLDOWN_MS) return true;
  failureCooldown.delete(source);
  return false;
}

function requestCachedTranslation(
  translator: ThinkingTranslatorFn,
  source: string,
): Promise<string> | null {
  if (isInFailureCooldown(source)) {
    return null;
  }
  let request = clientInflight.get(source);
  if (!request) {
    request = translator(source, "zh-CN")
      .then((out) => {
        const clean = typeof out === "string" ? out.trim() : "";
        if (clean && clean !== source) {
          rememberClientTranslation(source, clean);
          failureCooldown.delete(source);
          return clean;
        }
        rememberFailureCooldown(source);
        return "";
      })
      .catch(() => {
        rememberFailureCooldown(source);
        return "";
      })
      .finally(() => {
        clientInflight.delete(source);
      });
    clientInflight.set(source, request);
  }
  return request;
}

/**
 * Warms the client cache for `text` (e.g. on pointer hover / touch-down before
 * expanding a long thought) without mounting an extra hook or triggering state updates.
 */
export function prefetchThinkingTranslation(text: string): void {
  ensureStorageHydrated();
  const translator = activeTranslator;
  if (
    translator === null ||
    text.length > MAX_TRANSLATE_TEXT_LENGTH ||
    !needsChineseTranslation(text) ||
    clientCache.has(text)
  ) {
    return;
  }
  if (text.length > PROGRESSIVE_COMPLETE_THRESHOLD_CHARS) {
    const { pieces } = splitTranslationChunks(text, PROGRESSIVE_COMPLETE_CHUNK_CHARS);
    for (const piece of pieces) {
      if (needsChineseTranslation(piece) && !clientCache.has(piece)) {
        void requestCachedTranslation(translator, piece);
      }
    }
    return;
  }
  void requestCachedTranslation(translator, text);
}

export interface StreamingThinkingTranslation {
  /** Assembled Chinese translation when at least one segment is ready; `""` otherwise. */
  translated: string;
  /** Latest non-empty translated sentence/line for collapsed live previews. */
  latestTranslatedLine: string;
  /**
   * True during the brief initial wait (~100-300ms) before the first Chinese
   * translation arrives, so callers can display a calm placeholder (`推理中…`)
   * instead of flashing raw English and then jumping to Chinese.
   */
  pending: boolean;
}

/**
 * Incrementally translates streaming thinking content sentence-by-sentence
 * without English <-> Chinese flicker:
 * - Each closed sentence/line is translated once and locked in `clientCache`
 *   (and synchronously hydrated from browser `localStorage` on Web).
 * - When an active tail closes into a sentence, the prior live-tail Chinese is
 *   carried seamlessly across the ~100ms handoff window so it never flashes
 *   back to English.
 * - While tokens stream nonstop, the live tail uses a throttle + trailing
 *   cadence (~180ms pause / ~320ms max wait) instead of a pure debounce that
 *   would starve until a pause.
 * - Un-translated raw English tail text is never appended onto translated
 *   Chinese; a subtle ellipsis (`…`) holds the spot while streaming.
 */
export function useStreamingTranslatedThinking(
  text: string,
  phase: "streaming" | "complete",
  enabled: boolean,
  rowKey?: string,
): StreamingThinkingTranslation {
  ensureStorageHydrated();
  const translator = activeTranslator;
  const startingEnglish =
    enabled &&
    translator !== null &&
    phase === "streaming" &&
    isLikelyStartingEnglish(text);
  const eligible =
    enabled &&
    translator !== null &&
    text.length <= MAX_TRANSLATE_TEXT_LENGTH &&
    needsChineseTranslation(text);

  const mountedRef = useRef<boolean>(true);
  const rowEpochRef = useRef<number>(0);
  const prevRowKeyRef = useRef<string | undefined>(rowKey);
  const wasStreamingRef = useRef<boolean>(phase === "streaming");
  const prevTextRef = useRef<string>(text);
  const segFallbackRef = useRef<Map<number, { sourcePrefix: string; translated: string }>>(new Map());
  const tailLastRunRef = useRef<number>(0);
  const tailInflightRef = useRef<boolean>(false);
  const tailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tailDeadlineRef = useRef<number>(0);
  const prevTailIndexRef = useRef<number>(-1);

  const rowKeySwitched =
    rowKey !== undefined &&
    prevRowKeyRef.current !== undefined &&
    rowKey !== prevRowKeyRef.current;
  const textChanged = text !== prevTextRef.current;
  const grewSameRow = prevTextRef.current !== "" && text.startsWith(prevTextRef.current);

  if (rowKeySwitched || (textChanged && !grewSameRow)) {
    rowEpochRef.current += 1;
    wasStreamingRef.current = phase === "streaming";
    segFallbackRef.current.clear();
    tailLastRunRef.current = 0;
    tailInflightRef.current = false;
    prevTailIndexRef.current = -1;
  }
  prevRowKeyRef.current = rowKey;
  prevTextRef.current = text;
  if (phase === "streaming") {
    wasStreamingRef.current = true;
  }

  const rowEpoch = rowEpochRef.current;

  const [version, setVersion] = useState(0);
  const [liveTail, setLiveTail] = useState<{
    epoch: number;
    index: number;
    source: string;
    translated: string;
  }>({
    epoch: -1,
    index: -1,
    source: "",
    translated: "",
  });
  const [placeholderTimedOutState, setPlaceholderTimedOutState] = useState<{
    epoch: number;
    timedOut: boolean;
  }>({ epoch: -1, timedOut: false });
  const [settledTimedOutState, setSettledTimedOutState] = useState<{
    epoch: number;
    timedOut: boolean;
  }>({ epoch: -1, timedOut: false });

  const placeholderTimedOut =
    placeholderTimedOutState.epoch === rowEpoch && placeholderTimedOutState.timedOut;
  const settledTimedOut =
    settledTimedOutState.epoch === rowEpoch && settledTimedOutState.timedOut;

  const fullCacheHit = eligible ? clientCache.get(text) ?? "" : "";

  const segments = useMemo(() => {
    if (!eligible || fullCacheHit !== "") return [];
    if (phase === "complete" && !wasStreamingRef.current) {
      if (text.length > PROGRESSIVE_COMPLETE_THRESHOLD_CHARS) {
        const { pieces, seps } = splitTranslationChunks(text, PROGRESSIVE_COMPLETE_CHUNK_CHARS);
        if (pieces.length > 1) {
          return pieces.map((piece, idx) => ({
            text: piece,
            sep: seps[idx] ?? "",
            closed: true,
            isCode: false,
          }));
        }
      }
      return [];
    }
    return splitStreamingThinkingSegments(text, phase);
  }, [eligible, fullCacheHit, phase, text, rowEpoch]);

  const useIncremental =
    eligible &&
    fullCacheHit === "" &&
    (phase === "streaming" || wasStreamingRef.current || segments.length > 1);

  const openTailInfo = useMemo(() => {
    if (!useIncremental || phase !== "streaming" || segments.length === 0) {
      return { index: -1, text: "" };
    }
    const index = segments.length - 1;
    const last = segments[index]!;
    if (last.closed || last.isCode) return { index: -1, text: "" };
    // Prioritize earlier unresolved closed segments: avoid spending RPC slots on
    // a partial tail that is blocked behind the in-order barrier anyway.
    for (let i = 0; i < index; i += 1) {
      const seg = segments[i]!;
      if (seg.closed && !seg.isCode && needsChineseTranslation(seg.text) && !clientCache.has(seg.text)) {
        return { index: -1, text: "" };
      }
    }
    const trimmed = last.text.trim();
    const minChars = index === 0 ? LIVE_TAIL_MIN_CHARS : LIVE_TAIL_MIN_CHARS_SUBSEQUENT;
    if (trimmed.length < minChars || !needsChineseTranslation(trimmed)) {
      return { index: -1, text: "" };
    }
    return { index, text: trimmed };
  }, [useIncremental, phase, segments, version]);

  const latestTailRef = useRef<{
    epoch: number;
    index: number;
    text: string;
    eligible: boolean;
    translator: ThinkingTranslatorFn | null;
  }>({
    epoch: rowEpoch,
    index: openTailInfo.index,
    text: openTailInfo.text,
    eligible,
    translator,
  });
  latestTailRef.current = {
    epoch: rowEpoch,
    index: openTailInfo.index,
    text: openTailInfo.text,
    eligible,
    translator,
  };

  const liveTailRef = useRef(liveTail);
  liveTailRef.current = liveTail;

  const clearTailTimer = () => {
    if (tailTimerRef.current !== null) {
      clearTimeout(tailTimerRef.current);
      tailTimerRef.current = null;
    }
    tailDeadlineRef.current = 0;
  };

  // Track component unmount and clean up any pending live-tail timer.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTailTimer();
    };
  }, []);

  // Reset per-row transient state when switching to an unrelated thought or toggling mode.
  useEffect(() => {
    setPlaceholderTimedOutState((prev) =>
      prev.epoch === rowEpoch && !prev.timedOut ? prev : { epoch: rowEpoch, timedOut: false },
    );
    setSettledTimedOutState((prev) =>
      prev.epoch === rowEpoch && !prev.timedOut ? prev : { epoch: rowEpoch, timedOut: false },
    );
    setLiveTail((prev) =>
      prev.epoch === rowEpoch
        ? prev
        : { epoch: rowEpoch, index: -1, source: "", translated: "" },
    );
    clearTailTimer();
  }, [rowEpoch, enabled, translator !== null, fullCacheHit !== ""]);

  // Effect 1: Translate closed segments (incremental mode) or whole text (historical complete mode).
  useEffect(() => {
    if (!eligible || translator === null || fullCacheHit !== "") return;
    let cancelled = false;
    const bump = () => {
      if (!cancelled) setVersion((v) => v + 1);
    };

    if (!useIncremental) {
      const req = requestCachedTranslation(translator, text);
      if (req) {
        void req.then(() => {
          bump();
        });
      }
      return () => {
        cancelled = true;
      };
    }

    for (const seg of segments) {
      if (!seg.closed || seg.isCode) continue;
      if (!needsChineseTranslation(seg.text)) continue;
      if (clientCache.has(seg.text)) continue;
      const req = requestCachedTranslation(translator, seg.text);
      if (req) {
        void req.then(() => {
          bump();
        });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [eligible, translator, fullCacheHit, useIncremental, segments, text]);

  // Effect 2: Fixed-deadline throttle + trailing translation of the live unclosed tail.
  // Never cancels an in-flight RPC merely because more tokens arrived on the same sentence,
  // and always schedules a follow-up in `finally` if newer tokens arrived while in flight.
  const scheduleLiveTailRef = useRef<() => void>(() => undefined);
  scheduleLiveTailRef.current = () => {
    const latest = latestTailRef.current;
    if (!mountedRef.current || !latest.eligible || latest.translator === null || !latest.text) {
      clearTailTimer();
      return;
    }
    const currentLive = liveTailRef.current;
    if (
      currentLive.epoch === latest.epoch &&
      currentLive.index === latest.index &&
      currentLive.source === latest.text &&
      currentLive.translated !== ""
    ) {
      clearTailTimer();
      return;
    }
    const cachedTail = clientCache.get(latest.text);
    if (cachedTail !== undefined) {
      clearTailTimer();
      const prevFallback = segFallbackRef.current.get(latest.index);
      if (!prevFallback || latest.text.length >= prevFallback.sourcePrefix.length) {
        segFallbackRef.current.set(latest.index, {
          sourcePrefix: latest.text,
          translated: cachedTail,
        });
      }
      setLiveTail({
        epoch: latest.epoch,
        index: latest.index,
        source: latest.text,
        translated: cachedTail,
      });
      return;
    }
    if (isInFailureCooldown(latest.text)) {
      clearTailTimer();
      return;
    }
    if (tailInflightRef.current) {
      return;
    }

    const now = Date.now();
    const sinceLast = now - tailLastRunRef.current;
    const desiredDelay =
      tailLastRunRef.current === 0 || sinceLast >= LIVE_TAIL_MAX_WAIT_MS
        ? 40
        : Math.min(LIVE_TAIL_TRAILING_MS, Math.max(40, LIVE_TAIL_MAX_WAIT_MS - sinceLast));
    const desiredAt = now + desiredDelay;

    // Keep an existing earlier deadline so nonstop fast token streams cannot starve the timer.
    if (tailTimerRef.current !== null && tailDeadlineRef.current > 0 && tailDeadlineRef.current <= desiredAt) {
      return;
    }

    clearTailTimer();
    tailDeadlineRef.current = desiredAt;
    tailTimerRef.current = setTimeout(() => {
      tailTimerRef.current = null;
      tailDeadlineRef.current = 0;
      const current = latestTailRef.current;
      if (
        !mountedRef.current ||
        !current.eligible ||
        current.translator === null ||
        !current.text ||
        tailInflightRef.current
      ) {
        return;
      }
      if (isInFailureCooldown(current.text)) return;

      const targetEpoch = current.epoch;
      const targetIndex = current.index;
      const targetText = current.text;
      const fn = current.translator;

      tailInflightRef.current = true;
      tailLastRunRef.current = Date.now();

      void fn(targetText, "zh-CN")
        .then((out) => {
          const clean = typeof out === "string" ? out.trim() : "";
          if (!clean || clean === targetText) {
            rememberFailureCooldown(targetText);
            return;
          }
          failureCooldown.delete(targetText);
          if (!mountedRef.current || targetEpoch !== rowEpochRef.current) return;
          const prevFallback = segFallbackRef.current.get(targetIndex);
          if (!prevFallback || targetText.length >= prevFallback.sourcePrefix.length) {
            segFallbackRef.current.set(targetIndex, {
              sourcePrefix: targetText,
              translated: clean,
            });
          }
          setLiveTail((prev) => {
            if (
              prev.epoch === targetEpoch &&
              prev.index === targetIndex &&
              prev.source.length > targetText.length &&
              prev.source.startsWith(targetText)
            ) {
              return prev;
            }
            return {
              epoch: targetEpoch,
              index: targetIndex,
              source: targetText,
              translated: clean,
            };
          });
        })
        .catch(() => {
          rememberFailureCooldown(targetText);
        })
        .finally(() => {
          tailInflightRef.current = false;
          const after = latestTailRef.current;
          if (
            mountedRef.current &&
            after.epoch === rowEpochRef.current &&
            after.eligible &&
            after.translator !== null &&
            after.text &&
            (after.index !== targetIndex || after.text !== targetText)
          ) {
            scheduleLiveTailRef.current();
          }
        });
    }, desiredDelay);
  };

  useEffect(() => {
    if (!eligible || translator === null || !openTailInfo.text) {
      prevTailIndexRef.current = -1;
      clearTailTimer();
      return;
    }
    if (prevTailIndexRef.current !== openTailInfo.index) {
      prevTailIndexRef.current = openTailInfo.index;
      clearTailTimer();
    }
    scheduleLiveTailRef.current();
  }, [eligible, translator, rowEpoch, openTailInfo.index, openTailInfo.text]);

  const computeResult = (): {
    output: StreamingThinkingTranslation;
    allTranslatableResolved: boolean;
  } => {
    if (!eligible) {
      return {
        output: {
          translated: "",
          latestTranslatedLine: "",
          pending: startingEnglish && !placeholderTimedOut,
        },
        allTranslatableResolved: false,
      };
    }

    if (fullCacheHit !== "") {
      const lines = fullCacheHit.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return {
        output: {
          translated: fullCacheHit,
          latestTranslatedLine: (lines[lines.length - 1] ?? fullCacheHit).replaceAll("**", ""),
          pending: false,
        },
        allTranslatableResolved: true,
      };
    }

    if (!useIncremental) {
      const inCooldown = isInFailureCooldown(text);
      return {
        output: {
          translated: "",
          latestTranslatedLine: "",
          pending: !inCooldown && !placeholderTimedOut,
        },
        allTranslatableResolved: false,
      };
    }

    let hasAnyTranslation = false;
    let hasActiveTranslatable = false;
    let allTranslatableResolved = phase === "complete";
    let hasUnresolvedTail = false;
    let assembled = "";
    let latestTranslatedLine = "";

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      if (!seg.text) {
        assembled += seg.sep;
        continue;
      }
      if (seg.isCode || !needsChineseTranslation(seg.text)) {
        // Keep code blocks / already-Chinese text verbatim; suppress tiny trailing
        // English fragments while streaming so raw English words don't pop in at the end.
        if (!seg.isCode && !seg.closed && phase === "streaming" && isLikelyStartingEnglish(seg.text)) {
          hasUnresolvedTail = true;
          hasActiveTranslatable = true;
          continue;
        }
        assembled += seg.text + seg.sep;
        continue;
      }
      const leadingSpace = seg.text.slice(0, seg.text.length - seg.text.trimStart().length);
      if (seg.closed) {
        const hit = clientCache.get(seg.text);
        if (hit !== undefined) {
          hasAnyTranslation = true;
          segFallbackRef.current.set(i, { sourcePrefix: seg.text.trim(), translated: hit });
          assembled += leadingSpace + hit + seg.sep;
          const clean = hit.replaceAll("**", "").trim();
          if (clean) latestTranslatedLine = clean;
        } else {
          allTranslatableResolved = false;
          const inCooldown = isInFailureCooldown(seg.text);
          if (phase === "complete" && (inCooldown || settledTimedOut)) {
            // Segment failed/echoed into cooldown or settled grace window expired:
            // fall back verbatim to source text so completed thoughts never drop or hang.
            assembled += seg.text + seg.sep;
          } else {
            if (!inCooldown) hasActiveTranslatable = true;
            // Seamless handoff while the full closed sentence is still translating:
            // carry prior liveTail prefix briefly instead of flashing back to English.
            const prev = segFallbackRef.current.get(i);
            const trimmedClosed = seg.text.trim();
            if (
              prev &&
              !inCooldown &&
              (trimmedClosed.startsWith(prev.sourcePrefix) || prev.sourcePrefix.startsWith(trimmedClosed))
            ) {
              hasAnyTranslation = true;
              assembled += leadingSpace + prev.translated + seg.sep;
              const clean = prev.translated.replaceAll("**", "").trim();
              if (clean) latestTranslatedLine = clean;
            } else {
              // Strict monotonic in-order barrier: later closed sentences still
              // translate concurrently into `clientCache`, but never jump ahead
              // of an unresolved earlier sentence (preventing mid-stream rewrite flashes).
              hasUnresolvedTail = true;
              break;
            }
          }
        }
        continue;
      }

      // Active unclosed streaming tail: show latest translated Chinese tail if
      // available; otherwise hold off showing raw English until translation arrives.
      const trimmedTail = seg.text.trim();
      const prev = segFallbackRef.current.get(i);
      const fromLiveTail =
        liveTail.epoch === rowEpoch &&
        liveTail.index === i &&
        liveTail.translated !== "" &&
        (trimmedTail === liveTail.source || trimmedTail.startsWith(liveTail.source))
          ? liveTail.translated
          : "";
      const fromPrev =
        fromLiveTail === "" &&
        prev &&
        (trimmedTail === prev.sourcePrefix || trimmedTail.startsWith(prev.sourcePrefix))
          ? prev.translated
          : "";
      const usableLiveTail = fromLiveTail || fromPrev;
      if (usableLiveTail !== "") {
        hasAnyTranslation = true;
        assembled += leadingSpace + usableLiveTail + seg.sep;
        latestTranslatedLine = usableLiveTail.replaceAll("**", "").trim();
      } else {
        hasUnresolvedTail = true;
        if (!isInFailureCooldown(trimmedTail)) hasActiveTranslatable = true;
      }
    }

    if (!hasAnyTranslation) {
      return {
        output: {
          translated: "",
          latestTranslatedLine: "",
          pending: hasActiveTranslatable && !placeholderTimedOut && !settledTimedOut,
        },
        allTranslatableResolved: false,
      };
    }

    if ((phase === "streaming" || !allTranslatableResolved) && hasUnresolvedTail && assembled.trim() !== "") {
      assembled = assembled.trimEnd() + "…";
    }

    return {
      output: { translated: assembled, latestTranslatedLine, pending: false },
      allTranslatableResolved,
    };
  };

  const { output: result, allTranslatableResolved } = computeResult();

  // Persist completed assembled translation in an effect (never during render).
  const completedCacheCandidate =
    useIncremental && phase === "complete" && allTranslatableResolved && result.translated !== ""
      ? result.translated
      : "";
  useEffect(() => {
    if (!completedCacheCandidate || fullCacheHit !== "") return;
    rememberClientTranslation(text, completedCacheCandidate);
  }, [text, completedCacheCandidate, fullCacheHit]);

  // Safety timeout 1: if initial translation stalls before any segment resolves,
  // drop `pending` so the user gracefully sees the original text.
  useEffect(() => {
    if (!result.pending) return;
    const waitMs = phase === "streaming" ? PENDING_FALLBACK_STREAMING_MS : PENDING_FALLBACK_SETTLED_MS;
    const timer = setTimeout(() => {
      setPlaceholderTimedOutState({ epoch: rowEpoch, timedOut: true });
    }, waitMs);
    return () => clearTimeout(timer);
  }, [result.pending, phase, rowEpoch]);

  // Safety timeout 2: when a thought has completed in incremental mode and some
  // segments are still unresolved (even though earlier segments resolved and
  // `result.pending` is false), guarantee fallback to verbatim source segments.
  const needsSettledFallbackTimer =
    useIncremental && phase === "complete" && !allTranslatableResolved && !settledTimedOut;
  useEffect(() => {
    if (!needsSettledFallbackTimer) return;
    const timer = setTimeout(() => {
      setSettledTimedOutState({ epoch: rowEpoch, timedOut: true });
    }, PENDING_FALLBACK_SETTLED_MS);
    return () => clearTimeout(timer);
  }, [needsSettledFallbackTimer, rowEpoch]);

  return result;
}
