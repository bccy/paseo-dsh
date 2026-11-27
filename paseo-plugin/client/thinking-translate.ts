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
import { useEffect, useState } from "react";
import { MAX_TRANSLATE_TEXT_LENGTH, needsChineseTranslation } from "../shared/translate-text";

export type ThinkingTranslatorFn = (text: string, target: "zh-CN") => Promise<string>;

const MAX_CLIENT_CACHE = 400;
const MAX_FAILURE_COOLDOWN = 200;
const FAILURE_COOLDOWN_MS = 60_000;

let activeTranslator: ThinkingTranslatorFn | null = null;
const clientCache = new Map<string, string>();
const clientInflight = new Map<string, Promise<string>>();
const failureCooldown = new Map<string, number>();

export function registerThinkingTranslator(fn: ThinkingTranslatorFn): () => void {
  activeTranslator = fn;
  return () => {
    if (activeTranslator === fn) activeTranslator = null;
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
