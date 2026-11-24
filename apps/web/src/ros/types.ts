/** 连接状态。 */
export type RosStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

/** rosbridge transport 工厂，测试可注入假实现；生产默认使用 roslib 的 WebSocketTransportFactory。 */
export interface RosTransport {
  on(event: 'open' | 'close' | 'error', listener: (event: unknown) => void): RosTransport;
  on(event: 'message', listener: (message: RosbridgeMessage) => void): RosTransport;
  send(message: RosbridgeMessage): void;
  close(): void;
  isOpen(): boolean;
}

/** rosbridge 协议消息的极简形状，真实消息用 unknown 收窄后读取。 */
export interface RosbridgeMessage {
  op: string;
  [key: string]: unknown;
}

export type RosTransportFactory = (url: string) => Promise<RosTransport>;

export interface RosReconnectOptions {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
}

export interface RosClientOptions {
  url?: string;
  reconnect?: RosReconnectOptions;
  /** 仅用于测试/自定义底层通道；不传则动态 import roslib 的 WebSocketTransportFactory。 */
  transportFactory?: RosTransportFactory;
  /** 连接建立时的等待上限，默认 5000ms。 */
  connectTimeoutMs?: number;
  /** 重连并重新拉到全量参数列表后触发。 */
  onReconnected?: (names: string[]) => void;
}

/** node 形如 "/rosui_demo"。 */
export interface ParamBindingRef {
  node: string;
  param: string;
}

/** ROS 参数的运行时值；数组元素为 JSON 可表达的基本类型。 */
export type ParamValue =
  | string
  | number
  | boolean
  | number[]
  | string[]
  | boolean[]
  | (string | number | boolean)[]
  | null;

export interface ParamGetResult {
  name: string;
  /** 尽力推断的 ROS 参数类型（double / bool / string / double_array 等）。 */
  type: string;
  value: ParamValue;
}

export interface ParamSetResult {
  successful: boolean;
  reason?: string;
}

/** 单条 Parameter 消息（new/changed/deleted 中的元素）。 */
export interface ParamLike {
  name: string;
  value: ParamValue;
}

/** rcl_interfaces/msg/ParameterEvent 的可消费形状。 */
export interface ParamEventLike {
  node: string;
  newParameters: ParamLike[];
  changedParameters: ParamLike[];
  deletedParameters: ParamLike[];
  sec?: number;
  nanosec?: number;
}

export interface RosClient {
  readonly status: RosStatus;
  connect(): Promise<void>;
  close(): void;
  onStatus(cb: (s: RosStatus, detail?: string) => void): () => void;

  getParamNames(): Promise<string[]>;
  getParam(ref: ParamBindingRef): Promise<ParamGetResult>;
  setParam(ref: ParamBindingRef, value: ParamValue): Promise<ParamSetResult>;

  /** 订阅 /parameter_events，按 ref 过滤；返回取消订阅函数。 */
  subscribeParam(ref: ParamBindingRef, cb: (value: ParamValue) => void): () => void;
  /** 底层事件流（调试/未知参数）。 */
  subscribeAllParamEvents(cb: (evt: ParamEventLike) => void): () => void;
}
