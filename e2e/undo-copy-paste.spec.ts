import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { GraphIR } from '../packages/ir/src';

// T-032：undo/redo 与复制粘贴验收。只用 Vite dev server，不连 ROS、不跑 perf。
test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

interface HistoryState {
  undo: number;
  redo: number;
}

interface RosuiTestApi {
  editor: {
    getNodes: () => unknown[];
    getConnections: () => unknown[];
  };
  getSelectedNodeIds: () => string[];
  commitHistory: () => void;
  getHistoryState: () => HistoryState;
}

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
}

function history(page: Page): Promise<HistoryState> {
  return page.evaluate(() => {
    const handle = (window as unknown as { __rosui?: RosuiTestApi }).__rosui;
    return handle?.getHistoryState() ?? { undo: -1, redo: -1 };
  });
}

function graphCounts(page: Page): Promise<{ nodes: number; edges: number }> {
  return page.evaluate(() => {
    const handle = (window as unknown as { __rosui?: RosuiTestApi }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    return {
      nodes: handle.editor.getNodes().length,
      edges: handle.editor.getConnections().length,
    };
  });
}

function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const handle = (window as unknown as { __rosui?: RosuiTestApi }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    return handle.getSelectedNodeIds();
  });
}

/** 走真实保存下载路径读取当前 GraphIR，避免依赖未导出的 serializeGraph DEV API。 */
async function readGraph(page: Page): Promise<GraphIR> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-graph').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('rosui-graph.rosui.json');
  const graphPath = await download.path();
  if (!graphPath) throw new Error('download.path() 为空');
  return JSON.parse(await readFile(graphPath, 'utf8')) as GraphIR;
}


async function expectNoToast(page: Page): Promise<void> {
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
}

test('加载期间 Ctrl+Z 不会静默取消加载', async ({ page }) => {
  await ready(page);
  const origin = await readGraph(page);
  expect(origin.nodes).toHaveLength(5);

  const loaded = {
    version: 1,
    nodes: Array.from({ length: 30 }, (_, index) => ({
      id: `loaded-${index}`,
      type: 'Gain',
      position: { x: 80 + (index % 5) * 200, y: 80 + Math.floor(index / 5) * 130 },
      params: {
        gain: {
          node: `loaded-${index}`,
          param: 'gain',
          valueType: 'double',
          mode: 'static',
          widget: 'number',
          value: index + 1,
        },
      },
    })),
    edges: [],
  };
  const path = '/tmp/undo-during-load.rosui.json';
  await writeFile(path, JSON.stringify(loaded, null, 2));

  // 让第一次 loadGraph 停在 clear() 之后、建节点之前，制造确定的加载窗口。
  await page.evaluate(() => {
    const handle = (
      window as unknown as {
        __rosui?: { editor: { clear: () => Promise<void>; getNodes: () => unknown[] } };
      }
    ).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    const original = handle.editor.clear.bind(handle.editor);
    let paused = false;
    handle.editor.clear = async () => {
      const result = await original();
      if (!paused) {
        paused = true;
        await new Promise<void>((resolve) => {
          const gate = window as unknown as { __loadGate?: () => void };
          gate.__loadGate = resolve;
        });
      }
      return result;
    };
  });

  await page.getByTestId('load-graph-input').setInputFiles(path);
  await expect
    .poll(() => graphCounts(page).then((counts) => counts.nodes), { timeout: 10_000 })
    .toBe(0);
  await page.keyboard.press('Control+z');
  // 释放 clear() 闸门后，加载必须自行完成；Ctrl+Z 已在加载窗口内按下。
  await page.evaluate(() => {
    const gate = (window as unknown as { __loadGate?: () => void }).__loadGate;
    if (!gate) throw new Error('__loadGate 未就绪');
    gate();
  });
  await expect
    .poll(() => graphCounts(page).then((counts) => counts.nodes), { timeout: 10_000 })
    .toBe(30);
  await page.waitForTimeout(100);

  const after = await readGraph(page);
  expect(after.nodes).toHaveLength(30);
  expect(after.nodes.map((node) => node.id)).toEqual(loaded.nodes.map((node) => node.id));
  expect(after.nodes.some((node) => origin.nodes.some((old) => old.id === node.id))).toBe(false);
  expect((await history(page)).undo).toBeGreaterThanOrEqual(1);
  await expectNoToast(page);
});

