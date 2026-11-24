import type { ParamBindingRef, ParamValue } from '../ros';

/** 控件侧期望的 ROS 参数类型，用来拒绝明显不匹配的事件值。 */
export type BindingValueType = 'double' | 'bool' | 'string' | 'double_array';

/** 一条「节点类型 + 端口名 → ROS 参数」的静态绑定。 */
export interface ParamBindingDefinition {
  /** node 带前导 `/`，param 不含冒号；组合后形如 `/rosui_demo:gain`。 */
  readonly ref: ParamBindingRef;
  readonly valueType: BindingValueType;
}

const DEMO_NODE = '/rosui_demo';

const BINDINGS: ReadonlyMap<string, ParamBindingDefinition> = new Map([
  [`Gain:gain`, { ref: { node: DEMO_NODE, param: 'gain' }, valueType: 'double' }],
  [`Switch:enabled`, { ref: { node: DEMO_NODE, param: 'enabled' }, valueType: 'bool' }],
  [`Mode:mode`, { ref: { node: DEMO_NODE, param: 'mode' }, valueType: 'string' }],
  // Threshold.value 故意不绑定：用来演示「未绑定」状态。
]);

/**
 * 纯函数：按节点类型 + 端口名查绑定表；未绑定返回 undefined。
 * 用 `${nodeType}:${portKey}` 作为键，避免属性名冲突（如 `__proto__`）。
 */
export function bindingFor(nodeType: string, portKey: string): ParamBindingDefinition | undefined {
  return BINDINGS.get(`${nodeType}:${portKey}`);
}

/** 事件值是否匹配绑定的 ROS 类型（严格校验，避免把 error 字符串写进控件）。 */
export function matchesBindingType(value: ParamValue, type: BindingValueType): boolean {
  switch (type) {
    case 'double':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'double_array':
      return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v));
  }
}
