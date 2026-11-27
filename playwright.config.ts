import { defineConfig, devices } from '@playwright/test';

// 开发端口固定 5180：5173 被同机别的项目占用。
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // 单 worker：binding.spec 会起真 ROS 栈（rosbridge + rclpy 节点），与纯 UI 用例并行时会抢资源，
  // 曾出现 page fixture 30s 超时。串行跑 18 条 ~60s，可接受。
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    // 二轮 P2-E：原 command `corepack pnpm dev` 会经 pnpm → sh -c → vite 多代 spawn；
    // 实测 vite 子进程的 PGID 与 Playwright 启动的 shell PGID 不同，teardown 的
    // process.kill(-pid, SIGKILL) 只杀中间 shell，vite 存活并持有 stdio 管道，
    // 导致 CLI 全量测试结束后不退出（外层 timeout 124）。
    // 改为 `cd apps/web && exec node ...vite.js`：shell 被 exec 替换成 vite 本体，
    // 不再有 pnpm/sh -c 中间层造成 PGID 分裂；同时 cwd 定位到 apps/web
    // （index.html 所在目录），避免从仓库根启动 404。
    command: 'cd apps/web && exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5180 --strictPort',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
