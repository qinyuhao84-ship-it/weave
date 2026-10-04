import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDocument } from "@mixmark-io/domino";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { assertHtmlIsolation } from "../e2e/html-isolation";
import { waitForVisualSettling } from "../e2e/visual-settling";

const output = path.resolve(process.env.WEAVE_READING_EVIDENCE_DIR || "docs/evidence/reading-pages-2026-10-03");
type Sample = { name: string; sessionId: string; artifactId: string };
const samples = () => JSON.parse(fs.readFileSync(path.join(output, "browser-sessions.json"), "utf8")) as Sample[];

async function openSample(page: Page, name: string) {
  const sample = samples().find(entry => entry.name === name)!;
  await page.goto(`/chat?s=${sample.sessionId}`);
  const frame = page.frameLocator('iframe[title="回答图解.html · 预览"]');
  await expect(frame.locator("html")).toHaveAttribute("data-weave-reading", "1");
  await expect(frame.locator("html")).toHaveAttribute("data-weave-theme", "light");
  return { frame, sample };
}

async function checkControls(page: Page, name: string) {
  const frame = page.frameLocator('iframe[title="回答图解.html · 预览"]');
  if (name === "flow") {
    const previous = frame.getByRole("button", { name: "上一步", exact: true });
    const next = frame.getByRole("button", { name: "下一步", exact: true });
    const reset = frame.getByRole("button", { name: "重新开始", exact: true });
    await expect(previous).toBeDisabled();
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(frame.locator("#pos")).toContainText("第 2 / 5 步");
    await expect(frame.locator('[data-panel="1"]')).toBeVisible();
    for (let index = 0; index < 3; index++) await next.click();
    await expect(next).toBeDisabled();
    await expect(frame.locator('[data-panel="4"]')).toBeVisible();
    await previous.click();
    await expect(frame.locator("#pos")).toContainText("第 4 / 5 步");
    await reset.click();
    await expect(previous).toBeDisabled();
    for (let index = 0; index < 5; index++) {
      await frame.locator(".flow-node").nth(index).click();
      await expect(frame.locator(".flow-node").nth(index)).toHaveAttribute("aria-current", "step");
      await expect(frame.locator("#pos")).toContainText(`第 ${index + 1} / 5 步`);
    }
    await reset.click();
    await next.click();
    for (const summary of await frame.locator("details summary").all()) {
      await summary.click();
      await expect(summary.locator("..")).toHaveAttribute("open");
      await summary.click();
      await expect(summary.locator("..")).not.toHaveAttribute("open");
    }
  } else if (name === "comparison") {
    const sliders = frame.getByRole("slider");
    await sliders.nth(0).focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await sliders.nth(1).focus();
    await page.keyboard.press("End");
    await expect(frame.locator("#barRectVal")).toHaveText("20 cm²");
    await expect(frame.locator("#barTriVal")).toHaveText("10 cm²");
    await expect(frame.locator("#rectEq")).toContainText("20");
    await expect(frame.locator("#triEq")).toContainText("10");
    await frame.getByRole("button", { name: "三角形放进矩形", exact: true }).click();
    await expect(frame.locator("#view-overlay")).toBeVisible();
    await expect(frame.getByRole("button", { name: "三角形放进矩形", exact: true })).toHaveAttribute("aria-pressed", "true");
    await frame.getByRole("button", { name: "并列比较", exact: true }).click();
    await expect(frame.locator("#view-compare")).toBeVisible();
    await sliders.nth(0).focus();
    await page.keyboard.press("End");
    await expect(frame.locator("#barRectVal")).toHaveText("100 cm²");
    await expect(frame.locator("#barTriVal")).toHaveText("50 cm²");
  } else if (name === "parameters") {
    const clear = frame.getByRole("button", { name: "清除比较", exact: true });
    const preset = frame.getByRole("button", { name: "3 厘米 × 2 厘米", exact: true });
    const shape = await frame.locator("#ra-area-rect").elementHandle();
    await preset.click();
    await expect(frame.locator("#ra-area-val")).toHaveText("6");
    await frame.getByRole("button", { name: "长度加倍", exact: true }).click();
    await expect(frame.locator("#ra-area-val")).toHaveText("12");
    await expect(frame.getByRole("button", { name: "长度加倍", exact: true })).toBeDisabled();
    await frame.getByRole("button", { name: "宽度加倍", exact: true }).click();
    await expect(frame.locator("#ra-area-val")).toHaveText("24");
    await preset.click();
    await frame.getByRole("button", { name: "两边都加倍", exact: true }).click();
    await expect(frame.locator("#ra-area-val")).toHaveText("24");
    await expect(frame.locator("#ra-dbl-data")).toBeVisible();
    await expect(frame.locator("#ra-ratio")).toHaveText("4");
    expect(await shape!.evaluate(element => element === element.ownerDocument.getElementById("ra-area-rect"))).toBe(true);
    await clear.click();
    await expect(frame.locator("#ra-area-val")).toHaveText("24");
    await expect(clear).toBeDisabled();
    await frame.getByRole("button", { name: "6 厘米 × 4 厘米", exact: true }).click();
    const length = frame.getByRole("slider", { name: /长度/ });
    const width = frame.getByRole("slider", { name: /宽度/ });
    await length.focus();
    await page.keyboard.press("End");
    await width.focus();
    await page.keyboard.press("End");
    await expect(frame.locator("#ra-area-val")).toHaveText("100");
    await expect(frame.getByRole("button", { name: "两边都加倍", exact: true })).toBeDisabled();
  } else {
    const summary = frame.locator("summary").first();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(frame.locator("details").first()).not.toHaveAttribute("open");
    await page.keyboard.press("Enter");
    await expect(frame.locator("details").first()).toHaveAttribute("open");
  }
}

