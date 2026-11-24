import { describe, expect, it, vi } from 'vitest';
import { RosClientImpl } from './RosClient';
import { parseParamEvent, parseRosapiValue } from './protocol';
import type { RosbridgeMessage, RosTransport, RosTransportFactory } from './types';

class FakeTransport implements RosTransport {
  readonly sent: RosbridgeMessage[] = [];
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  private open = true;
  closed = false;

  on(event: 'open' | 'close' | 'error', listener: (event: unknown) => void): RosTransport;
  on(event: 'message', listener: (message: RosbridgeMessage) => void): RosTransport;
  on(event: string, listener: ((event: unknown) => void) | ((message: RosbridgeMessage) => void)): RosTransport {
    const set = this.listeners.get(event) ?? new Set<(value: unknown) => void>();
    set.add(listener as (value: unknown) => void);
    this.listeners.set(event, set);
    return this;
  }

  send(message: RosbridgeMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
    this.open = false;
  }

  isOpen(): boolean {
    return this.open;
  }

  emit(event: string, value: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(value);
  }

  reply(id: string, values: Record<string, unknown>, result = true): void {
    this.emit('message', { op: 'service_response', id, values, result });
  }

  publish(topic: string, msg: unknown): void {
    this.emit('message', { op: 'publish', topic, msg });
  }

  lastCall(service: string): RosbridgeMessage {
    const call = this.sent.filter((m) => m.op === 'call_service' && m.service === service).at(-1);
    if (!call) throw new Error(`no call to ${service}`);
    return call;
  }
}

function setup() {
  const instances: FakeTransport[] = [];
  const factory: RosTransportFactory = async () => {
    const t = new FakeTransport();
    instances.push(t);
    return t;
  };
  const client = new RosClientImpl({ transportFactory: factory, reconnect: { initialMs: 5 } });
  return { client, instances, factory };
}

function paramEvent(node: string, list: 'new_parameters' | 'changed_parameters', name: string, value: number) {
  return {
    node,
    [list]: [{ name, value: { type: 3, double_value: value } }],
  };
}

