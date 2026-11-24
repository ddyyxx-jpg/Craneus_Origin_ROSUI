import { describe, expect, it } from 'vitest';
import {
  ECHO_SUPPRESSION_MS,
  INITIAL_EVENT_WINDOW_MS,
  ParamBindingController,
  type BoundControl,
} from './useParamBinding';
import type {
  ParamEventLike,
  ParamGetResult,
  ParamSetResult,
  ParamValue,
  RosClient,
  RosStatus,
} from '../ros';

type StatusCb = (status: RosStatus, detail?: string) => void;
type ParamCb = (value: ParamValue) => void;

function fakeControl(nodeType: string, portKey: string) {
  const values: Array<{ value: ParamValue; origin: string }> = [];
  const readonlyStates: boolean[] = [];
  const control: BoundControl = {
    nodeType,
    portKey,
    value: null,
    setValue(value, origin) {
      (control as { value: ParamValue }).value = value;
      values.push({ value, origin });
    },
    setReadonly(readonly) {
      readonlyStates.push(readonly);
    },
  };
  return { control, values, readonlyStates };
}

function fakeClient(initial: Partial<Record<string, ParamValue>> = {}) {
  const statusListeners = new Set<StatusCb>();
  const paramListeners = new Map<string, Set<ParamCb>>();
  const setCalls: Array<{ name: string; value: ParamValue }> = [];
  let status: RosStatus = 'idle';
  let setResult: ParamSetResult = { successful: true };
  const client: RosClient = {
    get status() {
      return status;
    },
    async connect() {
      status = 'connecting';
      statusListeners.forEach((cb) => cb(status));
      status = 'connected';
      statusListeners.forEach((cb) => cb(status));
    },
    close() {
      status = 'disconnected';
      statusListeners.forEach((cb) => cb(status));
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    async getParam(ref) {
      const name = `${ref.node}:${ref.param}`;
      return { name, type: 'double', value: initial[name] ?? 0 } satisfies ParamGetResult;
    },
    async setParam(ref, value) {
      setCalls.push({ name: `${ref.node}:${ref.param}`, value });
      return setResult;
    },
    subscribeParam(ref, cb) {
      const name = `${ref.node}:${ref.param}`;
      const set = paramListeners.get(name) ?? new Set<ParamCb>();
      set.add(cb);
      paramListeners.set(name, set);
      return () => set.delete(cb);
    },
    subscribeAllParamEvents(_cb: (evt: ParamEventLike) => void) {
      return () => undefined;
    },
    getParamNames: async () => [],
  };
  const emit = (name: string, value: ParamValue) => {
    paramListeners.get(name)?.forEach((cb) => cb(value));
  };
  const setStatus = (next: RosStatus) => {
    status = next;
    statusListeners.forEach((cb) => cb(next));
  };
  return {
    client,
    setCalls,
    emit,
    setStatus,
    setRejectResult(reason: string) {
      setResult = { successful: false, reason };
    },
    listenerCount(name: string) {
      return paramListeners.get(name)?.size ?? 0;
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ParamBindingController', () => {
  it('连接后拉初值写入控件（init），不回灌 setParam，并订阅参数', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 3.5 });
    const c = fakeControl('Gain', 'gain');
    const errors: string[] = [];
    const controller = new ParamBindingController({ client: f.client, onError: (e) => errors.push(e) });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    expect(c.values).toEqual([{ value: 3.5, origin: 'init' }]);
    expect(f.setCalls).toEqual([]);
    expect(f.listenerCount('/rosui_demo:gain')).toBe(1);
    expect(c.readonlyStates.at(-1)).toBe(false);
    expect(errors).toEqual([]);
    controller.dispose();
  });

  it('拉初值迟到：期间用户已改值，迟到的 getParam 不覆盖输入', async () => {
    const f = fakeClient();
    let release: ((value: number) => void) | undefined;
    f.client.getParam = () =>
      new Promise<ParamGetResult>((resolve) => {
        release = (value) => resolve({ name: '/rosui_demo:gain', type: 'double', value });
      });
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();

    controller.onControlChange('Gain', 'gain', 3.5);
    expect(f.setCalls).toEqual([{ name: '/rosui_demo:gain', value: 3.5 }]);

    release?.(1);
    await flush();
    // 初值 1 已过期：不能把用户刚敲的 3.5 覆盖回 1
    expect(c.values.some((v) => v.origin === 'init')).toBe(false);
    controller.dispose();
  });

  it('同 key 重注册先清理旧 entry，订阅不泄漏', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 1 });
    const a = fakeControl('Gain', 'gain');
    const b = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', a.control);
    await f.client.connect();
    await flush();
    controller.register('Gain', 'gain', b.control);
    await flush();
    expect(f.listenerCount('/rosui_demo:gain')).toBe(1);
    controller.dispose();
    expect(f.listenerCount('/rosui_demo:gain')).toBe(0);
  });

  it('未绑定控件不受连接状态影响，readonly 始终 false', async () => {
    const f = fakeClient();
    const c = fakeControl('Threshold', 'value');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Threshold', 'value', c.control);
    await f.client.connect();
    await flush();
    expect(c.readonlyStates).toEqual([false]);
    controller.dispose();
  });

  it('用户改值回灌 setParam；失败时回滚并报 reason', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 1 });
    const c = fakeControl('Gain', 'gain');
    const errors: string[] = [];
    const controller = new ParamBindingController({ client: f.client, onError: (e) => errors.push(e) });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    f.setRejectResult('gain 必须在 [0.0, 10.0]');
    controller.onControlChange('Gain', 'gain', 42);
    await flush();
    expect(f.setCalls).toEqual([{ name: '/rosui_demo:gain', value: 42 }]);
    expect(c.values.at(-1)).toEqual({ value: 1, origin: 'rollback' });
    expect(errors).toEqual(['gain 必须在 [0.0, 10.0]']);
    controller.dispose();
  });

  it('成功 setParam 后 2s 内同值事件被忽略，窗口外新值生效', async () => {
    let now = 1_000;
    const f = fakeClient({ '/rosui_demo:gain': 1 });
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({
      client: f.client,
      onError: () => undefined,
      now: () => now,
    });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    // 订阅后 300ms 首帧噪声丢弃
    f.emit('/rosui_demo:gain', 9);
    expect(c.values.at(-1)?.value).toBe(1);
    now += INITIAL_EVENT_WINDOW_MS;

    controller.onControlChange('Gain', 'gain', 3.5);
    await flush();
    f.emit('/rosui_demo:gain', 3.5);
    expect(c.values.at(-1)?.value).toBe(1); // 回声被抑制
    now += ECHO_SUPPRESSION_MS + 1;
    f.emit('/rosui_demo:gain', 6.25);
    expect(c.values.at(-1)).toEqual({ value: 6.25, origin: 'ros' });
    controller.dispose();
  });

  it('断线后停止下发并清理订阅（控件仍可编辑），重连重新拉初值', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 2 });
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    f.setStatus('disconnected');
    expect(c.readonlyStates.at(-1)).toBe(false);
    expect(f.listenerCount('/rosui_demo:gain')).toBe(0);
    f.setStatus('connected');
    await flush();
    expect(c.values.filter((v) => v.origin === 'init')).toHaveLength(2);
    expect(f.listenerCount('/rosui_demo:gain')).toBe(1);
    controller.dispose();
    expect(f.listenerCount('/rosui_demo:gain')).toBe(0);
  });

  it('dispose 后 timer / 订阅 / 状态监听全部释放', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 2 });
    const c = fakeControl('Gain', 'gain');
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const controller = new ParamBindingController({
      client: f.client,
      onError: () => undefined,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        const h = setTimeout(fn, ms);
        timers.add(h);
        return h;
      }) as typeof setTimeout,
      clearTimeoutFn: ((h: ReturnType<typeof setTimeout>) => {
        clearTimeout(h);
        timers.delete(h);
      }) as typeof clearTimeout,
    });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    controller.dispose();
    expect(timers.size).toBe(0);
    expect(f.listenerCount('/rosui_demo:gain')).toBe(0);
  });

  it('匹配类型检查拒绝错误类型事件', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 1 });
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    const before = c.values.length;
    f.emit('/rosui_demo:gain', 'oops');
    expect(c.values).toHaveLength(before);
    controller.dispose();
  });
});
