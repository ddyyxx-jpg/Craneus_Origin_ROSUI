# M5 性能评审：LOD 混合渲染 + 200 节点压测（T-031）

评审对象：`feat/m5-lod-perf`（从 `feat/m5-save-load` 拉出，基线 HEAD `a0d054c`）
评审方式：Playwright Chromium headless（1280×720），不依赖 ROS，纯 UI 压测
截图：`docs/artifacts/m5-perf.png`（placeholder 模式下 200 节点）

## 实现要点

- LOD 阈值：`area.area.transform.k < 0.35` 切换占位渲染，`>= 0.35` 恢复完整渲染。
- 状态分发：`apps/web/src/rete/lod.ts` 用 `useSyncExternalStore` 广播全/占位两态；
  `apps/web/src/rete/editor.ts` 在 `area.addPipe('zoomed')` 里用 rAF 合并缩放事件，
  只有跨越阈值才 `notify()`，避免逐帧 `setState`。
- 渲染切换：`apps/web/src/rete/LodNode.tsx` 的 `withNodeLod` / `withCustomNodeLod`
  包住 `customize.node`。占位子树 `<div className="node-lod" data-testid="node-lod">`
  保留标题、输入/输出 socket DOM 与切换前记录的真实尺寸（`captureNodeSizes`），
  但不渲染 number/text/select/boolean/pose 控件。
- **不卸载 Rete NodeView**：只换 React 子树，socket 在 `SocketsPositionsStorage` 中
  保持唯一，缩放来回不会出现
  `Found more than one element for socket with same key and side`，连线端点不漂移。
  没有调用 `area.update('node', id)`，尺寸未真变时不触发重排。
- 测试支撑：`EditorHandle.addNodes(n)` / `setZoom(k)` 仅暴露给 DEV 的 `window.__rosui`，
  生产逻辑不变；首帧完成以 `editor.getNodes().length`、`area.nodeViews.size` 与
  DOM 里 `[data-testid="node"]`/`node-lod` 数量三者为口径，不依赖状态栏文案。
  `addNodes` 不进绑定层，不影响业务节点行为。

## 测量方法（`e2e/perf.spec.ts`）

每个用例独立页面，等待 `canvas-status[data-state=ready]`，然后：

1. `setZoom(1)`（full）或 `setZoom(0.3)`（placeholder）→ 等一帧 → `editor.clear()`；
2. `performance.now()` 起表 → `handle.addNodes(200)` → 轮询直到
   编辑器节点数、`area.nodeViews` 与 DOM 节点视图数都达 200 → 再等一帧 → 停表，
   记为 **200 节点首帧完成时间**;
3. 选中第 11 个新节点，连续 30 次 `area.translate` + `requestAnimationFrame` 采样，
   相邻 rAF 时间戳差即帧时间，取平均值与最大值，记为 **拖动平均帧时间**；
4. 两组独立重复同一函数，口径一致；结果 `console.log` 到测试输出。
   断言先记录基线，再用 3 倍宽松阈值（full 首帧 1076.7ms、拖动 48.63ms），
   避免 CI 抖动导致假阴性。

## 真实数字（本机一次权威运行结果）

| 模式 | 节点数 | 首帧完成 (ms) | 拖动平均帧 (ms) | 拖动最大帧 (ms) | placeholder 节点数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| full (k=1) | 200 | 366.0 | 16.53 | 16.8 | 0 |
| placeholder (k=0.3) | 200 | 239.6 | 16.13 | 16.8 | 200 |

（本机 headless Chromium 空转 rAF 约 16.4ms/帧，即 60fps 上限；拖动数字贴近该上限，
说明拖动期间没有额外的逐帧重排。）

此前同口径多轮采样首帧为 full 357–383ms、placeholder 231–241ms，
拖动平均均约 16.1–16.7ms，量级一致。

## 结论

- **达到「拖动可交互」<33ms/帧**：full 16.53ms、placeholder 16.13ms，均低于 33ms。
  200 节点首帧 366.0ms，远低于用户设定的 3s 门槛，因此**没有做控件懒渲染**
  （视口外 `IntersectionObserver` / `visible` 事件）：额外复杂度与连线端点状态收益不匹配。
- LOD 降级收益主要体现在首帧（366.0ms → 239.6ms，约 -35%），
  因为控件 DOM 少了，React 挂载量与布局成本下降；拖动阶段两者都受 rAF 60fps 上限限制，
  数字接近，未体现差异。
- 阈值切换可恢复：缩放回 1 后 `node-lod` 数量归零、`number-control` 恢复，
  节点视图与连线 socket 保持唯一，无重复注册告警。

## 未做到 / 剩余风险

- **连线插件在小缩放下仍全量命中测试**：`rete-connection-plugin` 的 hit test 不会随
  LOD 关闭，本压测没有创建 200 条连线；大量连线时低缩放的连线交互仍可能卡顿，
  需要单独做连线层 LOD 或canvas 绘制才能解决。
- **占位块尺寸来源**：切到低缩放前用 `offsetWidth/offsetHeight` 记录真实尺寸（不受 area transform 影响）；
  若节点在 placeholder 模式下被程序改尺寸（例如动态改 label 宽度），缓存不会更新，
  需在业务侧触发一次 full 模式重采样。当前节点定宽，不构成问题。
- 测量在 headless Chromium + 本机 CPU 上进行，绝对数字受机器负载影响；
  断言按 3 倍基线做宽松上限，重点看量级与是否出现数量级退化。

## 验证

- `corepack pnpm build`、`corepack pnpm check`（含 IR vitest 5 例）、
  `corepack pnpm -w exec vitest --run apps/web/src packages/ir` 全绿；
- `node node_modules/@playwright/test/cli.js test e2e/perf.spec.ts`：2 条通过；
- 全量 Playwright：`35 passed (1.7m)`（原 33 条 + 新增 2 条，全绿）。
  最后一次全量运行中的 perf 采样为 full 375.1 / 16.19ms、placeholder 241.6 / 16.11ms，
  与独立运行同量级。
- 期间有一次全量运行出现 2 条 ROS 依赖用例超时（`m3-pose.spec.ts:64` 外部参数 2s 同步窗口、
  `m4-param-browser.spec.ts:9` 延迟声明参数 20s 可见），均非 LOD 相关；重跑即全绿，
  判为 ROS 时序抖动，作为剩余风险记录。
