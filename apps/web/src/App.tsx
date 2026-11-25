import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphIR } from '@rosui/ir';
import { CurrentIR } from './controls';
import { createEditor, addNode, connect, toGraphIR, type EditorHandle } from './rete/editor';
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

  const binding = useParamBinding();
  // M3：动态添加的节点也要接进绑定层；unregister 在画布卸载时统一清理。
  const poseUnregisters = useRef<Array<() => void>>([]);

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
    const unregisters: Array<() => void> = [];

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
          unregisters.push(
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
      for (const unregister of unregisters) unregister();
      unregisters.length = 0;
      for (const unregister of poseUnregisters.current) unregister();
      poseUnregisters.current.length = 0;
      handle?.destroy();
      handleRef.current = null;
    };
  }, [binding.register, handleUserChange, onValue, refresh, selectNode]);

  const statusClass = `ros-status ros-status--${binding.status}`;
  const connected = binding.status === 'connected';

  const { bind, unbind } = binding;
  const handleBind = useCallback(
    (ref: ParamBindingRef, valueType: BindingValueType) => {
      if (!selectedPort) return;
      const expected = controlValueType(selectedPort.nodeType, selectedPort.portKey);
      if (!typesCompatible(valueType, expected)) {
        setLocalToast(`${selectedPort.nodeType}.${selectedPort.portKey} 控件不接受 ${valueType} 类型参数`);
        return;
      }
      setLocalToast('');
      bind(selectedPort.nodeType, selectedPort.portKey, ref, valueType, selectedPort.instanceId);
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
          disabled={!ready}
          onClick={() => {
            const editorHandle = handleRef.current;
            if (!editorHandle) return;
            void addNode(editorHandle, 'gain', 300, 520, onValue).then(() => {
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
            poseUnregisters.current.push(
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
            void addNode(editorHandle, 'script', 600, 700, onValue).then(() => refresh());
          }}
        >
          + Script
        </button>
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
