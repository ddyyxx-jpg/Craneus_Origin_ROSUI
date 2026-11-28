import { useState, type KeyboardEvent, type ReactNode } from 'react';

type EditorTab = 'graph' | 'ir';

const TABS: readonly { id: EditorTab; label: string; testId: string }[] = [
  { id: 'graph', label: '节点图', testId: 'editor-tab-graph' },
  { id: 'ir', label: '只读 IR', testId: 'editor-tab-ir' },
];

/**
 * Keep both panes mounted: the canvas is owned by a long-lived Rete editor, and
 * the existing e2e contract requires `[data-testid="current-ir"]` to stay
 * visible/readable on first load. The IR tab documents where the panel lives;
 * it does not duplicate the `current-ir` test id.
 */
export function EditorTabs({ graph, ir }: { graph: ReactNode; ir: ReactNode }) {
  const [active, setActive] = useState<EditorTab>('graph');

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === active);
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
    if (!next) return;
    setActive(next.id);
    document.getElementById(next.testId)?.focus();
  };

  return (
    <section className="editor-tabs" data-testid="editor-tabs">
      <div
        className="editor-tabbar"
        role="tablist"
        aria-label="编辑器标签"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={tab.testId}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={tab.id === 'graph' ? 'editor-pane-graph' : 'editor-pane-ir'}
            tabIndex={active === tab.id ? 0 : -1}
            data-testid={tab.testId}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="editor-panes">
        <div
          id="editor-pane-graph"
          className="editor-pane editor-pane-graph"
          role="tabpanel"
          aria-labelledby="editor-tab-graph"
          data-testid="editor-pane-graph"
          hidden={active !== 'graph'}
        >
          {graph}
        </div>
        <div
          id="editor-pane-ir"
          className="editor-pane editor-pane-ir"
          role="tabpanel"
          aria-labelledby="editor-tab-ir"
          data-testid="editor-pane-ir"
          data-active={active === 'ir'}
        >
          {ir}
        </div>
      </div>
    </section>
  );
}
