import type { Locator, Page } from '@playwright/test';

export async function selectChoice(page: Page, trigger: Locator, value: string) {
  await trigger.click();
  await page.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
}
