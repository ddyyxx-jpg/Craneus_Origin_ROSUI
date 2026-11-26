# M5 性能评审：LOD 混合渲染 + 200 节点压测（T-031）

评审对象：`feat/m5-lod-perf`（从 `feat/m5-save-load` 拉出；**必须先合 PR #3 保存/加载**，因为 `editor.ts` 依赖 `serialize.ts`）
评审方式：Playwright Chromium headless（1280×720），不依赖 ROS，纯 UI 压测
截图：`docs/artifacts/m5-perf.png`（placeholder 模式下 200 节点；由 `testInfo.outputPath()` 产物手动复制）
默认门禁：`e2e/perf.spec.ts` 默认跳过；显式开启 `ROSUI_PERF=1 node node_modules/@playwright/test/cli.js test e2e/perf.spec.ts`

## 实现要点（评审后）

- LOD 阈值：`<0.32` 进入占位，`>0.38` 回到 full，中间保持原状态（hysteresis）。
- 状态分发：`apps/web/src/rete/lod.ts` 用 `useSyncExternalStore` 广播全/占位两态，跨阈值才 `notify()`；
  `editor.ts` 在 `area.addPipe('zoomed')` 里用 rAF 合并缩放事件。
- 占位 DOM 复用 classic 布局类；socket 中心偏移 full ↔ placeholder ≤2px（`e2e/lod.spec.ts` 固化）。
  占位带 `selected` class 与 `data-selected`，样式与 classic 一致；socket 带 `data-testid`。
- 尺寸缓存：跨阈值前与 area 的 `render`/`noderesized` 管道采样 `offsetWidth/Height`，
  覆盖 `addNode()` 生产路径与 `loadGraph` 恢复节点；full 模式下尺寸变化才 `area.update`。
- **已知限制**：`lod.ts` 模块级单例暂不支持多 editor 实例；分屏时需改 `WeakMap<AreaPlugin, Store>`（见 ADR-008）。
- 测试支撑：`EditorHandle.addNodeKind(kind,x,y)` / `addNodes(n)` / `setZoom(k)` 仅暴露给 DEV 的 `window.__rosui`；
  `addNodes` 走生产 `addNode()` 路径，生成 gain/pose/inspector/script 混合类型 + 149 条真实连线。

## 测量方法（`e2e/perf.spec.ts`）

每个用例独立页面，等待 `canvas-status[data-state=ready]`，然后：

1. `setZoom(1)`（full）或 `setZoom(0.28)`（placeholder）→ 等一帧 → `editor.clear()`；
2. `performance.now()` 起表 → `handle.addNodes(200)` → 轮询直到编辑器节点数、`area.nodeViews`
   与 DOM 节点视图数都达 200 → 再等一帧 → 停表，记为 **200 节点首帧完成时间**；
3. 选中第 11 个新节点，连续 30 次 `area.translate` + `requestAnimationFrame` 采样，
   相邻 rAF 时间戳差即帧时间，取平均值与最大值，记为 **拖动平均帧时间**；
4. 两组独立重复同一函数，口径一致；结果 `console.log` 到测试输出。
   断言为对比式：placeholder 首帧 `< 0.85 × full 首帧`，拖动均值 `≤ full × 1.2`。

## 真实数字（`ROSUI_PERF=1` 一次权威运行，200 节点 + 149 连线）

| 模式 | 节点数 | 连线 | 首帧完成 (ms) | 拖动平均帧 (ms) | 拖动最大帧 (ms) | placeholder 节点数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| full (k=1) | 200 | 149 | 743.8 | 16.19 | 16.8 | 0 |
| placeholder (k=0.28) | 200 | 149 | 370.9 | 16.14 | 16.8 | 200 |

首帧对比：370.9 / 743.8 = 49.9%，满足 `<0.85×full`；拖动 16.14 ≤ 16.19×1.2，满足。
（headless Chromium 空转 rAF 约 16.4ms/帧；拖动贴近上限，说明没有额外的逐帧重排。）

评审前旧口径（200 个纯 gain 节点、无连线）为 full 366.0 / 16.53、placeholder 239.6 / 16.13；
新增混合类型与 149 条连线后两者成本都上升，但相对比例仍接近 50%。

## 阈值依据（评审 #5）

- **0.85 首帧比例**：同机多轮 placeholder/full 比例约 0.5~0.66，留约 20 个百分点余量；
  若 placeholder 首帧退化到 full 的 85% 以上，说明 LOD 失去意义，判失败。
- **1.2 拖动上限**：rAF 被 vsync 锁到 ~16.7ms，不能用固定毫秒阈值判断退化；
  改用相对 full 的 1.2 倍，容忍 20% 抖动但能抓住“占位反而更慢”的实质退化。

## 结论

- **拖动可交互**：full 16.19ms、placeholder 16.14ms，均低于 33ms/帧。
- LOD 降级收益在首帧（743.8ms → 370.9ms，约 -50%），因为控件 DOM 与布局成本下降。
- 阈值切换可恢复：缩放回 1 后 `node-lod` 归零、`number-control` 恢复，socket 唯一。

## 未做到 / 剩余风险

- 连线插件在小缩放下仍全量命中测试（149 条已覆盖）；更大规模连线需单独做连线层 LOD。
- 多 editor 实例不支持（模块单例，见 ADR-008）。
- 绝对数字受机器负载影响；对比式断言降低抖动误判，但低负载机器上若两者都接近 rAF 上限，
  首帧比例仍能稳定区分。
- ROS 依赖用例偶发时序抖动（外部参数 2s 同步窗口、延迟声明参数 20s 可见）与本 LOD 无关。

## 验证

- `corepack pnpm build`、`corepack pnpm check`、`corepack pnpm -w exec vitest --run apps/web/src packages/ir` 全绿；
- `ROSUI_PERF=1 node node_modules/@playwright/test/cli.js test e2e/perf.spec.ts`：2 条通过；
- 全量 `node node_modules/@playwright/test/cli.js test`：41 条通过（perf 默认跳过 2 条）。
