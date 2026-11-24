// 生成 M1 证据截图：连线态（控件被隐藏）与断线态（控件恢复）
import { chromium } from 'playwright';

const out = 'docs/artifacts';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await page.getByText(/Ready — 5 nodes/).waitFor({ timeout: 15_000 });
await page.waitForTimeout(600);

await page.screenshot({ path: `${out}/m1-connected.png` });

await page.evaluate(async () => {
  const handle = window.__rosui;
  for (const c of handle.editor.getConnections()) await handle.editor.removeConnection(c.id);
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/m1-disconnected.png` });

await browser.close();
console.log('wrote docs/artifacts/m1-connected.png + m1-disconnected.png');
