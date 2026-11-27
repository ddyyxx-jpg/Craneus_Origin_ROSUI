# M5 评审：缩放 LOD 混合渲染 + 200 节点压测

- 评审对象：PR #4 `feat/m5-lod-perf` @ `d543650`（base = PR #3 分支，自身 10 文件 +481/−7）
- 评审方式：独立 reviewer 子代理只读审查 + lead 静态复核 + 浏览器几何探针（`e2e/tmp-lod-probe.spec.ts`，评审后已删）+ 全量 e2e 与 perf 实测
- 结论：**request-changes**（无 P0；核心不变量「占位同尺寸、端点不漂移」实测不成立）

## verdict

| # | 位置 | 问题 | 级别 |
|---|---|---|---|
| 1 | `apps/web/src/rete/LodNode.tsx:49-86`、`apps/web/src/styles.css:294-307` | **占位模式下 socket 几何完全失真，连线端点塌到节点中间**。占位节点是裸 `div`，socket 用 `.input-socket`/`.output-socket` class 直接挂行内，但偏移规则在 rete-react-plugin 的 emotion scoped class 里（`.output-socket{margin-right:-18px}`、`.input-socket{margin-left:-18px}`，`$socketsize=24`/`$socketmargin=6`），占位根节点没有这些 class，socket 变成整行块。实测同一条 Gain（180×119）：full 下 output socket 中心 `dx=178, w=36`、input `dx=2`；切到 k=0.2 占位后 output `dx=90, w=168`、input `dx=90`——**水平位移约 88 个节点坐标单位**，连线在低缩放下会横穿节点。代码注释写的「不会因控件消失而改变输入端口的 x 坐标」与实际不符。 | **P1** |
| 2 | `apps/web/src/rete/LodNode.tsx:49-86` | 占位根节点不接收 `props.selected`、也不写 `data-selected`，classic 节点的选中高亮（黄色/亮色背景）在 k<0.35 时完全消失。实测：full 背景 `rgba(110,136,255,0.8)`，占位 `rgb(48,48,57)`，点击占位节点仍无选中态。 | P1 |
| 3 | `apps/web/src/rete/lod.ts:35-40` | 单阈值 0.35 无 hysteresis/去抖，缩放停在阈值附近时滚轮每帧都能翻转，200 节点会整树卸载/重挂。`zoomed` 虽用 rAF 合并，但只合并同一帧内的多次事件，不防抖。 | P1 |
| 4 | `apps/web/src/rete/editor.ts:52-62,100-115` | 尺寸缓存只在「跨阈值 / `addNodes` / `setZoom`」采样；生产路径 `addNode()`（`apps/web/src/App.tsx` 的 +Gain/+Pose/+Inspector/+Script）与 `loadGraph` 恢复节点都不采样。低缩放下新增的 Pose/Inspector/Script 会用 `FALLBACK_SIZE`（180×119），外框与真实节点差一大截，切回 full 时再跳变。 | P1 |
| 5 | `e2e/perf.spec.ts:93-101` | 压测断言测不出退化：拖动帧用相邻 rAF 时间戳差采样，被 vsync 锁在 16.4ms 附近，full 与 placeholder 实测 **16.2033ms vs 16.2467ms（无差异）**；阈值却是 `3 × 16.21 = 48.63ms`（容许 30fps），首帧阈值 `3 × 358.9 = 1076.7ms`。也就是说这条「性能门禁」既证明不了 LOD 收益，也拦不住性能回退，只是记录数字。建议改成对比式断言（placeholder 首帧必须显著低于 full，例如 `< 0.8 × full`）+ 用 `PerformanceObserver`/长任务或降低 vsync 干扰的方式量拖动成本。 | P1 |
| 6 | `e2e/perf.spec.ts:36-90`、`apps/web/src/rete/editor.ts:100-115` | 压测不代表最坏情况：只 `createNode('gain')` 批量加节点（无连线、无 Pose/Inspector/Script），且走的是仅 e2e 可见的 `addNodes()` 钩子而非生产 `addNode()` 路径；`rete-connection-plugin` 的 hit test 仍全量开启（报告已自认）。200 节点无连线与真实 200 节点图差距很大。 | P1 |
| 7 | `apps/web/src/rete/editor.ts:9` | 直接 `import { serializeGraph } from './serialize'`，而 `serialize.ts` 由 PR #3 引入、本分支 base 就是 #3 —— 栈式依赖没在 PR 描述/ADR 里写明，若先合 #4 会编译失败。 | P1 |
| 8 | `e2e/perf.spec.ts:104-105` | `page.screenshot({ path: 'docs/artifacts/m5-perf.png' })` 直接写仓库**已跟踪**文件：每跑一次 e2e 工作树就出现 ` M docs/artifacts/m5-perf.png`（我两次实测都复现）。CI 上会弄脏工作树/失败于 `git diff --exit-code` 类检查。截图应写 `testInfo.outputPath()`，产物再人工挑选提交。 | P2 |
| 9 | `playwright.config.ts`（未改）+ `e2e/perf.spec.ts` | perf 用例进了默认门禁（workers:1、串行），每次全量多 ~3s 且占用 200 节点渲染时间；建议加 `test.describe.configure` 或 `@perf` 标签，默认排除、CI 单独跑。 | P2 |
| 10 | `apps/web/src/rete/LodNode.tsx:63-84` | 占位 socket 没有 `data-testid`（classic 有 `data-testid="input-socket"/"output-socket"`），e2e 想验证端点几何只能靠 class 选择器（我的探针就是这么取的）。 | P2 |
| 11 | `apps/web/src/rete/lod.ts:4-12` | 尺寸缓存是模块级单例（`let current`/`const sizes`），多 editor 实例（未来分屏/缩略图）会互相覆盖；`resetLod` 只在 destroy 调用。 | P2 |
| 12 | `docs/backlog.md` T-031、`README.md` | T-031 标 ✅ 但验收写「同尺寸占位」——实测外框尺寸一致、**socket 位置**不一致，验收口径需要写清；README「35 条 Playwright 全绿」与实测 36 条（#4 全量）对不上；`docs/reviews/M5-perf.md` 的 366.0/239.6/16.53/16.13 数字与实测同量级，但拖动数字对 LOD 决策没有解释力（见 #5）。 | P2 |

