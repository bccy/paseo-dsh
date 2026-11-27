import { defineTranslations } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { currentLocale, type Locale } from "../locale";
import { useCurrentLocale } from "../use-locale";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });

export type TranslationParams = Readonly<Record<string, string | number>>;

type ResourceTree = Readonly<Record<string, unknown>>;

const RESOURCES: Readonly<Record<Locale, ResourceTree>> = {
  en,
  "zh-CN": zhCN,
};

function hasOwn(obj: ResourceTree, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function lookupTemplate(tree: ResourceTree, key: string, count?: number): string | undefined {
  const segments = key.split(".");
  let current: ResourceTree = tree;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (!hasOwn(current, segment)) return undefined;
    const next = current[segment];
    if (!next || typeof next !== "object") return undefined;
    current = next as ResourceTree;
  }
  const leaf = segments[segments.length - 1]!;
  if (typeof count === "number") {
    if (count === 0) {
      const zeroKey = `${leaf}_zero`;
      if (hasOwn(current, zeroKey) && typeof current[zeroKey] === "string") {
        return current[zeroKey] as string;
      }
    } else if (count === 1) {
      const oneKey = `${leaf}_one`;
      if (hasOwn(current, oneKey) && typeof current[oneKey] === "string") {
        return current[oneKey] as string;
      }
    }
    const otherKey = `${leaf}_other`;
    if (hasOwn(current, otherKey) && typeof current[otherKey] === "string") {
      return current[otherKey] as string;
    }
  }
  if (hasOwn(current, leaf) && typeof current[leaf] === "string") {
    return current[leaf] as string;
  }
  return undefined;
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function translateAntigravity(
  key: string,
  params?: TranslationParams,
  localeOverride?: Locale,
): string {
  const locale = localeOverride ?? currentLocale();
  const count = typeof params?.count === "number" ? params.count : undefined;
  const template =
    lookupTemplate(RESOURCES[locale], key, count) ??
    (locale !== "en" ? lookupTemplate(RESOURCES.en, key, count) : undefined);
  if (template === undefined) return key;
  return interpolate(template, params);
}

export function useAntigravityTranslation(): {
  t: (key: string, params?: TranslationParams) => string;
  locale: Locale;
} {
  const locale = useCurrentLocale();
  const t = useCallback(
    (key: string, params?: TranslationParams) => translateAntigravity(key, params, locale),
    [locale],
  );
  return { t, locale };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
