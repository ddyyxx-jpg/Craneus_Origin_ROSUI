/**
 * T-006 真实联调脚本：需要 rosbridge(9090)、rosapi 与 rosui_demo 在同一 ROS domain。
 * 运行（apps/web 目录）：
 *   corepack pnpm exec vite-node src/ros/dev-probe.ts
 * 或仓库根目录：
 *   corepack pnpm exec vite-node --config apps/web/vite.config.ts apps/web/src/ros/dev-probe.ts
 *
 * 验证内容：
 *   1. getParamNames() 拿到 /rosui_demo:gain
 *   2. setParam gain 3.5 成功
 *   3. setParam gain 42.0 被拒，reason 为「gain 必须在 [0.0, 10.0]」
 *   4. 外部 ros2 param set 改值能通过 /parameter_events 推到 subscribeParam 回调
 */
import { execFile } from 'node:child_process';
import { RosClientImpl } from './RosClient';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`OK   ${message}`);
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const client = new RosClientImpl({
    url: 'ws://127.0.0.1:9090',
    reconnect: { initialMs: 200, maxMs: 1000, factor: 2 },
  });
  const statuses: string[] = [];
  client.onStatus((s, detail) => statuses.push(`${s}:${detail ?? ''}`));
  await client.connect();
  console.log('connected', client.status);

  const names = await client.getParamNames();
  console.log('getParamNames count', names.length, 'has /rosui_demo:gain =', names.includes('/rosui_demo:gain'));
  assert(names.includes('/rosui_demo:gain'), 'getParamNames 包含 /rosui_demo:gain');

  const gain = { node: '/rosui_demo', param: 'gain' };
  const ok = await client.setParam(gain, 3.5);
  console.log('setParam 3.5 ->', JSON.stringify(ok));
  assert(ok.successful === true, 'setParam gain 3.5 成功');

  const rejected = await client.setParam(gain, 42.0);
  console.log('setParam 42.0 ->', JSON.stringify(rejected));
  assert(
    rejected.successful === false && rejected.reason === 'gain 必须在 [0.0, 10.0]',
    'setParam gain 42.0 被拒且 reason 正确',
  );

  const got = await client.getParam(gain);
  console.log('getParam gain ->', JSON.stringify(got));
  assert(got.name === '/rosui_demo:gain' && got.value === 3.5, 'getParam 回读 gain=3.5');

  const pushed: number[] = [];
  const off = client.subscribeParam(gain, (v) => pushed.push(Number(v)));
  await waitFor(200); // 等待 /parameter_events 订阅生效

  const externalSet = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      'bash',
      ['-c', 'source /opt/ros/jazzy/setup.bash && timeout 15 ros2 param set /rosui_demo gain 6.25'],
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
    );
  });
  console.log('external ros2 param set:', (externalSet.stdout + externalSet.stderr).trim());
  const deadline = Date.now() + 5_000;
  while (!pushed.includes(6.25) && Date.now() < deadline) await waitFor(100);
  console.log('subscribeParam values:', JSON.stringify(pushed));
  assert(pushed.includes(6.25), '外部 ros2 param set 的值通过 /parameter_events 到达订阅回调');

  off();
  client.close();
  console.log('statuses:', statuses.join(' | '));
  console.log('DEV PROBE PASS');
}

main().catch((err: unknown) => {
  console.error('DEV PROBE FAIL', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
