# ADR-008：缩放 LOD 混合渲染

- 状态：Accepted（PR #4 评审闭环后修订）
- 日期：2026-11-25
- 关联：T-031、`docs/reviews/M5-lod.md`、`docs/reviews/M5-perf.md`

## 背景

节点画布缩小时，内联控件（数字/位姿/文本/脚本/Inspector）在屏幕上只剩几像素，
继续渲染它们既无可读性，又拖慢首帧。需要在低缩放下只保留标题、输入/输出 socket
与节点外框，同时保持连线端点不漂移、不卸载 Rete NodeView（避免 socket 重复注册）。

## 决策

1. **两态 LOD + hysteresis**：`apps/web/src/rete/lod.ts` 用模块级
   `useSyncExternalStore` 广播 `full`/`placeholder`。缩放 `k < 0.32` 进入
   placeholder，`k > 0.38` 回到 full，中间区间保留原状态，避免滚轮停在阈值
   附近时整树反复卸载/重挂。跨阈值才 `notify()`。
2. **占位 DOM 复用 classic 布局**：`LodNode.tsx` 的 PlaceholderNode 根节点带
   `node-shell node node-lod node-lod-placeholder`，并在 `styles.css` 显式对齐
   rete-react-plugin classic preset 的几何常量（socket 24px、margin 6px、
   `.output-socket{margin-right:-18px}` / `.input-socket{margin-left:-18px}`、
   title padding 8px、行高 18px）。验收口径：同一节点 full ↔ placeholder 的
   外框尺寸一致、socket **中心偏移差 ≤2px**（e2e/lod.spec.ts）。
   二轮 P2-C 修订：**不读 Rete `data.selected`**（本应用未启用 selectableNodes，
   真实点击不会写它）。选中态由 `createEditor` 的 `nodepicked` 管道写到
   `area.nodeViews.get(id).element` 内 `[data-testid=node]`/`.node-shell` 的
   `selected` class + `data-selected`，并清掉其它节点；点空白由 `pointerdown`
   管道清视觉态，与 App 的 `selectedPort` 绑定语义一致而互不干扰。
3. **尺寸缓存与采样**：`captureNodeSizes` 在跨阈值前记录真实 `offsetWidth/Height`
   （不受 area transform 影响）；生产路径（`addNode()`、`loadGraph`）新增的节点在
   area 的 `render`/`noderesized` 管道里统一采样。二轮 P1-B 修订：**只在 full 模式
   采样**——placeholder 的 `offsetWidth/Height` 来自占位自身或兜底常量，回写缓存会
   覆盖跨阈值前锁定的 full 尺寸（实测 Pose 低缩放新建后切回 full 从 180×119 跳到
   180×144）。低缩放下新增且无缓存的节点由 `LodNode.tsx` 的 `TYPE_SIZES` 按节点类型
   选默认：Gain/Threshold/Label/Mode/Switch 180×119、Pose 180×144、Inspector 180×71、
   Script 252×273（2026-11-27 Playwright 探针实测）。full 模式下尺寸变化才触发
   `area.update('node', id)`。
4. **已知限制：模块级单例**：当前 store 是模块级单例，**暂不支持多个 editor 实例**；
   同一页面若出现分屏/多画布会共享 LOD 模式与尺寸缓存。未来改造方向是按
   `WeakMap<AreaPlugin, Store>` 存状态，在 `createEditor` 时创建/销毁对应 store；
   本次改造成本超出 30 行（需同步改 3 个文件的 store 引用与生命周期），故不做，留待分屏需求落地时处理。

## 合并顺序约束

本分支 base 是 `feat/m5-save-load`：`apps/web/src/rete/editor.ts` 依赖
`serialize.ts` 的 `serializeGraph`（保存图），而 `serialize.ts` 是 PR #3 引入的。
**必须先合 #3（save/load），再合本分支 #4**，否则 `editor.ts` 的 import 无法解析。

## 后果

- 优点：低缩放下 DOM/布局成本显著下降，连线 socket 位置不漂移；切换有去抖。
- 代价：占位节点不显示控件，用户需放大到 >0.38 才能编辑；多 editor 实例不支持。
- 测试：`e2e/lod.spec.ts` 固化几何/hysteresis/真实点击选中态/低缩放新增节点尺寸，
  `e2e/perf.spec.ts` 用 200 节点混合图 + 149 条连线做对比式压测（默认跳过，
  `ROSUI_PERF=1` 开启）。二轮 P2-D 将拖动指标从相邻 rAF 时间戳（被 vsync 锁在
  ~16.6ms）改为 `performance.now()` 包住 `area.translate` 的同步主线程工作量。
