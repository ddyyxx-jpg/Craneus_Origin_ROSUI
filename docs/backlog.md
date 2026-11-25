# ROSUI 任务卡（T-001 ~ T-020）

> 用法：把每张卡用 `team_task_create` 建到 DSH 任务板上（subject = 卡标题，description = 卡正文，write_scopes = scope）。
> 卡正文格式固定：`owner / scope / depends / 背景 / 验收 / 证据`。
> 状态机：`pending → in_progress → review → done`，`review` 只有 reviewer 能签。
> 单卡上限：≤ 40 步、≤ 100k tokens；超了交半成品 + handoff。

角色代号见主方案 §5.3：**L** lead、**A** canvas-dev、**B** control-dev、**C** bridge-dev、**D** ros-dev、**E** ir-dev、**R** reviewer、**Q** e2e-runner。

---

## M0 环境与骨架（半天，目标是"能跑起来"）

### T-001 仓库初始化与工程基线 ✅ 已完成
- owner: L ｜ scope: `/`（根配置）、`.npmrc`、`.gitignore`、`package.json`、`tsconfig.base.json`
- depends: —
- 背景：空目录起步，pnpm workspace 三段（apps/web、packages/ir、ros2 不进 workspace）。
- 验收：
  - [ ] `git init` + `.gitignore`（node_modules、.npm-cache、dist、test-results）
  - [ ] `.npmrc`：npmmirror + 仓库内 cache（解决 `~/.npm/_cacache` EACCES）
  - [ ] `pnpm -v`、`pnpm install` 退出码 0
  - [ ] `pnpm check` 脚本存在（tsc --noEmit + eslint + vitest --run）
- 证据：命令 + 退出码

### T-002 前端骨架跑通 ✅ 已完成（Vite 7 + React 19，build 退出码 0）
- owner: A ｜ scope: `apps/web/**`
- depends: T-001
- 验收：Vite + React 19 + TS strict；空白页面 200；`pnpm dev` 一条命令起；无 any。
- 证据：dev server 日志 + 访问截图

### T-003 Rete 画布最小可用 ✅ 已完成（apps/web/src/rete/editor.ts）
- owner: A ｜ scope: `apps/web/src/editor/**`
- depends: T-002
- 验收：拖拽建节点、拖端口连线、框选、删除；`ReactPlugin({ createRoot })`；关闭页面无 socket 泄漏警告。
- 证据：截图 + console 无 error

### T-004 IR v1 类型与 zod ✅ 已完成（version=1，ROS 参数类型，5 例测试）
- owner: E ｜ scope: `packages/ir/**`
- depends: T-001
- 验收：`GraphIR`/`NodeIR`/`ParamBinding` 与主方案 §2.4 一致；`parseGraph` 对 3 个坏样例报错；vitest ≥ 8 例。
- 证据：`pnpm -F @rosui/ir test` 输出

### T-005 rosbridge 安装与连通 ✅ 已完成（无 root 解包，scripts/fetch-rosbridge.sh + ros-up.sh，9090 实测可连）
- owner: C ｜ scope: `scripts/ros-up.sh`
- depends: T-001
- 背景：`ros-jazzy-rosbridge-suite` 2.7.1 未装，需一次 sudo 批准。
- 验收：`ros2 launch rosbridge_server rosbridge_websocket_launch.xml` 起 9090；`wss`/`ws` 握手成功；`scripts/ros-up.sh` 幂等（已起则跳过）。
- 证据：launch 日志 + ws 连接截图

### T-006 RosClient 连接层（无 UI）✅ 已完成（apps/web/src/ros/，7 例单测 + dev-probe 真机联调 PASS）
- owner: C ｜ scope: `apps/web/src/ros/**`
- depends: T-005
- 验收：连接/断开/重连（指数退避）；`getParam/setParam/subscribeParamEvents` 三个方法；断线时调用方收到 `disconnected` 状态；单测用 mock ws。
- 证据：单测 + 手动断网恢复录屏

### T-007 demo 参数节点 ✅ 已完成（ros2/rosui_demo，证据 docs/artifacts/T-007-param-validation.txt）
- owner: D ｜ scope: `ros2/rosui_demo/**`
- depends: T-005
- 验收：节点声明 `gain`(double,0..10)、`enabled`(bool)、`mode`(string enum)、`pose`(Pose)；`add_on_set_parameters_callback` 做范围校验；非法值被拒并回 reason。
- 证据：`ros2 param set` 成功/失败两例输出

