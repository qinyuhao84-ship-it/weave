import { describe, it, expect } from "vitest";
import { intParam } from "@/lib/api";

describe("intParam —— 缺省值必须真的生效", () => {
  it("参数缺失时返回缺省值（不是最小值）", () => {
    // Number(null) 是 0，早期实现因此把缺省值吞掉、永远返回 min
    expect(intParam(null, 500, 1, 2000)).toBe(500);
    expect(intParam(null, 20, 1, 100)).toBe(20);
    expect(intParam(null, 3000, 10, 20000)).toBe(3000);
  });

  it("空串按缺失处理", () => {
    expect(intParam("", 42)).toBe(42);
    expect(intParam("   ", 42)).toBe(42);
  });

  it("正常解析并夹到区间内", () => {
    expect(intParam("25", 10)).toBe(25);
    expect(intParam("0", 10, 1, 100)).toBe(1);
    expect(intParam("9999", 10, 1, 100)).toBe(100);
  });

  it("非数字回落到缺省值", () => {
    expect(intParam("abc", 7)).toBe(7);
    expect(intParam("NaN", 7)).toBe(7);
  });

  it("小数被截断", () => {
    expect(intParam("12.9", 5)).toBe(12);
  });

  it("负数的处理", () => {
    expect(intParam("-5", 10, 1, 100)).toBe(1);
  });
});
