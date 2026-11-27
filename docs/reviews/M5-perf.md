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
3. 选中第 11 个新节点，用 `performance.now()` 包住 **7 批 × 40 次**连续
   `area.translate`（含 `nodetranslated` 管道里的连线/socket 重算）的同步主线程
   工作量，取 7 批中位数再除以 40 记为 **拖动平均工作量**（ms/次）；rAF 只用于
   批间让出渲染帧，不计入工作量。
   （二轮 P2-D：旧口径取相邻 rAF 时间戳差，被 vsync 锁在 ~16.6ms，无法反映真实工作量；
   单次 translate 仅 ~0.02ms，会被 `performance.now()` 量化误差淹没，故按批测量。）
4. 两组独立重复同一函数，口径一致；结果 `console.log` 到测试输出。
   断言为对比式：placeholder 首帧 `< 0.85 × full 首帧`，拖动均值 `≤ full × 1.2`。

## 真实数字（`ROSUI_PERF=1` 一次权威运行，200 节点 + 149 连线）

| 模式 | 节点数 | 连线 | 首帧完成 (ms) | 拖动平均工作量 (ms/次) | 拖动最大批均值 (ms/次) | placeholder 节点数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| full (k=1) | 200 | 149 | 743.8 | 16.19* | 16.8* | 0 |
| placeholder (k=0.28) | 200 | 149 | 370.9 | 16.14* | 16.8* | 200 |

\* 一轮评审旧 rAF 口径数字；二轮 P2-D 新口径实测（7 批 ×40 次 `area.translate`，中位数/次）：
full 首帧 748.9ms / 拖动 0.0175ms、placeholder 首帧 330.7ms / 拖动 0.0125ms，
拖动比例 71.4%，满足 `≤full×1.2`。
首帧对比：370.9 / 743.8 = 49.9%，满足 `<0.85×full`；
二轮口径 330.7 / 748.9 = 44.2%，同样满足。

评审前旧口径（200 个纯 gain 节点、无连线）为 full 366.0 / 16.53、placeholder 239.6 / 16.13；
新增混合类型与 149 条连线后两者成本都上升，但相对比例仍接近 50%。

## 阈值依据（评审 #5）

- **0.85 首帧比例**：同机多轮 placeholder/full 比例约 0.5~0.66，留约 20 个百分点余量；
  若 placeholder 首帧退化到 full 的 85% 以上，说明 LOD 失去意义，判失败。
- **1.2 拖动上限**：旧 rAF 口径被 vsync 锁到 ~16.7ms，不能用固定毫秒阈值判断退化；
  二轮改为对比 7 批 ×40 次 `area.translate` 的 median 单步主线程工作量，相对 full 的
  1.2 倍容忍 ~20% 抖动但能抓住“占位反而更慢”的实质退化。

## 结论

- **拖动可交互**：二轮新口径 full 0.0175ms/次、placeholder 0.0125ms/次（均远低于 33ms 预算）；
  一轮旧 rAF 口径为 full 16.19ms、placeholder 16.14ms。
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
- 全量 `node node_modules/@playwright/test/cli.js test`：42 条通过（perf 默认跳过 2 条）。

## 二轮处置（PR #4 review round 2）

| 评审项 | 根因 | 处置 | 验证证据 |
| --- | --- | --- | --- |
| P1-B 低缩放新增节点占位尺寸 | `render`/`noderesized` 无条件把占位自身 `offsetWidth/Height`（fallback 180×119）回写尺寸缓存，切回 full 时 Pose 从 180×119 跳到 180×144（差 25px） | `sampleNode` 只在 full 模式采样；placeholder 不污染缓存；`LodNode.tsx` 按节点类型 `TYPE_SIZES` 取默认（Pose 180×144、Script 252×273、Inspector 180×71、其余 180×119），跨阈值前 `captureSizes()` 保留 | `e2e/lod.spec.ts` 新增「k=0.2 新增 Pose → 占位高度与 full 差 ≤2px、切回不跳变」通过 |
| P2-C 选中态与 UX 脱节 | 旧 e2e 直接置 `node.selected`，但本应用未启用 `selectableNodes`，真实点击只触发 `nodepicked` → `selectedPort` | `editor.ts` 在 `nodepicked` 管道给 `[data-testid=node]`/`.node-shell` 写 `selected`+`data-selected` 并清其它节点；`pointerdown` 空白清视觉态；不读写 `node.selected` | `e2e/lod.spec.ts` 改为真实点击标题 → full/placeholder 黄色高亮 (`rgb(255,217,44)`) → 点空白取消，通过 |
| P2-D perf 拖动指标被 vsync 锁死 | 相邻 rAF 时间戳差恒为 ~16.6ms，1.2× 阈值只能抓严重退化 | 用 `performance.now()` 包住 `area.translate` 同步主线程工作量；rAF 只用于让出渲染帧、不计入工作量；保留 `placeholder ≤ full × 1.2` | `ROSUI_PERF=1 ... e2e/perf.spec.ts` 2 passed，实测见下 |
| P2-E 全量 e2e 进程不退出 | Playwright webServer 用 `shell:true` + detached PGID；旧命令 `corepack pnpm dev` 派生 `sh -c vite` → vite 另起 PGID，teardown `kill(-shell_pgid)` 只杀中间 shell，vite 存活持有 stdio | `playwright.config.ts` 改 `cd apps/web && exec node node_modules/vite/bin/vite.js ...`：shell 被 exec 替换成 vite 本体，PID/PGID 与 Playwright 启动的进程组一致，`kill(-pid)` 完整回收；`reuseExistingServer` 保持 true | fresh 单文件与全量 e2e 无外层 timeout 自然退出，5180 无残留，EXIT=0 |

二轮 perf 实测口径（`performance.now()` 包住 7 批 × 40 次 `area.translate`，取批中位数 ÷ 40 记为 ms/次；rAF 只用于批间让出、不计入工作量）与最终五条验证命令数字见交付回报。
