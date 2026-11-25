import { expect, test } from '@playwright/test';
import { ros2, startDemoStack, startLateParamNode } from './demo-stack';
import { openParamBrowser } from './ui';

// M4 A: 参数浏览器要能发现「页面打开后才 declare」的参数，并用事件里的值刷新。
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test('运行中新增的参数会自动出现在浏览器里，并用事件值刷新', async ({ page }) => {
  const stopStack = await startDemoStack();
  const late = startLateParamNode();
  try {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await page.getByTestId('ros-connect').click();
    await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
    await openParamBrowser(page);

    // 节点在启动 3 秒后才 declare；页面若早于它加载，就要靠 parameter_events 发现。
    const row = page.locator(`[data-testid="param-row"][data-param="/${late.nodeName}:late_param"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });

    // 外部改值 → 事件值直接刷新（不需要重新 getParam 整表）。
    ros2(`ros2 param set /${late.nodeName} late_param 9.25`);
    await expect(row).toContainText('9.25', { timeout: 10_000 });
    ros2(`ros2 param set /${late.nodeName} late_param 7.5`);
    await expect(row).toContainText('7.5', { timeout: 10_000 });
  } finally {
    late.stop();
    stopStack();
  }
});
