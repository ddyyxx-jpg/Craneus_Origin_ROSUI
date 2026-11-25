import { expect, type Page } from '@playwright/test';

/** 参数浏览器默认收起：需要用到绑定按钮的用例先展开（展开才开始拉参数）。 */
export async function openParamBrowser(page: Page): Promise<void> {
  const toggle = page.getByTestId('param-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.locator('[data-testid="param-row"]').first()).toBeVisible({ timeout: 30_000 });
}
