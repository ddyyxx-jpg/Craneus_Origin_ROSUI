import { useCallback, useEffect, useRef, useState } from 'react';
import { getUID } from 'rete';
import type { GraphIR } from '@rosui/ir';
import { CurrentIR } from './controls';
import { createEditor, addNode, connect, toGraphIR, type EditorHandle } from './rete/editor';
import { loadGraph, serializeGraph, type LoadGraphResult } from './rete/serialize';
import { loadToast } from './loadToast';
import { createNode, type RosuiNode } from './rete/nodes';
import type { ParamBindingRef, ParamValue, RosStatus } from './ros';
import { getSharedClient } from './ros';
import { createControlAdapter } from './binding/controlAdapter';
import { useParamBinding } from './binding/useParamBinding';
import {
  clearRuntimeBinding,
  controlValueType,
  listRuntimeBindings,
  typesCompatible,
  type BindingValueType,
} from './binding/bindings';
import { ParamBrowser, type SelectedPort } from './ParamBrowser';
import { formatFailure, type FailureInput } from './toast';
import {
  createClipboard,
  createSnapshotState,
  pasteGraph,
  pushSnapshot,
  redo as redoSnapshot,
  undo as undoSnapshot,
  type ClipboardData,
  type SnapshotState,
} from './rete/history';

const AUTO_COMMIT_DELAY_MS = 80;
const SCRIPT_COMMIT_EVENT = 'rosui:script-committed';

function snapshot(handle: EditorHandle | null): GraphIR | null {
  return handle ? toGraphIR(handle) : null;
}

const STATUS_TEXT: Record<RosStatus, string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  disconnected: '已断开',
  error: '连接错误',
};

interface HistoryDevApi {
  commitHistory(): void;
  undoHistory(): Promise<void>;
  redoHistory(): Promise<void>;
  copySelection(): void;
  pasteSelection(): Promise<void>;
  getHistoryState(): { undo: number; redo: number };
}

/** 画布重建前清掉全局运行期绑定表，避免旧节点 id 把静态绑定误渲染成 runtime。 */
function clearAllRuntimeBindings(): void {
  for (const { nodeType, portKey, instanceId } of listRuntimeBindings()) {
    clearRuntimeBinding(nodeType, portKey, instanceId);
  }
}

