import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ECHO_SUPPRESSION_MS,
  INITIAL_EVENT_WINDOW_MS,
  RECONCILE_INTERVAL_MS,
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

/** getParam 初值/补拉守卫：用可控 getParam + 注入时钟覆盖两种迟到顺序，不依赖 wall clock。 */
function fakeDeferredClient(initial: ParamValue) {
  const base = fakeClient();
  const name = '/rosui_demo:gain';
  const requests: Array<(value: ParamValue) => void> = [];
  const result: ParamGetResult = { name, type: 'double', value: initial };
  let queueGetParam = false;
  base.client.getParam = () => {
    if (!queueGetParam) return Promise.resolve(result);
    return new Promise<ParamGetResult>((resolve) => {
      requests.push((value) => resolve({ ...result, value }));
    });
  };
  return {
    ...base,
    requests,
    getParamCalls: () => requests.length,
    deferGetParam() {
      queueGetParam = true;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it('同类型多节点带 instanceId 各自订阅，不互相顶掉', async () => {
    const f = fakeClient({ '/rosui_demo:pose': [0, 0, 0, 0, 0, 0, 1] });
    const a = fakeControl('Pose', 'pose');
    const b = fakeControl('Pose', 'pose');
    const errors: string[] = [];
    const controller = new ParamBindingController({
      client: f.client,
      onError: (reason) => errors.push(reason),
    });
    controller.register('Pose', 'pose', a.control, 'node-a');
    controller.register('Pose', 'pose', b.control, 'node-b');
    await f.client.connect();
    await flush();
    expect(f.listenerCount('/rosui_demo:pose')).toBe(2);

    controller.onControlChange('Pose', 'pose', [1, 2, 3, 0, 0, 0, 1], 'node-b');
    await flush();
    expect(f.setCalls).toContainEqual({
      name: '/rosui_demo:pose',
      value: [1, 2, 3, 0, 0, 0, 1],
    });
    controller.dispose();
    expect(f.listenerCount('/rosui_demo:pose')).toBe(0);
  });

  it('重复 bind 同一端口不重复订阅（旧 entry 先 dispose）', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 1, '/rosui_demo:mode': 'normal' });
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', c.control, 'n1');
    await f.client.connect();
    await flush();
    controller.bind('Gain', 'gain', { node: '/rosui_demo', param: 'mode' }, 'string', 'n1');
    controller.bind('Gain', 'gain', { node: '/rosui_demo', param: 'mode' }, 'string', 'n1');
    await flush();
    expect(f.listenerCount('/rosui_demo:gain')).toBe(0);
    expect(f.listenerCount('/rosui_demo:mode')).toBe(1);
    controller.dispose();
    expect(f.listenerCount('/rosui_demo:mode')).toBe(0);
  });

  it('两个节点绑同一参数：各自订阅，外部改值两边都更新', async () => {
    const f = fakeClient({ '/rosui_demo:gain': 1 });
    const a = fakeControl('Gain', 'gain');
    const b = fakeControl('Threshold', 'value');
    let now = 0;
    const controller = new ParamBindingController({
      client: f.client,
      onError: () => undefined,
      now: () => now,
    });
    controller.register('Gain', 'gain', a.control, 'n1');
    controller.register('Threshold', 'value', b.control, 'n2');
    controller.bind('Gain', 'gain', { node: '/rosui_demo', param: 'gain' }, 'double', 'n1');
    controller.bind('Threshold', 'value', { node: '/rosui_demo', param: 'gain' }, 'double', 'n2');
    await f.client.connect();
    await flush();
    expect(f.listenerCount('/rosui_demo:gain')).toBe(2);

    now += INITIAL_EVENT_WINDOW_MS + 1; // 越过首帧丢弃窗口
    f.emit('/rosui_demo:gain', 4.25);
    await flush();
    expect(a.values.some((v) => v.value === 4.25)).toBe(true);
    expect(b.values.some((v) => v.value === 4.25)).toBe(true);
    controller.dispose();
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
    expect(errors).toEqual(['写入被拒：Gain.gain gain 必须在 [0.0, 10.0]']);
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

describe('getParam 初值守卫（activate / refresh / warmup）', () => {
  it('用户写入后才发 activate：迟到初值不能覆盖用户值', async () => {
    const f = fakeDeferredClient(1);
    f.deferGetParam();
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    expect(f.getParamCalls()).toBe(1);

    controller.onControlChange('Gain', 'gain', 9);
    await flush();
    f.requests[0]?.(1);
    await flush();

    expect(c.values.some((v) => v.origin === 'init')).toBe(false);
    expect(c.values).toEqual([]);
    expect(f.setCalls).toEqual([{ name: '/rosui_demo:gain', value: 9 }]);
    controller.dispose();
  });

  it('激活请求已发、用户写入、补拉迟到：refreshOnce 不覆盖用户值', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const f = fakeDeferredClient(1);
    f.deferGetParam();
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({
      client: f.client,
      onError: () => undefined,
      now: () => now,
    });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    f.requests[0]?.(1);
    await flush();
    expect(c.values.at(-1)).toEqual({ value: 1, origin: 'init' });

    controller.onControlChange('Gain', 'gain', 9);
    await flush();
    // 300ms 首帧窗口结束后触发 refreshOnce（请求前 LKG=1，写已成功 LKG=9）。
    now += INITIAL_EVENT_WINDOW_MS;
    await vi.advanceTimersByTimeAsync(INITIAL_EVENT_WINDOW_MS);
    await flush();
    expect(f.getParamCalls()).toBe(2);

    f.requests[1]?.(1);
    await flush();
    expect(c.values.at(-1)).toEqual({ value: 1, origin: 'init' });
    expect(c.values.some((v) => v.value === 9)).toBe(false);
    controller.dispose();
  });

  it('首帧窗口 warmup 补拉迟到：用户写入后不覆盖用户值', async () => {
    vi.useFakeTimers();
    const f = fakeDeferredClient(1);
    f.deferGetParam();
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();
    f.requests[0]?.(1);
    await flush();

    // 首帧窗口内收到外部事件，触发 warmup getParam。
    f.emit('/rosui_demo:gain', 7);
    await flush();
    expect(f.getParamCalls()).toBe(2);
    controller.onControlChange('Gain', 'gain', 9);
    await flush();

    f.requests[1]?.(1);
    await flush();
    expect(c.values.at(-1)).toEqual({ value: 1, origin: 'init' });
    expect(c.values.some((v) => v.value === 9)).toBe(false);
    controller.dispose();
  });

  it('stale activate 不建订阅：旧初值回声不能覆盖用户写入', async () => {
    vi.useFakeTimers();
    const f = fakeDeferredClient(1);
    f.deferGetParam();
    const c = fakeControl('Gain', 'gain');
    const controller = new ParamBindingController({ client: f.client, onError: () => undefined });
    controller.register('Gain', 'gain', c.control);
    await f.client.connect();
    await flush();

    controller.onControlChange('Gain', 'gain', 9);
    await flush();
    // 用户写成功后迟到的旧初值判定 stale，本次 activation 直接结束。
    f.requests[0]?.(1);
    await flush();
    expect(c.values).toEqual([]);
    expect(f.setCalls).toEqual([{ name: '/rosui_demo:gain', value: 9 }]);
    expect(f.listenerCount('/rosui_demo:gain')).toBe(0);

    // stale activation 不能再开 warmup 窗口：后续 emit 旧值也不会覆盖用户值。
    f.emit('/rosui_demo:gain', 1);
    await vi.advanceTimersByTimeAsync(INITIAL_EVENT_WINDOW_MS + RECONCILE_INTERVAL_MS);
    await flush();
    expect(c.values).toEqual([]);
    expect(f.setCalls).toEqual([{ name: '/rosui_demo:gain', value: 9 }]);
    controller.dispose();
  });
});