### T-008 e2e 骨架 ✅ 已完成（Playwright 4 例：C1/C2/C2b + 冒烟） ⏳ 未开始（无 Playwright 浏览器）
- owner: Q ｜ scope: `e2e/**`、`scripts/demo.sh`
- depends: T-002
- 验收：Playwright 起前端 + 断言标题；失败自动截图到 `e2e/artifacts/`；`pnpm e2e` 一条命令。
- 证据：一次通过 + 一次故意失败的产物目录

---

## M1 内联控件与显隐联动（核心体验，1~2 天）

### T-009 节点/端口注册表
- owner: A ｜ scope: `apps/web/src/editor/registry.ts`
- depends: T-003, T-004
- 验收：节点类型 → 端口定义 + 默认 widget 的映射；新增一种节点只改注册表；未知类型降级为红色占位节点。
- 证据：单测 3 例

### T-010 数字内联控件（C1）✅ 已完成（input.addControl + change 回调）
- owner: B ｜ scope: `apps/web/src/controls/number.tsx`
- depends: T-009
- 验收：`input.addControl(new InputControl('number',{initial, change}))`；未连线时行内可编辑并写回 IR；`pnpm check` 0。
- 证据：截图 + 单测

### T-011 控件-类型映射表 ✅ 已完成（number/text/select/boolean 四类，5 种节点）
- owner: B ｜ scope: `apps/web/src/controls/map.ts`
- depends: T-010
- 验收：§2.6 表逐行有实现或明确 `todo`；double/integer/bool/string/select 全覆盖；未知类型走 JSON 兜底。
- 证据：单测逐类型断言

### T-012 连线隐藏 / 断线恢复（C2）✅ 已完成（AreaExtensions.showInputControl）
- owner: B ｜ scope: `apps/web/src/controls/linkage.ts`
- depends: T-010
- 背景：优先用 `AreaExtensions.showInputControl(area)`；需要副作用时再自己挂 `connectioncreated/removed`。
- 验收：连线后控件 100ms 内隐藏、label 出现；断线 300ms 内恢复；多连接端口不误判；`area.update('node', id)`。
- 证据：before/after 截图 + e2e 用例

### T-013 控件交互防冲突 ✅ 已完成（Drag.useNoDrag + capture 拦截）
- owner: B ｜ scope: `apps/web/src/controls/**`
- depends: T-012
- 验收：控件内点击不拖节点（`Drag.useNoDrag`）；输入框内空格/方向键不驱动画布；文本可选中（`user-select: all`）。
- 证据：录屏 3 例

### T-014 守卫与校验 ✅ 已完成（越界/NaN/空串/非法枚举不写 IR）
- owner: B ｜ scope: `apps/web/src/controls/validate.ts`
- depends: T-011
- 验收：NaN/越界/空串被拦并给 inline 错误；不合法值不发 `setParam`；zod schema 与 IR 同源。
- 证据：单测 + 截图

### T-015 评审卡：M1 全量
- owner: R ｜ scope: 只读
- depends: T-012, T-013, T-014
- 验收：按 §6.3 八问逐条给结论；verdict ∈ {approve, request-changes, block}；问题按 P0/P1/P2 分级。
- 证据：`docs/reviews/M1-review.md`

---

## M2 运行时参数绑定（对标 rqt_reconfigure）✅ 已完成

> 落地形态与初稿不同：没有做「static/runtime 切换开关」，而是**按绑定表默认绑定**（Gain/Switch/Mode 三个节点），Threshold 故意不绑定作对照。ADR-006 的「断连只读」也在实现后改成「断连不锁控件、只停止下发」。

### T-016 参数绑定 UI + 绑定表 ✅ 已完成（apps/web/src/binding/{bindings,controlAdapter,controlState}.ts）
- owner: B ｜ scope: `apps/web/src/binding/**`、`apps/web/src/App.tsx`
- depends: T-006, T-011
- 验收：工具栏（URL/连接/断开/状态胶囊/toast）；绑定表 `Gain.gain→/rosui_demo:gain`、`Switch.enabled→enabled`、`Mode.mode→mode`，`Threshold.value` 不绑定；单测覆盖类型匹配与未绑定路径。
- 证据：`e2e/binding.spec.ts` 第 1 条（连上后控件显示节点当前值）。

