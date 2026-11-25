import type { ParamBindingRef, ParamValue } from '../ros';

/** 控件侧期望的 ROS 参数类型，用来拒绝明显不匹配的事件值。 */
export type BindingValueType = 'double' | 'integer' | 'bool' | 'string' | 'double_array';

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
  [`Pose:pose`, { ref: { node: DEMO_NODE, param: 'pose' }, valueType: 'double_array' }],
  // Threshold.value 故意不绑定：用来演示「未绑定」状态。
]);

/**
 * 纯函数：按节点类型 + 端口名查绑定表；未绑定返回 undefined。
 * 用 `${nodeType}:${portKey}` 作为键，避免属性名冲突（如 `__proto__`）。
 */
export function bindingFor(nodeType: string, portKey: string): ParamBindingDefinition | undefined {
  return BINDINGS.get(`${nodeType}:${portKey}`);
}

/** M4 A：运行期绑定按节点实例 id 索引，优先级高于静态表。 */
const RUNTIME_BINDINGS = new Map<string, ParamBindingDefinition>();

function runtimeKey(nodeType: string, portKey: string, instanceId?: string): string {
  const base = `${nodeType}:${portKey}`;
  return instanceId ? `${base}@${instanceId}` : base;
}

/** 只按实例查询运行期绑定（IR 生成用）。 */
export function runtimeBindingFor(
  nodeType: string,
  portKey: string,
  instanceId?: string,
): ParamBindingDefinition | undefined {
  return RUNTIME_BINDINGS.get(runtimeKey(nodeType, portKey, instanceId));
}

/** 查找绑定：运行期优先，未命中回落静态硬编码表。 */
export function bindingForInstance(
  nodeType: string,
  portKey: string,
  instanceId?: string,
): ParamBindingDefinition | undefined {
  return runtimeBindingFor(nodeType, portKey, instanceId) ?? bindingFor(nodeType, portKey);
}

/** 建立/替换一条运行期绑定。 */
export function setRuntimeBinding(
  nodeType: string,
  portKey: string,
  definition: ParamBindingDefinition,
  instanceId?: string,
): void {
  RUNTIME_BINDINGS.set(runtimeKey(nodeType, portKey, instanceId), definition);
}

/** 删除一条运行期绑定；返回是否确有删除。 */
export function clearRuntimeBinding(
  nodeType: string,
  portKey: string,
  instanceId?: string,
): boolean {
  return RUNTIME_BINDINGS.delete(runtimeKey(nodeType, portKey, instanceId));
}

/** 列出全部运行期绑定（Inspector 面板用）。 */
export function listRuntimeBindings(): ReadonlyArray<{
  nodeType: string;
  portKey: string;
  instanceId?: string;
  definition: ParamBindingDefinition;
}> {
  return [...RUNTIME_BINDINGS.entries()].map(([key, definition]) => {
    const at = key.lastIndexOf('@');
    if (at >= 0) {
      return {
        nodeType: key.slice(0, key.indexOf(':')),
        portKey: key.slice(key.indexOf(':') + 1, at),
        instanceId: key.slice(at + 1),
        definition,
      };
    }
    const colon = key.indexOf(':');
    return {
      nodeType: key.slice(0, colon),
      portKey: key.slice(colon + 1),
      definition,
    };
  });
}

/** 把 getParam 返回的 ROS 类型映射到控件侧 BindingValueType；integer 按 double 处理。 */
export function bindingTypeFromRos(paramType: string): BindingValueType | undefined {
  const normalized = paramType.toLowerCase();
  switch (normalized) {
    case 'double':
    case 'int':
    case 'integer':
      return 'double';
    case 'bool':
    case 'boolean':
      return 'bool';
    case 'string':
      return 'string';
    case 'double_array':
    case 'int_array':
    case 'integer_array':
      return 'double_array';
    default:
      return undefined;
  }
}

/** 事件值是否匹配绑定的 ROS 类型（严格校验，避免把 error 字符串写进控件）。 */
export function matchesBindingType(value: ParamValue, type: BindingValueType): boolean {
  switch (type) {
    case 'double':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'double_array':
      return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v));
  }
}

/** 画布控件期望类型：绑定类型校验用，拒绝 string 参数绑到 number 控件等错配。 */
const CONTROL_TYPES: ReadonlyMap<string, BindingValueType> = new Map([
  ['Gain:gain', 'double'],
  ['Threshold:value', 'double'],
  ['Label:name', 'string'],
  ['Mode:mode', 'string'],
  ['Switch:enabled', 'bool'],
  ['Pose:pose', 'double_array'],
]);

export function controlValueType(nodeType: string, portKey: string): BindingValueType | undefined {
  return CONTROL_TYPES.get(`${nodeType}:${portKey}`);
}

/** 参数类型是否与控件期望类型兼容（integer 按 double 处理）。 */
export function typesCompatible(param: BindingValueType, control: BindingValueType | undefined): boolean {
  if (!control) return false;
  if (param === control) return true;
  return (param === 'double' || param === 'integer') && (control === 'double' || control === 'integer');
}
