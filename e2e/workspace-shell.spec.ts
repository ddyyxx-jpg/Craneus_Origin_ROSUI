import { expect, test } from '@playwright/test';

async function ready(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
}

function readGraph(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const raw = document.querySelector('[data-testid="current-ir"]')?.textContent ?? '{}';
    return JSON.parse(raw) as {
      nodes: { type: string }[];
      edges: unknown[];
    };
  });
}

test.describe('M6 Phase 1 UI Shell', () => {
  test('五个面板区域存在，初始图仍是 5 节点 / 1 连线', async ({ page }) => {
    await ready(page);
    for (const id of [
      'app-shell',
      'workspace-explorer',
      'editor-tabs',
      'param-browser',
      'bottom-panel',
      'status-bar',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByTestId('workspace-scan-notice')).toContainText('Phase 2');
    await expect(page.getByTestId('bottom-panel')).toBeInViewport();
    await expect(page.getByTestId('status-bar')).toBeInViewport();
    const graph = await readGraph(page);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(1);
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready');
  });

  test('EditorTabs / BottomPanel 可切换；工作区 active 状态可切换', async ({ page }) => {
    await ready(page);
    await expect(page.getByTestId('editor-tab-graph')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('editor-tab-graph').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('editor-tab-ir')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('editor-ir-note')).toContainText('右侧 Inspector');
    await expect(page.getByTestId('current-ir')).toBeVisible();
    await page.getByTestId('editor-tab-graph').click();
    await expect(page.getByTestId('editor-tab-graph')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('bottom-tab-problems').click();
    await expect(page.getByTestId('bottom-tab-problems')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('bottom-panel-content')).toContainText('暂无诊断');

    const roots = page.getByTestId('workspace-root');
    await expect(roots).toHaveCount(3);
    await expect(roots.nth(0)).toHaveAttribute('aria-current', 'page');
    await roots.nth(1).click();
    await expect(roots.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(roots.nth(0)).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('status-workspace')).toContainText('adaptive_lio_ws');
  });

  test('既有 testid 在 shell 中仍可用', async ({ page }) => {
    await ready(page);
    for (const id of [
      'canvas-status',
      'gain-readout',
      'ros-url',
      'ros-connect',
      'ros-disconnect',
      'ros-status',
      'add-gain',
      'add-pose',
      'add-inspector',
      'add-script',
      'save-graph',
      'load-graph',
      'load-graph-input',
      'current-ir',
    ]) {
      await expect(page.getByTestId(id)).toHaveCount(1);
    }
    await expect(page.getByTestId('canvas-status')).toBeVisible();
    await expect(page.getByTestId('current-ir')).toBeVisible();
    await expect(page.getByTestId('save-graph')).toBeEnabled();
  });
});
