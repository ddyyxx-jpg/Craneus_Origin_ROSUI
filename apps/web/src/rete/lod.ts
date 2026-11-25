import { useSyncExternalStore } from 'react';

/** 缩放低于该值时，节点切换到占位渲染，避免大量 DOM 控件拖慢交互。 */
export const LOD_THRESHOLD = 0.35;

/** 当前 LOD 模式。 */
export type Lod = 'full' | 'placeholder';

let current: Lod = 'full';
const listeners = new Set<() => void>();
/** 切换前的节点尺寸：占位模式用它锁定同尺寸，避免连线端点漂移。 */
const sizes = new Map<string, { width: number; height: number }>();

function snapshot(): Lod {
  return current;
}

/** 同步读取当前模式（供 zoom 监听判断是否跨越阈值）。 */
export function getLod(): Lod {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 根据当前缩放更新 LOD；仅跨越阈值时通知订阅者，避免每帧 setState。 */
export function setLodZoom(k: number): void {
  const next: Lod = k < LOD_THRESHOLD ? 'placeholder' : 'full';
  if (next === current) return;
  current = next;
  notify();
}

/** 记录节点切换前的真实 DOM 尺寸，占位模式复用它们保持节点外框不变。 */
export function captureNodeSizes(
  entries: readonly { id: string; width: number; height: number }[],
): void {
  sizes.clear();
  for (const entry of entries) sizes.set(entry.id, { width: entry.width, height: entry.height });
}

/** 读取占位模式应使用的节点尺寸。 */
export function placeholderSize(id: string): { width: number; height: number } | undefined {
  return sizes.get(id);
}

/** 恢复完整渲染并清空缓存尺寸（编辑器销毁时调用）。 */
export function resetLod(): void {
  sizes.clear();
  if (current === 'full') return;
  current = 'full';
  notify();
}

/** 订阅当前 LOD；返回稳定字符串快照，适合 useSyncExternalStore。 */
export function useLod(): Lod {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
