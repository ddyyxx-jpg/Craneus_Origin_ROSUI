import { describe, expect, it } from 'vitest';
import { runScript } from './scriptRunner';

describe('runScript（无 Worker 时的同步退路）', () => {
  it('正常表达式返回结果', async () => {
    const outcome = await runScript('return x * 2;', 3, { createWorker: () => null });
    expect(outcome).toMatchObject({ ok: true, value: 6, error: null });
  });

  it('运行期抛错变成 error 文本，不向上抛', async () => {
    const outcome = await runScript('throw new Error("boom");', 1, { createWorker: () => null });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('boom');
  });

  it('结果不是有限数字/字符串时拒绝', async () => {
    const outcome = await runScript('return {a: 1};', 1, { createWorker: () => null });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('有限数字');
  });
});

/** 假 Worker：只记录 postMessage，可手动触发 onmessage 或让它一直不回（模拟死循环）。 */
function fakeWorker(): Worker & { posted: unknown[] } {
  const posted: unknown[] = [];
  const worker = {
    posted,
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(data: unknown) {
      posted.push(data);
    },
    terminate() {
      // noop
    },
  };
  return worker as unknown as Worker & { posted: unknown[] };
}

describe('runScript（Worker 路径）', () => {
  it('worker 回传结果 → ok', async () => {
    const worker = fakeWorker();
    const pending = runScript('return x + 1;', 1, { createWorker: () => worker, timeoutMs: 50 });
    worker.posted.length = 1;
    worker.onmessage?.(new MessageEvent('message', { data: { ok: true, value: 2 } }));
    await expect(pending).resolves.toMatchObject({ ok: true, value: 2, timedOut: false });
  });

  it('worker 不回消息（死循环）→ 超时终止', async () => {
    const worker = fakeWorker();
    const outcome = await runScript('while (true) {}', 1, {
      createWorker: () => worker,
      timeoutMs: 20,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('超时');
  });
});
