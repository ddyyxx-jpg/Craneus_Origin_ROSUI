import { expect, test } from '@playwright/test';

// M4 C: Script node runs local JS code and renders results/errors in-node.
test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

test('script editor compiles code on blur and shows result', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await page.getByTestId('add-script').click();
  const editor = page.getByTestId('script-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('spellcheck', 'false');
  await editor.fill('return x * 3 + 1;');
  await editor.press('Control+Enter');
  await expect(page.getByTestId('script-result')).toContainText('out: 4', { timeout: 5_000 });
});

test('invalid code shows red error text instead of throwing globally', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await page.getByTestId('add-script').click();
  const editor = page.getByTestId('script-editor');
  await editor.fill('return (');
  await editor.blur();
  await expect(page.getByTestId('script-error')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('script-error')).toHaveCSS('color', 'rgb(255, 107, 107)');
});
