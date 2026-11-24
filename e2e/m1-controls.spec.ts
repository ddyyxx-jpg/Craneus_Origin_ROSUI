import { expect, test } from '@playwright/test';

// M1 验收（已按 T-011 的 5 节点演示图更新）：C1 端口内联控件 + C2 连线隐藏/断线恢复。
test.describe('M1 · 端口内联控件与显隐联动', () => {
  test('画布起得来：5 种节点 + 一条连线', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

    await page.goto('/');
    await expect(page.getByText('ROSUI', { exact: true })).toBeVisible();
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 15_000,
    });

    // 演示图覆盖 Gain / Threshold / Label / Mode / Switch 五种节点
    for (const label of ['Gain', 'Threshold', 'Label', 'Mode', 'Switch']) {
      await expect(page.locator('[data-testid="title"]', { hasText: label })).toHaveCount(1);
    }
    expect(errors, `浏览器控制台报错: ${errors.join(' | ')}`).toEqual([]);
  });

  test('C1：未连线的输入端口上有一个可编辑的数字控件', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 15_000,
    });

    const controls = page.locator('[data-testid="number-control"]');
    // 只有「未连线」的那一侧端口保留控件；被连线的那一侧控件应被 showInputControl 隐藏
    await expect(controls).toHaveCount(1);
    await expect(controls).toHaveValue('1');

    await controls.fill('3.5');
    await controls.blur();
    // 控件 change 回调 -> React state -> 工具栏显示（number 模型仍是内置 InputControl('number')）
    await expect(page.getByTestId('gain-readout')).toContainText('3.5');
  });

  test('C2b：删掉连线后控件 300ms 内恢复', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 15_000,
    });

    await expect(page.locator('[data-testid="number-control"]')).toHaveCount(1);
    // dev 模式下 App 把 editor handle 挂到 window.__rosui
    await page.evaluate(async () => {
      const handle = (window as unknown as { __rosui?: { editor: { getConnections: () => { id: string }[]; removeConnection: (id: string) => Promise<void> } } }).__rosui;
      if (!handle) throw new Error('window.__rosui 未挂载');
      for (const c of handle.editor.getConnections()) await handle.editor.removeConnection(c.id);
    });
    await expect(page.locator('[data-testid="number-control"]')).toHaveCount(2, { timeout: 300 });
  });

  test('C2：被连线端口的控件隐藏、label 出现', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
      timeout: 15_000,
    });

    // 连线那侧的 input 行渲染的是端口 label（gain→value），不是控件
    await expect(page.locator('.input-title', { hasText: 'value' })).toHaveCount(1);
    // 整页只有一个 number 控件，说明另一侧确实被隐藏了
    await expect(page.locator('[data-testid="number-control"]')).toHaveCount(1);
  });
});
