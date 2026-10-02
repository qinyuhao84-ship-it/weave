import zh from "./zh-CN.json";
import en from "./en.json";

export type Locale = "zh-CN" | "en";
export const LOCALE_COOKIE = "weave-locale";
export function normalizeLocale(value: unknown): Locale { return value === "en" ? "en" : "zh-CN"; }
export function messagesFor(locale: Locale) { return locale === "en" ? en : zh; }

export { createUiTranslator } from "./translator";