## 已核对无问题

- 不卸载 Rete `NodeView`、只切 React 子树的思路正确：socket 在 `SocketsPositionsStorage` 中保持唯一，`e2e/perf.spec.ts` 的「缩放回来 socket 不重复注册」用例实测通过。
- `zoomFrame` 的 rAF 合并与 `cancelAnimationFrame` 清理正确，卸载时不会残留回调。
- 切回 full 后几何完全恢复：实测 k=1 → 0.2 → 1，nodeW/H 与 socket 中心坐标与初始值逐位相同（`inDx=2, inDy=93, outDx=178`）。
- `useSyncExternalStore` 只在跨阈值时 `notify()`，不会每帧 setState。
- 首帧确有收益：full 358.5ms → placeholder 245.7ms（本机），报告 366.0 → 239.6 同量级。
- `window.__rosui` 暴露的 `addNodes`/`setZoom` 仅 DEV 生效，生产构建不含。
- LOD 卸载控件后不会留下 Tab 焦点，纯 UI 用例（默认 k=1）未受影响。

## 门禁（d543650 实测）

```
corepack pnpm build                               # 0
corepack pnpm check                               # 0
pnpm -w exec vitest --run apps/web/src packages/ir # 43 passed
playwright test（全量 36 条）                      # 36 passed
perf 采样：[full] firstFrame 358.5 / dragAvg 16.2033 / max 16.8
           [placeholder] firstFrame 245.7 / dragAvg 16.2467 / max 16.8
```

首次全量运行出现过 2 条 ROS 依赖用例连接超时（`e2e/m4-inspector.spec.ts:19`、`e2e/m4-runtime-binding.spec.ts:40`），单独重跑均通过——属 demo-stack 起停时序抖动，与本 PR 无关，但会稀释「全绿」可信度，建议 demo-stack 复用逻辑加「等端口真正可连」的探活。

## 备注

- 本机全量 e2e 在用例全过后进程不退出（超时被 kill），单文件运行正常；与 #3 一致，记为环境/teardown 问题，待单独排查。
- 合入顺序：先 #3 再 #4。
