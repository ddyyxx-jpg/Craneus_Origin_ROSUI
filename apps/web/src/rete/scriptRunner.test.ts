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

/** 假 Worker：记录 postMessage；可手动按 runId 回消息，或一直不回（模拟死循环）。 */
function fakeWorker(): Worker & { posted: { id: number; code: string }[]; terminated: boolean } {
  const posted: { id: number; code: string }[] = [];
  const worker = {
    posted,
    terminated: false,
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(data: { id: number; code: string }) {
      posted.push(data);
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker as unknown as Worker & { posted: { id: number; code: string }[]; terminated: boolean };
}

function reply(worker: Worker, id: number, payload: { ok: boolean; value?: unknown; error?: string }): void {
  (worker.onmessage as ((event: MessageEvent<unknown>) => void) | null)?.(
    new MessageEvent('message', { data: { id, ...payload } }),
  );
}

describe('runScript（Worker 路径）', () => {
  it('worker 回传结果 → ok', async () => {
    const worker = fakeWorker();
    const pending = runScript('return x + 1;', 1, { createWorker: () => worker, timeoutMs: 200 });
    const id = worker.posted[0]!.id;
    reply(worker, id, { ok: true, value: 2 });
    await expect(pending).resolves.toMatchObject({ ok: true, value: 2, timedOut: false });
  });

  it('连续执行复用同一个 Worker（工厂只调用一次）', async () => {
    const worker = fakeWorker();
    const factory = () => worker;
    const first = runScript('return 1;', 0, { createWorker: factory, timeoutMs: 200 });
    reply(worker, worker.posted[0]!.id, { ok: true, value: 1 });
    await first;
    const second = runScript('return 2;', 0, { createWorker: factory, timeoutMs: 200 });
    expect(worker.posted).toHaveLength(2);
    reply(worker, worker.posted[1]!.id, { ok: true, value: 2 });
    await expect(second).resolves.toMatchObject({ ok: true, value: 2 });
    expect(worker.terminated).toBe(false);
  });

  it('worker 不回消息（死循环）→ 超时终止，下次执行重建 Worker', async () => {
    const workers: (Worker & { posted: { id: number }[]; terminated: boolean })[] = [];
    const factory = () => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker;
    };
    const outcome = await runScript('while (true) {}', 1, { createWorker: factory, timeoutMs: 20 });
    expect(outcome.timedOut).toBe(true);
    expect(workers[0]!.terminated).toBe(true);

    const next = runScript('return 7;', 0, { createWorker: factory, timeoutMs: 200 });
    expect(workers).toHaveLength(2); // 超时后旧 Worker 已废弃，新建一个
    const second = workers[1]!;
    reply(second, second.posted[0]!.id, { ok: true, value: 7 });
    await expect(next).resolves.toMatchObject({ ok: true, value: 7 });
  });
});