test("真实生成页面：布局、主题、键盘、引用、全屏与下载", async ({ page, request, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const name of ["flow", "comparison", "parameters", "basic"]) {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1280, height: 900 });
    const { frame, sample } = await openSample(page, name);
    await expect(frame.locator("main")).toBeVisible();
    await expect(frame.locator("h1")).toBeVisible();
    await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(252, 251, 249)");
    await checkControls(page, name);
    if (name !== "basic") {
      if (name === "flow") expect(await frame.locator(".flow-node").count()).toBe(5);
      else expect(await frame.locator("svg").count()).toBeGreaterThan(0);
      expect(await frame.locator("sup[data-citation]").count()).toBeGreaterThan(0);
      const source = frame.getByRole("link", { name: /^引用 \d+：/ }).first();
      await source.click();
      await expect(frame.locator('[id^="weave-source-"]').first()).toBeInViewport();
      await frame.locator("h1").evaluate(element => element.scrollIntoView());
    }
    await waitForVisualSettling(page);
    await page.screenshot({ path: path.join(output, `${name}-desktop.png`), fullPage: true });
    const before = await frame.locator("body").evaluate(element => {
      const window = element.ownerDocument.defaultView!;
      (window as Window & { readingStateProbe?: object }).readingStateProbe = {};
      return element.querySelector("main")?.textContent;
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(frame.locator("html")).toHaveAttribute("data-weave-theme", "dark");
    await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(17, 17, 17)");
    expect(await frame.locator("main").textContent()).toBe(before);
    expect(await frame.locator("body").evaluate(element => Boolean((element.ownerDocument.defaultView as Window & { readingStateProbe?: object })?.readingStateProbe))).toBe(true);
    await frame.locator("body").evaluate(element => {
      const window = element.ownerDocument.defaultView!;
      window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "weave-artifact-theme", theme: "light" } }));
      window.parent.postMessage({ type: "unrelated-message", theme: "light" }, "*");
    });
    await expect(frame.locator("html")).toHaveAttribute("data-weave-theme", "dark");
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await frame.locator("body").evaluate(element => element.ownerDocument.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
      if (name === "flow") {
        await frame.locator(".flow-node").last().click();
        await expect(frame.locator("#pos")).toHaveText("第 5 / 5 步");
      } else if (name === "comparison") {
        await frame.getByRole("button", { name: "三角形放进矩形", exact: true }).click();
        await expect(frame.locator("#view-overlay")).toBeVisible();
        await frame.getByRole("button", { name: "并列比较", exact: true }).click();
      } else if (name === "parameters") {
        await frame.getByRole("button", { name: "3 厘米 × 2 厘米", exact: true }).click();
        await frame.getByRole("button", { name: "两边都加倍", exact: true }).click();
        await expect(frame.locator("#ra-area-val")).toHaveText("24");
        await expect(frame.locator("#ra-area-rect")).toHaveAttribute("width", "132");
        await expect(frame.locator("#ra-area-rect")).toHaveAttribute("height", "88");
      }
      expect(await frame.locator("body").evaluate(element => element.ownerDocument.documentElement.scrollWidth <= element.ownerDocument.defaultView!.innerWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await waitForVisualSettling(page);
      if (name !== "basic") await page.screenshot({ path: path.join(output, `${name}-window-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
    const fullscreen = page.frameLocator('iframe[title="回答图解.html · 全屏阅读"]');
    await expect(fullscreen.locator("html")).toHaveAttribute("data-weave-theme", "dark");
    await fullscreen.locator("h1").click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    const download = await request.get(`/api/chat/artifacts/${sample.artifactId}?download=1`);
    const content = await download.text();
    expect(content).not.toContain("weave-artifact-theme");
    expect(createDocument(content).documentElement.hasAttribute("data-weave-theme")).toBe(false);
    expect(content).toContain("prefers-color-scheme:dark");
    const saved = path.join(output, `${name}-download.html`);
    fs.writeFileSync(saved, content);
    const offlineContext = await browser.newContext({ colorScheme: "dark", offline: true });
    const offline = await offlineContext.newPage();
    await offline.goto(pathToFileURL(saved).href);
    await expect(offline.locator("body")).toHaveCSS("background-color", "rgb(17, 17, 17)");
    await offline.emulateMedia({ colorScheme: "light" });
    await expect(offline.locator("body")).toHaveCSS("background-color", "rgb(252, 251, 249)");
    await waitForVisualSettling(offline);
    const offlineAudit = await new AxeBuilder({ page: offline }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    fs.writeFileSync(path.join(output, `${name}-accessibility.json`), JSON.stringify({ violations: offlineAudit.violations, passes: offlineAudit.passes.map(item => item.id) }, null, 2) + "\n");
    expect(offlineAudit.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
    if (name !== "basic") {
      for (const width of [1440, 1024]) {
        await offline.setViewportSize({ width, height: 900 });
        await offline.emulateMedia({ colorScheme: width === 1440 ? "light" : "dark", reducedMotion: "reduce" });
        await offline.screenshot({ path: path.join(output, `${name}-reading-${width}.png`), fullPage: true });
      }
    }
    await offlineContext.close();
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(audit.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
  }
  await page.evaluate(() => localStorage.setItem("weave-theme", "dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.frameLocator('iframe[title="回答图解.html · 预览"]').locator("html")).toHaveAttribute("data-weave-theme", "dark");
  await assertHtmlIsolation(page, 'iframe[title="回答图解.html · 预览"]');
  expect(errors).toEqual([]);
});
