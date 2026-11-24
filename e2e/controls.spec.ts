import { expect, test } from '@playwright/test';

const irNode = (page: import('@playwright/test').Page, type: string) =>
  page.evaluate((nodeType) => {
    const raw = document.querySelector('[data-testid="current-ir"]')?.textContent ?? '{}';
    const graph = JSON.parse(raw) as {
      nodes: { id: string; type: string; params: Record<string, { value: unknown }> }[];
    };
    const node = graph.nodes.find((item) => item.type === nodeType);
    return node ?? null;
  }, type);

const irParam = (node: Awaited<ReturnType<typeof irNode>>, param: string) =>
  node?.params[param]?.value;

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByText(/Ready — 5 nodes/)).toBeVisible({ timeout: 15_000 });
}

test.describe('T-011 控件库与节点映射', () => {
  test('4 类控件都能编辑并写入 IR', async ({ page }) => {
    await ready(page);

    // number: Gain 的控件是内置 InputControl('number')，仍走 change/setValue 协议
    const number = page.locator('[data-testid="number-control"]');
    await expect(number).toHaveCount(1);
    await number.fill('4.5');
    await number.blur();
    await expect(page.getByText('last gain: 4.5')).toBeVisible();
    await expect.poll(async () => irParam(await irNode(page, 'Gain'), 'gain')).toBe(4.5);

    // text
    const text = page.locator('[data-testid="text-control"]');
    await expect(text).toBeVisible();
    await text.fill('hello-rosui');
    await text.blur();
    await expect.poll(async () => irParam(await irNode(page, 'Label'), 'name')).toBe('hello-rosui');

    // select
    const select = page.locator('[data-testid="select-control"]');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['low', 'normal', 'high']);
    await select.selectOption('high');
    await expect.poll(async () => irParam(await irNode(page, 'Mode'), 'mode')).toBe('high');

    // boolean
    const toggle = page.locator('[data-testid="boolean-control"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => irParam(await irNode(page, 'Switch'), 'enabled')).toBe(true);
  });

  test('IR 顶部只读展示可滚动，包含五种节点与一条连线', async ({ page }) => {
    await ready(page);
    const panel = page.locator('[data-testid="current-ir"]');
    await expect(panel).toBeVisible();
    const graph = await page.evaluate(() => {
      const raw = document.querySelector('[data-testid="current-ir"]')?.textContent ?? '{}';
      return JSON.parse(raw) as { nodes: unknown[]; edges: unknown[] };
    });
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(1);
    expect(await panel.evaluate((element) => getComputedStyle(element).maxHeight)).not.toBe('none');
  });
});

test.describe('T-014 输入校验', () => {
  test('number 越界显示红框和行内错误，且不写入 IR', async ({ page }) => {
    await ready(page);
    const before = await irParam(await irNode(page, 'Gain'), 'gain');
    const number = page.locator('[data-testid="number-control"]');
    await number.fill('99');
    await expect(page.getByTestId('control-error')).toContainText('≤ 10');
    await expect(number).toHaveClass(/invalid/);
    await number.blur();
    await expect.poll(async () => irParam(await irNode(page, 'Gain'), 'gain')).toBe(before);
  });

  test('NaN 输入显示错误，且不写入 IR', async ({ page }) => {
    await ready(page);
    const before = await irParam(await irNode(page, 'Gain'), 'gain');
    const number = page.locator('[data-testid="number-control"]');
    await number.fill('abc');
    await expect(page.getByTestId('control-error')).toContainText('finite number');
    await number.blur();
    await expect.poll(async () => irParam(await irNode(page, 'Gain'), 'gain')).toBe(before);
  });

  test('text 空串显示错误，且不写入 IR', async ({ page }) => {
    await ready(page);
    const before = await irParam(await irNode(page, 'Label'), 'name');
    const text = page.locator('[data-testid="text-control"]');
    await text.fill('');
    await expect(page.getByTestId('control-error')).toContainText('must not be empty');
    await expect(text).toHaveClass(/invalid/);
    await text.blur();
    await expect.poll(async () => irParam(await irNode(page, 'Label'), 'name')).toBe(before);
  });

  test('合法值修正后错误消失并写入 IR', async ({ page }) => {
    await ready(page);
    const number = page.locator('[data-testid="number-control"]');
    await number.fill('12');
    await expect(page.getByTestId('control-error')).toBeVisible();
    await number.fill('2.5');
    await expect(page.getByTestId('control-error')).toHaveCount(0);
    await number.blur();
    await expect.poll(async () => irParam(await irNode(page, 'Gain'), 'gain')).toBe(2.5);
  });
});

test.describe('T-013 交互防冲突', () => {
  test('控件内空格不触发画布拖动、不删除选中节点', async ({ page }) => {
    await ready(page);
    const node = page.locator('[data-testid="node"]', { has: page.locator('[data-testid="number-control"]') });
    const before = await node.boundingBox();
    const input = page.locator('[data-testid="number-control"]');
    await input.click();
    await input.press('Space');
    await page.waitForTimeout(150);
    const after = await node.boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(2);
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
    // 空格不能删除节点
    await expect(page.locator('[data-testid="node"]')).toHaveCount(5);
    // 控件仍持有焦点，键盘事件没有冒泡到画布
    await expect(input).toBeFocused();
  });

  test('控件内方向键不移动节点，Delete 不删除节点', async ({ page }) => {
    await ready(page);
    const node = page.locator('[data-testid="node"]', { has: page.locator('[data-testid="text-control"]') });
    const before = await node.boundingBox();
    const input = page.locator('[data-testid="text-control"]');
    await input.click();
    await input.press('ArrowRight');
    await input.press('Delete');
    await page.waitForTimeout(150);
    const after = await node.boundingBox();
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(2);
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
    await expect(page.locator('[data-testid="node"]')).toHaveCount(5);
  });

  test('文本控件中可选中文字，且选中操作不移动节点', async ({ page }) => {
    await ready(page);
    const node = page.locator('[data-testid="node"]', { has: page.locator('[data-testid="text-control"]') });
    const before = await node.boundingBox();
    const input = page.locator('[data-testid="text-control"]');
    await input.click();
    await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(0, 3));
    const selected = await input.evaluate((element: HTMLInputElement) => element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0));
    expect(selected.length).toBeGreaterThan(0);
    const after = await node.boundingBox();
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(2);
    expect(await input.evaluate((element) => getComputedStyle(element).userSelect)).toBe('all');
  });
});
