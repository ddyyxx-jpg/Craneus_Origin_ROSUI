import { useCallback, useEffect, useRef, useState } from 'react';
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
import { controlValueType, typesCompatible, type BindingValueType } from './binding/bindings';
import { ParamBrowser, type SelectedPort } from './ParamBrowser';

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

  const binding = useParamBinding();
  // M3/M5：所有节点的 unregister 都收进 allUnregisters，加载前统一清空，避免旧订阅泄漏。
  const allUnregisters = useRef<Array<() => void>>([]);

  const refresh = useCallback(() => {
    setGraph(snapshot(handleRef.current));
  }, []);

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
      onControlChange(nodeType, portKey, value, nodeId);
    },
    [onControlChange],
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
        if (import.meta.env.DEV) {
          // e2e 用：让 Playwright 能删连线，验证「断线后控件恢复」
          (window as unknown as { __rosui?: EditorHandle }).__rosui = created;
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
      })
      .catch((error: unknown) => {
        setMessage(`画布错误：${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      disposed = true;
      for (const unregister of allUnregisters.current) unregister();
      allUnregisters.current.length = 0;
      handle?.destroy();
      handleRef.current = null;
    };
  }, [binding.register, handleUserChange, onValue, refresh, selectNode]);

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
   * 成功加载与快照回滚都调用，保证 IR 中 mode:'runtime' 的绑定在重建后仍订阅 ROS。
   * registerDynamic 完成后静态表已就绪；bind() 只登记订阅，未连接 ROS 时不下发值。
   * 返回未能恢复的绑定数量，由调用方决定是否展示绑定失败提示。
   */
  const restoreGraphBindings = useCallback(
    (result: LoadGraphResult): number => {
      // 先清掉旧图/失败图残留的注册，再按新节点重建，避免订阅指向已移除的实例。
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
  const loadGraphInternal = useCallback(
    async (editorHandle: EditorHandle, ir: unknown, restoreSnapshot: boolean): Promise<void> => {
      const before = restoreSnapshot ? serializeGraph(editorHandle) : null;
      let cleared = false;
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
        setLocalToast(loadToast(failedBindings, result.scriptCodeCount));
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
            setLocalToast('加载失败：画布已重置，请用备份恢复');
            setGraph(null);
            setSelectedPort(null);
            setLastGain(null);
            return;
          }
        }
        // 回滚本身失败时 toast 保持「画布已重置」兜底；成功回滚时最终 toast 必须是「加载失败：…」，
        // 不能被「N 个运行期绑定未恢复」覆盖，因此回滚路径不展示绑定失败提示。
        setLocalToast(`加载失败：${error instanceof Error ? error.message : String(error)}`);
        // 校验失败时画布未动，但 graph/selectedPort/lastGain 可能与画布不同步，统一刷新。
        refresh();
      }
    },
    [clearDynamicRegistrations, refresh, restoreGraphBindings],
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
          setLocalToast('加载失败：仅支持 .json / .rosui.json 文件');
          return;
        }
        if (file.size > 8 * 1024 * 1024) {
          setLocalToast('加载失败：文件超过 8MB');
          return;
        }
        const text = await file.text();
        let ir: unknown;
        try {
          ir = JSON.parse(text);
        } catch {
          setLocalToast('加载失败：文件不是合法 JSON');
          return;
        }
        await loadGraphInternal(editorHandle, ir, true);
      } catch (error: unknown) {
        setLocalToast(`加载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [loadGraphInternal],
  );

  const handleBind = useCallback(
    (ref: ParamBindingRef, valueType: BindingValueType) => {
      if (!selectedPort) return;
      const expected = controlValueType(selectedPort.nodeType, selectedPort.portKey);
      if (!typesCompatible(valueType, expected)) {
        setLocalToast(`${selectedPort.nodeType}.${selectedPort.portKey} 控件不接受 ${valueType} 类型参数`);
        return;
      }
      const ok = bind(selectedPort.nodeType, selectedPort.portKey, ref, valueType, selectedPort.instanceId);
      setLocalToast(ok ? '' : `${selectedPort.nodeType}.${selectedPort.portKey} 未注册到绑定层，绑定已回滚`);
      refresh();
    },
    [bind, selectedPort, refresh],
  );
  const handleUnbind = useCallback(
    () => {
      if (!selectedPort) return;
      unbind(selectedPort.nodeType, selectedPort.portKey, selectedPort.instanceId);
      refresh();
    },
    [unbind, selectedPort, refresh],
  );
  const handleTypeReject = useCallback((reason: string) => {
    setLocalToast(reason);
  }, []);

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
        <span className={statusClass} data-testid="ros-status" data-status={binding.status}>
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
