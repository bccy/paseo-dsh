import { useSyncExternalStore } from "react";
import {
  currentLocale,
  localeText,
  subscribeLocale,
  type Locale,
  type UiText,
} from "./locale";

/** Subscribe a React component to the active UI copy table. */
export function useLocaleText(): UiText {
  return useSyncExternalStore(subscribeLocale, localeText, localeText);
}

/** Subscribe a React component to the active display locale. */
export function useCurrentLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, currentLocale, currentLocale);
}
