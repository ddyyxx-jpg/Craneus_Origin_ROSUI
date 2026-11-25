import type {
  ParamEventLike,
  ParamLike,
  ParamValue,
  RosbridgeMessage,
  RosTransportFactory,
} from './types';

export const DEFAULT_URL = 'ws://127.0.0.1:9090';
export const PARAM_EVENT_TOPIC = '/parameter_events';
export const PARAM_EVENT_TYPE = 'rcl_interfaces/msg/ParameterEvent';

// rcl_interfaces/msg/ParameterType
const PARAMETER_BOOL = 1;
const PARAMETER_INTEGER = 2;
const PARAMETER_DOUBLE = 3;
const PARAMETER_STRING = 4;
const PARAMETER_BYTE_ARRAY = 5;
const PARAMETER_BOOL_ARRAY = 6;
const PARAMETER_INTEGER_ARRAY = 7;
const PARAMETER_DOUBLE_ARRAY = 8;
const PARAMETER_STRING_ARRAY = 9;

let defaultFactoryPromise: Promise<RosTransportFactory> | undefined;

/** 动态加载 roslib 的 WebSocketTransportFactory，避免在模块加载期就依赖浏览器 WebSocket。 */
export async function getDefaultTransportFactory(): Promise<RosTransportFactory> {
  if (!defaultFactoryPromise) {
    defaultFactoryPromise = import('roslib').then((mod) => {
      const factory: unknown = mod.WebSocketTransportFactory;
      if (typeof factory !== 'function') {
        throw new Error('roslib 未导出 WebSocketTransportFactory');
      }
      return factory as RosTransportFactory;
    });
  }
  return defaultFactoryPromise;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;
}

export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** "/node" + "param" -> "/node:param"，tolerate 调用方多写了冒号。 */
export function fullParamName(node: string, param: string): string {
  const n = node.endsWith('/') ? node.slice(0, -1) : node;
  const p = param.startsWith(':') ? param.slice(1) : param;
  return `${n}:${p}`;
}

/** rosapi/get_param 返回 JSON 文本；rosapi/set_param 也要求 JSON 文本。 */
export function encodeParamValue(value: ParamValue): string {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    // "42" 会被 rclpy 推断为 int；补 .0 保持 double 语义（demo 的 gain 就是 double）。
    return `${value}.0`;
  }
  // 数值数组同样经 rclpy YAML 推断：整数字面量会被当成 int，mixed int/float 会被当成
  // STRING（导致 double_array 参数被拒）。每个数值项都补 .0，保持 double_array 语义。
  // 字符串数组与其他类型原样 JSON.stringify，不影响 string_array 场景。
  if (
    Array.isArray(value) &&
    value.every((item): item is number => typeof item === 'number' && Number.isFinite(item))
  ) {
    return `[${value.map((item) => (Number.isInteger(item) ? `${item}.0` : String(item))).join(',')}]`;
  }
  return JSON.stringify(value);
}

export function decodeParamValue(raw: unknown): ParamValue {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  const numericType = typeof type === 'number' ? type : Number(type);
  const toNumberArray = (v: unknown): number[] | null =>
    Array.isArray(v) ? v.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : null;
  const toStringArray = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  const toBoolArray = (v: unknown): boolean[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'boolean') ? (v as boolean[]) : null;

  switch (numericType) {
    case PARAMETER_BOOL:
      return typeof raw.bool_value === 'boolean' ? raw.bool_value : null;
    case PARAMETER_INTEGER:
    case PARAMETER_DOUBLE: {
      const source = numericType === PARAMETER_INTEGER ? raw.integer_value : raw.double_value;
      const n = Number(source);
      return Number.isFinite(n) ? n : null;
    }
    case PARAMETER_STRING:
      return typeof raw.string_value === 'string' ? raw.string_value : null;
    case PARAMETER_BYTE_ARRAY:
    case PARAMETER_INTEGER_ARRAY:
    case PARAMETER_DOUBLE_ARRAY:
      return toNumberArray(raw.double_array_value ?? raw.integer_array_value ?? raw.byte_array_value);
    case PARAMETER_BOOL_ARRAY:
      return toBoolArray(raw.bool_array_value);
    case PARAMETER_STRING_ARRAY:
      return toStringArray(raw.string_array_value);
    default:
      // 某些 bridge 版本省略 type，仅填一个 *_value 字段。
      if (typeof raw.type === 'string' && raw.type.length > 0) {
        // 例如 "double"/"bool"，仍按字段值推断。
      }
      if (typeof raw.bool_value === 'boolean') return raw.bool_value;
      if (typeof raw.string_value === 'string') return raw.string_value;
      const direct = toNumberArray(raw.double_array_value ?? raw.integer_array_value);
      if (direct) return direct;
      const n = Number(raw.double_value ?? raw.integer_value);
      return Number.isFinite(n) ? n : null;
  }
}

export function inferParamType(value: ParamValue): string {
  if (value === null) return 'unknown';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'string') return 'string';
  if (value.length === 0) return 'array';
  if (typeof value[0] === 'boolean') return 'bool_array';
  if (typeof value[0] === 'string') return 'string_array';
  return 'double_array';
}

/** 把 JSON 文本（rosapi/get_param 的 value 字段）解成运行时值。 */
export function parseRosapiValue(text: string): ParamValue {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed === 'string' ||
      typeof parsed === 'boolean' ||
      typeof parsed === 'number'
    ) {
      return parsed;
    }
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
      return parsed as ParamValue;
    }
    if (isRecord(parsed)) return decodeParamValue(parsed);
  } catch {
    return text;
  }
  return null;
}

function parseParameterList(raw: unknown): ParamLike[] {
  if (!Array.isArray(raw)) return [];
  const out: ParamLike[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = asString(item.name);
    if (name === undefined) continue;
    out.push({ name, value: decodeParamValue(item.value) });
  }
  return out;
}

/** 解析 /parameter_events 的 publish 消息；格式错误返回 null。 */
export function parseParamEvent(msg: unknown): ParamEventLike | null {
  if (!isRecord(msg)) return null;
  const node = asString(msg.node);
  if (node === undefined) return null;
  const stamp = isRecord(msg.stamp) ? msg.stamp : undefined;
  return {
    node,
    newParameters: parseParameterList(msg.new_parameters),
    changedParameters: parseParameterList(msg.changed_parameters),
    deletedParameters: parseParameterList(msg.deleted_parameters),
    sec: typeof stamp?.sec === 'number' ? stamp.sec : undefined,
    nanosec: typeof stamp?.nanosec === 'number' ? stamp.nanosec : undefined,
  };
}

export function makeCallMessage(
  service: string,
  args: Record<string, unknown>,
  id: string,
  timeoutSec = 5,
): RosbridgeMessage {
  return { op: 'call_service', id, service, args, timeout: timeoutSec };
}

export function makeSubscribeMessage(id: string): RosbridgeMessage {
  return { op: 'subscribe', topic: PARAM_EVENT_TOPIC, type: PARAM_EVENT_TYPE, id };
}

export function makeUnsubscribeMessage(id: string): RosbridgeMessage {
  return { op: 'unsubscribe', topic: PARAM_EVENT_TOPIC, id };
}
