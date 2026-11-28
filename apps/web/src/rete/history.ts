import type { GraphIR, NodeIR, EdgeIR, ParamBinding } from '@rosui/ir';

/** Maximum number of snapshots retained on either side of the history. */
export const HISTORY_LIMIT = 100;

export interface SnapshotState {
  undo: GraphIR[];
  redo: GraphIR[];
}

/** Empty history. A fresh pair of arrays is returned on every call. */
export function createSnapshotState(): SnapshotState {
  return { undo: [], redo: [] };
}

/**
 * Commit a new snapshot after a mutation boundary.
 * The IR is deep-cloned, appended to undo, and undo is trimmed to the newest
 * HISTORY_LIMIT entries. Redo is always cleared. Inputs are never mutated.
 */
export function pushSnapshot(state: SnapshotState, ir: GraphIR): SnapshotState {
  const snapshot = structuredClone(ir);
  const undo = [...state.undo, snapshot];
  const trimmed = undo.length > HISTORY_LIMIT ? undo.slice(undo.length - HISTORY_LIMIT) : undo;
  return { undo: trimmed, redo: [] };
}

export function canUndo(state: SnapshotState): boolean {
  return state.undo.length >= 2;
}

export function canRedo(state: SnapshotState): boolean {
  return state.redo.length >= 1;
}

export interface HistoryStep {
  state: SnapshotState;
  ir: GraphIR | null;
}

/**
 * Undo one step. The top of `undo` is the current state, so the restored
 * graph is the entry just below it and the current entry moves to `redo`.
 */
export function undo(state: SnapshotState): HistoryStep {
  if (!canUndo(state)) return { state, ir: null };

  const restored = state.undo[state.undo.length - 2];
  const moved = state.undo[state.undo.length - 1];
  if (restored === undefined || moved === undefined) return { state, ir: null };

  const redo = [...state.redo, moved];
  const cappedRedo = redo.length > HISTORY_LIMIT ? redo.slice(redo.length - HISTORY_LIMIT) : redo;
  return {
    state: { undo: state.undo.slice(0, -1), redo: cappedRedo },
    ir: restored,
  };
}

/** Redo one step, moving the top of `redo` back onto `undo`. */
export function redo(state: SnapshotState): HistoryStep {
  if (!canRedo(state)) return { state, ir: null };

  const moved = state.redo[state.redo.length - 1];
  if (moved === undefined) return { state, ir: null };

  return {
    state: {
      undo: [...state.undo, moved],
      redo: state.redo.slice(0, -1),
    },
    ir: moved,
  };
}

export interface ClipboardData {
  nodes: NodeIR[];
  edges: EdgeIR[];
}

/**
 * Convert any binding into a literal, static binding owned by one copied node.
 * `ParamBinding` requires both `node` and `param`, so ROS references are
 * replaced by the copied node's own id and local param key. Display fields,
 * value and constraints are preserved.
 */
function toStaticBinding(nodeId: string, paramKey: string, binding: ParamBinding): ParamBinding {
  return {
    ...binding,
    node: nodeId,
    param: paramKey,
    mode: 'static',
  };
}

/**
 * Copy the selected subgraph and strip ROS runtime references from its params.
 * Source order is preserved; only edges with both endpoints selected survive.
 */
export function createClipboard(ir: GraphIR, selectedIds: ReadonlySet<string>): ClipboardData {
  const cloned = structuredClone(ir);

  const nodes = cloned.nodes
    .filter((node) => selectedIds.has(node.id))
    .map((node) => {
      const params: Record<string, ParamBinding> = {};
      for (const [paramKey, binding] of Object.entries(node.params)) {
        params[paramKey] = toStaticBinding(node.id, paramKey, binding);
      }
      return { ...node, params };
    });

  const selectedNodeIds = new Set(nodes.map((node) => node.id));
  const edges = cloned.edges.filter(
    (edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target),
  );

  return { nodes, edges };
}

/**
 * Produce the complete graph after pasting. All ids for pasted nodes and
 * internal edges come from the injected `makeId`; offsets are read-only.
 */
export function pasteGraph(
  base: GraphIR,
  clipboard: ClipboardData,
  makeId: () => string,
  offset: { x: number; y: number } = { x: 40, y: 40 },
): { ir: GraphIR; newIds: string[] } {
  const next = structuredClone(base);
  if (clipboard.nodes.length === 0) return { ir: next, newIds: [] };

  const copied = structuredClone(clipboard);
  const idMap = new Map<string, string>();
  const newIds: string[] = [];

  for (const node of copied.nodes) {
    const newId = makeId();
    idMap.set(node.id, newId);
    newIds.push(newId);
    // 复制节点的绑定一律是静态字面量：把 node 引用重映射到新 id，避免
    // 旧节点 id 被 restoreBinding 写入 restoredBinding 后污染后续序列化。
    const params: Record<string, ParamBinding> = {};
    for (const [paramKey, binding] of Object.entries(node.params)) {
      params[paramKey] = toStaticBinding(newId, paramKey, binding);
    }
    node.id = newId;
    node.position = {
      x: node.position.x + offset.x,
      y: node.position.y + offset.y,
    };
    node.params = params;
    next.nodes.push(node);
  }

  for (const edge of copied.edges) {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (source === undefined || target === undefined) continue;

    edge.id = makeId();
    edge.source = source;
    edge.target = target;
    next.edges.push(edge);
  }

  return { ir: { version: 1, nodes: next.nodes, edges: next.edges }, newIds };
}
