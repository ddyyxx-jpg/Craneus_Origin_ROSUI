export interface ScriptRunResult {
  ok: boolean;
  value: number | string | null;
  error: string | null;
  /** 超时被 Worker 强制终止（区别于代码自己抛错）。 */
  timedOut: boolean;
}

/** 结果约束：只接受有限数字或字符串，避免把对象/函数塞进输出端口。 */
export function normalizeResult(value: unknown): { ok: true; value: number | string } | { ok: false; error: string } {
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (typeof value === 'string') return { ok: true, value };
  return { ok: false, error: '结果必须是有限数字或字符串' };
}

export interface ScriptRunnerDeps {
  /** 便于测试注入；同一个 factory 复用同一个 Worker（WeakMap 缓存）。 */
  createWorker?: () => Worker | null;
  timeoutMs?: number;
}

interface PendingRun {
  resolve: (result: ScriptRunResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 同一 factory 复用同一个 Worker：每次失焦都新建 Worker 的创建开销在参数面板这种高频场景很显眼。 */
const workerCache = new WeakMap<() => Worker | null, Worker>();
const pendingById = new Map<number, PendingRun>();
let nextRunId = 1;

function failAllPending(reason: string): void {
  for (const [id, pending] of pendingById) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, value: null, error: reason, timedOut: false });
    pendingById.delete(id);
  }
}

function handleWorkerMessage(event: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string }>): void {
  const { id, ok, value, error } = event.data;
  const pending = pendingById.get(id);
  if (!pending) return;
  pendingById.delete(id);
  clearTimeout(pending.timer);
  if (!ok) {
    pending.resolve({ ok: false, value: null, error: error ?? '执行失败', timedOut: false });
    return;
  }
  const normalized = normalizeResult(value);
  pending.resolve(
    normalized.ok
      ? { ok: true, value: normalized.value, error: null, timedOut: false }
      : { ok: false, value: null, error: normalized.error, timedOut: false },
  );
}

function acquireWorker(factory: () => Worker | null): Worker | null {
  const cached = workerCache.get(factory);
  if (cached) return cached;
  const worker = factory();
  if (!worker) return null;
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (event: ErrorEvent) => {
    failAllPending(event.message || 'Worker 执行失败');
    worker.terminate();
    workerCache.delete(factory);
  };
  workerCache.set(factory, worker);
  return worker;
}

/** 超时后 Worker 可能仍在死循环里，只能 terminate；下次调用重新建一个。 */
function resetWorker(factory: () => Worker | null, reason: string): void {
  const worker = workerCache.get(factory);
  if (worker) {
    worker.terminate();
    workerCache.delete(factory);
  }
  failAllPending(reason);
}

/**
 * 在 Worker 里执行用户脚本，超时就 terminate —— 这是 `while (true) {}` 唯一可靠的止血方式
 * （同步 `new Function` 在页面主线程里无法被中断）。
 * Worker 复用：连续执行不会反复创建；某次超时终止后重建。
 * 环境不支持 Worker（如 jsdom/单测）时回退到带 `__timeout` 守卫的同步执行。
 * 注意：仍然**不是沙箱**，只适合执行自己写的代码。
 */
export async function runScript(
  code: string,
  x: unknown,
  deps: ScriptRunnerDeps = {},
): Promise<ScriptRunResult> {
  const timeoutMs = deps.timeoutMs ?? 50;
  const factory = deps.createWorker ?? createDefaultWorker;
  const worker = acquireWorker(factory);
  if (!worker) return runInline(code, x, timeoutMs);

  const id = nextRunId++;
  return new Promise<ScriptRunResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingById.delete(id);
      resolve({ ok: false, value: null, error: `执行超时（${timeoutMs}ms），已终止`, timedOut: true });
      resetWorker(factory, `执行超时（${timeoutMs}ms），Worker 已重启`);
    }, timeoutMs);
    pendingById.set(id, { resolve, timer });
    worker.postMessage({ id, code, x });
  });
}

function createDefaultWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/** 无 Worker 时的退路：注入 __timeout() 守卫 + 前后墙钟检查，死循环拦不住但能防住常见失控。 */
function runInline(code: string, x: unknown, timeoutMs: number): ScriptRunResult {
  const deadline = Date.now() + timeoutMs;
  const guard = (): void => {
    if (Date.now() > deadline) throw new Error(`执行超时（${timeoutMs}ms）`);
  };
  try {
    const compiled = new Function('x', '__timeout', `"use strict";\n${code}`);
    const value: unknown = compiled(x, guard);
    guard();
    const normalized = normalizeResult(value);
    return normalized.ok
      ? { ok: true, value: normalized.value, error: null, timedOut: false }
      : { ok: false, value: null, error: normalized.error, timedOut: false };
  } catch (caught) {
    return {
      ok: false,
      value: null,
      error: caught instanceof Error ? caught.message : String(caught),
      timedOut: false,
    };
  }
}
