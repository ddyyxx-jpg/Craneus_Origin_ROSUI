import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bindingForInstance,
  clearRuntimeBinding,
  matchesBindingType,
  setRuntimeBinding,
  type BindingValueType,
  type ParamBindingDefinition,
} from './bindings';
import { formatFailure } from '../toast';
import { RosClientImpl, getSharedClient, type RosClient } from '../ros';
import type {
  ParamBindingRef,
  ParamValue,
  RosStatus,
} from '../ros';

export const INITIAL_EVENT_WINDOW_MS = 300;
export const ECHO_SUPPRESSION_MS = 2_000;
/** 兜底对账周期：rosbridge 的 /parameter_events 没有投递保证，丢一条事件就永远不同步。 */
export const RECONCILE_INTERVAL_MS = 5_000;

/** 控件写来源，决定一次 setValue 是否应回灌 ROS。 */
export type WriteOrigin = 'user' | 'ros' | 'init' | 'rollback';

export interface BoundControl {
  /** 画布节点类型，例如 Gain。 */
  readonly nodeType: string;
  /** 端口键，例如 gain。 */
  readonly portKey: string;
  /** 控件当前值，作为 lastKnownGood 的初始种子（可选）。 */
  readonly value?: ParamValue;
  /** 设置控件显示值；origin 标明来源，控制器据此决定是否回灌 setParam。 */
  setValue(value: ParamValue, origin: WriteOrigin): void;
  /** 只读态切换。控制器在断线 / 未绑定初始化失败时置 readonly。 */
  setReadonly(readonly: boolean): void;
}

/** 注入 client 的构造参数，便于单测用假 client 驱动全部逻辑。 */
export interface ParamBindingControllerOptions {
  client: RosClient;
  /** 状态变化通知（连接层 + 绑定层）。 */
  onStatus?: (status: RosStatus, detail?: string) => void;
  /** 展示 setParam 失败的 reason。 */
  onError: (reason: string) => void;
  /** 可注入时钟，单测用假时间驱动 300ms / 2s 窗口。 */
  now?: () => number;
  /** 可注入 timer，单测用假 timer 检查清理。 */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface Entry {
  readonly key: string;
  readonly control: BoundControl;
  readonly definition: ParamBindingDefinition;
  /** 最后一次已知正确值（初值 / 成功的 ROS 值 / 用户合法输入）。 */
  lastKnownGood: ParamValue;
  /** 首次订阅建立后丢弃该参数的事件，避免首帧噪声。 */
  warmupUntil: number;
  /** setParam 成功后短时间内忽略同值事件（回声抑制）。 */
  echoUntil: number;
  unsubscribe?: () => void;
  active: boolean;
  /** activate 代际号：丢弃迟到的 getParam 结果（例如 connect 期间用户已改值 / 又断连）。 */
  activateToken: number;
  /** 用户改值序号：只让最新一次 setParam 的结果决定回滚或确认。 */
  writeSeq: number;
  /** 初值 getParam 失败的重试次数（rosapi 忙时不该永久锁死控件）。 */
  retries: number;
  /** 首帧窗口内收到事件时，是否已经在补拉权威值（避免并发重复拉）。 */
  warmupRefresh: boolean;
}

/** 绑定表按「节点类型:端口」查找；运行期 entry 再按节点实例区分，避免同类型多节点互相顶掉。 */
function entryKey(nodeType: string, portKey: string, instanceId?: string): string {
  const base = `${nodeType}:${portKey}`;
  return instanceId ? `${base}@${instanceId}` : base;
}

/**
 * 不依赖 React 的绑定控制器：管理连接、初值拉取、事件订阅、回声抑制、回滚与清理。
 * 所有外部能力（client / 时钟 / timer / 回调）均通过构造函数注入，可独立单测。
 */
export class ParamBindingController {
  private readonly client: RosClient;
  private readonly onStatus: (status: RosStatus, detail?: string) => void;
  private readonly onError: (reason: string) => void;
  private readonly now: () => number;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly entries = new Map<string, Entry>();
  /** 所有已注册控件（含未绑定端口），供运行时 bind/unbind 即时建/拆订阅。 */
  private readonly controls = new Map<string, BoundControl>();
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly statusUnsubscribe: () => void;
  private disposed = false;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private connecting: Promise<void> | undefined;
  private currentStatus: RosStatus;

  constructor(options: ParamBindingControllerOptions) {
    this.client = options.client;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.currentStatus = this.client.status;
    this.statusUnsubscribe = this.client.onStatus((status, detail) => {
      this.currentStatus = status;
      this.applyStatus(status);
      this.onStatus(status, detail);
    });
    this.applyStatus(this.currentStatus);
  }

