import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ros2, startDemoStack, captureDetachedGroup, killDetachedGroup, type DetachedGroup } from './demo-stack';

// M5 T-033：AC-1 / AC-4 端到端验收（真 rosbridge + 真 rclpy 节点，无 mock）。
// 两个用例共用一套 ROS 栈；rosbridge 重启用例必须放在最后，避免污染其它用例。
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

const ROOT = path.resolve(import.meta.dirname, '..');
const ROS_ENV = {
  ...process.env,
  ROS_DOMAIN_ID: process.env['ROS_DOMAIN_ID'] ?? '0',
  ROS_LOG_DIR: '/tmp/roslog',
};
const BRIDGE_PATTERN = 'rosbridge_websocket';
const spawnedBridgeGroups = new Set<DetachedGroup>();

let stopStack: () => void = () => undefined;

test.beforeAll(async () => {
  stopStack = await startDemoStack();
});

test.afterAll(() => {
  // 兜底：任何没走到 finally 的替换 rosbridge 也要收掉，避免重复 /rosapi 污染后续全量运行。
  // detached spawn 的 PID 即新 PGID；captureDetachedGroup 记录 /proc starttime，
  // killDetachedGroup 在 PID 被复用时不会误杀无关进程组。
  for (const group of spawnedBridgeGroups) killDetachedGroup(group);
  spawnedBridgeGroups.clear();
  stopStack();
});

interface SavedGraph {
  nodes: Array<{
    id: string;
    type: string;
    params: Record<string, { node: string; param: string; value: unknown }>;
  }>;
}

// AC-4 用：在页面里记录 ros-status 的每一次 data-status 变化，避免「卡在 connected」
// 被 toHaveAttribute 误判成重连成功。
declare global {
  interface Window {
    __acStatusLog?: string[];
    __acStatusObserver?: MutationObserver;
  }
}

async function gotoConnected(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await page.getByTestId('ros-connect').click();
  await expect(page.getByTestId('ros-status')).toHaveAttribute('data-status', 'connected', {
    timeout: 20_000,
  });
}

/** 走真实保存路径拿下载文件，不用 window 内部字段硬取图状态。 */
async function saveGraph(page: Page): Promise<SavedGraph> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-graph').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('rosui-graph.rosui.json');
  const graphPath = await download.path();
  if (!graphPath) throw new Error('download.path() 为空');
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(graphPath, 'utf8')) as SavedGraph;
}

/** 与 demo-stack.ts 的 portOpen 同口径：轮询 9090 TCP 监听。 */
function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 9090 }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}

/**
 * 最小侵入：用 pgrep -f 'rosbridge_websocket' 匹配 scripts/ros-up.sh 起的 rosbridge
 * 相关进程（ros2 launch 主进程 rosbridge_websocket_launch.xml + websocket 本体），
 * 然后 SIGKILL 这些 PID；不整栈 teardown，/rosui_demo param_node 不在匹配范围，
 * 不会被杀。rosapi 可能随 ros2 launch 一起退出，由随后的 ros-up.sh 重新拉起，
 * 所以本用例证明的是「杀掉 rosbridge 服务 + 重启后页面自动重连、状态可见」，
 * 不证明 rosapi 全程存活。这覆盖 AC-4 的核心：WebSocket 断链 → 自动重连 → 状态可见。
 */
function findBridgePids(): number[] {
  const result = spawnSync('pgrep', ['-f', BRIDGE_PATTERN], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return `${result.stdout}`
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function killBridge(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程可能已由 launch 退出，忽略。
    }
  }
}

