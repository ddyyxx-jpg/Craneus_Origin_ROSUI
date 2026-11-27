// M5 证据截图：保存/加载按钮 + 加载后的图。
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5180');
await page.waitForSelector('[data-testid="canvas-status"][data-state="ready"]', { timeout: 30_000 });
await page.getByTestId('add-pose').click();
await page.waitForSelector('[data-testid="pose-field"]');
const poseFields = page.getByTestId('pose-field');
await poseFields.nth(0).fill('1.5');
await poseFields.nth(0).blur();
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByTestId('save-graph').click(),
]);
const path = await download.path();
await page.reload();
await page.waitForSelector('[data-testid="canvas-status"][data-state="ready"]', { timeout: 30_000 });
await page.getByTestId('load-graph-input').setInputFiles(path);
await page.waitForTimeout(600);
await page.screenshot({ path: 'docs/artifacts/m5-save-load.png' });
console.log('nodes:', await page.locator('[data-testid="node"]').count());
console.log('pose-x:', await poseFields.nth(0).inputValue());
await browser.close();
