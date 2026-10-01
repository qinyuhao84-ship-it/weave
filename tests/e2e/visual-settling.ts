import { expect, type Page } from '@playwright/test';

export async function waitForVisualSettling(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const animations = document.getAnimations().filter(animation => {
      const effect = animation.effect as KeyframeEffect | null;
      return animation.playState === 'running' && effect?.target instanceof Element && effect.target.getClientRects().length > 0 && Number.isFinite(effect.getComputedTiming().endTime);
    });
    await Promise.race([
      Promise.all(animations.map(animation => animation.finished.catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);
  });
}

/** Canvas 的布局与镜头缓动不在 document.getAnimations() 中，需检查实际绘制帧。 */
export async function waitForCanvasSettling(page: Page) {
  const canvas = page.locator('main canvas').first();
  let previous = '';
  let stableFrames = 0;
  await expect.poll(async () => {
    const frame = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    stableFrames = frame === previous ? stableFrames + 1 : 0;
    previous = frame;
    return stableFrames;
  }, { timeout: 10_000, intervals: [150] }).toBeGreaterThanOrEqual(3);
}
