import { expect, test, type Page } from '@playwright/test';
import { ros2, startDemoStack } from './demo-stack';
import { openParamBrowser } from './ui';

// M5：runtime 绑定在「存盘 → 刷新 → 加载」之后仍然是真的绑定（真 rosbridge，无 mock）。
// 这条用例专门覆盖评审 P0-2：加载后控件改值必须写进 ROS，而不是只写回 IR。
test.describe.configure({ mode: 'serial' });
test.setTimeout(150_000);

let stopStack: () => void = () => undefined;

test.beforeAll(async () => {
  stopStack = await startDemoStack();
});

test.afterAll(() => {
  stopStack();
});

async function connect(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await page.getByTestId('ros-connect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await openParamBrowser(page);
}

test('runtime 绑定加载后改值真的写进 ROS', async ({ page }, testInfo) => {
  ros2('ros2 param set /rosui_demo gain 1.0');
  await connect(page);

  // 新增的 Gain 输入未连线，控件可见；把它运行时绑到 /rosui_demo:gain。
  await page.getByTestId('add-gain').click();
  const gainNode = page.locator('[data-testid="node"]').filter({ has: page.locator('.title:text-is("Gain")') }).last();
  await gainNode.locator('.title').click();
  await expect(page.getByTestId('selected-port')).toContainText('Gain');
  const bindGain = page.locator('[data-testid="bind-param"][data-param="/rosui_demo:gain"]');
  await expect(bindGain).toBeEnabled({ timeout: 15_000 });
  await bindGain.click();
  await expect(page.getByTestId('current-ir')).toContainText('"mode": "runtime"');

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-graph').click();
  const graphPath = await (await downloadPromise).path();
  if (!graphPath) throw new Error('download.path() 为空');

  await page.reload();
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await page.getByTestId('ros-connect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  await page.getByTestId('load-graph-input').setInputFiles(graphPath);
  await expect(page.getByTestId('current-ir')).toContainText('"mode": "runtime"');

  const restoredGain = page.locator('[data-testid="node"]').filter({ has: page.locator('.title:text-is("Gain")') }).last();
  const control = restoredGain.locator('[data-testid="number-control"]');
  await expect(control).toBeVisible({ timeout: 15_000 });
  await control.fill('2.7');
  await control.blur();
  await expect
    .poll(() => ros2('ros2 param get /rosui_demo gain'), { timeout: 15_000 })
    .toMatch(/value is: 2\.7$/);

  await testInfo.attach('loaded-runtime-binding', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