  /** 注册画布控件；未绑定的控件保持可编辑且不受连接状态影响。
   *  instanceId（节点 id）让同类型多个节点各自独立订阅，互不顶掉。 */
  register(
    nodeType: string,
    portKey: string,
    control: BoundControl,
    instanceId?: string,
    ref?: ParamBindingRef,
    valueType?: BindingValueType,
  ): () => void {
    const key = entryKey(nodeType, portKey, instanceId);
    this.controls.set(key, control);
    const definition = ref
      ? { ref, valueType: valueType ?? 'double' }
      : bindingForInstance(nodeType, portKey, instanceId);
    if (!definition) {
      control.setReadonly(false);
      return () => {
        if (this.controls.get(key) === control) this.controls.delete(key);
      };
    }
    // 同 key 重注册（React 重渲染 / StrictMode 双挂载）时先清掉旧 entry，否则旧订阅泄漏。
    const previous = this.entries.get(key);
    if (previous) this.disposeEntry(previous);

    const entry: Entry = {
      key,
      control,
      definition,
      lastKnownGood: controlLastValue(control),
      warmupUntil: 0,
      echoUntil: 0,
      active: false,
      activateToken: 0,
      writeSeq: 0,
      retries: 0,
      warmupRefresh: false,
    };
    this.entries.set(key, entry);
    // 离线也可编辑：未连接时改动只留在 IR 里，不发 ROS，避免「设计态被锁死」。
    control.setReadonly(false);

    if (this.currentStatus === 'connected') void this.activateEntry(entry);

    return () => {
      if (this.controls.get(key) === control) this.controls.delete(key);
      if (this.entries.get(key) !== entry) return;
      this.disposeEntry(entry);
      this.entries.delete(key);
    };
  }

