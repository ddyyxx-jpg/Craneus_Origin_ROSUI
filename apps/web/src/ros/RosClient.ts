import {
  DEFAULT_URL,
  PARAM_EVENT_TOPIC,
  describeError,
  encodeParamValue,
  fullParamName,
  getDefaultTransportFactory,
  inferParamType,
  isRecord,
  makeCallMessage,
  makeSubscribeMessage,
  parseParamEvent,
  parseRosapiValue,
  asString,
} from './protocol';
import type {
  ParamBindingRef,
  ParamEventLike,
  ParamGetResult,
  ParamSetResult,
  ParamValue,
  RosClient,
  RosClientOptions,
  RosStatus,
  RosTransport,
  RosTransportFactory,
  RosbridgeMessage,
} from './types';

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ParamEventListener {
  ref?: ParamBindingRef;
  cb: (value: ParamValue) => void;
}

type AllEventsListener = (evt: ParamEventLike) => void;

function normalizeNode(node: string): string {
  return node.startsWith('/') ? node : `/${node}`;
}

function sameParam(ev: ParamEventLike, ref: ParamBindingRef): boolean {
  return normalizeNode(ev.node) === normalizeNode(ref.node);
}

/**
 * 直接说 rosbridge 协议的 RosClient。
 * 用「连接代际号」generation 丢弃过期连接的消息/回调；重连成功后会重新拉一次
 * getParamNames，并通过 onReconnected / onStatus('connected', 'reconnected') 通知上层。
 */
export class RosClientImpl implements RosClient {
  private readonly url: string;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly factor: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectedHook?: (names: string[]) => void;
  private readonly statusListeners = new Set<(s: RosStatus, detail?: string) => void>();
  private readonly allEventListeners = new Set<AllEventsListener>();
  private readonly paramListeners = new Set<ParamEventListener>();
  private readonly pendingCalls = new Map<string, PendingCall>();

  private factory: RosTransportFactory | undefined;
  private transport: RosTransport | undefined;
  private state: RosStatus = 'idle';
  private generation = 0;
  private seq = 0;
  private backoffMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private intentionalClose = false;

  constructor(options: RosClientOptions = {}) {
    this.url = options.url ?? DEFAULT_URL;
    const initial = options.reconnect?.initialMs ?? 500;
    this.initialMs = initial > 0 ? initial : 500;
    this.maxMs = options.reconnect?.maxMs ?? 10_000;
    this.factor = options.reconnect?.factor ?? 2;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.reconnectedHook = options.onReconnected;
    this.factory = options.transportFactory;
    this.backoffMs = this.initialMs;
  }

  get status(): RosStatus {
    return this.state;
  }

