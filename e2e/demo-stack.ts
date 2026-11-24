import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let stack: ChildProcess | null = null;

const ROS_ENV = {
  ...process.env,
  ROS_DOMAIN_ID: process.env['ROS_DOMAIN_ID'] ?? '0',
  ROS_LOG_DIR: '/tmp/roslog',
};

/** 跑一条 ros2 CLI，返回 stdout（用于断言节点侧真实值）。 */
export function ros2(args: string): string {
  const result = spawnSync('bash', ['-lc', `set +u; source /opt/ros/jazzy/setup.bash; ${args}`], {
    env: ROS_ENV,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (result.status !== 0) {
    throw new Error(`ros2 命令失败: ${args}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return `${result.stdout}`.trim();
}

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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待超时 ${timeoutMs}ms`);
}

/** 起 rosbridge + demo 节点（若已在跑则复用）；返回清理函数。 */
export async function startDemoStack(): Promise<() => void> {
  if (!(await portOpen())) {
    stack = spawn(path.join(ROOT, 'scripts/demo-stack.sh'), [], {
      cwd: ROOT,
      env: ROS_ENV,
      detached: true,
      stdio: 'ignore',
    });
    stack.unref();
    await waitFor(portOpen, 60_000);
  } else if (ros2('ros2 node list').includes('/rosui_demo')) {
    return () => undefined; // 外部已经起好了，不归我们清理
  }

  const hasNode = () => {
    try {
      return ros2('ros2 param list /rosui_demo').includes('gain');
    } catch {
      return false;
    }
  };
  if (!hasNode() && !stack) {
    stack = spawn(path.join(ROOT, 'scripts/demo-stack.sh'), [], {
      cwd: ROOT,
      env: ROS_ENV,
      detached: true,
      stdio: 'ignore',
    });
    stack.unref();
  }
  await waitFor(hasNode, 60_000);

  return () => {
    if (!stack?.pid) return;
    try {
      process.kill(-stack.pid, 'SIGTERM');
    } catch {
      /* 已退出 */
    }
    stack = null;
  };
}
