import { describe, expect, it, vi } from 'vitest';
import type { GraphIR, NodeIR } from '@rosui/ir';
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createClipboard,
  createSnapshotState,
  pasteGraph,
  pushSnapshot,
  type SnapshotState,
  redo,
  undo,
} from './history';

function graph(label: string): GraphIR {
  return { version: 1, nodes: [{ id: `n-${label}`, type: 'Gain', position: { x: 0, y: 0 }, params: {} }], edges: [] };
}

function selectedGraph(): GraphIR {
  return {
    version: 1,
    nodes: [
      {
        id: 'a',
        type: 'Gain',
        position: { x: 10, y: 20 },
        params: {
          gain: {
            node: '/ros_topic:12345',
            param: 'remote_gain',
            valueType: 'double',
            mode: 'runtime',
            widget: 'number',
            value: 2.5,
            constraints: { min: 0, max: 10, step: 0.5, unit: 'x', options: ['a', 'b'] },
          },
        },
      },
      {
        id: 'b',
        type: 'Gain',
        position: { x: 30, y: 40 },
        params: {
          gain: {
            node: 'b',
            param: 'gain',
            valueType: 'double',
            mode: 'static',
            widget: 'number',
            value: 4,
          },
        },
      },
      { id: 'c', type: 'Gain', position: { x: 50, y: 60 }, params: {} },
    ],
    edges: [
      { id: 'e-ab', source: 'a', sourcePort: 'out', target: 'b', targetPort: 'in' },
      { id: 'e-ac', source: 'a', sourcePort: 'out', target: 'c', targetPort: 'in' },
    ],
  };
}

describe('snapshot history', () => {
  it('keeps only the newest HISTORY_LIMIT snapshots', () => {
    let state = createSnapshotState();
    for (let i = 0; i < HISTORY_LIMIT + 25; i += 1) {
      state = pushSnapshot(state, graph(String(i)));
    }
    expect(state.undo).toHaveLength(HISTORY_LIMIT);
    expect(state.undo[0]?.nodes[0]?.id).toBe('n-25');
    expect(state.undo[HISTORY_LIMIT - 1]?.nodes[0]?.id).toBe(`n-${HISTORY_LIMIT + 24}`);
  });

  it('clears redo, returns new objects, and leaves inputs unchanged', () => {
    const initial = createSnapshotState();
    const afterFirst = pushSnapshot(initial, graph('first'));
    const afterSecond = pushSnapshot(afterFirst, graph('second'));
    const stepped = undo(afterSecond);
    expect(canRedo(stepped.state)).toBe(true);

    const pushed = pushSnapshot(stepped.state, graph('third'));
    expect(pushed).not.toBe(stepped.state);
    expect(pushed.undo).not.toBe(stepped.state.undo);
    expect(pushed.redo).toEqual([]);
    expect(stepped.state.redo).toHaveLength(1);
    expect(initial.undo).toEqual([]);
    expect(afterFirst.undo).toHaveLength(1);

    pushed.undo[0]?.nodes.push({ id: 'mutated', type: 'Gain', position: { x: 0, y: 0 }, params: {} });
    expect(afterSecond.undo[1]?.nodes).toHaveLength(1);
  });

  it('round-trips undo/redo with correct canUndo/canRedo boundaries', () => {
    let state = createSnapshotState();
    expect(canUndo(state)).toBe(false);
    state = pushSnapshot(state, graph('1'));
    expect(canUndo(state)).toBe(false);
    state = pushSnapshot(state, graph('2'));
    state = pushSnapshot(state, graph('3'));
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);

    const back = undo(state);
    expect(back.ir?.nodes[0]?.id).toBe('n-2');
    expect(back.state.undo).toHaveLength(2);
    expect(back.state.redo).toHaveLength(1);
    expect(canRedo(back.state)).toBe(true);
    expect(state.undo).toHaveLength(3);

    const forward = redo(back.state);
    expect(forward.ir?.nodes[0]?.id).toBe('n-3');
    expect(forward.state.undo).toHaveLength(3);
    expect(forward.state.redo).toEqual([]);
    expect(canRedo(forward.state)).toBe(false);

    const back2 = undo(forward.state);
    const back1 = undo(back2.state);
    expect(back1.ir?.nodes[0]?.id).toBe('n-1');
    expect(canUndo(back1.state)).toBe(false);
    expect(undo(back1.state).ir).toBeNull();
  });

  it('returns null and an unchanged state at history boundaries', () => {
    const empty = createSnapshotState();
    const emptyStep = undo(empty);
    expect(emptyStep.ir).toBeNull();
    expect(emptyStep.state).toBe(empty);
    expect(redo(empty).ir).toBeNull();
    expect(redo(empty).state).toBe(empty);

    const onlyOne = pushSnapshot(empty, graph('only'));
    const oneStep = undo(onlyOne);
    expect(oneStep.ir).toBeNull();
    expect(oneStep.state).toBe(onlyOne);
  });
});

