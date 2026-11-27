// AC-5 证据脚本：100 节点拖动/缩放的最大 longtask 采样 + 截图。
// 前置：5180 dev server 已在跑（lead 在门禁阶段负责启动）；本脚本不碰 ROS 栈。
// 运行：node e2e/capture-ac.mjs
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = 'docs/artifacts';
const PNG = `${OUT}/ac5-100-nodes.png`;
const JSON_PATH = `${OUT}/ac5-100-nodes.json`;
const NODE_COUNT = 100;
const THRESHOLD_MS = 200;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
  await page.getByTestId('canvas-status').filter({ hasText: '就绪' }).waitFor({ timeout: 15_000 });

  // 复用 perf.spec.ts 的 DEV 句柄建节点手法：addNodes 走生产 addNode 路径，
  // 按 gain→pose→inspector→script 混合类型建图，并生成真实连线；再设一个接近 LOD 阈值的缩放。
  const nodeCount = await page.evaluate(async (count) => {
    const handle = window.__rosui;
    if (!handle) throw new Error('window.__rosui 未挂载（需要 DEV 模式的 5180 dev server）');
    await handle.editor.clear();
    await handle.addNodes(count);
    await handle.setZoom(0.5);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    return handle.editor.getNodes().length;
  }, NODE_COUNT);

  // PerformanceObserver 必须在交互开始前挂好；记录整个拖动/缩放窗口的 longtask。
  await page.evaluate(() => {
    window.__acLongTasks = [];
    window.__acObserver?.disconnect();
    window.__acObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__acLongTasks?.push(entry.duration);
      }
    });
    window.__acObserver.observe({ entryTypes: ['longtask'] });
  });

  // 缩放 + 拖动各做一轮，覆盖 AC-5 的「拖动/缩放」两种交互。
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, i % 2 === 0 ? -220 : 220);
    await page.waitForTimeout(120);
  }
  const canvas = page.locator('.canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('画布 boundingBox 为空');
  // 从靠边空白处起拖，避免点到节点变成节点拖动；验证的是画布平移/缩放性能。
  const startX = box.x + 24;
  const startY = box.y + 24;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(startX + i * 14, startY + i * 7);
  }
  await page.mouse.up();
  await page.waitForTimeout(200); // 让最后一个 longtask 的回调被观察到。

  const maxLongTaskMs = await page.evaluate(() => {
    window.__acObserver?.disconnect();
    const values = window.__acLongTasks ?? [];
    return values.length > 0 ? Math.max(...values) : 0;
  });

  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: PNG, fullPage: false });
  await writeFile(JSON_PATH, `${JSON.stringify({ maxLongTaskMs, nodeCount }, null, 2)}\n`);

  // 先落盘证据再判定：>200ms 必须让脚本以非 0 退出，AC-5 才是真正的门禁而非提示。
  if (maxLongTaskMs > THRESHOLD_MS) {
    throw new Error(`[AC-5] 最长 longtask ${maxLongTaskMs.toFixed(1)}ms > ${THRESHOLD_MS}ms`);
  }
  console.log(`[AC-5] 最长 longtask ${maxLongTaskMs.toFixed(1)}ms ≤ ${THRESHOLD_MS}ms`);
  console.log(`wrote ${PNG} + ${JSON_PATH} (nodeCount=${nodeCount})`);
} finally {
  await browser.close();
}
