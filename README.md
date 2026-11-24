# Origin_ROSUI

ROS 2 可视化节点编辑器 —— 目标：像 ComfyUI 一样在画布节点上直接编辑参数（真实 DOM 控件、连线即隐藏、可绑定运行时参数）。

当前状态：**方案阶段**（仓库尚未初始化代码，见 `docs/ROSUI-落地方案.md` 的 M0）。

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

## 预计启动命令（M0 完成后生效）

```bash
pnpm install
pnpm dev          # 起前端
pnpm check        # tsc + eslint + vitest
pnpm e2e          # Playwright
scripts/demo.sh   # rosbridge + demo 节点 + 前端，一条命令
```

## 开工前必须确认的三件事

1. rosbridge 是否允许用 sudo 安装（`ros-jazzy-rosbridge-suite` 2.7.1，本机未装）。
2. 运行时参数绑定是否用现有业务节点，还是先做一个 demo 节点（`ros2/rosui_demo`）。
3. 先做「数/文本/布尔」三件套跑通闭环，还是一步到位做 Pose 表单。
