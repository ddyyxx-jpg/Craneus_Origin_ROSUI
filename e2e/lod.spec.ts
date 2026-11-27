import { expect, test } from '@playwright/test';

/** 缩放 LOD 的几何一致性回归：full ↔ placeholder 的 socket 中心偏移逐像素一致。 */
test.describe('LOD 几何与阈值', () => {
  test('同一节点 full ↔ placeholder 的 socket 中心偏移差 ≤2px', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });

    /** 用 area 变换比例归一化，读的是节点局部坐标系下的 socket 中心与外框尺寸。 */
    const measure = async (): Promise<{
      nodeW: number;
      nodeH: number;
      sockets: { side: string; dx: number; dy: number; w: number; h: number }[];
    }> =>
      page.evaluate(() => {
        const node = document.querySelector('[data-node-id]') as HTMLElement;
        const nr = node.getBoundingClientRect();
        const k = nr.width / node.offsetWidth;
        return {
          nodeW: node.offsetWidth,
          nodeH: node.offsetHeight,
          sockets: Array.from(
            node.querySelectorAll<HTMLElement>(
              '[data-testid="input-socket"], [data-testid="output-socket"]',
            ),
          ).map((socket) => {
            const sr = socket.getBoundingClientRect();
            return {
              side: socket.getAttribute('data-testid') ?? '',
              // socket 中心相对节点左上角的偏移（节点局部坐标，不受缩放影响）。
              dx: (sr.left + sr.width / 2 - nr.left) / k,
              dy: (sr.top + sr.height / 2 - nr.top) / k,
              w: sr.width / k,
              h: sr.height / k,
            };
          }),
        };
      });

    const full = await measure();
    expect(full.sockets).toHaveLength(2);
    await page.evaluate(async () => {
      const handle = (window as unknown as { __rosui?: { setZoom: (k: number) => Promise<void> } })
        .__rosui;
      if (!handle) throw new Error('window.__rosui 未挂载');
      await handle.setZoom(0.3);
    });
    await expect(page.locator('[data-testid="node-lod"]').first()).toBeVisible();
    const placeholder = await measure();

    expect(placeholder.nodeW).toBe(full.nodeW);
    expect(placeholder.nodeH).toBe(full.nodeH);
    expect(placeholder.sockets).toHaveLength(full.sockets.length);
    for (let i = 0; i < full.sockets.length; i += 1) {
      const a = full.sockets[i]!;
      const b = placeholder.sockets[i]!;
      expect(b.side).toBe(a.side);
      // 评审 #1 验收口径：socket 中心偏移差 ≤2px（外框尺寸也须一致）。
      expect(Math.abs(b.dx - a.dx)).toBeLessThanOrEqual(2);
      expect(Math.abs(b.dy - a.dy)).toBeLessThanOrEqual(2);
      expect(Math.abs(b.w - a.w)).toBeLessThanOrEqual(2);
      expect(Math.abs(b.h - a.h)).toBeLessThanOrEqual(2);
    }
  });

  test('双阈值 hysteresis：0.32~0.38 之间保持原状态，跨阈值才切换', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    const zoom = async (k: number): Promise<void> =>
      page.evaluate(async (value) => {
        const handle = (window as unknown as { __rosui?: { setZoom: (k: number) => Promise<void> } })
          .__rosui;
        if (!handle) throw new Error('window.__rosui 未挂载');
        await handle.setZoom(value);
      }, k);
    const lodCount = async (): Promise<number> =>
      page.locator('[data-testid="node-lod"]').count();

    await zoom(0.35);
    await expect(page.locator('[data-testid="node-lod"]')).toHaveCount(0);
    await zoom(0.3);
    await expect(page.locator('[data-testid="node-lod"]')).toHaveCount(5);
    await zoom(0.35);
    await expect(page.locator('[data-testid="node-lod"]')).toHaveCount(5);
    await zoom(0.39);
    await expect(page.locator('[data-testid="node-lod"]')).toHaveCount(0);
    await zoom(0.38);
    expect(await lodCount()).toBe(0);
    await zoom(0.3);
    await zoom(0.32);
    expect(await lodCount()).toBe(5);
  });

  test('k=0.2 下新增 Pose：占位尺寸按类型取值，切回 full 尺寸不跳变', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    const addPose = async (): Promise<string> =>
      page.evaluate(async () => {
        const handle = (window as unknown as {
          __rosui?: { addNodeKind: (kind: 'pose', x: number, y: number) => Promise<{ id: string }> };
        }).__rosui;
        if (!handle) throw new Error('window.__rosui 未挂载');
        const node = await handle.addNodeKind('pose', 900, 600);
        return node.id;
      });
    const zoom = async (k: number): Promise<void> =>
      page.evaluate(async (value) => {
        const handle = (window as unknown as { __rosui?: { setZoom: (k: number) => Promise<void> } })
          .__rosui;
        if (!handle) throw new Error('window.__rosui 未挂载');
        await handle.setZoom(value);
      }, k);
    const sizeOf = async (id: string): Promise<{ w: number; h: number }> =>
      page.evaluate((nodeId) => {
        const node = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] .node-shell`)
          ?? document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
        if (!node) throw new Error(`找不到节点 ${nodeId}`);
        return { w: node.offsetWidth, h: node.offsetHeight };
      }, id);

    await zoom(0.2);
    const id = await addPose();
    const placeholder = await sizeOf(id);
    // 真实 full Pose 探针为 180×144（见 LodNode.tsx TYPE_SIZES 注释），不是全局 180×119。
    expect(placeholder.w).toBe(180);
    expect(Math.abs(placeholder.h - 144)).toBeLessThanOrEqual(2);

    await zoom(1);
    const full = await sizeOf(id);
    expect(Math.abs(full.w - placeholder.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(full.h - placeholder.h)).toBeLessThanOrEqual(2);
    expect(full.h).toBe(144);
  });

  test('选中态：真实点击 → full/placeholder 保持高亮 → 点空白取消', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    // P2-C：真实点击节点标题触发 nodepicked → App.selectNode → selectedPort；
    // 本应用不会写 Rete node.selected，直接置位属于不可达路径。
    const titles = page.locator('[data-testid="node"] .title');
    await titles.first().click();
    const selected = page.locator('[data-testid="node"].selected[data-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveCSS('background-color', 'rgb(255, 217, 44)');

    await page.evaluate(async () => {
      const handle = (window as unknown as { __rosui?: { setZoom: (k: number) => Promise<void> } })
        .__rosui;
      if (!handle) throw new Error('window.__rosui 未挂载');
      await handle.setZoom(0.3);
    });
    const placeholder = page.locator('[data-testid="node-lod"].selected[data-selected="true"]');
    await expect(placeholder).toHaveCount(1);
    await expect(placeholder).toHaveCSS('background-color', 'rgb(255, 217, 44)');

    await page.locator('.canvas').click({ position: { x: 5, y: 5 } });
    await expect(
      page.locator('[data-testid="node"].selected[data-selected="true"], [data-testid="node-lod"].selected[data-selected="true"]'),
    ).toHaveCount(0);
  });
});
