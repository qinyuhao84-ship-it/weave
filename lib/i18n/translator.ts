import { createTranslator, type TranslationValues, type IntlError } from "use-intl/core";
import zh from "./zh-CN.json";
import en from "./en.json";
import type { Locale } from "./index";

/** Catalogs have one namespace level. The wrapper also supports enum-derived keys. */
export function createUiTranslator(locale: Locale, onError?: (error: IntlError) => void) {
  const translate = createTranslator({ locale, messages: (locale === "en" ? en : zh), onError });
  type MessageKey = Parameters<typeof translate>[0];
  return Object.assign(
    (key: string, values?: TranslationValues) => translate(key as MessageKey, values),
    { has: (key: string) => translate.has(key as MessageKey) },
  );
}