/** T-032：输入框/脚本区聚焦时不抢浏览器原生快捷键。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [data-testid^="pose-"]'),
  );
}

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('正在初始化画布…');
  const [lastGain, setLastGain] = useState<number | null>(null);
  const [graph, setGraph] = useState<GraphIR | null>(null);
  const [url, setUrl] = useState('ws://127.0.0.1:9090');
  const [selectedPort, setSelectedPort] = useState<SelectedPort | null>(null);
  const [localToast, setLocalToast] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // T-032：历史/剪贴板放在 ref 里，状态变化不触发画布 effect 重建。
  const historyRef = useRef<SnapshotState>(createSnapshotState());
  const clipboardRef = useRef<ClipboardData | null>(null);
  const restoringRef = useRef(false);
  const lastCommittedRef = useRef('');
  const autoCommitTimerRef = useRef<number | undefined>(undefined);
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const devApiRef = useRef<HistoryDevApi | null>(null);

  // M5：错误提示统一经此出口，失败类传 FailureInput，成功/清空类直接传字符串。
  const pushToast = useCallback((message: FailureInput | string): void => {
    setLocalToast(typeof message === 'string' ? message : formatFailure(message));
  }, []);

  const binding = useParamBinding();
  const { dismissToast } = binding;
  // M3/M5：所有节点的 unregister 都收进 allUnregisters，加载前统一清空，避免旧订阅泄漏。
  const allUnregisters = useRef<Array<() => void>>([]);

  const refresh = useCallback(() => {
    setGraph(snapshot(handleRef.current));
  }, []);

  /** 无差别把当前图推入 undo 栈；显式 DEV commit 与加载/粘贴后的强制提交都走这里。 */
  const commitCurrentGraph = useCallback((): void => {
    const editorHandle = handleRef.current;
    if (!editorHandle) return;
    const ir = serializeGraph(editorHandle);
    historyRef.current = pushSnapshot(historyRef.current, ir);
    lastCommittedRef.current = JSON.stringify(ir);
    refresh();
  }, [refresh]);

  /**
   * 自动提交只更新 ref 中的历史栈，不 setGraph：200 节点批量建图时，
   * CurrentIR 对整张图 JSON.stringify 的 React 重渲染会把 LOD 首帧拖慢数秒。
   * IR 面板仍由用户改值 onValue / 程序写值 setValue / 加载与恢复路径显式 refresh。
   */
  const commitGraphIfChanged = useCallback((): void => {
    if (restoringRef.current) return;
    const editorHandle = handleRef.current;
    if (!editorHandle) return;
    const ir = serializeGraph(editorHandle);
    const serialized = JSON.stringify(ir);
    if (serialized === lastCommittedRef.current) return;
    historyRef.current = pushSnapshot(historyRef.current, ir);
    lastCommittedRef.current = serialized;
  }, []);

  const commitHistory = useCallback((): void => {
    if (restoringRef.current) return;
    commitCurrentGraph();
  }, [commitCurrentGraph]);

  const initialiseHistory = useCallback((): void => {
    const editorHandle = handleRef.current;
    if (!editorHandle) return;
    const ir = serializeGraph(editorHandle);
    historyRef.current = pushSnapshot(createSnapshotState(), ir);
    lastCommittedRef.current = JSON.stringify(ir);
  }, []);

  /**
   * 自动提交：Rete 结构事件、拖动结束、控件合法改值都可能连续触发；
   * 80ms 合并 + JSON 去重，确保每个用户动作只形成一条历史边界。
   */
  const scheduleGraphCommit = useCallback(
    (immediate = false): void => {
      if (restoringRef.current) return;
      if (autoCommitTimerRef.current !== undefined) {
        window.clearTimeout(autoCommitTimerRef.current);
        autoCommitTimerRef.current = undefined;
      }
      if (immediate) {
        commitGraphIfChanged();
        return;
      }
      autoCommitTimerRef.current = window.setTimeout(() => {
        autoCommitTimerRef.current = undefined;
        commitGraphIfChanged();
      }, AUTO_COMMIT_DELAY_MS);
    },
    [commitGraphIfChanged],
  );

  const onValue = useCallback(
    (node: { spec: { type: string } }, value: unknown) => {
      if (node.spec.type === 'Gain' && typeof value === 'number') setLastGain(value);
      refresh();
    },
    [refresh],
  );

  // 只依赖稳定的 onControlChange：依赖整个 binding 对象会让 status/toast 一变就重建画布。
  const { onControlChange } = binding;
  const handleUserChange = useCallback(
    (nodeType: string, portKey: string, value: ParamValue, nodeId?: string) => {
      if (restoringRef.current) return;
      onControlChange(nodeType, portKey, value, nodeId);
      scheduleGraphCommit();
    },
    [onControlChange, scheduleGraphCommit],
  );

  // M4 A: Rete 的 nodepicked 事件在画布点击节点标题/控件区时触发，记录当前选中端口。
  const selectNode = useCallback((nodeId: string) => {
    const editorHandle = handleRef.current;
    if (!editorHandle) return;
    const node = editorHandle.editor.getNode(nodeId);
    if (!node) return;
    const nodeType = node.spec.type;
    const portKey = nodeType === 'Script' ? 'x' : node.spec.inputKey;
    setSelectedPort({ instanceId: node.id, portKey, nodeType });
  }, []);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    let disposed = false;
    let handle: EditorHandle | null = null;

    void createEditor(container, selectNode)
      .then(async (created) => {
        if (disposed) {
          created.destroy();
          return;
        }
        handle = created;
        handleRef.current = created;
        if (import.meta.env.DEV && devApiRef.current) {
          // e2e 用：既有 EditorHandle 能力 + T-032 历史/剪贴板 DEV API。
          const devHandle = Object.assign(created, devApiRef.current);
          (window as unknown as { __rosui?: EditorHandle & HistoryDevApi }).__rosui = devHandle;
        }

        const gain = await addNode(created, 'gain', 140, 120, onValue);
        const threshold = await addNode(created, 'threshold', 420, 120, onValue);
        const label = await addNode(created, 'label', 140, 340, onValue);
        const mode = await addNode(created, 'mode', 420, 340, onValue);
        const sw = await addNode(created, 'switch', 700, 340, onValue);
        // 保留 M1 的「连线隐藏控件」效果：threshold.value 被连线后，其控件会隐藏。
        await connect(created, gain.id, 'out', threshold.id, 'value');

        if (disposed) return;
        // M4 A: 所有带控件的节点都注册进绑定层，运行时绑定可以指向任意端口。
        // 静态绑定表只覆盖 Gain/Mode/Switch/Pose；其他节点默认保持本地值。
        const allNodes: RosuiNode[] = [gain, threshold, label, mode, sw];
        for (const node of allNodes) {
          const adapter = createControlAdapter({
            nodeType: node.spec.type,
            portKey: node.spec.inputKey,
            nodeId: node.id,
            control: node.control,
            onUserChange: handleUserChange,
          });
          allUnregisters.current.push(
            binding.register(
              node.spec.type,
              node.spec.inputKey,
              {
                ...adapter,
                setValue(value, origin) {
                  adapter.setValue(value, origin);
                  if (node.spec.type === 'Gain' && typeof value === 'number') setLastGain(value);
                  refresh();
                },
              },
              node.id,
            ),
          );
        }

        setReady(true);
        setMessage('就绪 — 5 个节点（Gain/Threshold/Label/Mode/Switch），1 条连线。');
        setGraph(snapshot(created));
        initialiseHistory();

        // T-032：初始图建成后才挂自动提交管道，避免初始化过程被当成用户动作。
        created.editor.addPipe((context) => {
          if (
            context.type === 'nodecreated' ||
            context.type === 'noderemoved' ||
            context.type === 'connectioncreated' ||
            context.type === 'connectionremoved' ||
            context.type === 'cleared'
          ) {
            scheduleGraphCommit();
          }
          return context;
        });
        created.area.addPipe((context) => {
          // nodedragged 由 Rete 在节点拖拽 pointerup 时发出，不用逐帧的 nodetranslated。
          if (context.type === 'nodedragged') scheduleGraphCommit();
          return context;
        });
      })
      .catch((error: unknown) => {
        setMessage(`画布错误：${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      disposed = true;
      if (autoCommitTimerRef.current !== undefined) {
        window.clearTimeout(autoCommitTimerRef.current);
        autoCommitTimerRef.current = undefined;
      }
      for (const unregister of allUnregisters.current) unregister();
      allUnregisters.current.length = 0;
      handle?.destroy();
      handleRef.current = null;
    };
  }, [
    binding.register,
    handleUserChange,
    initialiseHistory,
    onValue,
    refresh,
    scheduleGraphCommit,
    selectNode,
  ]);

  useEffect(() => {
    const onScriptCommitted = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') {
        // Script 代码不在控件 onChange 上：用节点 id 精确定位并串行化当前值。
        const editorHandle = handleRef.current;
        const node = editorHandle?.editor.getNode(event.detail);
        if (node && (node as RosuiNode).toParamBinding) {
          // ScriptNode.toParamBinding() 从 data.code 读取，广播发生前 data.run() 已写入 code。
          scheduleGraphCommit();
        }
        return;
      }
      scheduleGraphCommit();
    };
    window.addEventListener(SCRIPT_COMMIT_EVENT, onScriptCommitted);
    return () => window.removeEventListener(SCRIPT_COMMIT_EVENT, onScriptCommitted);
  }, [scheduleGraphCommit]);

  const statusClass = `ros-status ros-status--${binding.status}`;
  const connected = binding.status === 'connected';

  const { bind, unbind } = binding;
  /** 动态新增的节点也要注册进绑定层，否则参数浏览器能「绑定成功」但实际没有订阅。 */
  const registerDynamic = useCallback(
    (node: RosuiNode): void => {
      // inspector 等节点没有内联控件，不能把 undefined 交给 WeakMap 适配器。
      if (!node.control || !node.control.kind) return;
      const adapter = createControlAdapter({
        nodeType: node.spec.type,
        portKey: node.spec.inputKey,
        nodeId: node.id,
        control: node.control,
        onUserChange: handleUserChange,
      });
      allUnregisters.current.push(
        binding.register(
          node.spec.type,
          node.spec.inputKey,
          {
            ...adapter,
            setValue(value, origin) {
              adapter.setValue(value, origin);
              if (node.spec.type === 'Gain' && typeof value === 'number') setLastGain(value);
              refresh();
            },
          },
          node.id,
        ),
      );
    },
    [binding.register, handleUserChange, refresh],
  );

  /** 清空全部绑定订阅（初始 5 节点 + 动态节点）：加载前调用，避免旧节点的 entry/timer 泄漏。 */
  const clearDynamicRegistrations = useCallback(() => {
    for (const unregister of allUnregisters.current) unregister();
    allUnregisters.current.length = 0;
  }, []);

  /**
   * M5 二轮 P1-A：注册控件 + 恢复运行期绑定收进同一个函数。
   * T-032：重建画布前先清掉全部 RUNTIME_BINDINGS，静态副本不会被旧 id 误判为 runtime。
   * 成功加载、快照回滚与 undo/redo 都调用，保证 IR 中 mode:'runtime' 的绑定在重建后仍订阅 ROS。
   */
  const restoreGraphBindings = useCallback(
    (result: LoadGraphResult): number => {
      clearAllRuntimeBindings();
      clearDynamicRegistrations();
      for (const node of result.nodes) registerDynamic(node);
      let failedBindings = 0;
      for (const { node, ref, valueType } of result.runtimeBindings) {
        const portKey = node.spec.inputKey;
        const expected = controlValueType(node.spec.type, portKey);
        const ok =
          expected && typesCompatible(valueType, expected)
            ? bind(node.spec.type, portKey, ref, valueType, node.id)
            : false;
        if (!ok) failedBindings += 1;
      }
      return failedBindings;
    },
    [bind, clearDynamicRegistrations, registerDynamic],
  );

  const handleSaveGraph = useCallback(() => {
    const editorHandle = handleRef.current;
    if (!editorHandle) return;
    const json = JSON.stringify(toGraphIR(editorHandle), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rosui-graph.rosui.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  // 加载主流程：JSON → IR → 画布。
  // restoreSnapshot: clear() 前拍快照，任何中途失败都用 serializeGraph 快照重建旧图。
  // T-032：加载期间 suppressing 自动历史/控件回灌；成功后强制提交一条边界。
  const loadGraphInternal = useCallback(
    async (editorHandle: EditorHandle, ir: unknown, restoreSnapshot: boolean): Promise<boolean> => {
      const before = restoreSnapshot ? serializeGraph(editorHandle) : null;
      let cleared = false;
      restoringRef.current = true;
      if (autoCommitTimerRef.current !== undefined) {
        window.clearTimeout(autoCommitTimerRef.current);
        autoCommitTimerRef.current = undefined;
      }
      try {
        // 先停掉旧节点的所有订阅，再清画布；新节点按恢复后的类型重新注册。
        clearDynamicRegistrations();
        cleared = true;
        const result = await loadGraph(editorHandle, ir);
        const failedBindings = restoreGraphBindings(result);

        setSelectedPort(null);
        setLastGain(null);
        refresh();
        // P2-A：绑定失败与脚本来源提示合并展示，不再互相覆盖。
        pushToast(loadToast(failedBindings, result.scriptCodeCount));
        commitCurrentGraph();
        return true;
      } catch (error: unknown) {
        if (cleared && restoreSnapshot && before) {
          try {
            // 快照重建走同一个 addNode 管道，但不再次拍快照，避免递归。
            // loadGraph 返回的 result 指向重建后的节点，交给同一个恢复函数重建订阅。
            const snapshotResult = await loadGraph(editorHandle, before);
            restoreGraphBindings(snapshotResult);
            setSelectedPort(null);
            setLastGain(null);
            refresh();
          } catch {
            pushToast({ kind: 'load', reason: '画布已重置，请用备份恢复' });
            setGraph(null);
            setSelectedPort(null);
            setLastGain(null);
            lastCommittedRef.current = JSON.stringify(serializeGraph(editorHandle));
            return false;
          }
        }
        // 回滚本身失败时 toast 保持「画布已重置」兜底；成功回滚时最终 toast 必须是「加载失败：…」，
        // 不能被「N 个运行期绑定未恢复」覆盖，因此回滚路径不展示绑定失败提示。
        pushToast({ kind: 'load', reason: error instanceof Error ? error.message : String(error) });
        // 校验失败时画布未动，但 graph/selectedPort/lastGain 可能与画布不同步，统一刷新。
        refresh();
        lastCommittedRef.current = JSON.stringify(serializeGraph(editorHandle));
        return false;
      } finally {
        restoringRef.current = false;
      }
    },
    [clearDynamicRegistrations, commitCurrentGraph, refresh, restoreGraphBindings, pushToast],
  );

  const handleLoadGraph = useCallback(
    async (file: File): Promise<void> => {
      const editorHandle = handleRef.current;
      if (!editorHandle) return;
      try {
        // 扩展名校验按用户选中的文件名做；Playwright 可能传入无扩展名的下载临时文件，
        // 此时由后续 JSON.parse + parseGraph 做内容校验，不靠文件名放行/拒绝。
        const name = file.name.toLowerCase();
        if (name.includes('.') && !name.endsWith('.json')) {
          pushToast({ kind: 'load', reason: '仅支持 .json / .rosui.json 文件' });
          return;
        }
        if (file.size > 8 * 1024 * 1024) {
          pushToast({ kind: 'load', reason: '文件超过 8MB' });
          return;
        }
        const text = await file.text();
        let ir: unknown;
        try {
          ir = JSON.parse(text);
        } catch {
          pushToast({ kind: 'load', reason: '文件不是合法 JSON' });
          return;
        }
        await loadGraphInternal(editorHandle, ir, true);
      } catch (error: unknown) {
        pushToast({ kind: 'load', reason: error instanceof Error ? error.message : String(error) });
      }
    },
    [loadGraphInternal, pushToast],
  );

  /** T-032 undo/redo/粘贴共用的静默重建：不 toast、不自动入栈、不回灌 ROS。 */
  const restoreGraphSilently = useCallback(
    async (ir: GraphIR): Promise<boolean> => {
      const editorHandle = handleRef.current;
      if (!editorHandle) return false;
      restoringRef.current = true;
      if (autoCommitTimerRef.current !== undefined) {
        window.clearTimeout(autoCommitTimerRef.current);
        autoCommitTimerRef.current = undefined;
      }
      try {
        clearDynamicRegistrations();
        const result = await loadGraph(editorHandle, ir);
        restoreGraphBindings(result);
        editorHandle.clearNodeSelection();
        setSelectedPort(null);
        setLastGain(null);
        setLocalToast('');
        dismissToast();
        refresh();
        lastCommittedRef.current = JSON.stringify(serializeGraph(editorHandle));
        return true;
      } catch (error: unknown) {
        pushToast({ kind: 'load', reason: error instanceof Error ? error.message : String(error) });
        refresh();
        return false;
      } finally {
        restoringRef.current = false;
      }
    },
    [clearDynamicRegistrations, dismissToast, refresh, restoreGraphBindings, pushToast],
  );

  /** 串行执行 undo/redo/粘贴，避免两次异步 loadGraph 同时重建画布。 */
  const enqueueHistoryAction = useCallback(
    (action: () => Promise<void>): Promise<void> => {
      const run = async (): Promise<void> => {
        // 80ms 内紧接着按快捷键时，先把待提交改动定稿，再算 undo 栈，避免丢失边界。
        commitGraphIfChanged();
        if (autoCommitTimerRef.current !== undefined) {
          window.clearTimeout(autoCommitTimerRef.current);
          autoCommitTimerRef.current = undefined;
        }
        await action();
      };
      const next = historyQueueRef.current.then(run, run);
      historyQueueRef.current = next.catch(() => undefined);
      return historyQueueRef.current;
    },
    [commitGraphIfChanged],
  );

  const undoHistory = useCallback(
    (): Promise<void> =>
      enqueueHistoryAction(async () => {
        const previousState = historyRef.current;
        const step = undoSnapshot(previousState);
        if (!step.ir) return;
        const restored = await restoreGraphSilently(step.ir);
        historyRef.current = restored ? step.state : previousState;
      }),
    [enqueueHistoryAction, restoreGraphSilently],
  );

  const redoHistory = useCallback(
    (): Promise<void> =>
      enqueueHistoryAction(async () => {
        const previousState = historyRef.current;
        const step = redoSnapshot(previousState);
        if (!step.ir) return;
        const restored = await restoreGraphSilently(step.ir);
        historyRef.current = restored ? step.state : previousState;
      }),
    [enqueueHistoryAction, restoreGraphSilently],
  );

  const copySelection = useCallback((): void => {
    // 异步恢复（undo/redo/粘贴）期间画布可能只重建到一半；忽略此期间的复制，避免把中间态写入剪贴板。
    if (restoringRef.current) return;
    const editorHandle = handleRef.current;
    if (!editorHandle) return;
    const ir = serializeGraph(editorHandle);
    const ids = new Set(editorHandle.getSelectedNodeIds());
    clipboardRef.current = createClipboard(ir, ids);
  }, []);

  const pasteSelection = useCallback(
    (): Promise<void> =>
      enqueueHistoryAction(async () => {
        const editorHandle = handleRef.current;
        const clipboard = clipboardRef.current;
        if (!editorHandle || !clipboard || clipboard.nodes.length === 0) return;
        const base = serializeGraph(editorHandle);
        const pasted = pasteGraph(base, clipboard, getUID);
        if (!(await restoreGraphSilently(pasted.ir))) return;
        editorHandle.setSelectedNodeIds(pasted.newIds);
        setSelectedPort(null);
        setLastGain(null);
        commitCurrentGraph();
      }),
    [commitCurrentGraph, enqueueHistoryAction, restoreGraphSilently],
  );

  const handleBind = useCallback(
    (ref: ParamBindingRef, valueType: BindingValueType) => {
      if (!selectedPort) return;
      const expected = controlValueType(selectedPort.nodeType, selectedPort.portKey);
      if (!typesCompatible(valueType, expected)) {
        pushToast({
          kind: 'type',
          param: `${selectedPort.nodeType}.${selectedPort.portKey}`,
          reason: `控件不接受 ${valueType} 类型参数`,
        });
        return;
      }
      const ok = bind(selectedPort.nodeType, selectedPort.portKey, ref, valueType, selectedPort.instanceId);
      pushToast(
        ok
          ? ''
          : { kind: 'bind', param: `${selectedPort.nodeType}.${selectedPort.portKey}`, reason: '未注册到绑定层，绑定已回滚' },
      );
      refresh();
      scheduleGraphCommit(true);
    },
    [bind, selectedPort, refresh, pushToast, scheduleGraphCommit],
  );
  const handleUnbind = useCallback(
    () => {
      if (!selectedPort) return;
      unbind(selectedPort.nodeType, selectedPort.portKey, selectedPort.instanceId);
      refresh();
      scheduleGraphCommit(true);
    },
    [unbind, selectedPort, refresh, scheduleGraphCommit],
  );
  const handleTypeReject = useCallback(
    (reason: string, param?: string) => pushToast({ kind: 'validate', param, reason }),
    [pushToast],
  );

  // DEV API 用 effect 写入 ref，避免在渲染期写 ref；createEditor().then() 是微任务，
  // 会等本轮所有 effect 同步执行完再读取 devApiRef.current，顺序仍然可靠。
  useEffect(() => {
    devApiRef.current = {
      commitHistory: () => commitHistory(),
      undoHistory: () => undoHistory(),
      redoHistory: () => redoHistory(),
      copySelection: () => copySelection(),
      pasteSelection: () => pasteSelection(),
      getHistoryState: () => ({
        undo: historyRef.current.undo.length,
        redo: historyRef.current.redo.length,
      }),
    };
  }, [commitHistory, undoHistory, redoHistory, copySelection, pasteSelection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) void redoHistory();
        else void undoHistory();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        void redoHistory();
        return;
      }
      if (key === 'c') {
        event.preventDefault();
        copySelection();
        return;
      }
      if (key === 'v') {
        event.preventDefault();
        void pasteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelection, pasteSelection, redoHistory, undoHistory]);

  return (
    <div className="app">
      <header className="toolbar">
        <strong>ROSUI</strong>
        <span className="status" data-testid="canvas-status" data-state={ready ? 'ready' : 'loading'}>
          {message}
        </span>
        <span className="status" data-testid="gain-readout">
          {lastGain === null ? '增益：—' : `增益：${lastGain}`}
        </span>
        <input
          className="ros-url"
          aria-label="rosbridge 地址"
          data-testid="ros-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={connected || binding.status === 'connecting'}
        />
        <button
          type="button"
          data-testid="ros-connect"
          disabled={connected || binding.status === 'connecting'}
          onClick={() => {
            void binding.connect(url);
          }}
        >
          连接
        </button>
        <button
          type="button"
          data-testid="ros-disconnect"
          disabled={!connected}
          onClick={() => binding.disconnect()}
        >
          断开
        </button>
        <span
          className={statusClass}
          data-testid="ros-status"
          data-status={binding.status}
          data-detail={`${binding.status}:${binding.statusDetail}`}
        >
          {STATUS_TEXT[binding.status]}
        </span>
        <button
          type="button"
          data-testid="add-gain"
          disabled={!ready}
          onClick={() => {
            const editorHandle = handleRef.current;
            if (!editorHandle) return;
            void addNode(editorHandle, 'gain', 300, 520, onValue).then((node) => {
              registerDynamic(node);
              refresh();
            });
          }}
        >
          + Gain
        </button>
        <button
          type="button"
          data-testid="add-pose"
          disabled={!ready}
          onClick={() => {
            const editorHandle = handleRef.current;
            if (!editorHandle) return;
            // M3：Pose 不在默认 5 节点里，点按钮加到画布空白处并注册绑定。
            const node = createNode('pose', onValue);
            const count = editorHandle.editor.getNodes().length;
            void editorHandle.editor.addNode(node).then(() =>
              editorHandle.area.translate(node.id, { x: 300 + count * 30, y: 520 + count * 20 }),
            );
            const adapter = createControlAdapter({
              nodeType: node.spec.type,
              portKey: node.spec.inputKey,
              nodeId: node.id,
              control: node.control,
              onUserChange: handleUserChange,
            });
            allUnregisters.current.push(
              binding.register(
                'Pose',
                'pose',
                {
                  ...adapter,
                  setValue(value, origin) {
                    adapter.setValue(value, origin);
                    refresh();
                  },
                },
                node.id,
              ),
            );
            refresh();
          }}
        >
          + Pose
        </button>
        <button
          type="button"
          data-testid="add-inspector"
          disabled={!ready}
          onClick={() => {
            const editorHandle = handleRef.current;
            if (!editorHandle) return;
            void addNode(editorHandle, 'inspector', 300, 700, onValue).then(() => refresh());
          }}
        >
          + Inspector
        </button>
        <button
          type="button"
          data-testid="add-script"
          disabled={!ready}
          onClick={() => {
            const editorHandle = handleRef.current;
            if (!editorHandle) return;
            void addNode(editorHandle, 'script', 600, 700, onValue).then((node) => {
              registerDynamic(node);
              refresh();
            });
          }}
        >
          + Script
        </button>
        <button
          type="button"
          data-testid="save-graph"
          disabled={!ready}
          onClick={handleSaveGraph}
        >
          保存图
        </button>
        <button
          type="button"
          data-testid="load-graph"
          disabled={!ready}
          onClick={() => fileInputRef.current?.click()}
        >
          加载图
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="graph-file-input"
          data-testid="load-graph-input"
          accept=".json,.rosui.json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleLoadGraph(file);
            event.target.value = '';
          }}
        />
      </header>
      {binding.toast || localToast ? (
        <div className="ros-toast" data-testid="ros-toast" role="alert">
          {binding.toast || localToast}
        </div>
      ) : null}
      <div className="workspace">
        <div ref={canvasRef} className="canvas" />
        <ParamBrowser
          client={getSharedClient()}
          status={binding.status}
          selected={selectedPort}
          onBind={handleBind}
          onUnbind={handleUnbind}
          onTypeReject={handleTypeReject}
        />
        <aside className="ir-panel">
          <div className="ir-title">当前 IR（只读）</div>
          <CurrentIR graph={graph} />
        </aside>
      </div>
    </div>
  );
}
