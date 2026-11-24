import { RosClientImpl } from './RosClient';
import type { RosClient, RosClientOptions } from './types';

let sharedClient: RosClientImpl | undefined;

/** UI 共用的单例；需要独立连接时直接 new RosClientImpl(options)。 */
export function getSharedClient(options?: RosClientOptions): RosClient {
  if (!sharedClient) sharedClient = new RosClientImpl(options);
  return sharedClient;
}

/** 仅用于测试重置单例。 */
export function resetSharedClient(): void {
  sharedClient?.close();
  sharedClient = undefined;
}
