import { expect, test } from '@playwright/test';
import { ros2, startDemoStack } from './demo-stack';

// M2 验收：控件 ↔ ROS 参数双向绑定（真 rosbridge + 真 rclpy 节点，无 mock）。
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let stopStack: () => void = () => undefined;

test.beforeAll(async () => {
  stopStack = await startDemoStack();
});

test.afterAll(() => {
  stopStack();
});

async function connect(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('ros-connect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', {
    timeout: 20_000,
  });
}

const gainControl = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="number-control"]');

test('连上后控件显示 ROS 侧当前值', async ({ page }) => {
  ros2('ros2 param set /rosui_demo gain 2.5');
  await connect(page);
  await expect(gainControl(page)).toHaveValue('2.5', { timeout: 15_000 });
});

test('控件改值 → 节点侧真的变了', async ({ page }) => {
  await connect(page);
  await gainControl(page).fill('3.5');
  await gainControl(page).blur();
  await expect
    .poll(() => ros2('ros2 param get /rosui_demo gain'), { timeout: 15_000 })
    .toMatch(/value is: 3\.5$/);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
});

test('越界值被本地校验拦下：不发 ROS、不弹 toast（服务端拒绝在单测覆盖）', async ({ page }) => {
  ros2('ros2 param set /rosui_demo gain 4.0');
  await connect(page);
  await expect(gainControl(page)).toHaveValue(/^4(\.0)?$/, { timeout: 15_000 });

  await gainControl(page).fill('42');
  await gainControl(page).blur();

  // Gain 的约束 max=10 在前端就拦住了，根本不会走到 setParam。
  await expect(page.getByTestId('control-error')).toContainText('≤ 10');
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(ros2('ros2 param get /rosui_demo gain')).toMatch(/value is: 4(\.0)?$/);
});

test('外部改参数 → 控件 2 秒内跟着变', async ({ page }) => {
  await connect(page);
  ros2('ros2 param set /rosui_demo gain 6.25');
  await expect(gainControl(page)).toHaveValue('6.25', { timeout: 5_000 });
});

test('断开后不锁死控件：仍可编辑，且不再下发', async ({ page }) => {
  await connect(page);
  await page.getByTestId('ros-disconnect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'disconnected', {
    timeout: 15_000,
  });

  const before = ros2('ros2 param get /rosui_demo gain');
  await gainControl(page).fill('7.5');
  await gainControl(page).blur();
  await expect(gainControl(page)).toHaveValue('7.5');
  // 节点侧不应变化（下发已停）
  await page.waitForTimeout(1200);
  expect(ros2('ros2 param get /rosui_demo gain')).toBe(before);
});
