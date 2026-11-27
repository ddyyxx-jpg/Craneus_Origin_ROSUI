import { expect, test } from '@playwright/test';
import { ros2, startDemoStack } from './demo-stack';

// M3 验收：Pose 复杂控件 + double_array 双向绑定（真 rosbridge + 真 rclpy 节点）。
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let stopStack: () => void = () => undefined;

test.beforeAll(async () => {
  stopStack = await startDemoStack();
});

test.afterAll(() => {
  stopStack();
});

/** ros2 param get 的真实格式为：`Double values are: [1.0, 2.0, ...]`。 */
function poseFromCli(): number[] {
  const output = ros2('ros2 param get /rosui_demo pose');
  const match = output.match(/^Double values are: \[([^\]]+)\]$/);
  if (!match) throw new Error(`无法解析 ros2 pose 输出：${output}`);
  return match[1]!.split(',').map((part) => Number(part.trim()));
}

async function connectAndAddPose(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('ros-connect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', {
    timeout: 20_000,
  });
  await page.getByTestId('add-pose').click();
  await expect(page.getByTestId('pose-field')).toHaveCount(7, { timeout: 15_000 });
}

test('点 add-pose 出现 7 个字段，初值等于 ROS 当前 pose', async ({ page }) => {
  ros2('ros2 param set /rosui_demo pose "[1.0,2.0,3.0,0.0,0.0,0.0,1.0]"');
  await connectAndAddPose(page);
  const fields = page.getByTestId('pose-field');
  const expected = poseFromCli();
  for (let i = 0; i < 7; i += 1) {
    await expect(fields.nth(i)).toHaveValue(String(expected[i]), { timeout: 15_000 });
  }
  await expect(fields.nth(0)).toHaveAttribute('aria-label', 'pose-x');
});

test('改 x 字段为 4.5 → ROS 参数变成 4.5', async ({ page }) => {
  ros2('ros2 param set /rosui_demo pose "[1.0,2.0,3.0,0.0,0.0,0.0,1.0]"');
  await connectAndAddPose(page);
  // 初值 pull 是异步的：先等 y 字段显示 ROS 的 2.0，避免拿默认 0 提交整组 pose。
  await expect(page.getByTestId('pose-field').nth(1)).toHaveValue('2', { timeout: 15_000 });
  const x = page.getByTestId('pose-field').nth(0);
  await x.fill('4.5');
  await x.blur();
  await expect
    .poll(() => ros2('ros2 param get /rosui_demo pose'), { timeout: 15_000 })
    .toMatch(/^Double values are: \[4\.5, 2\.0, 3\.0, 0\.0, 0\.0, 0\.0, 1\.0\]$/);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
});

test('外部 ros2 param set → UI 1 秒内同步', async ({ page }) => {
  ros2('ros2 param set /rosui_demo pose "[1.0,2.0,3.0,0.0,0.0,0.0,1.0]"');
  await connectAndAddPose(page);
  ros2('ros2 param set /rosui_demo pose "[2.0,2.0,2.0,0.0,0.0,0.0,1.0]"');
  await expect(page.getByTestId('pose-field').nth(0)).toHaveValue('2', { timeout: 1_000 });
  await expect(page.getByTestId('pose-field').nth(2)).toHaveValue('2', { timeout: 1_000 });
  await expect(page.getByTestId('pose-field').nth(0)).toHaveAttribute('aria-label', 'pose-x');
});

test('非法字段值 → 红框、不写 ROS、不弹 toast', async ({ page }) => {
  ros2('ros2 param set /rosui_demo pose "[1.0,2.0,3.0,0.0,0.0,0.0,1.0]"');
  await connectAndAddPose(page);
  await expect(page.getByTestId('pose-field').nth(1)).toHaveValue('2', { timeout: 15_000 });

  const x = page.getByTestId('pose-field').nth(0);
  await x.fill('abc');
  await x.blur();

  await expect(x).toHaveClass(/invalid/);
  await expect(page.getByTestId('control-error')).toBeVisible();
  await page.waitForTimeout(800);
  expect(ros2('ros2 param get /rosui_demo pose')).toMatch(
    /^Double values are: \[1\.0, 2\.0, 3\.0, 0\.0, 0\.0, 0\.0, 1\.0\]$/,
  );
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
});
