// M4 证据截图：参数浏览器 → 把未绑定的 Threshold.value 绑到 /rosui_demo:gain，
// 再加 Inspector / Script 节点（节点内嵌应用面板 + 节点内代码编辑）。
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5180/');
await page.getByTestId('canvas-status').waitFor({ timeout: 20_000 });
await page.getByTestId('ros-connect').click();
await page.getByTestId('ros-status').and(page.locator('[data-status="connected"]')).waitFor({ timeout: 20_000 });

// 1) 选中 Threshold 节点 → 绑定 gain 参数
await page.getByText('Threshold', { exact: true }).click();
await page.getByTestId('param-filter').fill('gain');
await page.locator('[data-testid="bind-param"][data-param="/rosui_demo:gain"]').first().click();
await page.waitForTimeout(600);

// 2) 加 Inspector / Script
await page.getByTestId('add-inspector').click();
await page.getByTestId('add-script').click();
await page.getByTestId('script-editor').fill('return Math.round(x * 2) + 1;');
await page.getByTestId('script-editor').blur();
await page.waitForTimeout(800);

await page.screenshot({ path: 'docs/artifacts/m4-runtime-binding.png' });
console.log(
  'saved docs/artifacts/m4-runtime-binding.png',
  'selected=', await page.getByTestId('selected-port').textContent(),
  'script=', await page.getByTestId('script-result').textContent(),
);
await browser.close();
