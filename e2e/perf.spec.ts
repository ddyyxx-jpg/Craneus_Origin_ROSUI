import { expect, test, type Page } from '@playwright/test';
import type { EditorHandle } from '../apps/web/src/rete/editor';

// M5 T-031：纯 UI 压测，不依赖 ROS。每个用例独立页面，避免节点累积。
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

interface PerfSample {
  firstFrameMs: number;
  dragAvgMs: number;
  dragMaxMs: number;
  placeholderCount: number;
  nodeCount: number;
}

interface PerfWindow {
  __rosui?: EditorHandle;
}

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
}

/**
 * 在页面上下文里采样一次：
 * 设置缩放 → 清空 → 从 addNodes 开始计时 → 等节点数与 DOM 视图齐全 → 再等一帧 → 测 30 帧拖动。
 * 两个模式共用同一函数，保证测量口径完全一致。
 */
async function measure(page: Page, count: number, placeholder: boolean): Promise<PerfSample> {
  return page.evaluate(
    async ({ count, usePlaceholder }) => {
      const handle = (window as unknown as PerfWindow).__rosui;
      if (!handle) throw new Error('window.__rosui 未挂载');
      await handle.setZoom(usePlaceholder ? 0.3 : 1);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await handle.editor.clear();

      const started = performance.now();
      const ids = await handle.addNodes(count);
      // 首帧口径：编辑器节点数到位，且 DOM 节点视图齐全（不依赖状态栏文案）。
      while (
        handle.editor.getNodes().length < count ||
        handle.area.nodeViews.size < count ||
        document.querySelectorAll('[data-testid="node"], [data-testid="node-lod"]').length < count
      ) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const firstFrameMs = performance.now() - started;

      const target = ids[10];
      if (!target) throw new Error('批量添加未返回节点 id');
      const view = handle.area.nodeViews.get(target);
      if (!view) throw new Error('节点视图不存在');
      const before = view.position;
      const frames: number[] = [];
      let previous = performance.now();
      for (let i = 0; i < 30; i += 1) {
        await handle.area.translate(target, { x: before.x + i * 2, y: before.y + i });
        await new Promise<void>((resolve) => {
          requestAnimationFrame((now) => {
            frames.push(now - previous);
            previous = now;
            resolve();
          });
        });
      }
      const dragAvgMs = frames.reduce((sum, value) => sum + value, 0) / frames.length;
      const dragMaxMs = Math.max(...frames);
      return {
        firstFrameMs,
        dragAvgMs,
        dragMaxMs,
        nodeCount: handle.editor.getNodes().length,
        placeholderCount: document.querySelectorAll('[data-testid="node-lod"]').length,
      };
    },
    { count, usePlaceholder: placeholder },
  );
}

test('200 节点 full/placeholder 首帧与拖动帧时间可测', async ({ page }, testInfo) => {
  await ready(page);

  // 首轮（full）实测基线：firstFrameMs 358.9ms，dragAvgMs 16.21ms。
  // CI 抖动按 3 倍宽阈值断言；placeholder 也必须明显低于该上限。
  const full = await measure(page, 200, false);
  expect(full.nodeCount).toBe(200);
  expect(full.placeholderCount).toBe(0);
  expect(full.firstFrameMs).toBeLessThan(3 * 358.9);
  expect(full.dragAvgMs).toBeLessThan(3 * 16.21);
  console.log(`[perf][full] ${JSON.stringify(full)}`);

  const placeholder = await measure(page, 200, true);
  expect(placeholder.nodeCount).toBe(200);
  expect(placeholder.placeholderCount).toBe(200);
  expect(placeholder.firstFrameMs).toBeLessThan(3 * 358.9);
  expect(placeholder.dragAvgMs).toBeLessThan(3 * 16.21);
  console.log(`[perf][placeholder] ${JSON.stringify(placeholder)}`);

  await page.screenshot({ path: 'docs/artifacts/m5-perf.png', fullPage: false });
  await page.screenshot({ path: testInfo.outputPath('m5-perf.png') });
});

test('LOD 阈值恢复：缩放回来控件重新渲染且 socket 唯一', async ({ page }) => {
  await ready(page);
  const zoomed = await page.evaluate(async () => {
    const handle = (window as unknown as PerfWindow).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    await handle.setZoom(0.3);
    return handle.area.area.transform.k;
  });
  expect(zoomed).toBeCloseTo(0.3);
  await expect(page.locator('[data-testid="node-lod"]')).toHaveCount(5);
  await expect(page.locator('[data-testid="number-control"]')).toHaveCount(0);

  await page.evaluate(async () => {
    const handle = (window as unknown as PerfWindow).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    await handle.setZoom(1);
  });
  await expect(page.locator('[data-testid="node-lod"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="number-control"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="node"]')).toHaveCount(5);
});