test('节点增删：新增 Gain 后 Ctrl+Z / Ctrl+Y 撤销重做且不弹 toast', async ({ page }) => {
  await ready(page);
  await expect(page.locator('[data-testid="node"]')).toHaveCount(5);
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 1, redo: 0 });

  await page.getByTestId('add-gain').click();
  await expect(page.locator('[data-testid="node"]')).toHaveCount(6);
  // 不等 debounce：Ctrl+Z 前必须把待提交改动定稿，否则会丢掉新增节点这一历史边界。
  await page.keyboard.press('Control+z');
  await expect.poll(() => graphCounts(page), { timeout: 10_000 }).toEqual({ nodes: 5, edges: 1 });
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 1, redo: 1 });
  await expectNoToast(page);

  await page.keyboard.press('Control+y');
  await expect.poll(() => graphCounts(page), { timeout: 10_000 }).toEqual({ nodes: 6, edges: 1 });
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 2, redo: 0 });
  await expectNoToast(page);
});

test('控件提交：fill 不 blur 不入栈，blur 后提交一次，IR 可撤销重做', async ({ page }) => {
  await ready(page);
  const before = await readGraph(page);
  const gainBefore = before.nodes.find((node) => node.type === 'Gain');
  if (!gainBefore) throw new Error('初始图缺少 Gain 节点');
  const originalValue = gainBefore.params['gain']?.value;
  expect(originalValue).toBe(1);

  const initialHistory = await history(page);
  expect(initialHistory.undo).toBe(1);

  const number = page.locator('[data-testid="number-control"]');
  await expect(number).toHaveCount(1);
  await number.fill('4.2');
  // 只 fill，不 blur；每次 keystroke / DOM input 事件都不应形成历史边界。
  await expect(number).toHaveValue('4.2');
  expect(await history(page)).toEqual(initialHistory);

  await number.blur();
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({
    undo: initialHistory.undo + 1,
    redo: 0,
  });
  await expect
    .poll(async () => (await readGraph(page)).nodes.find((node) => node.type === 'Gain')?.params['gain']?.value, {
      timeout: 10_000,
    })
    .toBe(4.2);

  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await readGraph(page)).nodes.find((node) => node.type === 'Gain')?.params['gain']?.value, {
      timeout: 10_000,
    })
    .toBe(originalValue);
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({
    undo: initialHistory.undo,
    redo: initialHistory.redo + 1,
  });

  await page.keyboard.press('Control+y');
  await expect
    .poll(async () => (await readGraph(page)).nodes.find((node) => node.type === 'Gain')?.params['gain']?.value, {
      timeout: 10_000,
    })
    .toBe(4.2);
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({
    undo: initialHistory.undo + 1,
    redo: 0,
  });
  await expectNoToast(page);
});

