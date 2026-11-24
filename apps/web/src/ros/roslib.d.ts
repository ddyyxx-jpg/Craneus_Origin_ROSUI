// 最小的 roslib 本地类型声明。roslib@2.1.0 是 ESM-only，导出的类型与 exports map
// 不完整；这里只声明 RosClient 实际用到的 WebSocketTransportFactory 及其 transport 接口。
declare module 'roslib' {
  export interface RosbridgeMessageLike {
    op: string;
    [key: string]: unknown;
  }

  export interface RosTransportLike {
    on(event: 'open' | 'close' | 'error', listener: (event: unknown) => void): RosTransportLike;
    on(event: 'message', listener: (message: RosbridgeMessageLike) => void): RosTransportLike;
    send(message: RosbridgeMessageLike): void;
    close(): void;
    isOpen(): boolean;
  }

  export type RosTransportFactoryLike = (url: string) => Promise<RosTransportLike>;

  export const WebSocketTransportFactory: RosTransportFactoryLike;
}
