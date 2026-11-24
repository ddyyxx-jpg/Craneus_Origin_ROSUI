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

### T-006 RosClient 连接层（无 UI）
- owner: C ｜ scope: `apps/web/src/ros/**`
- depends: T-005
- 验收：连接/断开/重连（指数退避）；`getParam/setParam/subscribeParamEvents` 三个方法；断线时调用方收到 `disconnected` 状态；单测用 mock ws。
- 证据：单测 + 手动断网恢复录屏

### T-007 demo 参数节点 ✅ 已完成（ros2/rosui_demo，证据 docs/artifacts/T-007-param-validation.txt）
- owner: D ｜ scope: `ros2/rosui_demo/**`
- depends: T-005
- 验收：节点声明 `gain`(double,0..10)、`enabled`(bool)、`mode`(string enum)、`pose`(Pose)；`add_on_set_parameters_callback` 做范围校验；非法值被拒并回 reason。
- 证据：`ros2 param set` 成功/失败两例输出

### T-008 e2e 骨架 ⏳ 未开始（无 Playwright 浏览器）
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

### T-011 控件-类型映射表
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

### T-013 控件交互防冲突
- owner: B ｜ scope: `apps/web/src/controls/**`
- depends: T-012
- 验收：控件内点击不拖节点（`Drag.useNoDrag`）；输入框内空格/方向键不驱动画布；文本可选中（`user-select: all`）。
- 证据：录屏 3 例

### T-014 守卫与校验
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

## M2 运行时参数绑定（对标 rqt_reconfigure，2~3 天）

### T-016 参数绑定 UI（C3 前置）
- owner: B ｜ scope: `apps/web/src/controls/binding.tsx`
- depends: T-006, T-011
- 验收：控件可切换 static/runtime；runtime 时显示连接状态点（灰/绿/红）；切换不改 IR 语义。
- 证据：截图

### T-017 双向同步与回声抑制
- owner: C ｜ scope: `apps/web/src/ros/sync.ts`
- depends: T-016, T-007
- 验收：UI 改 → 节点变；`ros2 param set` → UI 变；自身写入不回灌；连发 10 次不抖动；首帧事件被丢弃。
- 证据：e2e 双向用例 + 日志

### T-018 断线重连与状态机
- owner: C ｜ scope: `apps/web/src/ros/reconnect.ts`
- depends: T-017
- 验收：重连后重放订阅、拉一次全量参数；代际号阻止旧回调写 UI；离线时控件只读 + 顶部横幅。
- 证据：拔网线录屏 + 单测

### T-019 一键演示环境
- owner: Q ｜ scope: `scripts/demo.sh`、`docs/handoff/`
- depends: T-007, T-018
- 验收：一条命令起 rosbridge + demo 节点 + 前端；5 步演示脚本（改 gain→看节点→断线→重连→值恢复）全绿。
- 证据：`docs/artifacts/demo-<date>.mp4` + 退出码

### T-020 评审卡：M2 全量 + 反馈归档
- owner: R ｜ scope: `docs/reviews/`、`docs/feedback/`
- depends: T-017, T-018, T-019
- 验收：八问结论；反馈表按「现象/期望/严重度/复现步骤」记录 ≥ 5 条；每条转成新卡或明确关闭理由。
- 证据：`docs/feedback/M2.md`

---

## 后续（M3/M4，先不细化）

- **M3 复杂控件与性能**：Pose 表单、JSON 编辑器（`customize.node` + `RefSocket`/`RefControl` + `area.resize`）、LOD（低缩放占位矩形）、200 节点压测（输入 16ms 内不卡顿）。
- **M4 打磨与验收**：撤销/重做、复制粘贴、保存/加载 `.rosui.json`、错误 toast 统一、AC-1..5 逐条验收。

## 依赖图（ASCII）

```
T-001 ─┬─ T-002 ── T-003 ── T-009 ── T-010 ─┬─ T-011 ── T-014
       │            │                       └─ T-012 ── T-013
       ├─ T-004 ────┘                                  │
       ├─ T-005 ─┬─ T-006 ── T-016 ── T-017 ─┬─ T-018 ── T-019
       │         └─ T-007 ───────────────────┘            │
       └─ T-002 ── T-008                                   └─ T-020
```
