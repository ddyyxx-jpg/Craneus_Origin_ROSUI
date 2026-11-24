import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphIR } from '@rosui/ir';
import { CurrentIR } from './controls';
import { createEditor, addNode, connect, toGraphIR, type EditorHandle } from './rete/editor';
import type { RosuiNode } from './rete/nodes';
import type { ParamValue, RosStatus } from './ros';
import { createControlAdapter } from './binding/controlAdapter';
import { useParamBinding } from './binding/useParamBinding';

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

const BOUND_NODES: ReadonlyArray<{ kind: 'gain' | 'mode' | 'switch'; nodeType: string; portKey: string }> = [
  { kind: 'gain', nodeType: 'Gain', portKey: 'gain' },
  { kind: 'mode', nodeType: 'Mode', portKey: 'mode' },
  { kind: 'switch', nodeType: 'Switch', portKey: 'enabled' },
];

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('正在初始化画布…');
  const [lastGain, setLastGain] = useState<number | null>(null);
  const [graph, setGraph] = useState<GraphIR | null>(null);
  const [url, setUrl] = useState('ws://127.0.0.1:9090');

  const binding = useParamBinding();

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
    (nodeType: string, portKey: string, value: ParamValue) => {
      onControlChange(nodeType, portKey, value);
    },
    [onControlChange],
  );

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    let disposed = false;
    let handle: EditorHandle | null = null;
    const unregisters: Array<() => void> = [];

    void createEditor(container)
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
        await addNode(created, 'label', 140, 340, onValue);
        const mode = await addNode(created, 'mode', 420, 340, onValue);
        const sw = await addNode(created, 'switch', 700, 340, onValue);
        // 保留 M1 的「连线隐藏控件」效果：threshold.value 被连线后，其控件会隐藏。
        await connect(created, gain.id, 'out', threshold.id, 'value');

        if (disposed) return;
        // 把已绑定的三个内联控件接进绑定控制器；Threshold 保持未绑定。
        const boundNodes: Record<'gain' | 'mode' | 'switch', RosuiNode> = { gain, mode, switch: sw };
        for (const item of BOUND_NODES) {
          const node = boundNodes[item.kind];
          const adapter = createControlAdapter({
            nodeType: item.nodeType,
            portKey: item.portKey,
            control: node.control,
            onUserChange: handleUserChange,
          });
          unregisters.push(binding.register(item.nodeType, item.portKey, {
            ...adapter,
            setValue(value, origin) {
              adapter.setValue(value, origin);
              if (typeof value === 'number') setLastGain(value);
              refresh();
            },
          }));
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
      handle?.destroy();
      handleRef.current = null;
    };
  }, [binding.register, handleUserChange, onValue, refresh]);

  const statusClass = `ros-status ros-status--${binding.status}`;
  const connected = binding.status === 'connected';

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
      </header>
      {binding.toast ? (
        <div className="ros-toast" data-testid="ros-toast" role="alert">
          {binding.toast}
        </div>
      ) : null}
      <div className="workspace">
        <div ref={canvasRef} className="canvas" />
        <aside className="ir-panel">
          <div className="ir-title">当前 IR（只读）</div>
          <CurrentIR graph={graph} />
        </aside>
      </div>
    </div>
  );
}
