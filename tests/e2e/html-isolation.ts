import { expect, type Page } from "@playwright/test";

/** 即使界面误加同源权限、恶意脚本移除 meta，响应头沙箱仍须隔离。 */
export async function assertHtmlIsolation(page: Page, selector: string): Promise<void> {
  const iframe = page.locator(selector);
  const navigation = page.waitForResponse(response => response.url().includes("/api/") && response.headers()["content-type"]?.startsWith("text/html"));
  await iframe.evaluate(element => {
    const frame = element as HTMLIFrameElement;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.src = frame.src;
  });
  const response = await navigation;
  expect(response.headers()["content-security-policy"]).toContain("sandbox allow-scripts;");
  const body = page.frameLocator(selector).locator("body");
  await expect(body).toBeVisible();
  await body.evaluate(element => {
    const script = element.ownerDocument.createElement("script");
    script.textContent = `
      document.querySelectorAll('meta[http-equiv]').forEach(function(node){node.remove();});
      var result=[];
      try { parent.document.body.dataset.compromised='yes'; result.push('parent-access'); } catch(e) { result.push('parent-blocked'); }
      try { localStorage.setItem('weave-probe','yes'); result.push('storage-access'); } catch(e) { result.push('storage-blocked'); }
      fetch('/api/settings').then(function(){result.push('fetch-access');}).catch(function(){result.push('fetch-blocked');}).finally(function(){document.body.dataset.isolation=result.join(',');});
    `;
    element.appendChild(script);
  });
  await expect(body).toHaveAttribute("data-isolation", "parent-blocked,storage-blocked,fetch-blocked");
  expect(await page.locator("body").getAttribute("data-compromised")).toBeNull();
}
