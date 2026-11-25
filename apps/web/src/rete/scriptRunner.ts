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
  /** 便于测试注入；默认用真实 Worker。 */
  createWorker?: () => Worker | null;
  timeoutMs?: number;
}

/**
 * 在 Worker 里执行用户脚本，超时就 terminate —— 这是 `while (true) {}` 唯一可靠的止血方式
 * （同步 `new Function` 在页面主线程里无法被中断）。
 * 环境不支持 Worker（如 jsdom/单测）时回退到带 `__timeout` 守卫的同步执行。
 * 注意：仍然**不是沙箱**，只适合执行自己写的代码。
 */
export async function runScript(
  code: string,
  x: unknown,
  deps: ScriptRunnerDeps = {},
): Promise<ScriptRunResult> {
  const timeoutMs = deps.timeoutMs ?? 50;
  const worker = deps.createWorker ? deps.createWorker() : createDefaultWorker();
  if (!worker) return runInline(code, x, timeoutMs);

  return new Promise<ScriptRunResult>((resolve) => {
    let settled = false;
    const finish = (result: ScriptRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          value: null,
          error: `执行超时（${timeoutMs}ms），已终止`,
          timedOut: true,
        }),
      timeoutMs,
    );
    worker.onmessage = (event: MessageEvent<{ ok: boolean; value?: unknown; error?: string }>) => {
      const payload = event.data;
      if (!payload.ok) {
        finish({ ok: false, value: null, error: payload.error ?? '执行失败', timedOut: false });
        return;
      }
      const normalized = normalizeResult(payload.value);
      finish(
        normalized.ok
          ? { ok: true, value: normalized.value, error: null, timedOut: false }
          : { ok: false, value: null, error: normalized.error, timedOut: false },
      );
    };
    worker.onerror = (event: ErrorEvent) => {
      finish({ ok: false, value: null, error: event.message || 'Worker 执行失败', timedOut: false });
    };
    worker.postMessage({ code, x, timeoutMs });
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
