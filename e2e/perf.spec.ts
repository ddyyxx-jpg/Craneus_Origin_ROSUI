import { expect, test, type Page } from '@playwright/test';
import type { EditorHandle } from '../apps/web/src/rete/editor';

// M5 T-031：纯 UI 压测，不依赖 ROS。默认不进全量门禁，需 ROSUI_PERF=1 显式开启。
// 每个用例独立页面，避免节点累积。
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);
test.skip(process.env.ROSUI_PERF !== '1', '性能压测默认跳过：ROSUI_PERF=1 开启');

interface PerfSample {
  firstFrameMs: number;
  /** 一批节点拖动中，平均每次 area.translate 的主线程工作量（ms），不含 rAF/vsync 间隔。 */
  dragAvgMs: number;
  /** 各批拖动中工作量最大的一批的平均值（ms）。 */
  dragMaxMs: number;
  placeholderCount: number;
  nodeCount: number;
  connectionCount: number;
  kinds: string[];
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
      await handle.setZoom(usePlaceholder ? 0.28 : 1);
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
      // 二轮评审 P2-D：旧指标用相邻 rAF 时间戳（≈16.6ms），被 vsync 锁死，
      // 1.2× 阈值只能抓严重退化。新指标用 performance.now() 包住「一批」连续
      // area.translate（含 nodetranslated 管道里的连线/socket 重算）的同步主线程
      // 工作量；每批 40 次摊薄 performance.now() 的量化误差，跑 7 批取中位数，
      // rAF 只用于批间让出渲染帧，不计入工作量。
      const batchSizes: number[] = [];
      for (let round = 0; round < 7; round += 1) {
        const startedAt = performance.now();
        for (let i = 0; i < 40; i += 1) {
          const step = round * 40 + i + 1;
          await handle.area.translate(target, { x: before.x + step, y: before.y + step });
        }
        batchSizes.push(performance.now() - startedAt);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const sorted = [...batchSizes].sort((a, b) => a - b);
      const dragAvgMs = sorted[Math.floor(sorted.length / 2)]! / 40;
      const dragMaxMs = Math.max(...batchSizes) / 40;
      return {
        firstFrameMs,
        dragAvgMs,
        dragMaxMs,
        nodeCount: handle.editor.getNodes().length,
        placeholderCount: document.querySelectorAll('[data-testid="node-lod"]').length,
        connectionCount: handle.editor.getConnections().length,
        kinds: Array.from(
          new Set(handle.editor.getNodes().map((node) => (node as { spec?: { type?: string } }).spec?.type ?? '')),
        ),
      };
    },
    { count, usePlaceholder: placeholder },
  );
}

test('200 节点混合图 full/placeholder 首帧对比与拖动成本', async ({ page }, testInfo) => {
  await ready(page);

  const full = await measure(page, 200, false);
  expect(full.nodeCount).toBe(200);
  expect(full.placeholderCount).toBe(0);
  // 评审 #6：混合四种节点 + 至少 100 条连线，走生产 addNode() 路径。
  expect(full.connectionCount).toBeGreaterThanOrEqual(100);
  console.log(`[perf][full] ${JSON.stringify(full)}`);

  const placeholder = await measure(page, 200, true);
  expect(placeholder.nodeCount).toBe(200);
  expect(placeholder.placeholderCount).toBe(200);
  expect(placeholder.connectionCount).toBeGreaterThanOrEqual(100);
  console.log(`[perf][placeholder] ${JSON.stringify(placeholder)}`);

  // 评审 #5 + 二轮 P2-D：对比式断言。0.85 基于同机多轮 full 366ms / placeholder 240ms 的
  // 65.6% 比例留 ~20 个百分点余量；拖动新指标是 7 批 ×40 次 area.translate 的 median
  // 单步主线程工作量，1.2 上限容忍 ~20% 抖动，但能抓住“占位反而比 full 慢 20% 以上”的实质退化。
  expect(placeholder.firstFrameMs).toBeLessThan(0.85 * full.firstFrameMs);
  expect(placeholder.dragAvgMs).toBeLessThanOrEqual(full.dragAvgMs * 1.2);

  // 截图只写 Playwright 的 outputPath，不污染仓库；最终产物由维护者手动复制。
  await page.screenshot({ path: testInfo.outputPath('m5-perf.png'), fullPage: false });
});

test('LOD 阈值恢复：缩放回来控件重新渲染且 socket 唯一', async ({ page }) => {
  await ready(page);
  const zoomed = await page.evaluate(async () => {
    const handle = (window as unknown as PerfWindow).__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载');
    await handle.setZoom(0.28);
    return handle.area.area.transform.k;
  });
  expect(zoomed).toBeCloseTo(0.28);
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
