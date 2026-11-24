# Origin_ROSUI

ROS 2 可视化节点编辑器 —— 目标：像 ComfyUI 一样在画布节点上直接编辑参数（真实 DOM 控件、连线即隐藏、可绑定运行时参数）。

当前状态：**M1 骨架已跑通**（Rete 画布 + 端口内联数字控件 + 连线显隐联动；IR v1 定稿；rosbridge 无 root 可跑；demo 参数节点可用）。

## 文档入口

| 文件 | 内容 |
|---|---|
| [`docs/ROSUI-落地方案.md`](docs/ROSUI-落地方案.md) | 主方案：能力定义、架构、ADR、GraphIR、关键技术点、里程碑、会话拓扑、角色分工、流水线、门禁、风险 |
| [`docs/backlog.md`](docs/backlog.md) | 20 张可直接建到任务板的卡（T-001..T-020，M0–M2） |
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
corepack pnpm dev         # 起前端（Vite，默认 5173/5174）
corepack pnpm build       # tsc + vite build
corepack pnpm check       # tsc --noEmit ×2 + vitest（IR 5 例）

scripts/ros-up.sh             # 起 rosbridge :9090（无 root，见下）
scripts/test-demo-params.sh   # 验证 demo 节点 4 类参数与校验
```

## 两个环境坑（已解决，别重踩）

- **sudo 不可用**：本机 `NoNewPrivs=1`，`sudo`/`apt install` 直接被拒。rosbridge 改为 `scripts/fetch-rosbridge.sh` 下载 deb 解包到 `vendor/prefix`，`scripts/ros-up.sh` 设好 `AMENT_PREFIX_PATH/PYTHONPATH/LD_LIBRARY_PATH` 后启动（纯 Python，无需编译）。
- **npm 缓存 EACCES**：`.npmrc` 把 cache 指到仓库内 `.npm-cache/`，registry 用 npmmirror。

## 开工前必须确认的三件事

1. rosbridge 是否允许用 sudo 安装（`ros-jazzy-rosbridge-suite` 2.7.1，本机未装）。
2. 运行时参数绑定是否用现有业务节点，还是先做一个 demo 节点（`ros2/rosui_demo`）。
3. 先做「数/文本/布尔」三件套跑通闭环，还是一步到位做 Pose 表单。
