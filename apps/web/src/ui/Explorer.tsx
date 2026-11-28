export interface WorkspaceRoot {
  id: string;
  path: string;
  label: string;
}

/** Static list only. Filesystem scanning is owned by the Phase 2 agent. */
export const WORKSPACE_ROOTS: readonly WorkspaceRoot[] = [
  {
    id: 'nav2027_ws',
    path: '/home/ddyyxx/ROSWORK/nav2027_ws',
    label: 'nav2027_ws',
  },
  {
    id: 'adaptive_lio_ws',
    path: '/home/ddyyxx/ROSWORK/adaptive_lio_ws',
    label: 'adaptive_lio_ws',
  },
  {
    id: 'craneus_pcd2pgm_advanced',
    path: '/home/ddyyxx/ROSWORK/craneus_pcd2pgm_advanced',
    label: 'craneus_pcd2pgm_advanced',
  },
];

export function Explorer({
  roots,
  activeId,
  onSelect,
}: {
  roots: readonly WorkspaceRoot[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="explorer-dock" data-testid="workspace-explorer">
      <div className="dock-title">Explorer</div>
      <div className="explorer-section-title">工作区</div>
      <div className="workspace-list">
        {roots.map((root) => (
          <button
            key={root.id}
            type="button"
            className="workspace-root"
            data-testid="workspace-root"
            data-workspace-id={root.id}
            aria-current={root.id === activeId ? 'page' : undefined}
            onClick={() => onSelect(root.id)}
          >
            <span className="workspace-root-label">{root.label}</span>
            <span className="workspace-root-path">{root.path}</span>
          </button>
        ))}
      </div>
      <div className="explorer-section-title">Packages</div>
      <div className="explorer-placeholder" data-testid="explorer-packages-placeholder">
        packages（占位）
      </div>
      <p className="explorer-notice" data-testid="workspace-scan-notice">
        扫描接口将在 Phase 2 接入。
      </p>
    </section>
  );
}
