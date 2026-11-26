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

  test('placeholder 选中态：class 与 data-selected 与 classic 一致', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    // classic preset 的选中态来自 node.data.selected；用与 selectableNodes 相同的
    // 数据路径置位后 area.update，再切 placeholder，验证它是从 data.selected 传播而非 DOM 残留。
    await page.evaluate(async () => {
      const handle = (window as unknown as {
        __rosui?: {
          setZoom: (k: number) => Promise<void>;
          editor: { getNodes: () => { id: string; selected?: boolean }[] };
          area: { update: (type: string, id: string) => Promise<void> };
        };
      }).__rosui;
      if (!handle) throw new Error('window.__rosui 未挂载');
      const target = handle.editor.getNodes()[0];
      if (!target) throw new Error('页面没有节点');
      target.selected = true;
      await handle.area.update('node', target.id);
      await handle.setZoom(0.3);
    });
    await expect(page.locator('[data-testid="node-lod"].selected')).toHaveCount(1);
    await expect(page.locator('[data-testid="node-lod"][data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="node-lod"].selected')).toHaveCSS(
      'background-color',
      'rgb(255, 217, 44)',
    );
  });
});
