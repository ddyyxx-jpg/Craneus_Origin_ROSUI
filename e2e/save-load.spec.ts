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
  expect(download.suggestedFilename()).toBe('rosui-graph.json');
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
  await download.saveAs(testInfo.outputPath('rosui-graph.json'));
  expect(browserName).toBe('chromium');
});