  /** 控件用户改值：合法值回灌 ROS；未连接时忽略。 */
  onControlChange(
    nodeType: string,
    portKey: string,
    value: ParamValue,
    instanceId?: string,
  ): void {
    const entry = this.entries.get(entryKey(nodeType, portKey, instanceId));
    // 只看「是否已绑定 + 是否连上」：activateEntry 拉初值期间（active 短暂为 false）用户改值也要下发，
    // 否则刚 bind 就输入会静默丢失（UI 改了、ROS 没变）。
    if (!entry || this.currentStatus !== 'connected') return;
    if (!matchesBindingType(value, entry.definition.valueType)) {
      entry.control.setValue(entry.lastKnownGood, 'rollback');
      this.onError(formatFailure({ kind: 'type', param: `${nodeType}.${portKey}`, reason: '的值类型不匹配' }));
      return;
    }
    if (sameValue(value, entry.lastKnownGood)) return;

    const writeSeq = ++entry.writeSeq;
    const ref = entry.definition.ref;
    void this.client.setParam(ref, value).then(
      (result) => {
        if (this.disposed || this.entries.get(entry.key) !== entry) return;
        // 期间用户又改了值：旧结果已过期，交给最新那次处理。
        if (entry.writeSeq !== writeSeq) return;
        if (result.successful) {
          entry.lastKnownGood = value;
          // 成功写后 2 秒内忽略同值事件（echo suppression）。
          entry.echoUntil = this.now() + ECHO_SUPPRESSION_MS;
          return;
        }
        entry.control.setValue(entry.lastKnownGood, 'rollback');
        this.onError(
          formatFailure({
            kind: 'write',
            param: `${nodeType}.${portKey}`,
            reason: result.reason ?? '服务端未给出原因',
          }),
        );
      },
      (error: unknown) => {
        if (this.disposed || this.entries.get(entry.key) !== entry) return;
        if (entry.writeSeq !== writeSeq) return;
        entry.control.setValue(entry.lastKnownGood, 'rollback');
        this.onError(
          formatFailure({
            kind: 'write',
            param: `${nodeType}.${portKey}`,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    );
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.client.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  disconnect(): void {
    this.client.close();
  }

  /** M4 A：把已注册控件切换到新的运行时绑定，立即拉新参数初值。 */
  bind(
    nodeType: string,
    portKey: string,
    ref: ParamBindingRef,
    valueType: BindingValueType,
    instanceId?: string,
  ): boolean {
    const key = entryKey(nodeType, portKey, instanceId);
    const control = this.controls.get(key);
    // 端口没注册进绑定层时不能假成功：否则 IR 显示已绑、UI 显示「解绑」，实际没有任何订阅。
    if (!control) return false;
    setRuntimeBinding(nodeType, portKey, { ref, valueType }, instanceId);
    const existing = this.entries.get(key);
    if (existing) this.disposeEntry(existing);
    const replacement: Entry = {
      key,
      control,
      definition: { ref, valueType },
      lastKnownGood: controlLastValue(control),
      warmupUntil: 0,
      echoUntil: 0,
      active: false,
      activateToken: 0,
      writeSeq: 0,
      retries: 0,
      warmupRefresh: false,
    };
    this.entries.set(key, replacement);
    replacement.control.setReadonly(false);
    if (this.currentStatus === 'connected') void this.activateEntry(replacement);
    return true;
  }

  /** M4 A：解除绑定，控件回到本地值，不再下发；同时清掉运行期绑定记录。 */
  unbind(nodeType: string, portKey: string, instanceId?: string): void {
    clearRuntimeBinding(nodeType, portKey, instanceId);
    const key = entryKey(nodeType, portKey, instanceId);
    const existing = this.entries.get(key);
    if (!existing) return;
    this.disposeEntry(existing);
    this.entries.delete(key);
    existing.control.setReadonly(false);
  }

  /** 周期性对账：把每个已绑定端口的权威值拉一次，弥补丢事件。 */
  private startReconcile(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      for (const entry of this.entries.values()) {
        if (entry.active) void this.refreshOnce(entry, entry.activateToken);
      }
    }, RECONCILE_INTERVAL_MS);
  }

  private stopReconcile(): void {
    if (!this.reconcileTimer) return;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  /** 完整清理：连接状态订阅、参数订阅、所有 timer。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopReconcile();
    this.statusUnsubscribe();
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    for (const timer of this.pendingTimers) this.clearTimeoutFn(timer);
    this.pendingTimers.clear();
  }

  /**
   * 所有 getParam 回调共用的过期判定：请求发出后用户又写过、权威值已变更，
   * 或仍在写后回声抑制窗口且返回值与当前值不同，都不能写回控件。
   */
  private isStaleGetParamResult(
    entry: Entry,
    writeSeqAtRequest: number,
    lastKnownGoodAtRequest: ParamValue,
    resultValue: ParamValue,
  ): boolean {
    if (entry.writeSeq !== writeSeqAtRequest) return true;
    if (!sameValue(entry.lastKnownGood, lastKnownGoodAtRequest)) return true;
    return this.now() < entry.echoUntil && !sameValue(resultValue, entry.lastKnownGood);
  }

  private applyStatus(status: RosStatus): void {
    const connected = status === 'connected';
    if (connected) this.startReconcile();
    else this.stopReconcile();
    for (const entry of this.entries.values()) {
      // 断线不锁死控件：停止下发（deactivateEntry）比禁止编辑更不容易误导用户。
      if (connected) {
        entry.control.setReadonly(false);
        void this.activateEntry(entry);
      } else {
        this.deactivateEntry(entry);
      }
    }
  }

  private activateEntry(entry: Entry): void {
    if (entry.active) return;
    // 标记 active 防止 getParam 微任务未完成时重复拉取。
    entry.active = true;
    const token = ++entry.activateToken;
    const writeSeqAtRequest = entry.writeSeq;
    const lastKnownGoodAtRequest = entry.lastKnownGood;
    const ref = entry.definition.ref;
    // activation 成功且结果不过期时才建订阅/warmup：stale 时退出本次 activation，
    // 否则迟到的 getParam 回声会借新开的 warmup 窗口覆盖用户值。
    void this.client.getParam(ref).then(
      (result) => {
        if (this.disposed || this.entries.get(entry.key) !== entry) return;
        if (entry.activateToken !== token || !entry.active) return;
        // 拉初值期间用户已经改过值：用户输入优先，别被迟到的 getParam 覆盖。
        if (
          this.isStaleGetParamResult(entry, writeSeqAtRequest, lastKnownGoodAtRequest, result.value)
        ) {
          entry.active = false;
          return;
        }
        if (!matchesBindingType(result.value, entry.definition.valueType)) {
          entry.control.setReadonly(true);
          entry.active = false;
          return;
        }
        // init 来源：只更新控件，不触发 setParam 回灌。
        entry.lastKnownGood = result.value;
        entry.control.setValue(result.value, 'init');
        entry.control.setReadonly(false);
        this.armInitialSubscription(entry, token, ref);
      },
      () => {
        if (this.disposed || this.entries.get(entry.key) !== entry) return;
        // rosapi 忙/瞬断时 getParam 会失败：重试而不是把控件永久锁死。
        if (entry.retries >= 3) {
          entry.control.setReadonly(true);
          entry.active = false;
          return;
        }
        entry.retries += 1;
        entry.active = false;
        const retryDelay = 800 * entry.retries;
        const handle = setTimeout(() => {
          this.pendingTimers.delete(handle);
          if (this.disposed || this.entries.get(entry.key) !== entry) return;
          if (this.currentStatus !== 'connected') return;
          void this.activateEntry(entry);
        }, retryDelay);
        this.pendingTimers.add(handle);
      },
    );
  }

  /** activation 结果有效时建立首帧订阅与一次性补拉；stale/failed 激活不调用。 */
  private armInitialSubscription(
    entry: Entry,
    token: number,
    ref: ParamBindingRef,
  ): void {
    if (this.disposed || this.entries.get(entry.key) !== entry) return;
    if (entry.activateToken !== token || !entry.active) return;
    // 订阅在初值拉取完成后建立，首帧 300ms 窗口从此时开始。
    entry.warmupUntil = this.now() + INITIAL_EVENT_WINDOW_MS;
    entry.unsubscribe = this.client.subscribeParam(ref, (value) => this.onParamEvent(entry, value));
    // 订阅建立前发生的外部改值不会补发事件（例如刚连上就被 ros2 param set）。
    // 窗口结束后补拉一次权威值，保证 UI 最终收敛。
    const handle = setTimeout(() => {
      this.pendingTimers.delete(handle);
      void this.refreshOnce(entry, token);
    }, INITIAL_EVENT_WINDOW_MS);
    this.pendingTimers.add(handle);
  }

  /** 窗口结束后补拉一次权威值：只在与 lastKnownGood 不同时更新，避免把刚写进去的值又冲掉。 */
  private async refreshOnce(entry: Entry, token: number): Promise<void> {
    const writeSeqAtRequest = entry.writeSeq;
    const lastKnownGoodAtRequest = entry.lastKnownGood;
    const result = await this.client.getParam(entry.definition.ref).catch(() => null);
    if (!result) return;
    if (this.disposed || this.entries.get(entry.key) !== entry) return;
    if (entry.activateToken !== token || !entry.active) return;
    if (
      this.isStaleGetParamResult(entry, writeSeqAtRequest, lastKnownGoodAtRequest, result.value)
    ) {
      return;
    }
    if (!matchesBindingType(result.value, entry.definition.valueType)) return;
    if (sameValue(result.value, entry.lastKnownGood)) return;
    entry.lastKnownGood = result.value;
    entry.control.setValue(result.value, 'ros');
    entry.control.setReadonly(false);
  }

  private deactivateEntry(entry: Entry): void {
    entry.active = false;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    // 不置 readonly：离线仍可编辑，避免「ROS 没起就什么都改不了」。
  }

  private onParamEvent(entry: Entry, value: ParamValue): void {
    if (this.disposed || this.entries.get(entry.key) !== entry || !entry.active) return;
    if (!matchesBindingType(value, entry.definition.valueType)) return;
    const now = this.now();
    if (now < entry.warmupUntil) {
      // 首帧窗口内的事件可能是订阅前的旧值，不直接采信；改为问一次权威值，
      // 否则「刚连上就被外部改值」的事件会被窗口吞掉，UI 永远停在初值。
      if (entry.warmupRefresh) return;
      entry.warmupRefresh = true;
      const writeSeqAtRequest = entry.writeSeq;
      const lastKnownGoodAtRequest = entry.lastKnownGood;
      void this.client.getParam(entry.definition.ref).then(
        (result) => {
          entry.warmupRefresh = false;
          if (this.disposed || this.entries.get(entry.key) !== entry || !entry.active) return;
          if (
            this.isStaleGetParamResult(
              entry,
              writeSeqAtRequest,
              lastKnownGoodAtRequest,
              result.value,
            )
          ) {
            return;
          }
          if (!matchesBindingType(result.value, entry.definition.valueType)) return;
          if (sameValue(result.value, entry.lastKnownGood)) return;
          entry.lastKnownGood = result.value;
          entry.control.setValue(result.value, 'ros');
        },
        () => {
          entry.warmupRefresh = false;
        },
      );
      return;
    }
    if (now < entry.echoUntil && sameValue(value, entry.lastKnownGood)) return; // 成功写后 2s 内同值回声
    if (sameValue(value, entry.lastKnownGood)) return; // 与当前值相同忽略
    entry.lastKnownGood = value;
    entry.control.setValue(value, 'ros');
    entry.control.setReadonly(false);
  }

  private disposeEntry(entry: Entry): void {
    entry.active = false;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    entry.control.setReadonly(true);
  }
}

/** 用反射读取控件当前值作为 lastKnownGood 的初始种子；不支持时留空。 */
function controlLastValue(control: BoundControl): ParamValue {
  const candidate = (control as BoundControl & { value?: unknown }).value;
  if (
    candidate === null ||
    typeof candidate === 'string' ||
    typeof candidate === 'number' ||
    typeof candidate === 'boolean' ||
    (Array.isArray(candidate) && candidate.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
  ) {
    return candidate as ParamValue;
  }
  return null;
}

function sameValue(a: ParamValue, b: ParamValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return false;
}

/** React 包装：把连接状态 / toast 暴露给 UI，client 通过参数注入便于替换。 */
export interface UseParamBindingResult {
  status: RosStatus;
  statusDetail: string;
  toast: string;
  connect(url: string): Promise<void>;
  disconnect(): void;
  register(
    nodeType: string,
    portKey: string,
    control: BoundControl,
    instanceId?: string,
    ref?: ParamBindingRef,
    valueType?: BindingValueType,
  ): () => void;
  bind(
    nodeType: string,
    portKey: string,
    ref: ParamBindingRef,
    valueType: BindingValueType,
    instanceId?: string,
  ): boolean;
  unbind(nodeType: string, portKey: string, instanceId?: string): void;
  onControlChange(
    nodeType: string,
    portKey: string,
    value: ParamValue,
    instanceId?: string,
  ): void;
  /** T-032：静默恢复 undo/redo/粘贴时清掉仍挂着的 ROS 写入/绑定错误提示。 */
  dismissToast(): void;
}

export function useParamBinding(client?: RosClient): UseParamBindingResult {
  const injected = useRef<RosClient | undefined>(client);
  const [instance, setInstance] = useState<RosClient>(() => injected.current ?? getSharedClient());
  const instanceUrl = useRef(injected.current ? '' : 'ws://127.0.0.1:9090');
  const controllerRef = useRef<ParamBindingController | undefined>(undefined);
  const [status, setStatus] = useState<RosStatus>(instance.status);
  const [statusDetail, setStatusDetail] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingConnect = useRef(false);

  useEffect(() => {
    const controller = new ParamBindingController({
      client: instance,
      onStatus: (next, detail) => {
        setStatus(next);
        setStatusDetail(detail ?? '');
      },
      onError: (reason) => {
        setToast(reason);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 8_000);
      },
    });
    controllerRef.current = controller;
    if (pendingConnect.current) {
      pendingConnect.current = false;
      void controller.connect();
    }
    return () => {
      controller.dispose();
      controllerRef.current = undefined;
    };
  }, [instance]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const connect = useCallback(async (url: string) => {
    // RosClient 实例按 URL 缓存：换 URL 时用新实例，旧实例断开。
    const normalized = url.trim() || 'ws://127.0.0.1:9090';
    if (injected.current) {
      await controllerRef.current?.connect();
      return;
    }
    if (instanceUrl.current !== normalized) {
      instance.close();
      instanceUrl.current = normalized;
      pendingConnect.current = true;
      setInstance(new RosClientImpl({ url: normalized }));
      return;
    }
    await controllerRef.current?.connect();
  }, [instance]);

  const disconnect = useCallback(() => controllerRef.current?.disconnect(), []);
  const register = useCallback(
    (
      nodeType: string,
      portKey: string,
      control: BoundControl,
      instanceId?: string,
      ref?: ParamBindingRef,
      valueType?: BindingValueType,
    ) =>
      controllerRef.current?.register(nodeType, portKey, control, instanceId, ref, valueType) ??
      (() => undefined),
    [],
  );
  const bind = useCallback(
    (
      nodeType: string,
      portKey: string,
      ref: ParamBindingRef,
      valueType: BindingValueType,
      instanceId?: string,
    ) => controllerRef.current?.bind(nodeType, portKey, ref, valueType, instanceId) ?? false,
    [],
  );
  const unbind = useCallback(
    (nodeType: string, portKey: string, instanceId?: string) =>
      controllerRef.current?.unbind(nodeType, portKey, instanceId),
    [],
  );
  const onControlChange = useCallback(
    (nodeType: string, portKey: string, value: ParamValue, instanceId?: string) =>
      controllerRef.current?.onControlChange(nodeType, portKey, value, instanceId),
    [],
  );
  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = undefined;
    setToast('');
  }, []);

  // 保持返回对象稳定（除状态字段），避免调用方 effect 因引用变化反复重跑。
  return useMemo(
    () => ({ status, statusDetail, toast, connect, disconnect, register, bind, unbind, onControlChange, dismissToast }),
    [status, statusDetail, toast, connect, disconnect, register, bind, unbind, onControlChange, dismissToast],
  );
}
