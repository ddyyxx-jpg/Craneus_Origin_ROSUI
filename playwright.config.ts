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
    command: 'corepack pnpm dev',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
