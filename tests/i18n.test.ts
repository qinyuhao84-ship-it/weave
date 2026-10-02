import { expect, it } from "vitest";
import { createUiTranslator, messagesFor, normalizeLocale } from "@/lib/i18n";
import { localizeApiError } from "@/lib/i18n/errors";

it("两种语言覆盖相同文案，全部 ICU 消息可格式化", () => {
  const keys = (locale: "en" | "zh-CN") => Object.entries(messagesFor(locale)).flatMap(([namespace, messages]) => Object.keys(messages).map(key => `${namespace}.${key}`)).sort();
  expect(keys("en")).toEqual(keys("zh-CN"));
  for (const locale of ["zh-CN", "en"] as const) {
    const t = createUiTranslator(locale, error => { throw error; });
    for (const key of keys(locale)) {
      expect(t(key, { v0: 2, v1: 3, v2: 4, name: "原始资料", count: 2, minutes: 3, seconds: 4, effort: "Low" })).not.toBe(key);
    }
  }
});

it("模板变量按原文插入，文案不解释用户 HTML 或改变引用", () => {
  const t = createUiTranslator("en");
  const original = "中文 <script>alert(1)</script> [ID:999]";
  expect(t("documents_document_reader.m003", { v0: original })).toBe(`${original} · Preview`);
  expect(normalizeLocale("en")).toBe("en");
  expect(normalizeLocale("<script>")).toBe("zh-CN");
});

it("错误按稳定代码提供英文说明，中文兼容既有契约", () => {
  expect(localizeApiError("en", "CONFLICT", "旧说明")).toBe(localizeApiError("en", "CONFLICT", "新说明"));
  expect(localizeApiError("en", "CONFLICT", "旧说明")).toContain("Reload");
  expect(localizeApiError("zh-CN", "CONFLICT", "正文被外部修改")).toBe("正文被外部修改");
});