describe('createClipboard', () => {
  it('copies selected nodes/edges, strips runtime ROS refs, and leaves input untouched', () => {
    const ir = selectedGraph();
    const before = JSON.stringify(ir);
    const clipboard = createClipboard(ir, new Set(['a', 'b']));

    expect(clipboard.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(clipboard.edges.map((edge) => edge.id)).toEqual(['e-ab']);

    const first = clipboard.nodes[0];
    const binding = first?.params['gain'];
    expect(binding?.mode).toBe('static');
    expect(binding?.node).toBe('a');
    expect(binding?.param).toBe('gain');
    expect(binding?.value).toBe(2.5);
    expect(binding?.valueType).toBe('double');
    expect(binding?.widget).toBe('number');
    expect(binding?.constraints).toEqual({ min: 0, max: 10, step: 0.5, unit: 'x', options: ['a', 'b'] });

    const staticBinding = clipboard.nodes[1]?.params['gain'];
    expect(staticBinding?.mode).toBe('static');
    expect(staticBinding?.node).toBe('b');
    expect(staticBinding?.value).toBe(4);

    expect(JSON.stringify(ir)).toBe(before);
    if (first) first.position.x = 999;
    expect(ir.nodes[0]?.position.x).toBe(10);
  });
});

describe('pasteGraph', () => {
  it('creates fresh ids, offsets positions, remaps internal edges, and preserves inputs', () => {
    const base = graph('base');
    const selected = selectedGraph();
    const clipboard = createClipboard(selected, new Set(['a', 'b']));
    const oldIds = [...clipboard.nodes.map((node) => node.id), ...clipboard.edges.map((edge) => edge.id)];
    const generated = ['new-a', 'new-b', 'new-e'].values();
    const makeId = vi.fn(() => generated.next().value ?? 'missing');
    const baseBefore = JSON.stringify(base);
    const clipboardBefore = JSON.stringify(clipboard);

    const result = pasteGraph(base, clipboard, makeId);
    expect(result.newIds).toEqual(['new-a', 'new-b']);
    expect(makeId).toHaveBeenCalledTimes(3);
    expect(result.newIds.every((id) => !oldIds.includes(id))).toBe(true);

    const pastedA = result.ir.nodes[1] as NodeIR | undefined;
    const pastedB = result.ir.nodes[2] as NodeIR | undefined;
    expect(pastedA?.position).toEqual({ x: 50, y: 60 });
    expect(pastedB?.position).toEqual({ x: 70, y: 80 });
    expect(pastedA?.params['gain']).toEqual({
      node: 'new-a',
      param: 'gain',
      valueType: 'double',
      mode: 'static',
      widget: 'number',
      value: 2.5,
      constraints: { min: 0, max: 10, step: 0.5, unit: 'x', options: ['a', 'b'] },
    });
    expect(pastedB?.params['gain']).toEqual({
      node: 'new-b',
      param: 'gain',
      valueType: 'double',
      mode: 'static',
      widget: 'number',
      value: 4,
    });
    expect(result.ir.edges).toEqual([
      expect.objectContaining({ id: 'new-e', source: 'new-a', target: 'new-b', sourcePort: 'out', targetPort: 'in' }),
    ]);
    expect(base.nodes).toHaveLength(1);
    expect(base.edges).toHaveLength(0);
    expect(JSON.stringify(base)).toBe(baseBefore);
    expect(JSON.stringify(clipboard)).toBe(clipboardBefore);

    if (pastedA) pastedA.position.x = 1234;
    expect(base.nodes[0]?.position.x).toBe(0);

    const empty = pasteGraph(base, { nodes: [], edges: [] }, makeId);
    expect(empty.newIds).toEqual([]);
    expect(empty.ir.nodes).toHaveLength(1);
    expect(empty.ir.edges).toHaveLength(0);
  });

  it('supports a custom offset', () => {
    const base = graph('base');
    const clipboard = createClipboard(selectedGraph(), new Set(['a']));
    const result = pasteGraph(base, clipboard, () => 'pasted', { x: -5, y: 100 });
    expect(result.ir.nodes[1]?.position).toEqual({ x: 5, y: 120 });
    expect(result.ir.nodes[1]?.params['gain']?.node).toBe('pasted');
  });

  it('remaps static binding node references to the pasted node id', () => {
    const base = graph('base');
    const source: GraphIR = {
      version: 1,
      nodes: [
        {
          id: 'old',
          type: 'Gain',
          position: { x: 1, y: 2 },
          params: {
            gain: {
              node: 'old',
              param: 'gain',
              valueType: 'double',
              mode: 'static',
              widget: 'number',
              value: 3,
            },
          },
        },
      ],
      edges: [],
    };
    const clipboard = createClipboard(source, new Set(['old']));
    const result = pasteGraph(base, clipboard, () => 'new');
    expect(result.ir.nodes[1]?.id).toBe('new');
    expect(result.ir.nodes[1]?.params['gain']?.node).toBe('new');
    expect(result.ir.nodes[1]?.params['gain']?.mode).toBe('static');
    expect(clipboard.nodes[0]?.params['gain']?.node).toBe('old');
  });

  it('caps redo at HISTORY_LIMIT', () => {
    const state: SnapshotState = {
      undo: [graph('current-below'), graph('current')],
      redo: Array.from({ length: HISTORY_LIMIT }, (_, index) => graph(`r-${index}`)),
    };

    const next = undo(state);
    expect(next.state.redo).toHaveLength(HISTORY_LIMIT);
    expect(next.state.redo[0]?.nodes[0]?.id).toBe('n-r-1');
    expect(next.state.redo.at(-1)?.nodes[0]?.id).toBe('n-current');
    expect(state.redo).toHaveLength(HISTORY_LIMIT);
  });
});