test('多选复制粘贴：新 id / +40/+40 / 静态绑定 / 内部边 / undo-redo', async ({ page }) => {
  await ready(page);
  const before = await readGraph(page);
  const gainBefore = before.nodes.find((node) => node.type === 'Gain');
  const thresholdBefore = before.nodes.find((node) => node.type === 'Threshold');
  if (!gainBefore || !thresholdBefore) throw new Error('初始图缺少 Gain/Threshold 节点');
  const originalIds = [gainBefore.id, thresholdBefore.id];

  const internalEdge = before.edges.find(
    (edge) => originalIds.includes(edge.source) && originalIds.includes(edge.target),
  );
  if (!internalEdge) throw new Error('Gain/Threshold 之间缺少内部边');

  const gainTitle = page.locator(`[data-testid="node"][data-node-id="${gainBefore.id}"] .title`).first();
  const thresholdTitle = page.locator(`[data-testid="node"][data-node-id="${thresholdBefore.id}"] .title`).first();
  await gainTitle.click();
  await expect.poll(() => selectedIds(page), { timeout: 10_000 }).toEqual([gainBefore.id]);
  await thresholdTitle.click({ modifiers: ['Control'] });
  await expect
    .poll(() => selectedIds(page), { timeout: 10_000 })
    .toEqual(expect.arrayContaining(originalIds));
  expect((await selectedIds(page)).length).toBe(2);

  expect((await selectedIds(page)).sort()).toEqual([...originalIds].sort());
  await page.keyboard.press('Control+c');
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 1, redo: 0 });

  await page.keyboard.press('Control+v');
  await expect.poll(() => graphCounts(page), { timeout: 10_000 }).toEqual({ nodes: 7, edges: 2 });
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 2, redo: 0 });

  const pasted = await readGraph(page);
  const copiedNodes = pasted.nodes.filter((node) => !before.nodes.some((old) => old.id === node.id));
  expect(copiedNodes).toHaveLength(2);
  const copiedById = new Map(copiedNodes.map((node) => [node.type, node]));
  const copiedGain = copiedById.get('Gain');
  const copiedThreshold = copiedById.get('Threshold');
  if (!copiedGain || !copiedThreshold) throw new Error('粘贴结果缺少 Gain/Threshold 副本');
  const newIds = [copiedGain.id, copiedThreshold.id];
  expect(new Set(newIds).size).toBe(2);
  for (const newId of newIds) {
    expect(before.nodes.some((node) => node.id === newId)).toBe(false);
  }

  expect(copiedGain.position).toEqual({ x: gainBefore.position.x + 40, y: gainBefore.position.y + 40 });
  expect(copiedThreshold.position).toEqual({
    x: thresholdBefore.position.x + 40,
    y: thresholdBefore.position.y + 40,
  });

  for (const [source, copy] of [
    [gainBefore, copiedGain],
    [thresholdBefore, copiedThreshold],
  ] as const) {
    for (const [paramKey, binding] of Object.entries(copy.params)) {
      expect(binding.mode).toBe('static');
      expect(binding.node).toBe(copy.id);
      expect(binding.param).toBe(paramKey);
      expect(source.params[paramKey]).toBeDefined();
    }
  }

  const copiedEdges = pasted.edges.filter(
    (edge) => newIds.includes(edge.source) && newIds.includes(edge.target),
  );
  expect(copiedEdges).toHaveLength(1);
  expect(copiedEdges[0]?.source).toBe(copiedGain.id);
  expect(copiedEdges[0]?.sourcePort).toBe(internalEdge.sourcePort);
  expect(copiedEdges[0]?.target).toBe(copiedThreshold.id);
  expect(copiedEdges[0]?.targetPort).toBe(internalEdge.targetPort);

  await expect
    .poll(() => selectedIds(page), { timeout: 10_000 })
    .toEqual(expect.arrayContaining(newIds));
  expect((await selectedIds(page)).sort()).toEqual([...newIds].sort());

  await page.keyboard.press('Control+z');
  await expect.poll(() => graphCounts(page), { timeout: 10_000 }).toEqual({ nodes: 5, edges: 1 });
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 1, redo: 1 });

  await page.keyboard.press('Control+y');
  await expect.poll(() => graphCounts(page), { timeout: 10_000 }).toEqual({ nodes: 7, edges: 2 });
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 2, redo: 0 });
  await expectNoToast(page);
});

test('栈深 100 与输入焦点旁路：commit 120 次截顶，input 内 Ctrl+Z 不生效', async ({ page }) => {
  await ready(page);
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 1, redo: 0 });

  await page.evaluate(() => {
    const handle = (window as unknown as { __rosui?: RosuiTestApi }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    for (let i = 0; i < 120; i += 1) handle.commitHistory();
  });
  expect(await history(page)).toEqual({ undo: 100, redo: 0 });

  const number = page.locator('[data-testid="number-control"]');
  await expect(number).toHaveCount(1);
  await number.focus();
  expect(await history(page)).toEqual({ undo: 100, redo: 0 });
  await page.keyboard.press('Control+z');
  expect(await history(page)).toEqual({ undo: 100, redo: 0 });
  await number.press('Control+Shift+z');
  expect(await history(page)).toEqual({ undo: 100, redo: 0 });
  await number.press('Control+y');
  expect(await history(page)).toEqual({ undo: 100, redo: 0 });

  // 把焦点从 input 移开，但不点空白画布（LOD 既有语义：空白点击清选中）。
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(() => history(page), { timeout: 10_000 }).toEqual({ undo: 99, redo: 1 });
  await expectNoToast(page);
});
