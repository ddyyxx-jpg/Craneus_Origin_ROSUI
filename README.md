# Origin_ROSUI

ROS 2 可视化节点编辑器 —— 目标：像 ComfyUI 一样在画布节点上直接编辑参数（真实 DOM 控件、连线即隐藏、可绑定运行时参数）。

当前状态：**M5 进行中（保存/加载 + LOD 已完成）** —— GraphIR 文件存盘/加载（`.rosui.json`，含节点位置、控件值、运行期绑定元数据与连线）与缩放 LOD 混合渲染（<0.32 切占位、>0.38 恢复、200 节点混合图 + 149 连线压测首帧 full 744ms / placeholder 371ms，拖动 ~16.2ms/帧）都跑通；本分支 43 条 Playwright（41 条默认执行 + perf 2 条显式开启，`e2e/lod.spec.ts` 3 条新增已计入默认），`vitest` 43 例。M3 的 Pose 复杂 DOM 控件、M4 的运行时绑定/参数浏览器/Inspector/Script 均已并入。

- UI 改值 → `rosapi/set_param` → 节点参数真的变；外部 `ros2 param set` → `/parameter_events` → 控件 2s 内跟着变。
- 已绑定：`Gain.gain`、`Switch.enabled`、`Mode.mode`、`Pose.pose`（`/rosui_demo`）；`Threshold.value` 故意不绑定作对照。
- 工具栏 `+ Pose` 可添加 Pose 节点（默认 5 节点不变，避免既有 e2e 断言失效）。
- 断线**不锁控件**：停止下发但保留编辑，重连以节点值为准（见 `docs/adr/ADR-006-parameter-events.md` 补记）。

## 文档入口

| 文件 | 内容 |
|---|---|
| [`docs/ROSUI-落地方案.md`](docs/ROSUI-落地方案.md) | 主方案：能力定义、架构、ADR、GraphIR、关键技术点、里程碑、会话拓扑、角色分工、流水线、门禁、风险 |
| [`docs/backlog.md`](docs/backlog.md) | 23 张任务卡（T-001..T-023，M0–M3） |
| `docs/reviews/` | 评审报告（R 产出） |
| `docs/feedback/` | 试运行反馈（Q/R 产出） |
| `docs/handoff/` | 里程碑交接块 |

## 三条主线（谁干什么）

- **画布**（`apps/web/src/editor/`）：Rete.js v2 + React 19，节点/端口/连线。
- **控件**（`apps/web/src/controls/`）：端口内联控件、连线显隐、复杂 DOMWidget。
- **桥接**（`apps/web/src/ros/`）：rosbridge + rosapi + `/parameter_events` 双向同步。

## 常用命令（已实测）

```bash
corepack pnpm install     # 本机 PATH 无裸 pnpm，统一用 corepack
corepack pnpm dev         # 起前端（Vite，固定 5180）
corepack pnpm build       # tsc + vite build
corepack pnpm check       # tsc --noEmit ×2 + vitest（IR 5 例）
corepack pnpm -w exec vitest --run apps/web/src packages/ir  # 全量单测

scripts/ros-up.sh             # 起 rosbridge :9090（无 root，见下）
scripts/demo-stack.sh         # rosbridge + demo 参数节点一起起（--check 自检读写/校验）
node node_modules/@playwright/test/cli.js test   # 41 条默认 e2e（perf 2 条默认跳过；binding/m3 会自己拉起 demo 栈）
ROSUI_PERF=1 node node_modules/@playwright/test/cli.js test e2e/perf.spec.ts  # 200 节点混合图压测（需显式开启）
scripts/test-demo-params.sh   # 验证 demo 节点 4 类参数与校验
```

## 两个环境坑（已解决，别重踩）

- **sudo 不可用**：本机 `NoNewPrivs=1`，`sudo`/`apt install` 直接被拒。rosbridge 改为 `scripts/fetch-rosbridge.sh` 下载 deb 解包到 `vendor/prefix`，`scripts/ros-up.sh` 设好 `AMENT_PREFIX_PATH/PYTHONPATH/LD_LIBRARY_PATH` 后启动（纯 Python，无需编译）。
- **npm 缓存 EACCES**：`.npmrc` 把 cache 指到仓库内 `.npm-cache/`，registry 用 npmmirror。

## 开工前必须确认的三件事

1. rosbridge 是否允许用 sudo 安装（`ros-jazzy-rosbridge-suite` 2.7.1，本机未装）。
2. 运行时参数绑定是否用现有业务节点，还是先做一个 demo 节点（`ros2/rosui_demo`）。
3. 先做「数/文本/布尔」三件套跑通闭环，还是一步到位做 Pose 表单。
