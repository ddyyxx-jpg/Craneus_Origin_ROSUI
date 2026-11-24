import { useEffect, useRef, useState } from 'react';
import type { GraphIR } from '@rosui/ir';
import { CurrentIR } from './controls';
import { addNode, connect, createEditor, toGraphIR, type EditorHandle } from './rete/editor';

function snapshot(handle: EditorHandle | null): GraphIR | null {
  return handle ? toGraphIR(handle) : null;
}

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('Initializing canvas…');
  const [lastGain, setLastGain] = useState<number | null>(null);
  const [graph, setGraph] = useState<GraphIR | null>(null);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    let disposed = false;
    let handle: EditorHandle | null = null;

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

        const refresh = () => {
          if (!disposed) setGraph(snapshot(handleRef.current));
        };

        const onValue = (node: { spec: { type: string } }, value: unknown) => {
          if (node.spec.type === 'Gain' && typeof value === 'number') setLastGain(value);
          refresh();
        };

        const gain = await addNode(created, 'gain', 140, 120, onValue);
        const threshold = await addNode(created, 'threshold', 420, 120, onValue);
        await addNode(created, 'label', 140, 340, onValue);
        await addNode(created, 'mode', 420, 340, onValue);
        await addNode(created, 'switch', 700, 340, onValue);
        // 保留 M1 的「连线隐藏控件」效果：threshold.value 被连线后，其控件会隐藏。
        await connect(created, gain.id, 'out', threshold.id, 'value');

        if (disposed) return;
        setReady(true);
        setMessage('Ready — 5 nodes (Gain/Threshold/Label/Mode/Switch), 1 connection.');
        setGraph(snapshot(created));
      })
      .catch((error: unknown) => {
        setMessage(`Canvas error: ${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      disposed = true;
      handle?.destroy();
      handleRef.current = null;
    };
  }, []);

  return (
    <div className="app">
      <header className="toolbar">
        <strong>ROSUI</strong>
        <span className="status">{message}</span>
        <span className="status">{lastGain === null ? 'last gain: —' : `last gain: ${lastGain}`}</span>
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            const handle = handleRef.current;
            if (!handle) return;
            void addNode(handle, 'gain', 300, 520, (node, value) => {
              if (node.spec.type === 'Gain' && typeof value === 'number') setLastGain(value);
              setGraph(snapshot(handleRef.current));
            }).then(() => setGraph(snapshot(handleRef.current)));
          }}
        >
          + Gain
        </button>
      </header>
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