describe('protocol helpers', () => {
  it('解析 rosapi/get_param 的 JSON 文本值', () => {
    expect(parseRosapiValue('3.5')).toBe(3.5);
    expect(parseRosapiValue('"normal"')).toBe('normal');
    expect(parseRosapiValue('true')).toBe(true);
    expect(parseRosapiValue('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('解析 ParameterEvent 的 new/changed 两个落点', () => {
    const evt = parseParamEvent({
      node: '/rosui_demo',
      new_parameters: [{ name: 'gain', value: { type: 3, double_value: 1.5 } }],
      changed_parameters: [{ name: 'enabled', value: { type: 1, bool_value: false } }],
      deleted_parameters: [],
    });
    expect(evt?.newParameters[0]?.value).toBe(1.5);
    expect(evt?.changedParameters[0]?.value).toBe(false);
  });
});

describe('RosClientImpl', () => {
  it('getParamNames 解析 names 数组', async () => {
    const { client, instances } = setup();
    await client.connect();
    const pending = client.getParamNames();
    const t = instances[0]!;
    t.reply(String(t.lastCall('/rosapi/get_param_names').id), {
      names: ['/rosui_demo:gain', '/rosui_demo:enabled'],
    });
    expect(await pending).toEqual(['/rosui_demo:gain', '/rosui_demo:enabled']);
    client.close();
  });

  it('getParam 成功与失败（reason 抛错）', async () => {
    const { client, instances } = setup();
    await client.connect();
    const t = instances[0]!;
    const ref = { node: '/rosui_demo', param: 'gain' };

    const ok = client.getParam(ref);
    expect(t.lastCall('/rosapi/get_param').args).toMatchObject({ name: '/rosui_demo:gain' });
    t.reply(String(t.lastCall('/rosapi/get_param').id), {
      value: '3.5',
      successful: true,
      reason: '',
    });
    expect(await ok).toEqual({ name: '/rosui_demo:gain', type: 'double', value: 3.5 });

    const bad = client.getParam(ref).catch((e: unknown) => e);
    t.reply(String(t.lastCall('/rosapi/get_param').id), {
      value: '""',
      successful: false,
      reason: 'Service /rosui_demo/get_parameters is not available',
    });
    await expect(await bad).toBeInstanceOf(Error);
    expect((await bad as Error).message).toContain('Service /rosui_demo/get_parameters is not available');
    client.close();
  });

  it('setParam 成功与拒绝（reason 透传，整数补 .0 保持 double）', async () => {
    const { client, instances } = setup();
    await client.connect();
    const t = instances[0]!;
    const ref = { node: '/rosui_demo', param: 'gain' };

    const ok = client.setParam(ref, 3.5);
    expect(t.lastCall('/rosapi/set_param').args).toMatchObject({ value: '3.5' });
    t.reply(String(t.lastCall('/rosapi/set_param').id), { successful: true, reason: '' });
    expect(await ok).toEqual({ successful: true });

    const intCall = client.setParam(ref, 42);
    expect(t.lastCall('/rosapi/set_param').args).toMatchObject({ value: '42.0' });
    t.reply(String(t.lastCall('/rosapi/set_param').id), { successful: true, reason: '' });
    await intCall;

    const bad = client.setParam(ref, 42.0);
    t.reply(String(t.lastCall('/rosapi/set_param').id), {
      successful: false,
      reason: 'gain 必须在 [0.0, 10.0]',
    });
    expect(await bad).toEqual({ successful: false, reason: 'gain 必须在 [0.0, 10.0]' });
    client.close();
  });

  it('parameter_events 的 new_parameters / changed_parameters 都推送给按 ref 过滤的订阅', async () => {
    const { client, instances } = setup();
    await client.connect();
    const t = instances[0]!;
    const gain: number[] = [];
    const all: string[] = [];
    const offGain = client.subscribeParam({ node: '/rosui_demo', param: 'gain' }, (v) => {
      gain.push(Number(v));
    });
    client.subscribeAllParamEvents((evt) => all.push(evt.node));

    t.publish('/parameter_events', paramEvent('/rosui_demo', 'new_parameters', 'gain', 2.5));
    t.publish('/parameter_events', paramEvent('/rosui_demo', 'changed_parameters', 'gain', 4.5));
    t.publish('/parameter_events', paramEvent('/other_node', 'changed_parameters', 'gain', 99));
    t.publish('/parameter_events', paramEvent('/rosui_demo', 'changed_parameters', 'mode', 1));

    expect(gain).toEqual([2.5, 4.5]);
    expect(all).toEqual(['/rosui_demo', '/rosui_demo', '/other_node', '/rosui_demo']);
    offGain();
    client.close();
  });

  it('断线后指数退避重连；重连成功重新拉参数；旧代际号的事件被丢弃', async () => {
    vi.useFakeTimers();
    try {
      const reconnected = vi.fn();
      const instances: FakeTransport[] = [];
      const factory: RosTransportFactory = async () => {
        const t = new FakeTransport();
        instances.push(t);
        return t;
      };
      const client = new RosClientImpl({
        transportFactory: factory,
        reconnect: { initialMs: 10, maxMs: 40, factor: 2 },
        onReconnected: reconnected,
      });
      const statuses: string[] = [];
      client.onStatus((s, detail) => statuses.push(`${s}:${detail ?? ''}`));

      await client.connect();
      const old = instances[0]!;
      const values: number[] = [];
      client.subscribeParam({ node: '/rosui_demo', param: 'gain' }, (v) => values.push(Number(v)));

      // 触发断线并重连。
      client.handleTransportClose(1);
      expect(client.status).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      const fresh = instances[1]!;
      expect(fresh).toBeDefined();
      expect(client.status).toBe('connected');
      const refreshCall = fresh.sent.find(
        (m) => m.op === 'call_service' && m.service === '/rosapi/get_param_names',
      );
      expect(refreshCall).toBeDefined();
      fresh.reply(String(refreshCall?.id), { names: ['/rosui_demo:gain'] });
      await vi.advanceTimersByTimeAsync(0);
      expect(reconnected).toHaveBeenCalledWith(['/rosui_demo:gain']);

      // 旧连接迟到的消息：不能进入 UI。
      old.publish('/parameter_events', paramEvent('/rosui_demo', 'new_parameters', 'gain', 999));
      expect(values).toEqual([]);

      // 新连接的消息正常进入 UI。
      fresh.publish('/parameter_events', paramEvent('/rosui_demo', 'changed_parameters', 'gain', 7));
      expect(values).toEqual([7]);
      expect(statuses).toContain('connected:reconnected');
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
