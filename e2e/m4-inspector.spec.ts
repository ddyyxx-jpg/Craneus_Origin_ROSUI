import { expect, test } from '@playwright/test';
import { ros2, startDemoStack } from './demo-stack';
import { openParamBrowser } from './ui';

// M4 B: Inspector node shows all runtime bindings with live ROS values.
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let stopStack: () => void = () => undefined;

test.beforeAll(async () => {
  stopStack = await startDemoStack();
});

test.afterAll(() => {
  stopStack();
});

test('Inspector panel lists bound ports and follows ROS value changes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await page.getByTestId('add-inspector').click();
  const panel = page.getByTestId('inspector-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('max-height', '160px');

  await page.getByTestId('ros-connect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });

  // Gain is statically bound in M2; Inspector lists runtime bindings, so bind one via UI first.
  const gainNode = page.locator('[data-testid="node"]').filter({ has: page.locator('.title:text-is("Gain")') }).first();
  await gainNode.locator('.title').click();
  await openParamBrowser(page);
  await page.locator('[data-testid="bind-param"][data-param="/rosui_demo:gain"]').click();
  await expect(panel.getByTestId('inspector-row')).toContainText('Gain.gain');
  await expect(panel.getByTestId('inspector-row')).toContainText('/rosui_demo:gain');

  ros2('ros2 param set /rosui_demo gain 8.25');
  await expect(panel.getByTestId('inspector-row')).toContainText('8.25', { timeout: 15_000 });
});