### T-017 双向同步与回声抑制 ✅ 已完成（apps/web/src/binding/useParamBinding.ts）
- owner: C ｜ scope: `apps/web/src/binding/useParamBinding.ts`
- depends: T-016, T-007
- 验收：UI 改 → 节点变；外部 `ros2 param set` → UI 变；自身写入 2s 同值回声被吞；订阅后 300ms 首帧丢弃；失败回滚 + toast。
- 证据：`e2e/binding.spec.ts` 第 2/4 条，`useParamBinding.test.ts` 6 例。

### T-018 断线重连与状态机 ✅ 已完成
- owner: C ｜ scope: `apps/web/src/ros/client.ts`、`apps/web/src/binding/useParamBinding.ts`
- depends: T-017
- 验收：指数退避重连（500ms→10s）+ 代际号；重连后重订阅并重拉全量；**断线不锁控件**，只停下发（离线可编辑，见 ADR-006 补记）。
- 证据：`e2e/binding.spec.ts` 第 5 条；`RosClient` 单测 7 例。

### T-019 一键演示环境 ✅ 已完成（scripts/demo-stack.sh [--check]）
- owner: Q ｜ scope: `scripts/`、`docs/handoff/`
- depends: T-007, T-018
- 验收：一条命令起 rosbridge + demo 节点，`--check` 自检参数读写与校验拒绝；e2e 复用同一脚本（`e2e/demo-stack.ts`）。
- 证据：`/tmp/roslog/` 日志 + `--check` 退出码 0。

### T-020 评审卡：M2 全量 + 反馈归档
- owner: R ｜ scope: `docs/reviews/`、`docs/feedback/`
- depends: T-017, T-018, T-019
- 验收：八问结论；反馈表 ≥ 5 条；每条转成新卡或明确关闭理由。
- 状态：独立评审已跑（m2-reviewer），结论见 `docs/reviews/M2-review.md`。

---

## M3 复杂控件（Pose + double_array 双向绑定）

### T-021 Pose 控件 ✅ 已完成
- owner: D ｜ scope: `apps/web/src/controls/model.ts`、`apps/web/src/controls/react.tsx`、`apps/web/src/styles.css`
- 验收：7 字段 DOM 表单（x/y/z/qx/qy/qz/qw），逐字段 blur/Enter 校验（有限数字），`data-testid="pose-field"` + `aria-label`，错误边框/文案复用现有样式；不冒泡画布拖拽/键盘事件。

### T-022 数组参数双向绑定 ✅ 已完成
- owner: D ｜ scope: `apps/web/src/rete/nodes.ts`、`apps/web/src/binding/bindings.ts`、`apps/web/src/binding/controlAdapter.ts`、`apps/web/src/ros/protocol.ts`、`apps/web/src/App.tsx`、`packages/ir/src/index.ts`
- 验收：`Pose:pose → /rosui_demo:pose (double_array)`；UI 写值与 `ros2 param set` 外部事件双向同步；数组值不再被 `guardedChange` 过滤；`encodeParamValue` 数值数组整数项补 `.0` 保持 double_array 语义（rclpy YAML 推断）。

### T-023 M3 e2e ✅ 已完成
- owner: D ｜ scope: `e2e/m3-pose.spec.ts`
- 验收：真 ROS 栈下 `+ Pose` 出现 7 字段且等于当前 pose；改 x=4.5 → `ros2 param get` 精确匹配；外部 set → UI 2s 内同步。3 条 serial，90s 超时。

---

## M4 运行时绑定 / Inspector / Script（PR #2）

### T-024 参数浏览器（运行期发现 + 绑定）✅ 已完成
- owner: D ｜ scope: `apps/web/src/ParamBrowser.tsx`、`apps/web/src/binding/bindings.ts`
- 验收：连上后列出 `<node>:<param>`，可按名字过滤；运行中新 declare 的参数出现在列表里（`/parameter_events` 的 `new_parameters` 驱动）；点「绑定」把选中端口改成 runtime 绑定，类型不兼容时拒绝并 toast。

### T-025 Inspector 节点 ✅ 已完成
- owner: D ｜ scope: `apps/web/src/rete/nodeRenderers.tsx`、`apps/web/src/styles.css`
- 验收：列出所有已绑定端口的实时值；面板内滚轮只滚面板（不缩放画布）。

### T-026 Script 节点（Worker 执行）✅ 已完成
- owner: D ｜ scope: `apps/web/src/rete/scriptRunner.ts`、`apps/web/src/rete/script.worker.ts`、`apps/web/src/rete/nodes.ts`、`apps/web/src/rete/nodeRenderers.tsx`
- 验收：节点内 textarea 编辑 JS，blur/Ctrl+Enter 执行；`while(true){}` 在 50ms 被 terminate、页面仍可交互；Worker 复用（同一 factory 只创建一个），超时后重建；结果只接受有限数字/字符串。

