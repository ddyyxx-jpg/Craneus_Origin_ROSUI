import { useEffect, useRef, useState } from 'react';
import { createEditor, addGainNode, connect, type EditorHandle } from './rete/editor';

export function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('Initializing canvas…');
  const [lastGain, setLastGain] = useState(1);

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

        const a = await addGainNode(created, 140, 160, (value) => setLastGain(value));
        const b = await addGainNode(created, 480, 160, (value) => setLastGain(value));
        await connect(created, a.id, 'out', b.id, 'gain');

        if (disposed) return;
        setReady(true);
        setMessage('Ready — 2 Gain nodes connected. Drag the canvas to explore.');
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
        <span className="status">last gain: {lastGain}</span>
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            const handle = handleRef.current;
            if (!handle) return;
            void addGainNode(handle, 300, 340, (value) => setLastGain(value));
          }}
        >
          + Gain
        </button>
      </header>
      <div ref={canvasRef} className="canvas" />
    </div>
  );
}
