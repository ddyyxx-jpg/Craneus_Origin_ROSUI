import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  explorer: ReactNode;
  editor: ReactNode;
  inspector: ReactNode;
  bottom: ReactNode;
  status: ReactNode;
  children?: ReactNode;
}

/** Phase 1 IDE layout: keep every region as plain React children; no global state. */
export function AppShell({
  topBar,
  explorer,
  editor,
  inspector,
  bottom,
  status,
  children,
}: AppShellProps) {
  return (
    <div className="app app-shell" data-testid="app-shell">
      {topBar}
      {children}
      <div className="shell-main">
        <aside className="shell-explorer">{explorer}</aside>
        <main className="shell-editor">{editor}</main>
        <aside className="shell-inspector">{inspector}</aside>
      </div>
      {bottom}
      {status}
    </div>
  );
}