### T-027 M4 e2e 与门禁 ✅ 已完成
- owner: Q ｜ scope: `e2e/`
- 验收：真 ROS 栈下覆盖运行时绑定、动态新增节点、解绑、参数发现、Inspector、Script；全量 `playwright test` 31 passed，连跑两轮稳定；`build`/`check`/`vitest` 全绿。

### T-028 M4 评审闭环 ✅ 已完成
- owner: R ｜ scope: `docs/reviews/M4-review.md`
- 验收：首轮 6 项 + 二轮 2 项全部处置，结论与证据写回评审文件；门禁数字更新为 31 e2e。

### T-029 第二轮稳定性与遗留项 ✅ 已完成
- owner: L/D ｜ scope: `apps/web/src/{binding,controls,rete}/**`、`e2e/**`、`packages/ir/src/index.ts`
- 验收：参数浏览器改默认收起 + 展开懒加载（4 并发 + 退避重试）；绑定层补 warmup 权威补拉、订阅后 300ms 对账、5s 周期对账；动态节点注册绑定层 + `bind()` 返回 boolean 回滚；Pose 字段改 `text/inputMode` + `key={label}` + 7 元兜底；IR 数组项 `.finite()`；`playwright` 31 passed 连续 3 轮。

## M5 打磨与验收

### T-030 图保存 / 加载 `.rosui.json` ✅ 已完成
- owner: D ｜ scope: `apps/web/src/rete/serialize.ts`、`apps/web/src/rete/editor.ts`、`apps/web/src/App.tsx`、`e2e/save-load.spec.ts`
- 验收：工具栏「保存」下载 GraphIR v1（节点/位置/控件值/绑定模式/连线）；「加载」经 `parseGraph` 校验后还原画布并可继续编辑；非法文件 toast 报错且不破坏当前画布；e2e 覆盖「建图→保存→刷新→加载→值/连线一致」。已知限制：Script 的 `x` 只恢复 `code`（M5 验收按此口径）。
- 落地：`apps/web/src/rete/serialize.ts`（`kindForType`/`serializeGraph`/`loadGraph`）、`nodes.ts` 的 `applyParamBinding`、`App.tsx` 保存/加载按钮与动态注册清理、`e2e/save-load.spec.ts`、ADR-007。

### T-031 LOD 混合渲染与 200 节点压测 ✅ 已完成
- owner: C ｜ scope: `apps/web/src/rete/**`、`e2e/perf.spec.ts`、`docs/artifacts/**`
- 验收：缩放 < 0.35 时节点内容降级为同尺寸占位（控件不渲染），缩放回来恢复；200 节点图的首帧与拖动帧率有可复现的测量脚本与数字（记录到 `docs/reviews/M5-perf.md`）。
- 落地：`rete/lod.ts`（`useSyncExternalStore` 广播 + 尺寸缓存）、`rete/LodNode.tsx`（占位节点保留 socket、不卸载 NodeView）、`editor.ts` 的 rAF 节流 zoomed → LOD、`e2e/perf.spec.ts`。实测 full 首帧 366ms / placeholder 240ms，拖动均 16.5ms/帧。

### T-032 撤销 / 重做 + 复制粘贴 ⏳ 待开始
- owner: A ｜ scope: `apps/web/src/rete/editor.ts`、`apps/web/src/App.tsx`
- 验收：节点增删、连线、控件值修改可撤销/重做（Ctrl+Z / Ctrl+Shift+Z），栈深 100；复制粘贴节点保留值与位置偏移。

### T-033 错误 toast 统一 + AC-1..5 逐条验收 ⏳ 待开始
- owner: R/Q ｜ scope: `apps/web/src/**`、`docs/reviews/M5-acceptance.md`
- 验收：所有失败路径走同一 toast 组件（连接失败/加载失败/绑定失败/写入被拒），文案可读且含参数名；AC-1..5 每条有 e2e 或截图证据，写进验收报告。

## 依赖图（ASCII）

```
T-001 ─┬─ T-002 ── T-003 ── T-009 ── T-010 ─┬─ T-011 ── T-014
       │            │                       └─ T-012 ── T-013
       ├─ T-004 ────┘                                  │
       ├─ T-005 ─┬─ T-006 ── T-016 ── T-017 ─┬─ T-018 ── T-019
       │         └─ T-007 ───────────────────┘            │
       └─ T-002 ── T-008                                   └─ T-020
```
