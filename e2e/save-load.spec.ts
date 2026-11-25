import { expect, test, type Page } from '@playwright/test';
import type { EditorHandle } from '../apps/web/src/rete/editor';

// M5：纯 UI 保存/加载回归，不起 ROS 栈。
test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

interface GraphSnapshot {
  nodeCount: number;
  connectionCount: number;
}

async function addPoseAndConnect(page: Page): Promise<GraphSnapshot> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('add-pose').click();
  await expect(page.getByTestId('pose-field')).toHaveCount(7);
  const y = page.getByTestId('pose-field').nth(1);
  await y.fill('4.5');
  await y.blur();
  await expect(y).toHaveValue('4.5');

  const snapshot = await page.evaluate(async () => {
    const handle = (window as unknown as { __rosui?: EditorHandle }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    const nodes = handle.editor.getNodes();
    const pose = nodes.find((node) => node.spec.type === 'Pose');
    const gain = nodes.find((node) => node.spec.type === 'Gain');
    if (!pose || !gain) throw new Error('找不到 Pose/Gain 节点');
    await handle.editor.addConnection(new handle.Connection(gain, 'out', pose, 'pose'));
    return {
      nodeCount: nodes.length,
      connectionCount: handle.editor.getConnections().length,
    };
  });

  // 让 IR 面板同步最新连线。
  await expect(page.getByTestId('current-ir')).toContainText('"version": 1');
  return snapshot;
}

test('保存 → reload → 加载：节点/字段/连线/IR 版本全部还原', async ({ page, browserName }, testInfo) => {
  const before = await addPoseAndConnect(page);

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-graph').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('rosui-graph.rosui.json');
  const graphPath = await download.path();
  if (!graphPath) throw new Error('download.path() 为空');

  await page.reload();
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });

  await page.getByTestId('load-graph-input').setInputFiles(graphPath);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
  await expect(page.getByTestId('current-ir')).toContainText('"version": 1', { timeout: 10_000 });

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const handle = (window as unknown as { __rosui?: EditorHandle }).__rosui;
          if (!handle) throw new Error('window.__rosui 未挂载');
          return {
            nodeCount: handle.editor.getNodes().length,
            connectionCount: handle.editor.getConnections().length,
          };
        }),
      { timeout: 10_000 },
    )
    .toEqual({ nodeCount: before.nodeCount, connectionCount: before.connectionCount });

  // 连线会让 Rete 的 showInputControl 隐藏 Pose 控件；先断开再核对字段值。
  await page.evaluate(() => {
    const handle = (window as unknown as {
      __rosui?: {
        editor: {
          getNodes: () => Array<{ id: string; spec: { type: string } }>;
          getConnections: () => Array<{ id: string; target: string }>;
          removeConnection: (id: string) => Promise<void>;
        };
      };
    }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    const poseIds = new Set(
      handle.editor.getNodes().filter((node) => node.spec.type === 'Pose').map((node) => node.id),
    );
    return Promise.all(
      handle.editor
        .getConnections()
        .filter((connection) => poseIds.has(connection.target))
        .map((connection) => handle.editor.removeConnection(connection.id)),
    );
  });
  await expect(page.getByTestId('pose-field').nth(1)).toHaveValue('4.5');
  await expect(page.getByTestId('current-ir')).toContainText('"version": 1');
  // 文件名按浏览器落地；显式保存一份到测试结果目录，便于失败时人工查看。
  await download.saveAs(testInfo.outputPath('rosui-graph.rosui.json'));
  expect(browserName).toBe('chromium');
});

/** 写一份临时 JSON，交给文件输入框加载。 */
async function setGraphFile(page: Page, graph: unknown, name: string): Promise<void> {
  const filePath = `/tmp/${name}`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, typeof graph === 'string' ? graph : JSON.stringify(graph, null, 2));
  await page.getByTestId('load-graph-input').setInputFiles(filePath);
}

/** 等加载处理结束（画布节点数稳定），避免断言抢在异步 addNode 之前。 */
async function waitNodeCount(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const handle = (window as unknown as { __rosui?: EditorHandle }).__rosui;
          return handle?.editor.getNodes().length ?? -1;
        }),
      { timeout: 10_000 },
    )
    .toBe(count);
}

test('含 Inspector 的图：保存 → reload → 加载不崩、节点数一致', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('add-inspector').click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const handle = (window as unknown as { __rosui?: EditorHandle }).__rosui;
          return handle?.editor.getNodes().length ?? -1;
        }),
      { timeout: 10_000 },
    )
    .toBe(6);

  const before = await page.evaluate(() => {
    const handle = (window as unknown as { __rosui?: EditorHandle }).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    return handle.editor.getNodes().length;
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-graph').click();
  const graphPath = await (await downloadPromise).path();
  if (!graphPath) throw new Error('download.path() 为空');

  await page.reload();
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('load-graph-input').setInputFiles(graphPath);
  await waitNodeCount(page, before);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
  await expect(page.getByTestId('current-ir')).toContainText('"version": 1');
});

test('运行时绑定：保存 → 加载后 IR 仍是 runtime（未连接时登记订阅、不下发）', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  // 用文件注入一张 Threshold 绑定 /rosui_demo:gain 的 runtime IR，再存盘走完整保存路径。
  const runtimeIR = {
    version: 1,
    nodes: [
      {
        id: 'threshold-runtime',
        type: 'Threshold',
        position: { x: 100, y: 100 },
        params: {
          value: {
            node: '/rosui_demo:gain',
            param: 'value',
            valueType: 'double',
            mode: 'runtime',
            widget: 'number',
            value: 3,
          },
        },
      },
    ],
    edges: [],
  };
  await setGraphFile(page, runtimeIR, 'runtime-before.rosui.json');
  await waitNodeCount(page, 1);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
  await expect(page.getByTestId('current-ir')).toContainText('"mode": "runtime"');

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-graph').click();
  const graphPath = await (await downloadPromise).path();
  if (!graphPath) throw new Error('download.path() 为空');

  await page.reload();
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('load-graph-input').setInputFiles(graphPath);
  await waitNodeCount(page, 1);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
  await expect(page.getByTestId('current-ir')).toContainText('/rosui_demo:gain');
  await expect(page.getByTestId('current-ir')).toContainText('"mode": "runtime"');
});

test('非法文件（schema 缺字段 / 非 JSON）加载后画布节点数不变', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  const before = 5;
  await setGraphFile(page, { version: 1, nodes: [] }, 'invalid-schema.json');
  await expect(page.getByTestId('ros-toast')).toContainText('加载失败');
  await waitNodeCount(page, before);

  await setGraphFile(page, 'not json at all', 'invalid-json.json');
  await expect(page.getByTestId('ros-toast')).toContainText('文件不是合法 JSON');
  await waitNodeCount(page, before);
  await expect(page.getByTestId('current-ir')).toContainText('"version": 1');
});

test('空图加载后画布为 0 节点且无报错', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await setGraphFile(page, { version: 1, nodes: [], edges: [] }, 'empty.rosui.json');
  await waitNodeCount(page, 0);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
  await expect(page.getByTestId('current-ir')).toContainText('"nodes": []');
});
