import { useState, type KeyboardEvent } from 'react';

type BottomTab = 'output' | 'problems' | 'diagnostics';

const TABS: readonly { id: BottomTab; label: string }[] = [
  { id: 'output', label: 'Output' },
  { id: 'problems', label: 'Problems' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

const TAB_MESSAGES: Record<BottomTab, string> = {
  output: '等待工作区扫描；本阶段不连接 agent。',
  problems: '暂无诊断（扫描接口将在 Phase 2 接入）。',
  diagnostics: '暂无诊断；等待工作区扫描。',
};

export function BottomPanel() {
  const [active, setActive] = useState<BottomTab>('output');

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === active);
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
    if (!next) return;
    setActive(next.id);
    document.getElementById(`bottom-tab-${next.id}`)?.focus();
  };

  return (
    <section className="bottom-panel" data-testid="bottom-panel">
      <div
        className="bottom-tabbar"
        role="tablist"
        aria-label="底部面板标签"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`bottom-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls="bottom-panel-content"
            tabIndex={active === tab.id ? 0 : -1}
            data-testid={`bottom-tab-${tab.id}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="bottom-panel-content"
        className="bottom-content"
        role="tabpanel"
        aria-labelledby={`bottom-tab-${active}`}
        data-testid="bottom-panel-content"
      >
        {TAB_MESSAGES[active]}
      </div>
    </section>
  );
}
