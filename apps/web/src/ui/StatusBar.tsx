interface StatusBarProps {
  rosStatus: string;
  canvasStatus: string;
  workspace: string;
  nodeCount: number;
  edgeCount: number;
}

export function StatusBar({
  rosStatus,
  canvasStatus,
  workspace,
  nodeCount,
  edgeCount,
}: StatusBarProps) {
  return (
    <footer className="status-bar" data-testid="status-bar" aria-live="polite">
      <span data-testid="status-ros">ROS：{rosStatus}</span>
      <span data-testid="status-canvas">画布：{canvasStatus}</span>
      <span data-testid="status-workspace">工作区：{workspace}</span>
      <span data-testid="status-graph">节点 {nodeCount} / 连线 {edgeCount}</span>
    </footer>
  );
}
