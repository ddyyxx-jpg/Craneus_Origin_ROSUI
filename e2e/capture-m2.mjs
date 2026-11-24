// M2 证据截图：连上真 rosbridge、控件与节点值同步。
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5180/');
await page.getByTestId('canvas-status').waitFor({ timeout: 20_000 });
await page.getByTestId('ros-connect').click();
await page.getByTestId('ros-status').and(page.locator('[data-status="connected"]')).waitFor({ timeout: 20_000 });
const gain = page.locator('[data-testid="number-control"]');
await gain.fill('3.5');
await gain.blur();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/artifacts/m2-binding-connected.png' });
console.log('saved docs/artifacts/m2-binding-connected.png gain=', await gain.inputValue());
await browser.close();
