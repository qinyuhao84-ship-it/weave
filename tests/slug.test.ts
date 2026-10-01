import { describe, it, expect } from "vitest";
import { slugify, uniqueSlug } from "@/lib/vault/slug";

describe("slugify", () => {
  it("把中文转成拼音", () => {
    expect(slugify("张一鸣")).toBe("zhang-yi-ming");
  });

  it("英文转小写并保留连字符", () => {
    expect(slugify("Byte Dance")).toBe("byte-dance");
  });

  it("中英混排", () => {
    expect(slugify("字节跳动 ByteDance")).toBe("zi-jie-tiao-dong-bytedance");
  });

  it("折叠连续的非字母数字为单个连字符", () => {
    expect(slugify("hello   ---   world")).toBe("hello-world");
    expect(slugify("A/B 测试")).toBe("a-b-ce-shi");
  });

  it("去掉首尾连字符", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
    expect(slugify("《推荐算法》")).toBe("tui-jian-suan-fa");
  });

  it("去掉变音符号", () => {
    expect(slugify("Café Résumé")).toBe("cafe-resume");
  });

  it("空字符串与纯符号返回空", () => {
    expect(slugify("")).toBe("");
    expect(slugify("！！！")).toBe("");
  });

  it("超长标题被截断到 80 字符", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("uniqueSlug", () => {
  it("未占用时原样返回", () => {
    expect(uniqueSlug("abc", () => false)).toBe("abc");
  });

  it("被占用时追加序号", () => {
    const taken = new Set(["abc", "abc-2"]);
    expect(uniqueSlug("abc", (c) => taken.has(c))).toBe("abc-3");
  });

  it("空 base 回退到 untitled", () => {
    expect(uniqueSlug("", () => false)).toBe("untitled");
  });
});