/** 独立启动 rosbridge；返回进程组身份，调用方负责在 finally / afterAll 回收。 */
function startBridge(): DetachedGroup {
  const proc = spawn(path.join(ROOT, 'scripts/ros-up.sh'), [], {
    cwd: ROOT,
    env: ROS_ENV,
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  const group = captureDetachedGroup(proc);
  spawnedBridgeGroups.add(group);
  return group;
}

test('AC-1 未连线数字端口写 3.5 → ROS 与图 IR 同时落地', async ({ page }) => {
  ros2('ros2 param set /rosui_demo gain 1.0');
  await gotoConnected(page);

  // 默认图里的 Gain 输入没有连线，控件可见；写一个非默认值并 blur 触发下发。
  // 用节点标题定位，避开被连线隐藏的 Threshold 数字控件。
  const gainNode = page
    .locator('[data-testid="node"]')
    .filter({ has: page.locator('.title:text-is("Gain")') })
    .first();
  const gain = gainNode.locator('[data-testid="number-control"]');
  await expect(gain).toBeVisible();
  await gain.fill('3.5');
  await gain.blur();

  // (a) ROS 侧：真 ros2 CLI 读回。
  await expect
    .poll(() => ros2('ros2 param get /rosui_demo gain'), { timeout: 15_000 })
    .toMatch(/value is: 3\.5$/);

  // (b) 图 IR：走已验证的保存 → 下载 → JSON.parse 路径，避免读未公开的内部状态。
  const graph = await saveGraph(page);
  const savedGain = graph.nodes.find((node) => node.type === 'Gain');
  expect(savedGain).toBeDefined();
  expect(savedGain?.params['gain']?.value).toBe(3.5);
  await expect(page.getByTestId('ros-toast')).toHaveCount(0);
});

test('AC-4 杀 rosbridge 后 5s 内自动重连（保留 /rosui_demo）', async ({ page }) => {
  await gotoConnected(page);

  // 先装 MutationObserver，记录每一次状态切换及其时间戳；这是页面可见的真实状态，
  // 不依赖 RosClient 内部字段（DEV window.__rosui 只暴露编辑器，不暴露 client）。
  await page.evaluate(() => {
    const span = document.querySelector<HTMLElement>('[data-testid="ros-status"]');
    if (!span) throw new Error('找不到 ros-status');
    window.__acStatusLog = [`${Date.now()}:${span.dataset.status ?? '?'}`];
    window.__acStatusObserver?.disconnect();
    const observer = new MutationObserver(() => {
      const next = span.dataset.status ?? '?';
      const log = window.__acStatusLog;
      if (log && log[log.length - 1]?.endsWith(`:${next}`)) return;
      log?.push(`${Date.now()}:${next}`);
    });
    observer.observe(span, { attributes: true, attributeFilter: ['data-status'] });
    window.__acStatusObserver = observer;
  });

  const bridgePids = findBridgePids();
  expect(bridgePids.length, 'pgrep 必须找到正在运行的 rosbridge 进程').toBeGreaterThan(0);

  // 证明 rosbridge 真的被杀掉：/rosui_demo 节点保持存活。
  expect(ros2('ros2 node list')).toContain('/rosui_demo');

  let bridgeGroup: DetachedGroup | undefined;
  let killedAt = 0;
  try {
    // 计时起点：从发出 SIGKILL 那一刻开始；不整栈 teardown，只杀 rosbridge 本体。
    killedAt = Date.now();
    killBridge(bridgePids);
    // 等端口真正关闭再拉起：SIGKILL 发送后 socket 可能短暂还在 TIME_WAIT，
    // 不等待会让 ros-up.sh 因端口占用启动失败，导致后续 poll 误判。
    const portClosed = await waitUntil(async () => !(await portOpen()), 2_000);
    expect(portClosed, 'rosbridge 被杀后 9090 必须断开').toBe(true);

    // 立刻用 scripts/ros-up.sh 单独拉起 rosbridge；保留原 param_node。
    bridgeGroup = startBridge();
    const portBack = await waitUntil(portOpen, 2_000);
    expect(portBack, 'rosbridge 必须在 2s 内重新监听 9090').toBe(true);

    // 计时口径：AC-4 的终点是「页面可见 connected:reconnected」，而不是轨迹里短暂
    // 出现过 connected；5s 预算覆盖状态轨迹和 data-detail 的最终可见性。
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const log = window.__acStatusLog ?? [];
            const firstDown = log.findIndex((entry) => !entry.endsWith(':connected'));
            const status = document.querySelector<HTMLElement>('[data-testid="ros-status"]');
            return (
              firstDown >= 0 &&
              log.slice(firstDown + 1).some((entry) => entry.endsWith(':connected')) &&
              status?.dataset.detail === 'connected:reconnected'
            );
          }),
        { timeout: 5_000, intervals: [100, 200] },
      )
      .toBe(true);

    const elapsedMs = Date.now() - killedAt;
    expect(elapsedMs).toBeLessThanOrEqual(5_000);
    const statusLog = await page.evaluate(() => {
      window.__acStatusObserver?.disconnect();
      return window.__acStatusLog ?? [];
    });
    console.log(`[ac4] 杀 rosbridge 到页面 connected 用时 ${elapsedMs}ms；状态轨迹 ${statusLog.join(' → ')}`);

    // 落地方案 AC-4 要求「状态可见 / connected:reconnected」：RosClient.ts:161 的
    // emitStatus('connected','reconnected') 会写进 statusDetail，App.tsx 已把该 state
    // 暴露为 ros-status 的 data-detail，因此这里真实断言重连原因，不再只停留在单测里。
    await expect(page.getByTestId('ros-status')).toHaveAttribute('data-detail', 'connected:reconnected');
  } finally {
    // try/finally 兜底：无论断言成功与否都确保 9090 不留坏状态。
    // 只杀自己新起的 rosbridge 进程组，不能动 startDemoStack 起的 /rosui_demo param_node。
    if (bridgeGroup !== undefined) {
      // 用 SIGKILL 整组回收：findBridgePids() 的 SIGKILL 只命中 launch/websocket，
      // rosapi 子进程会变孤儿；下一轮全量运行会出现重复 /rosapi 抢答 set_param。
      killDetachedGroup(bridgeGroup);
      spawnedBridgeGroups.delete(bridgeGroup);
      // 等端口释放再判断是否需要补拉，避免竞态下重复起 rosbridge。
      await waitUntil(async () => !(await portOpen()), 2_000);
    }
    expect(ros2('ros2 node list'), '/rosui_demo param_node 必须全程存活').toContain('/rosui_demo');
    // 兜底：若新起的 rosbridge 被杀掉而原 launch 也没自动恢复，用同一脚本再拉一次，
    // 保证后续用例拿到健康的 9090（仅补 rosbridge，不重建 /rosui_demo）。
    // 注意：这里故意不杀 fallback 进程——它是 9090 的唯一存活 rosbridge，
    // 杀掉会把端口留给后续用例一个坏状态。findBridgePids() 的 SIGKILL 只覆盖
    // launch/websocket，rosapi 子进程会变成孤儿；若不在 afterAll 整组回收，第二次
    // 全量运行就会出现两个 /rosapi 抢答 set_param（曾让 binding.spec.ts:38 收到 2.5）。
    // 所有 startBridge() 起的进程组都记入 spawnedBridgeGroups，由 afterAll 统一 SIGKILL。
    if (!(await portOpen())) {
      startBridge();
    }
    const recovered = await waitUntil(portOpen, 3_000);
    expect(recovered, 'finally 清理后必须有一个健康的 9090 rosbridge').toBe(true);
    await page.evaluate(() => window.__acStatusObserver?.disconnect());
  }
});