  onStatus(cb: (s: RosStatus, detail?: string) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private emitStatus(status: RosStatus, detail?: string): void {
    this.state = status;
    for (const cb of this.statusListeners) {
      try {
        cb(status, detail);
      } catch {
        // 上层回调异常不应打断连接层。
      }
    }
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    if (this.state === 'connected' && this.transport?.isOpen()) return;
    if (this.state === 'connecting') return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.openConnection(false);
  }

  close(): void {
    this.intentionalClose = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.generation += 1; // 丢弃旧连接的一切回调。
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('RosClient closed'));
      this.pendingCalls.delete(id);
    }
    const transport = this.transport;
    this.transport = undefined;
    try {
      transport?.close();
    } catch {
      // ignore
    }
    this.emitStatus('disconnected', 'closed');
  }

  private async openConnection(isReconnect: boolean): Promise<void> {
    const generation = ++this.generation;
    this.emitStatus('connecting', isReconnect ? 'reconnecting' : 'connecting');
    try {
      if (!this.factory) this.factory = await getDefaultTransportFactory();
      const factory = this.factory;
      const transport = await factory(this.url);
      if (generation !== this.generation) {
        transport.close();
        return;
      }
      await this.waitForOpen(transport, generation);
      if (generation !== this.generation) {
        transport.close();
        return;
      }
      this.transport = transport;
      this.backoffMs = this.initialMs;
      this.subscribeParamEvents(transport, generation);
      this.emitStatus('connected', isReconnect ? 'reconnected' : 'connected');

      if (isReconnect) {
        try {
          const names = await this.requestParamNames();
          if (generation !== this.generation) return;
          this.reconnectedHook?.(names);
        } catch (err) {
          if (generation === this.generation) {
            this.emitStatus('error', `重新拉取参数列表失败: ${describeError(err)}`);
          }
        }
      }
    } catch (err) {
      if (generation !== this.generation) return;
      this.emitStatus('error', describeError(err));
      this.scheduleReconnect(generation);
    }
  }

  private waitForOpen(transport: RosTransport, generation: number): Promise<void> {
    if (transport.isOpen()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`连接 ${this.url} 超时 (${this.connectTimeoutMs}ms)`));
      }, this.connectTimeoutMs);
      const onOpen = (): void => resolve();
      const onError = (event: unknown): void => {
        reject(new Error(`连接 ${this.url} 失败: ${describeError(event)}`));
      };
      transport.on('open', onOpen);
      transport.on('error', onError);
      // 过期 listener 由 generation 守卫拦截；这里只忽略 resolved 后的重复事件。
      void generation;
    });
  }

  private scheduleReconnect(failedGeneration: number): void {
    if (this.intentionalClose || failedGeneration !== this.generation || this.retryTimer) return;
    this.emitStatus('disconnected', 'connection lost, retrying');
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.maxMs, Math.max(this.initialMs, delay * this.factor));
    const generationAtSchedule = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.intentionalClose || generationAtSchedule !== this.generation) return;
      void this.openConnection(true);
    }, delay);
  }

  private subscribeParamEvents(transport: RosTransport, generation: number): void {
    const id = `rosclient_param_events_${generation}_${++this.seq}`;
    transport.send(makeSubscribeMessage(id));
    transport.on('message', (message) => {
      // 代际号守卫：旧连接的缓存消息绝不能写进当前 UI。
      if (generation !== this.generation) return;
      this.handleMessage(message);
    });
  }

  private handleMessage(message: RosbridgeMessage): void {
    if (message.op === 'service_response') {
      const id = asString(message.id);
      if (id === undefined) return;
      const pending = this.pendingCalls.get(id);
      if (!pending) return;
      this.pendingCalls.delete(id);
      clearTimeout(pending.timer);
      if (message.result === true) {
        pending.resolve(isRecord(message.values) ? message.values : {});
      } else {
        const values = message.values;
        const reason =
          asString(values) ??
          (isRecord(values) ? asString(values.reason) : undefined) ??
          'rosbridge service call failed';
        pending.reject(new Error(reason));
      }
      return;
    }
    if (message.op !== 'publish' || asString(message.topic) !== PARAM_EVENT_TOPIC) return;
    const evt = parseParamEvent(message.msg);
    if (!evt) return;
    for (const cb of this.allEventListeners) {
      try {
        cb(evt);
      } catch {
        // ignore listener errors
      }
    }
    const params = [...evt.newParameters, ...evt.changedParameters];
    for (const param of params) {
      for (const listener of this.paramListeners) {
        if (listener.ref && (!sameParam(evt, listener.ref) || param.name !== listener.ref.param)) {
          continue;
        }
        try {
          listener.cb(param.value);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  private callService(
    service: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const generation = this.generation;
    const transport = this.transport;
    if (!transport || !transport.isOpen()) {
      return Promise.reject(new Error('RosClient 未连接'));
    }
    const id = `rosclient_call_${generation}_${++this.seq}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`调用 ${service} 超时`));
      }, this.connectTimeoutMs);
      this.pendingCalls.set(id, { resolve, reject, timer });
      try {
        transport.send(makeCallMessage(service, args, id, this.connectTimeoutMs / 1000));
      } catch (err) {
        this.pendingCalls.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async requestParamNames(): Promise<string[]> {
    const response = await this.callService('/rosapi/get_param_names', {});
    const names = response.names;
    if (!Array.isArray(names) || !names.every((v) => typeof v === 'string')) {
      throw new Error('/rosapi/get_param_names 返回格式错误');
    }
    return names as string[];
  }

  async getParamNames(): Promise<string[]> {
    return this.requestParamNames();
  }

  async getParam(ref: ParamBindingRef): Promise<ParamGetResult> {
    const name = fullParamName(ref.node, ref.param);
    const response = await this.callService('/rosapi/get_param', { name, default_value: '' });
    if (response.successful !== true) {
      const reason = asString(response.reason) ?? '未知错误';
      throw new Error(`读取参数 ${name} 失败: ${reason}`);
    }
    const raw = asString(response.value);
    if (raw === undefined) throw new Error(`参数 ${name} 返回值格式错误`);
    const value = parseRosapiValue(raw);
    return { name, type: inferParamType(value), value };
  }

  async setParam(ref: ParamBindingRef, value: ParamValue): Promise<ParamSetResult> {
    const name = fullParamName(ref.node, ref.param);
    const response = await this.callService('/rosapi/set_param', {
      name,
      value: encodeParamValue(value),
    });
    if (response.successful === true) return { successful: true };
    return {
      successful: false,
      reason: asString(response.reason) ?? '未知错误',
    };
  }

  subscribeParam(ref: ParamBindingRef, cb: (value: ParamValue) => void): () => void {
    const listener: ParamEventListener = { ref: { ...ref }, cb };
    this.paramListeners.add(listener);
    return () => this.paramListeners.delete(listener);
  }

  subscribeAllParamEvents(cb: (evt: ParamEventLike) => void): () => void {
    this.allEventListeners.add(cb);
    return () => this.allEventListeners.delete(cb);
  }

  /** 测试用：模拟 transport 断线，走标准重连路径（生成新代际号）。 */
  handleTransportClose(generation: number): void {
    if (generation !== this.generation) return;
    this.transport = undefined;
    this.scheduleReconnect(generation);
  }
}
