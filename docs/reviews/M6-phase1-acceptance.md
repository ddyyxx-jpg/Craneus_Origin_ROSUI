# M6 Phase 1 验收报告 — Unity/VSCode 风格 UI Shell

- 分支：`feat/m6-phase1-ui-shell`（从 PR #6 head `5d1b178` 切出）
- 日期：2026-11-28
- 范围：App Shell、Explorer、EditorTabs、BottomPanel、StatusBar、Inspector 布局；不包含 workspace agent、真实 ROS 扫描、编译/启动/Gazebo/RViz 执行。

## 1. 交付内容

- `apps/web/src/ui/AppShell.tsx`：顶栏 + Explorer/Editor/Inspector 三栏 + BottomPanel + StatusBar。
- `apps/web/src/ui/Explorer.tsx`：多根工作区列表；默认 active `nav2027_ws`，其他根点击后切换。Phase 1 只显示静态根，不读文件系统。
- `apps/web/src/ui/EditorTabs.tsx`：节点图 / 只读 IR 两个 tab；IR 数据实际常驻右侧 Inspector，避免覆盖画布。
- `apps/web/src/ui/BottomPanel.tsx`：Output / Problems / Diagnostics 占位。
- `apps/web/src/ui/StatusBar.tsx`：ROS 状态、画布状态、工作区、节点/连线数。
- `apps/web/src/App.tsx`：布局/传参重构，保留 toolbar、历史、保存/加载、快捷键、binding 与初始 5 节点 + 1 连线。
- `apps/web/src/styles.css`：shell grid/flex 布局；`.editor-pane-graph { display:flex }` 修复画布高度为 0 导致的控件点击命中问题；IR 从 `.editor-ir-peek` 绝对叠层移到 Inspector。
- `e2e/workspace-shell.spec.ts`：3 条纯 UI 用例（五个区域、tab/工作区切换、既有 testid）。
- `apps/web/src/binding/useParamBinding.ts`：修复全量 e2e 暴露的初值覆盖竞态——激活请求在用户成功写入之后才发出时，迟到 `getParam` 初值不得覆盖 `lastKnownGood`（AC-1 回归）。

## 2. 决策映射

- D1：从 PR #6 head 切链式分支。
- D3：`bringup/startup.launch.py` 为主；保留每节点单独启动（Phase 1 仅保留 UI/接口位，未接 agent）。
- D4：RViz 沿用 launch 内置；Gazebo 保留 world 模型导入接口，不假装本机有 Gazebo。
- D5：不内置 Monaco/CodeMirror；后续通过“在 VSCode 中打开”与 AI 接入接口复用 VSCode/Copilot/Cline。
- D6：不自研常驻 AI agent；本地能力按需启动或交给外部工具。
- D7：允许 workspace sidecar，写入前备份。
- D9：烟测不修改 `/home/ddyyxx/ROSWORK`，使用临时 build/install/log 或副本。

## 3. 门禁（2026-11-28）

| 项目 | 结果 |
|---|---|
| `corepack pnpm build` | exit 0；`dist/assets/index--CY5yonG.js 470.46 kB │ gzip: 140.29 kB` |
| `corepack pnpm check` | exit 0 |
| `corepack pnpm -w exec vitest --run apps/web/src packages/ir` | 10 files / 61 passed |
| 全量 e2e | 55 tests；53 passed + 2 skipped（perf 默认跳过）；`2 skipped / 53 passed (2.3m)`，`E2E=0` |
| AC-1 | 修复后全量通过；单跑曾 `1 passed (18.8s)` |
| `ROSUI_PERF=1 ... e2e/perf.spec.ts` | 2 passed；full 679.2ms / placeholder 272.4ms，dragAvg 0.015/0.0125 |
| `git diff --check` | exit 0 |

说明：全量 e2e 日志 `/tmp/m6-final-e2e.log` 末尾为 `2 skipped / 53 passed (2.3m)`；端口关闭、无 Playwright/Vite/ROS 残留。此前父进程被 harness SIGKILL 时曾出现孤儿完成日志 `/tmp/m6-full-e2e2.log`，最终轮已在干净环境独立跑通。

## 4. 已知限制 / 后续 Phase

- Explorer 是静态三根占位，不读文件系统、不接 `rosui-agent`（Phase 2）。
- 参数/驱动/话题三类小节点尚未接入真实 introspection（Phase 2）。
- 一键编译、Gazebo/RViz 拉起、每节点启动、VSCode/AI 外部接口仍是 Phase 3/4 接口位（D3/D4/D5/D6）。
- D2/D8 默认解释：D2 多根工作区默认激活 `nav2027_ws`；D8 runtime 参数实时写、YAML/launch 参数只读并给 diff 建议，不改源文件。待用户确认。
- `current-ir` 常驻 Inspector，EditorTabs 的“只读 IR”tab 目前显示说明文字，不是独立编辑器 panel；完整 IR tab 留 Phase 2。
- 审查 P2-4（binding 新 guard 的专门单测）与 P2-5（Explorer 绝对路径配置化）留 Phase 2；本轮已明确记录，不影响 Phase 1。

## 5. 审查

- 独立只读 reviewer：`m6-review`，结论 **无 P0/P1，可合并**。
- 已处置：P2-1 IR tab 断言改为校验 `editor-ir-note`（IR 仍常驻 Inspector）；P2-2 补 tablist/tabpanel ARIA 与左右方向键；P2-3 修正 1280×720 布局（`.app-shell height:100%`、`shell-main min-height:0`、BottomPanel 100px）并复跑 controls 几何用例。
- 保留：P2-4 binding guard 专门单测、P2-5 Explorer 路径配置化，均列入 Phase 2。
- 要求：不引入新的 P0/P1；不破坏 M5 的 GraphIR/history/binding/LOD/e2e 行为。
