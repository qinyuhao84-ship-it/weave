import { createUiTranslator, normalizeLocale, type Locale } from "@/lib/i18n";
import type { TranslationValues } from "use-intl";

export function clientLocale(): Locale {
  return normalizeLocale(typeof document === "undefined" ? undefined : document.documentElement.lang);
}

/** API codes are stable contracts; server prose remains diagnostic detail. */
export function localizeApiError(locale: Locale, code: string, original: string): string {
  if (locale === "zh-CN") return original;
  const t = createUiTranslator(locale);
  const key = `apiErrors.${code}`;
  return t(t.has(key) ? key : "apiErrors.REQUEST_FAILED");
}

const uiTranslators = { "zh-CN": createUiTranslator("zh-CN"), en: createUiTranslator("en") };
/** For event handlers: translation never becomes a job subscription dependency. */
export function uiMessage(key: string, values?: TranslationValues): string { return uiTranslators[clientLocale()](key, values); }
