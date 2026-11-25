// M3 证据截图：Pose 复杂控件（7 字段 DOM 表单）连上真 rosbridge 并双向绑定。
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5180/');
await page.getByTestId('canvas-status').waitFor({ timeout: 20_000 });
await page.getByTestId('ros-connect').click();
await page.getByTestId('ros-status').and(page.locator('[data-status="connected"]')).waitFor({ timeout: 20_000 });
await page.getByTestId('add-pose').click();
const x = page.getByTestId('pose-field').nth(0);
await x.waitFor({ timeout: 15_000 });
await x.fill('1.5');
await x.blur();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/artifacts/m3-pose-control.png' });
console.log('saved docs/artifacts/m3-pose-control.png pose-x=', await x.inputValue());
await browser.close();
