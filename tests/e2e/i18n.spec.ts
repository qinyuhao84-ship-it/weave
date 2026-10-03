import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitForVisualSettling } from "./visual-settling";

test("设置移除语言入口；已保存的界面语言仍可读取，知识内容不受影响", async ({ page, context }) => {
  await page.goto("/settings");
  await expect(page.getByLabel("语言", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "语言", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await context.addCookies([{ name: "weave-locale", value: "en", url: "http://127.0.0.1:3300" }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByLabel("Language", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add model service", exact: true }).click();
  await page.getByLabel("Model name", { exact: true }).fill("未保存的模型-name");
  await expect(page.getByLabel("Model name", { exact: true })).toHaveValue("未保存的模型-name");
  await waitForVisualSettling(page);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations.map(item => item.id)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForVisualSettling(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("link", { name: "Knowledge base", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Knowledge base", exact: true })).toBeVisible();
});
