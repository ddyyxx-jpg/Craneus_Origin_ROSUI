// 探查 Rete/React 渲染出的 DOM 结构，用于写 e2e 选择器（一次性脚本）
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('[data-testid="node"], .rete-node, div')].slice(0, 0);
  const inputs = [...document.querySelectorAll('input')].map((el) => ({
    type: el.type,
    value: el.value,
    cls: el.className,
    parent: el.parentElement?.className ?? '',
  }));
  const titles = [...document.querySelectorAll('.title, .input-title')].map((el) => el.textContent);
  return {
    nodeCount: document.querySelectorAll('.rete-node').length,
    inputCount: inputs.length,
    inputs,
    titles,
    bodyText: document.body.innerText.slice(0, 400),
  };
});

console.log(JSON.stringify(info, null, 2));
console.log('console errors:', errors);
await browser.close();
