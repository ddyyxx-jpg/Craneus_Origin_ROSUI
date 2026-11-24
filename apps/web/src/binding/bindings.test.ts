import { describe, expect, it } from 'vitest';
import { bindingFor, matchesBindingType } from './bindings';

describe('bindingFor', () => {
  it('映射四个绑定中的三个（Threshold 故意不绑定）', () => {
    expect(bindingFor('Gain', 'gain')).toEqual({
      ref: { node: '/rosui_demo', param: 'gain' },
      valueType: 'double',
    });
    expect(bindingFor('Switch', 'enabled')).toEqual({
      ref: { node: '/rosui_demo', param: 'enabled' },
      valueType: 'bool',
    });
    expect(bindingFor('Mode', 'mode')).toEqual({
      ref: { node: '/rosui_demo', param: 'mode' },
      valueType: 'string',
    });
    expect(bindingFor('Threshold', 'value')).toBeUndefined();
    expect(bindingFor('Label', 'name')).toBeUndefined();
    expect(bindingFor('Gain', 'nope')).toBeUndefined();
  });

  it('未知键不会命中原型属性', () => {
    expect(bindingFor('__proto__', 'toString')).toBeUndefined();
  });
});

describe('matchesBindingType', () => {
  it('按 ROS 类型拒绝错值', () => {
    expect(matchesBindingType(1.25, 'double')).toBe(true);
    expect(matchesBindingType('1.25', 'double')).toBe(false);
    expect(matchesBindingType(true, 'bool')).toBe(true);
    expect(matchesBindingType(1, 'bool')).toBe(false);
    expect(matchesBindingType('high', 'string')).toBe(true);
    expect(matchesBindingType(42, 'string')).toBe(false);
    expect(matchesBindingType([0, 0, 0, 0, 0, 0, 1], 'double_array')).toBe(true);
    expect(matchesBindingType(['x'], 'double_array')).toBe(false);
  });
});
