import { expect, test, type Page } from '@playwright/test';
import { ros2, startDemoStack } from './demo-stack';

// M4 A: runtime parameter browser + generic binding (real ROS, no mocks).
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let stopStack: () => void = () => undefined;

test.beforeAll(async () => {
  stopStack = await startDemoStack();
});

test.afterAll(() => {
  stopStack();
});

async function connect(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('ros-connect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('param-browser')).toBeVisible();
}

async function selectNode(page: Page, nodeType: string): Promise<void> {
  // Classic preset renders .title[data-testid="title"] inside [data-testid="node"];
  // the area pipe stamps data-node-id on the wrapper for exact instance mapping.
  const node = page.locator(`[data-testid="node"]`).filter({ has: page.locator(`.title:text-is("${nodeType}")`) }).first();
  await node.locator('.title').click();
  await expect(page.getByTestId('selected-port')).toContainText(nodeType);
}

test('param browser lists demo params and filter works', async ({ page }) => {
  await connect(page);
  const browser = page.getByTestId('param-browser');
  await expect(browser.getByText('/rosui_demo')).toBeVisible();
  await expect(browser.locator('[data-testid="bind-param"][data-param="/rosui_demo:gain"]')).toBeVisible();
  await page.getByTestId('param-filter').fill('gain');
  await expect(browser.locator('[data-testid="bind-param"]')).toHaveCount(1);
  await expect(browser.locator('[data-testid="bind-param"][data-param="/rosui_demo:gain"]')).toBeVisible();
});

test('runtime bind gain param to Threshold number port: value flows and writes back', async ({ page }) => {
  ros2('ros2 param set /rosui_demo gain 0.75');
  await connect(page);
  await selectNode(page, 'Threshold');
  await page.locator('[data-testid="bind-param"][data-param="/rosui_demo:gain"]').click();
  await expect(page.getByTestId('current-ir')).toContainText('"mode": "runtime"');
  await expect(page.getByTestId('current-ir')).toContainText('/rosui_demo:gain');

  // Threshold input is connected to Gain in default layout; disconnect so its control is visible.
  await page.evaluate(async () => {
    const handle = (window as unknown as { __rosui?: { editor: { getConnections: () => { id: string }[]; removeConnection: (id: string) => Promise<void> } } }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    for (const c of handle.editor.getConnections()) await handle.editor.removeConnection(c.id);
  });
  // Use the number control inside the selected Threshold node.
  const threshold = page.locator('[data-testid="node"]').filter({ has: page.locator('.title:text-is("Threshold")') }).first();
  const control = threshold.locator('[data-testid="number-control"]');
  await expect(control).toHaveValue('0.75', { timeout: 15_000 });

  await control.fill('0.85');
  await control.blur();
  await expect
    .poll(() => ros2('ros2 param get /rosui_demo gain'), { timeout: 15_000 })
    .toMatch(/value is: 0\.85$/);
});

test('unbind stops ROS write-back', async ({ page }) => {
  await connect(page);
  await selectNode(page, 'Threshold');
  await page.locator('[data-testid="bind-param"][data-param="/rosui_demo:gain"]').click();
  await page.evaluate(async () => {
    const handle = (window as unknown as { __rosui?: { editor: { getConnections: () => { id: string }[]; removeConnection: (id: string) => Promise<void> } } }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    for (const c of handle.editor.getConnections()) await handle.editor.removeConnection(c.id);
  });
  const threshold = page.locator('[data-testid="node"]').filter({ has: page.locator('.title:text-is("Threshold")') }).first();
  await expect(threshold.locator('[data-testid="number-control"]')).toHaveValue(/.*/, { timeout: 15_000 });
  await page.locator('[data-testid="unbind-param"][data-param="/rosui_demo:gain"]').click();
  await expect(page.getByTestId('current-ir')).not.toContainText('"mode": "runtime"');
  const before = ros2('ros2 param get /rosui_demo gain');
  await threshold.locator('[data-testid="number-control"]').fill('9.9');
  await threshold.locator('[data-testid="number-control"]').blur();
  await page.waitForTimeout(800);
  expect(ros2('ros2 param get /rosui_demo gain')).toBe(before);
});

test('type mismatch is rejected: string param to number control', async ({ page }) => {
  await connect(page);
  await selectNode(page, 'Threshold');
  await page.locator('[data-testid="bind-param"][data-param="/rosui_demo:mode"]').click();
  await expect(page.getByTestId('ros-toast')).toContainText('不接受 string');
  await expect(page.getByTestId('current-ir')).not.toContainText('/rosui_demo:mode');
});
