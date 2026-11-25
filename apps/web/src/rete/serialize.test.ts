import { describe, expect, it } from 'vitest';
import { parseGraph } from '@rosui/ir';
import { NODE_REGISTRY } from './nodes';
import { bindingForNode, collectBindings, kindForType } from './serialize';

describe('loadGraph 入参校验', () => {
  it('非法 IR 直接抛错，交给调用方 toast', () => {
    expect(() => parseGraph({ version: 2, nodes: [], edges: [] })).toThrow(/Invalid GraphIR/);
    expect(() => parseGraph({ version: 1, nodes: [{ id: 'a' }], edges: [] })).toThrow();
  });
});

describe('kindForType 覆盖 NODE_REGISTRY 全部条目', () => {
  it('每个 type 都能大小写不敏感地反查回 kind', () => {
    for (const [kind, spec] of Object.entries(NODE_REGISTRY)) {
      expect(kindForType(spec.type)).toBe(kind);
      expect(kindForType(spec.type.toLowerCase())).toBe(kind);
    }
    expect(kindForType('Unknown')).toBeUndefined();
  });
});

describe('collectBindings / bindingForNode', () => {
  const ir = {
    id: 'p1',
    type: 'Pose',
    position: { x: 0, y: 0 },
    params: {
      pose: {
        node: 'p1',
        param: 'pose',
        valueType: 'double_array' as const,
        mode: 'static' as const,
        widget: 'pose' as const,
        value: [4.5, 0, 0, 0, 0, 0, 1],
      },
    },
  };

  it('抽取值用于恢复控件', () => {
    expect(collectBindings(ir)).toHaveLength(1);
    expect(bindingForNode(ir)?.value).toEqual([4.5, 0, 0, 0, 0, 0, 1]);
  });

  it('空 params 时保留节点默认绑定结构，后续交给控件默认值', () => {
    const empty = { ...ir, params: {} };
    expect(collectBindings(empty)).toHaveLength(1);
    expect(bindingForNode(empty)?.value).toBeUndefined();
  });

  it('Script 节点优先 code 绑定', () => {
    const script = {
      id: 's1',
      type: 'Script',
      position: { x: 0, y: 0 },
      params: {
        x: { node: 's1', param: 'x', valueType: 'double' as const, mode: 'static' as const, widget: 'number' as const, value: 1 },
        code: { node: 's1', param: 'code', valueType: 'string' as const, mode: 'static' as const, widget: 'text' as const, value: 'return x * 3;' },
      },
    };
    expect(bindingForNode(script)?.param).toBe('code');
  });
});
