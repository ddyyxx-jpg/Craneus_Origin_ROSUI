import { describe, expect, it } from 'vitest';
import { GraphIRParseError, parseGraph, type GraphIR } from '../src/index.js';

const validGraph: GraphIR = {
  version: 1,
  nodes: [
    {
      id: 'gain-1',
      type: 'Gain',
      position: { x: 100, y: 200 },
      params: {
        gain: {
          node: 'gain-1',
          param: 'gain',
          valueType: 'double',
          mode: 'static',
          widget: 'number',
          constraints: { min: 0, max: 10, step: 0.1 },
        },
      },
    },
  ],
  edges: [],
};

describe('parseGraph', () => {
  it('accepts a valid GraphIR v1 document', () => {
    expect(parseGraph(validGraph)).toEqual(validGraph);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseGraph({ ...validGraph, version: 2 })).toThrow(GraphIRParseError);
  });

  it('rejects a missing required node field', () => {
    const bad = {
      version: 1,
      nodes: [{ id: 'gain-1', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    };
    expect(() => parseGraph(bad)).toThrow(GraphIRParseError);
  });

  it('rejects an invalid ParamBinding mode', () => {
    const bad = structuredClone(validGraph);
    const binding = bad.nodes[0]?.params['gain'];
    if (!binding) throw new Error('fixture broken');
    binding.mode = 'invalid' as typeof binding.mode;
    expect(() => parseGraph(bad)).toThrow(GraphIRParseError);
  });

  it('rejects an edge referencing missing fields', () => {
    const bad = {
      ...validGraph,
      edges: [{ id: 'e1', source: 'gain-1', sourcePort: 'out' }],
    };
    expect(() => parseGraph(bad)).toThrow(GraphIRParseError);
  });
});
