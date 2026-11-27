import { useSyncExternalStore } from 'react';

/** 从 full 进入 placeholder 的阈值：缩放小于它才降级。 */
export const LOD_ENTER_THRESHOLD = 0.32;
/** 从 placeholder 回到 full 的阈值：必须大于它才升级；两段阈值间保留原状态（hysteresis）。 */
export const LOD_EXIT_THRESHOLD = 0.38;

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

/**
 * 根据当前缩放更新 LOD；双阈值去抖，只有真正跨阈值才 notify。
 * 0.32~0.38 之间保持原状态，避免滚轮停在阈值附近时反复整树卸载/重挂。
 */
export function setLodZoom(k: number): void {
  const next: Lod =
    current === 'full'
      ? k < LOD_ENTER_THRESHOLD
        ? 'placeholder'
        : 'full'
      : k > LOD_EXIT_THRESHOLD
        ? 'full'
        : 'placeholder';
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

/**
 * 补采单个节点的真实尺寸（不清空其它节点缓存）。
 * 二轮评审 P1-B：只允许 full 模式调用；placeholder 的 offsetWidth/Height 是占位/兜底尺寸，
 * 回写会污染跨阈值前 captureNodeSizes 锁定的真实尺寸，切回 full 后节点会跳变。
 */
export function updateNodeSize(id: string, width: number, height: number): boolean {
  const old = sizes.get(id);
  sizes.set(id, { width, height });
  return old?.width !== width || old?.height !== height;
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
