import { expect, test, type Page } from '@playwright/test';

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

/** 面板与画布几何：新增节点必须整框落在 .canvas 内，且中心命中节点自身。 */
async function expectNewNodeVisible(page: Page, addTestId: string): Promise<void> {
  const before = await page.evaluate(() => {
    const handle = (
      window as unknown as {
        __rosui?: { getSelectedNodeIds: () => string[]; editor: { getNodes: () => unknown[] } };
      }
    ).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    return { ids: handle.getSelectedNodeIds(), count: handle.editor.getNodes().length };
  });

  await page.getByTestId(addTestId).click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const handle = (
            window as unknown as { __rosui?: { editor: { getNodes: () => unknown[] } } }
          ).__rosui;
          return handle?.editor.getNodes().length ?? -1;
        }),
      { timeout: 10_000 },
    )
    .toBe(before.count + 1);

  const geometry = await page.evaluate((previousIds) => {
    const canvas = document.querySelector('.canvas');
    const handle = (
      window as unknown as {
        __rosui?: { getSelectedNodeIds: () => string[]; editor: { getNodes: () => unknown[] } };
      }
    ).__rosui;
    if (!canvas || !handle) throw new Error('canvas 或 __rosui 不存在');
    const canvasRect = canvas.getBoundingClientRect();
    const nodes = Array.from(document.querySelectorAll('[data-testid="node"]'));
    const node = nodes.find((element) => {
      const id = element.getAttribute('data-node-id');
      return id && !previousIds.includes(id);
    });
    if (!node) throw new Error('新增节点未渲染');
    const rect = node.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      nodeId: node.getAttribute('data-node-id'),
      inside:
        rect.left >= canvasRect.left &&
        rect.top >= canvasRect.top &&
        rect.right <= canvasRect.right &&
        rect.bottom <= canvasRect.bottom,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      canvas: {
        left: canvasRect.left,
        top: canvasRect.top,
        right: canvasRect.right,
        bottom: canvasRect.bottom,
      },
      hitIsNode: Boolean(hit && (node.contains(hit) || hit.contains(node))),
      hitTag: hit?.tagName ?? '',
      hitClass: hit instanceof Element ? hit.className : '',
    };
  }, before.ids);

  expect(geometry.inside, `node rect ${JSON.stringify(geometry.rect)} outside ${JSON.stringify(geometry.canvas)}`).toBe(true);
  expect(
    geometry.hitIsNode,
    `center hit ${geometry.hitTag}.${geometry.hitClass}, expected node ${geometry.nodeId}`,
  ).toBe(true);
}

test('1280×720 新增 Gain / Script 节点完整落在画布可视区', async ({ page }) => {
  await ready(page);
  await expectNewNodeVisible(page, 'add-gain');
  await expectNewNodeVisible(page, 'add-script');
});

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
