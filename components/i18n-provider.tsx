"use client";

import * as React from "react";
import { LOCALE_COOKIE, normalizeLocale, type Locale, createUiTranslator } from "@/lib/i18n";

function createI18n(locale: Locale) {
  const t = createUiTranslator(locale);
  return { locale, t };
}
const defaultI18n = { ...createI18n("zh-CN"), setLocale: (_locale: Locale) => {} };
const I18nContext = React.createContext(defaultI18n);

/** Locale is UI state. Switching never remounts editors or changes stored content. */
export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const [locale, updateLocale] = React.useState(initialLocale);
  const setLocale = React.useCallback((value: Locale) => {
    const next = normalizeLocale(value);
    document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.lang = next;
    updateLocale(next);
  }, []);
  const value = React.useMemo(() => ({ ...createI18n(locale), setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { return React.useContext(I18nContext); }
