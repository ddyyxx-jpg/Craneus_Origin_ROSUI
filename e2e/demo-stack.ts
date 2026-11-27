import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let stack: ChildProcess | null = null;

/** detached spawn 在 Linux 上 setsid() 成新进程组；记录 leader 的 /proc starttime 防 PID 复用误杀。 */
export interface DetachedGroup {
  readonly pid: number;
  readonly startTime: string;
}

function readProcStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error(`无法解析 /proc/${pid}/stat`);
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const startTime = fields[19]; // field 22：state 是 field 3，故 starttime 在索引 19。
  if (!startTime) throw new Error(`无法读取 /proc/${pid}/stat 的 starttime`);
  return startTime;
}

export function captureDetachedGroup(proc: ChildProcess): DetachedGroup {
  const pid = proc.pid;
  if (pid === undefined) throw new Error('detached 进程没有 PID');
  return { pid, startTime: readProcStartTime(pid) };
}

export function killDetachedGroup(
  group: DetachedGroup,
  signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL',
): void {
  let currentStartTime: string | undefined;
  try {
    currentStartTime = readProcStartTime(group.pid);
  } catch {
    // leader 已退出但同一进程组可能还有 rosapi 等子进程；PGID 未释放时仍可整组 kill。
  }
  if (currentStartTime !== undefined && currentStartTime !== group.startTime) return;
  try {
    process.kill(-group.pid, signal);
  } catch {
    // 进程组已退出。
  }
}

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
  // 过滤 RTPS 的 SHM/participant 噪声行（带时间戳，逐字比对会假失败）。
  return `${result.stdout}`
    .split('\n')
    .filter((line) => !/RTPS_|Permission denied/.test(line))
    .join('\n')
    .trim();
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
  let group: DetachedGroup | null = null;
  if (!(await portOpen())) {
    stack = spawn(path.join(ROOT, 'scripts/demo-stack.sh'), [], {
      cwd: ROOT,
      env: ROS_ENV,
      detached: true,
      stdio: 'ignore',
    });
    stack.unref();
    group = captureDetachedGroup(stack);
    await waitFor(portOpen, 60_000);
  } else if (ros2('ros2 node list').includes('/rosui_demo')) {
    return () => undefined; // 外部已经起好了，不归我们清理
  }

  /** 每次栈就绪后把 demo 参数复位，避免上一个 spec / 上一次运行留下的值污染断言。 */
  const resetDemoParams = (): void => {
    ros2('ros2 param set /rosui_demo gain 1.0');
    ros2('ros2 param set /rosui_demo mode normal');
    ros2('ros2 param set /rosui_demo enabled true');
    ros2('ros2 param set /rosui_demo pose "[2.0, 3.0, 0.0, 0.0, 0.0, 0.0, 1.0]"');
  };

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
    group = captureDetachedGroup(stack);
  }
  await waitFor(hasNode, 60_000);
  resetDemoParams();

  return () => {
    if (group) killDetachedGroup(group);
    stack = null;
  };
}

/** 起一个 3 秒后才声明参数的节点，用来验证参数浏览器能发现运行期新增参数。 */
export function startLateParamNode(): { nodeName: string; stop: () => void } {
  const nodeName = `rosui_late_${String(Date.now() % 100000)}`;
  // 必须 source ROS 环境，裸 python3 找不到 rclpy（会静默退出，测试只会看到「节点没出现」）。
  const proc = spawn(
    'bash',
    ['-lc', 'set +u; source /opt/ros/jazzy/setup.bash; exec python3 scripts/late_param_node.py'],
    {
      cwd: ROOT,
      env: { ...ROS_ENV, ROSUI_LATE_NODE: nodeName },
      detached: true,
      stdio: 'ignore',
    },
  );
  proc.unref();
  const lateGroup = captureDetachedGroup(proc);
  return {
    nodeName,
    stop: () => killDetachedGroup(lateGroup, 'SIGTERM'),
  };
}
