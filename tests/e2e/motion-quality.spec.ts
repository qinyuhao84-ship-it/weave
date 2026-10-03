import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test('动效自检：导航过渡帧间隔采样与减少动态效果', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/chat/sessions', route => route.fulfill({ json: { ok: true, data: { sessions: Array.from({ length: 40 }, (_, index) => ({ id: `motion-${index}`, title: `动效样本 ${index}`, generating: false })), total: 40 } } }));
  await page.goto('/chat');
  await expect(page.locator('.sidebar-session')).toHaveCount(40);
  const results = [];
  for (let sample = 0; sample < 3; sample++) {
    const frames = page.evaluate(() => new Promise<number[]>(resolve => {
      const intervals: number[] = [];
      let last = 0;
      const start = performance.now();
      const tick = (timestamp: number) => {
        if (last) intervals.push(timestamp - last);
        last = timestamp;
        if (performance.now() - start >= 500) resolve(intervals);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    await page.getByRole('button', { name: sample % 2 ? '展开导航' : '收起导航', exact: true }).click();
    const intervals = (await frames).sort((a, b) => a - b);
    results.push({ sample, frames: intervals.length, medianMs: intervals[Math.floor(intervals.length / 2)], p95Ms: intervals[Math.floor(intervals.length * .95)] });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('aside.sidebar-collapsible')).toHaveCSS('transition-duration', '0s');
  fs.writeFileSync('test-results/refinement-motion.json', JSON.stringify({ environment: { browser: browser.version(), viewport: '1366×900', sessions: 40, durationPerSampleMs: 500, samples: 3 }, results }, null, 2));
});
