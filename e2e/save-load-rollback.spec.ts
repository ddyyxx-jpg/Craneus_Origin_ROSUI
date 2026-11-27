import { expect, test, type Page } from '@playwright/test';
import type { EditorHandle } from '../apps/web/src/rete/editor';
import { ros2, startDemoStack } from './demo-stack';
import { openParamBrowser } from './ui';
import { writeFile } from 'node:fs/promises';

// M5 二轮 P1-A / P2-B：schema 合法、clear 后的中途失败 → 快照回滚，且运行期绑定仍可写 ROS。
// 不 mock loadGraph：用 DEV 钩子让 editor.addConnection 抛一次错，模拟画布已清空但重建中途失败。
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

/** 注入一张带合法边的图，再让第一条边在 addConnection 阶段恰好抛错一次。 */
async function injectFailingGraph(page: Page, marker: string): Promise<void> {
  const param = (value: number) => ({
    node: 'node-local',
    param: 'value',
    valueType: 'double' as const,
    mode: 'static' as const,
    widget: 'number' as const,
    value,
  });
  const graph = {
    version: 1,
    nodes: [
      { id: 'g1', type: 'Gain', position: { x: 10, y: 10 }, params: { value: param(1) } },
      { id: 't1', type: 'Threshold', position: { x: 200, y: 10 }, params: { value: param(2) } },
    ],
    edges: [{ id: 'edge-1', source: 'g1', sourcePort: 'out', target: 't1', targetPort: 'value' }],
  };
  const path = `/tmp/rollback-mid-load-${marker}.rosui.json`;
  await writeFile(path, JSON.stringify(graph, null, 2));

  await page.evaluate(() => {
    const handle = (
      window as unknown as {
        __rosui?: { editor: { addConnection: (...args: unknown[]) => Promise<void>; getNodes: () => unknown[] } };
      }
    ).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    const original = handle.editor.addConnection.bind(handle.editor);
    let thrown = false;
    handle.editor.addConnection = async (...args: unknown[]) => {
      if (!thrown) {
        thrown = true;
        // 探针证据：抛错瞬间画布只剩待加载图的两个节点，证明 clear() 已发生。
        (window as unknown as { __rollbackProbe?: string }).__rollbackProbe = JSON.stringify({
          nodesAtThrow: handle.editor.getNodes().length,
          ids: handle.editor.getNodes().map((node) => (node as { id?: string }).id),
        });
        throw new Error('rollback probe: addConnection failed once');
      }
      return original(...args);
    };
  });

  await page.getByTestId('load-graph-input').setInputFiles(path);
  await expect(page.getByTestId('ros-toast')).toContainText('加载失败：rollback probe: addConnection failed once', {
    timeout: 15_000,
  });
}

/** 等待画布节点数回到指定值，避免断言抢在异步回滚完成前。 */
async function waitNodeCount(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const handle = (window as unknown as { __rosui?: EditorHandle }).__rosui;
          return handle?.editor.getNodes().length ?? -1;
        }),
      { timeout: 15_000 },
    )
    .toBe(count);
}

test('中途加载失败：快照回滚后节点/IR 不变、Inspector 不崩', async ({ page }, testInfo) => {
  const snapshotIR = {
    version: 1,
    nodes: [
      {
        id: 'snapshot-threshold',
        type: 'Threshold',
        position: { x: 60, y: 60 },
        params: {
          value: {
            node: 'node-local',
            param: 'value',
            valueType: 'double',
            mode: 'static',
            widget: 'number',
            value: 4.2,
          },
        },
      },
      {
        id: 'snapshot-inspector',
        type: 'Inspector',
        position: { x: 320, y: 60 },
        params: {},
      },
    ],
    edges: [],
  };
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const snapshotPath = '/tmp/rollback-snapshot.rosui.json';
  await writeFile(snapshotPath, JSON.stringify(snapshotIR, null, 2));
  await page.getByTestId('load-graph-input').setInputFiles(snapshotPath);
  await waitNodeCount(page, 2);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
  const snapshotText = await page.getByTestId('current-ir').innerText();
  expect(snapshotText).toContain('"id": "snapshot-threshold"');
  expect(snapshotText).toContain('"id": "snapshot-inspector"');

  await injectFailingGraph(page, 'ui');
  await waitNodeCount(page, 2);

  // 一次性探针证据：clear 后画布短暂只剩待加载图的 2 个节点，随后抛错并回滚。
  const probeEvidence = await page.evaluate(
    () => (window as unknown as { __rollbackProbe?: string }).__rollbackProbe,
  );
  expect(probeEvidence).toBeTruthy();
  const atThrow = JSON.parse(probeEvidence ?? '{}') as { nodesAtThrow?: number; ids?: string[] };
  expect(atThrow.nodesAtThrow).toBe(2);
  expect(atThrow.ids).toEqual(['g1', 't1']);

  const restoredText = await page.getByTestId('current-ir').innerText();
  expect(restoredText).toBe(snapshotText);
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('current-ir')).toContainText('"version": 1');
  await expect(page.getByTestId('inspector-panel')).toBeVisible();

  await testInfo.attach('rollback-ui-snapshot', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('中途加载失败回滚后：runtime 绑定改值仍能写进 ROS', async ({ page }, testInfo) => {
  ros2('ros2 param set /rosui_demo gain 1.0');
  await connect(page);

  // 快照里放一个绑定到 /rosui_demo:gain 的 Gain；加载失败后必须恢复这条运行期订阅。
  const snapshotIR = {
    version: 1,
    nodes: [
      {
        id: 'runtime-gain',
        type: 'Gain',
        position: { x: 80, y: 80 },
        params: {
          value: {
            node: '/rosui_demo:gain',
            param: 'gain',
            valueType: 'double',
            mode: 'runtime',
            widget: 'number',
            value: 1,
          },
        },
      },
    ],
    edges: [],
  };
  const snapshotPath = '/tmp/rollback-runtime-snapshot.rosui.json';
  await writeFile(snapshotPath, JSON.stringify(snapshotIR, null, 2));
  await page.getByTestId('load-graph-input').setInputFiles(snapshotPath);
  await waitNodeCount(page, 1);
  await expect(page.getByTestId('current-ir')).toContainText('"mode": "runtime"');
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);

  await injectFailingGraph(page, 'runtime');
  await waitNodeCount(page, 1);
  const restoredText = await page.getByTestId('current-ir').innerText();
  expect(restoredText).toContain('"mode": "runtime"');
  expect(restoredText).toContain('/rosui_demo:gain');

  // P1-A 核心回归：回滚后改控件值，必须真的写进 ROS 参数。
  const control = page.locator('[data-testid="node"]').filter({ has: page.locator('.title:text-is("Gain")') }).locator('[data-testid="number-control"]');
  await expect(control).toBeVisible({ timeout: 15_000 });
  await control.fill('3.3');
  await control.blur();
  await expect
    .poll(() => ros2('ros2 param get /rosui_demo gain'), { timeout: 15_000 })
    .toMatch(/value is: 3\.3$/);

  await testInfo.attach('rollback-runtime-binding', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
