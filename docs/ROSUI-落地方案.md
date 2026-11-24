# ROSUI 落地方案 v1

> 目标：把「ComfyUI 式画布参数编辑」从概念落到一个**可演示、可验收**的 ROS 2 可视化节点编辑器；
> 并用 DSH 多智能体把「写代码 → 评审 → 试运行 → 反馈」跑成可重复的流水线。

- 适用工作区：`/home/ddyyxx/Origin_ROSUI`（当前为空，按绿地项目规划）
- 目标机：Ubuntu 24.04 + ROS 2 Jazzy + Node 22（已核实）
- 文档状态：v1，待确认后冻结为 G0

---

## 0. 一页纸结论

| 项 | 结论 |
|---|---|
| 做什么 | 一个浏览器里的 ROS 2 节点编辑器：参数控件长在节点端口上、连线即隐藏、运行时与真实参数双向同步 |
| 不做什么 | 多用户协作、完整代码生成、真实机器人上线（MVP 只到仿真 + demo 节点） |
| 技术底座 | Vite + React 19 + TS / Rete.js 2.x / roslib 2.1 / rosbridge_suite 2.7.1 + `/parameter_events` |
| 组织方式 | 1 条主线会话 + 5 个固定角色 + 1 个只读评审；任务板驱动；每张卡都有验收命令和证据 |
| 交付节奏 | M0 骨架 0.5d → M1 内联控件 2d → M2 参数双向 2d → M3 复杂控件 1.5d → M4 试运行 1.5d |
| 首个可演示 | M1 结束：拖节点、改参数、连线后控件消失、断线后回来 |
| 最终验收 | `scripts/demo.sh` 一条命令起全链路；浏览器改滑块 → `ros2 param get` 同步；CLI 改参数 → 画布控件 1s 内更新 |

**一句话**：先用 Rete 的 `Input.control + showControl` 做出「画布感」，再用 rosbridge 的 `rosapi/set_param` + `/parameter_events` 打通「真参数」，最后用 Playwright 把这两件事钉成回归测试。

---

## 1. 从分享对话到工程定义

分享对话给出四条设计原则，这里翻译成四个可开发、可验收的能力：

| 原文要点 | 工程能力编号 | 交付物 | 验收方式 |
|---|---|---|---|
| 控件是真实 DOM，不画在 Canvas 上 | **C1 内联控件** | 数字/文本/枚举/布尔四种端口控件 | 能在输入框里正常打字、选中、复制 |
| 未连线显示默认值，连线后隐藏 | **C2 显隐联动** | 连线/断线时 `showControl` 自动切换 | 连线后控件消失、label 出现；断线后恢复 |
| 节点是微型应用容器（DOMWidget） | **C3 复杂控件** | Pose 表单、JSON 折叠编辑器 | 缩放/平移画布时控件位置与交互正确 |
| 混合渲染（Canvas 布局 + DOM 内容） | **C4 性能策略** | 只在 M3 实测后决定是否做 | 100 节点下拖动画布 ≥ 30fps |

### 1.1 用户故事

- **US-1**：作为调试者，我在画布上直接改节点参数，不用切到终端敲 `ros2 param set`。
- **US-2**：作为搭图的人，端口没接线时我能看到并编辑默认值；接线后它让位给数据流，节点不被控件撑爆。
- **US-3**：作为观察者，别人（或 CLI）改了参数，我能立刻在画布上看到值变化，而不是刷新页面。

### 1.2 验收口径（可测，不可含糊）

| 编号 | 场景 | 判定 | 证据 |
|---|---|---|---|
| AC-1 | 未连线的数字端口 | 输入 `3.5`，IR 中 `value=3.5`，`ros2 param get` 返回 `3.5` | e2e 断言 + 终端输出 |
| AC-2 | 连线后 | 控件 DOM 消失、label 出现；断线后 300ms 内恢复 | 前后截图对比 |
| AC-3 | CLI 改参数 | `ros2 param set` 后 1s 内画布控件值更新 | e2e 断言 |
| AC-4 | 断线重连 | 杀掉 rosbridge 再拉起，页面 5s 内自动重连且状态可见 | 录屏 + 日志 |
| AC-5 | 100 节点 | 拖动/缩放假死不超过 200ms | Performance 面板截图 |

### 1.3 非目标（本 MVP 明确不做）

- 多用户协同编辑、权限体系
- 从图生成完整 ROS 2 包/launch
- 真实机械臂/实车联调（只做 demo 节点 + 可选 Gazebo）
- 任意 msg 类型的全自动表单（M3 只做 Pose + JSON 兜底）

---

## 2. 技术方案（版本已核实）

### 2.1 分层

```
┌─────────────────────────────────────────────────────────┐
│ apps/web  (Vite + React 19 + TS)                        │
│  ├─ editor/   Rete 画布、节点、端口、连线、选择           │
│  ├─ controls/ C1/C2/C3：内联控件、显隐、DOMWidget        │
│  └─ ros/      RosClient 封装（连接、重连、状态机）        │
├─────────────────────────────────────────────────────────┤
│ packages/ir   GraphIR 类型 + zod 校验 + 序列化/迁移       │
├─────────────────────────────────────────────────────────┤
│ WebSocket ws://host:9090  (rosbridge v2 JSON)           │
├─────────────────────────────────────────────────────────┤
│ ROS 2 Jazzy: rosbridge_server + rosapi + demo nodes     │
│   参数：/rosapi/get_param, /rosapi/set_param            │
│   变更：/parameter_events (rcl_interfaces/ParameterEvent)│
└─────────────────────────────────────────────────────────┘
```

### 2.2 版本锁定（2026-11-24 实测）

| 包 | 版本 | 说明 |
|---|---|---|
| `rete` | 2.0.6 | 核心；`ClassicPreset` 在此 |
| `rete-area-plugin` | 2.3.2 | 画布、缩放、`area.update(type,id)` |
| `rete-connection-plugin` | 2.0.5 | 连线交互 |
| `rete-react-plugin` | 2.1.2 | React 渲染；支持 React 19 |
| `rete-render-utils` | 2.0.3 | socket 位置计算 |
| `rete-engine` | 2.1.1 | 数据流执行（M2 用） |
| `styled-components` | ^6 | **`rete-react-plugin` 的 peer 依赖，必须显式装**（^5.3.6 也兼容） |
| `roslib` | 2.1.0 | **ESM-only**，Node ≥ 20 |
| `ros-jazzy-rosbridge-suite` | 2.7.1 | 本机 apt 候选已确认，**尚未安装** |
| `@playwright/test` | 最新 | 无头试运行 |

所有版本写进 `package.json` 时用精确版本（不带 `^`），避免 agent 并行安装时漂移。
React 19 下必须 `new ReactPlugin({ createRoot })`（从 `react-dom/client` 传入），否则渲染报错；TypeScript ≥ 4.7，否则可能 `ts(2589)`。

### 2.3 关键决策（ADR）

**ADR-001：用 Rete.js，不换 LiteGraph。**
Rete v2 是 TS 优先、React 渲染、端口有类型系统，和「参数控件即 DOM」的目标天然一致；LiteGraph（ComfyUI 底座）更成熟但 canvas-first、TS 类型弱，且 ComfyUI 用的是分叉版。
**代价**：Rete 生态小、文档偏少。
**翻盘条件**：M1 结束时若 C1/C2 任一无法在 Rete 内实现（不 fork 源码），才评估切 LiteGraph；届时只换 `editor/` 层，IR 和 `ros/` 层不动。

**ADR-002：控件一律真实 DOM，不用 Canvas 绘制。**
这是 ComfyUI 体验的底线：键盘输入、复制粘贴、无障碍、复杂控件都依赖它。

**ADR-003：参数变更订阅 `/parameter_events`，不做轮询。**
rosapi **没有**参数变更事件；Jazzy 中 `ros2 param set` 会触发 `/parameter_events`（已实测）。
轮询只做兜底：重连后拉一次全量 `get_param_names` + `get_param`。
前端必须同时处理 `new_parameters` / `changed_parameters` / `deleted_parameters`——首次 set 往往落在 `new_parameters`，只监听 changed 会漏。

**ADR-004：MVP 浏览器直连 rosbridge，不自建 gateway。**
少一层、少一个进程；前端用 `RosClient` 接口隔离，后续要加鉴权/多机器人时替换实现即可。
**安全**：rosbridge 接受任意 Origin 且无认证，演示只绑内网、演示完即关。

**ADR-005：参数名在 IR 里拆成两段存。**
`{ node: "/web_editor_node", param: "gain" }`，序列化时才拼 `/web_editor_node:gain`。
理由：rosapi 的参数名格式是 `<node>:<param>`，存整串容易在改名/迁移时出错。

### 2.4 GraphIR v0

```ts
// packages/ir/src/types.ts
export type WidgetKind = 'number' | 'text' | 'boolean' | 'select' | 'pose' | 'json'

export interface ParamBinding {
  node: string            // "/web_editor_node"
  param: string           // "gain"
  valueType: 'double' | 'integer' | 'boolean' | 'string' | 'string_array'
  mode: 'static' | 'runtime'
  widget: WidgetKind
  constraints?: { min?: number; max?: number; step?: number; options?: string[] }
}

export interface NodeIR {
  id: string
  type: string            // "rosui/Gain"
  position: { x: number; y: number }
  params: Record<string, ParamBinding>   // key = 端口名
}

export interface GraphIR {
  version: 1
  nodes: NodeIR[]
  edges: { id: string; source: string; sourcePort: string; target: string; targetPort: string }[]
}
```

示例：

```json
{
  "version": 1,
  "nodes": [{
    "id": "n1", "type": "rosui/Gain", "position": { "x": 120, "y": 80 },
    "params": {
      "gain": { "node": "/web_editor_node", "param": "gain", "valueType": "double",
                "mode": "runtime", "widget": "number",
                "constraints": { "min": 0, "max": 10, "step": 0.1 } }
    }
  }],
  "edges": []
}
```

### 2.5 三个关键技术点（已从源码核实）

**(a) 端口内联控件 = `Input.control` + `showControl`**

```ts
import { ClassicPreset } from 'rete'

const socket = new ClassicPreset.Socket('number')
const input = new ClassicPreset.Input(socket, 'gain')

// 端口内联控件必须 addControl 到 Input 上（不是 node.addControl）
input.addControl(
  new ClassicPreset.InputControl('number', {
    initial: 1.0,
    readonly: false,
    // 唯一官方回写路径：setValue(v) 会调用 change(v)
    change: (v) => { this.gain = v }
  })
)
this.addInput('gain', input)
```

关键事实（`rete@2.0.6` / `rete-react-plugin@2.1.2` 源码）：
- 输入行渲染逻辑是 `input.control && input.showControl ? <RefControl payload={input.control}/> : <div className="input-title">{input.label}</div>`，所以「连线隐藏」只需切 `showControl`，不需要自定义节点组件。
- `InputControl` 内置类型**只有 `text` / `number`**；`select`/`boolean`/`pose`/`json` 必须自定义 `Control` 子类 + `customize.control`。
- 写值协议：`control.setValue(v)` 赋值并调用 `options.change(v)`；直接 `control.value = v` **不触发** `change`。外部程序改值后若界面没刷新，再补 `area.update('control', control.id)`。

**(b) 连线联动 = 官方扩展 `showInputControl`（首选）**

```ts
import { AreaExtensions } from 'rete-area-plugin'

// 默认策略：该 input 只要有连线就隐藏控件，断开后自动显示
AreaExtensions.showInputControl(area)

// 需要更细的规则时传第二个参数
AreaExtensions.showInputControl(area, ({ hasAnyConnection, input }) => !hasAnyConnection)
```

该扩展内部监听 `connectioncreated` / `connectionremoved`，自己算出 `hasAnyConnection` 并 `area.update('node', node.id)`；不要重复实现。

只有在需要额外副作用（比如写回 IR、发遥测）时才自己挂管道，手写版必须注意：

```ts
editor.on('connectioncreated', async (conn) => {
  const node = editor.getNode(conn.target) as ClassicPreset.Node
  const input = node.inputs[conn.targetInput]
  if (input?.control) {
    input.showControl = false
    await area.update('node', node.id)   // 必须刷 node，刷 control 不会切换分支
  }
})

editor.on('connectionremoved', async (conn) => {
  const stillConnected = editor.getConnections().some(
    (c) => c.target === conn.target && c.targetInput === conn.targetInput
  )
  if (!stillConnected) {
    const node = editor.getNode(conn.target) as ClassicPreset.Node
    const input = node.inputs[conn.targetInput]
    if (input?.control) {
      input.showControl = true
      await area.update('node', node.id)
    }
  }
})
```

注意：
- 用 `connectioncreated` / `connectionremoved`，**不要**用 `connectioncreate` / `connectionremove`——后者在建连写入 `editor` 之前触发，此时 `getConnections()` 还看不到新连线。
- `connection` 对象只有 `source` / `target` / `sourceOutput` / `targetInput`；socket 要从 `node.ports` 上取，别指望 connection 带 socket。
- 删除连线后要先检查同一端口是否还有其他连接（多连接端口），上面的 `stillConnected` 就是干这个。
- 自定义控件里的交互元素（select/input/button）必须 `Drag.useNoDrag(ref)` 或 `onPointerDown={e => e.stopPropagation()}`，否则点击会变成拖节点；可编辑文本区还要设 `user-select: all`（classic 节点默认 `none`）。

**(c) 参数双向 = rosapi 服务 + `/parameter_events`**

```ts
import { Ros, Param, Topic } from 'roslib'

const ros = new Ros({ url: 'ws://localhost:9090' })
const p = new Param({ ros, name: '/web_editor_node:gain' })

// 写
p.set(3.5, (r) => r.successful || console.error(r.reason), console.error)

// 读（首次渲染/重连兜底）
p.get((v) => setControlValue(v), console.error)

// 实时变更
new Topic({ ros, name: '/parameter_events', messageType: 'rcl_interfaces/msg/ParameterEvent' })
  .subscribe((msg) => {
    for (const p of [...msg.new_parameters, ...msg.changed_parameters]) {
      if (`${msg.node}:${p.name}` === bindingKey) applyValue(p.value)
    }
  })
```

坑：
- `set_param` 的 `value` 是 **JSON 字符串**（roslib 已处理）；直接发数字会被拒。
- int64 可能以字符串跨桥，前端转 Number 前先判 `Number.isSafeInteger`。
- 未声明的参数 set 会失败；demo 节点必须 `declare_parameter`。
- 节点启动时会刷一批参数事件，首帧要按 `node + stamp` 过滤，否则控件会闪。

### 2.6 控件-类型映射

| ROS 类型 | 控件 | 校验 |
|---|---|---|
| double / float | 滑杆 + 数字输入（联动） | min/max/step |
| integer | 步进器 | 整数、范围 |
| boolean | 开关 | — |
| string | 单行输入 | 长度、正则（可选） |
| string[] / enum | 下拉 | options |
| geometry_msgs/Pose | Pose 表单（DOMWidget） | 6 个数 |
| 其他复杂类型 | 折叠 JSON 编辑器 + zod 校验 | schema |

### 2.7 自定义控件接入（签名已核实）

```ts
// 1) 控件类：继承 ClassicPreset.Control
export class EnumControl extends ClassicPreset.Control {
  constructor(
    public options: readonly string[],
    public value: string,
    public change?: (v: string) => void
  ) { super() }
  setValue(v: string) { this.value = v; this.change?.(v) }
}

// 2) 渲染：customize.control 返回 React 组件，组件收到 { data }
render.addPreset(
  Presets.classic.setup({
    customize: {
      control(ctx) {
        if (ctx.payload instanceof EnumControl) return EnumControlView
        if (ctx.payload instanceof ClassicPreset.InputControl) return Presets.classic.Control
        return null
      }
    }
  })
)
```

规则：
- 内置控件必须显式 `return Presets.classic.Control`，否则 text/number 控件会消失。
- 自定义控件里所有可交互元素加 `Drag.useNoDrag(ref)`，或在 `onPointerDown` 里 `stopPropagation()`。
- 复杂表单（Pose、JSON）两条路：轻量走自定义 Control；需要多行布局/折叠就走 `customize.node` 自定义节点组件，用 `Presets.classic.RefSocket` / `RefControl` 保住端口定位，尺寸变化后调 `area.resize(node.id, w, h)`。
- 自定义节点的 socket ref 必须正确 unmount，否则出现 "Found more than one element for socket with same key and side" 警告并泄漏。

---

## 3. 仓库与工程基线

### 3.1 目录

```
Origin_ROSUI/
├─ apps/web/                 # Vite + React + TS
│  └─ src/{editor,controls,ros,app}/
├─ packages/ir/              # 类型 + zod + 序列化
├─ services/bridge/          # 预留：自建 WS 代理（MVP 不启用）
├─ ros2/rosui_demo/          # demo 节点、launch、参数回调
├─ e2e/                      # Playwright + fixtures + artifacts
├─ scripts/                  # env.sh, ros-up.sh, demo.sh
├─ docs/
│  ├─ ROSUI-落地方案.md       # 本文
│  ├─ backlog.md             # 任务卡
│  ├─ adr/                   # 决策记录
│  ├─ handoff/               # 里程碑交接
│  └─ feedback/              # 试运行反馈
└─ .npmrc                    # registry + 仓库内 cache
```

### 3.2 环境前置（P0，今天必须解决）

| 问题 | 现状 | 处理 |
|---|---|---|
| sudo 不可用 | `NoNewPrivs=1`，`sudo`/`apt install` 直接被拒 | 改为**无 root 解包**：`scripts/fetch-rosbridge.sh` 下载 deb 到 `vendor/prefix`，`scripts/ros-up.sh` 设 `AMENT_PREFIX_PATH/PYTHONPATH/LD_LIBRARY_PATH` 启动（已实测 9090 可连、rosapi 可用） |
| npm 缓存有 root 残留 | `~/.npm/_cacache` EACCES | 不用全局缓存，`.npmrc` 指到仓库内 `.npm-cache` |
| 代理未开时 npm 不通 | 127.0.0.1:7890 拒绝连接 | 项目 `.npmrc` 用 npmmirror；需要 GitHub 时再开代理 |
| ROS 日志目录 | 默认 `~/.ros/log` 可能不可写 | 所有脚本 `export ROS_LOG_DIR=/tmp/roslog` |
| 文件沙箱 | 只能写工作区 | 所有产物落仓库内，不写 `~/` |

`.npmrc`：

```ini
registry=https://registry.npmmirror.com
cache=.npm-cache
```

### 3.3 脚本基线

| 命令 | 作用 | 时限 |
|---|---|---|
| `pnpm dev` | 起前端 | — |
| `pnpm check` | tsc + eslint + vitest | < 40s |
| `pnpm e2e` | 起 ROS + 前端 + Playwright | < 3min |
| `scripts/demo.sh` | 一条命令起演示环境 | < 30s |

---

## 4. 里程碑

| 里程碑 | 目标 | 关键产出 | 演示（Demo） | 预估 |
|---|---|---|---|---|
| **M0 骨架** | 链路先通 | monorepo、Rete 空画布、RosClient 连上 9090、demo 节点、CI 脚本 | 页面显示 `connected` + `/chatter` 实时文本 | 0.5d |
| **M1 内联控件** | 画布感 | number/text/bool/select 控件、显隐联动、IR v0、单测 | 拖 2 个节点、改值、连线控件消失、断线恢复 | 2d |
| **M2 参数双向** | 真参数 | get/set、`/parameter_events` 订阅、重连兜底、类型校验 | 滑块 → CLI 同步；CLI → 画布 1s 内更新 | 2d |
| **M3 复杂控件** | 容器化 | Pose 表单、JSON 编辑器、zod 校验、错误态 | 编辑 Pose 6 字段并下发成功/失败提示 | 1.5d |
| **M4 试运行** | 可交付 | e2e 全绿、demo.sh、反馈闭环、文档 | 5 分钟演示脚本一次跑通 | 1.5d |

依赖关系：M0 → M1 → M2；M3 依赖 M2 的绑定层；M4 依赖全部。

每个里程碑结束必须产出：
1. `docs/handoff/Mx.md`（做了什么/没做什么/怎么跑/已知坑）
2. 一次全量 `pnpm check` + `pnpm e2e` 的退出码与报告路径
3. 一张关键界面截图（存 `docs/artifacts/`）

---

## 5. 会话与智能体分工

### 5.1 会话拓扑

```
主线会话（lead，唯一对用户交付）
├─ 子代理 canvas-dev   （M1 起，常驻到 M3）
├─ 子代理 control-dev  （M1 起，核心）
├─ 子代理 bridge-dev   （M0 起）
├─ 子代理 ir-dev       （M1 前半）
├─ 子代理 ros-dev      （M0/M2，按需）
├─ 子代理 reviewer     （每张卡，只读）
└─ 子代理 e2e-runner   （M0 起，按需）
```

**为什么不是「一个角色一个 GUI 会话」**：DSH 的任务板、子代理树、上下文都只在同一会话内共享。拆成多个 GUI 会话 = 任务板断裂、交接靠人肉粘贴。所以默认单主线 + 子代理池。

**什么时候才开新 GUI 会话**（满足任一）：
1. 跨天且主线上下文已 > 60%；
2. 需要用户中途接管、长时间等待外部条件（如等硬件）；
3. 主线被一次失败的大重构污染，需要干净上下文重来。

新会话开场必须贴交接块（见 §10.4），30 秒内恢复状态。

### 5.2 五条会话纪律

1. **单一出口**：只有 lead 对用户汇报；子代理的结论必须回到 lead 再转述。
2. **单一合并者**：只有 lead 能改 `package.json`、锁文件、根配置、`docs/` 索引。
3. **任务板即事实**：口头说「做完了」不算，卡上要有证据（命令 + 退出码 + 截图路径）。
4. **写域不重叠**：并行任务的文件 scope 必须互斥（见 §5.5），重叠就串行。
5. **上下文预算**：单卡 ≤ 100k tokens 或 ≤ 40 步；超了先交半成品 + 交接，不硬撑。

### 5.3 角色表

| 代号 | 角色 | 职责 | 可写范围 | 模型档 | 主要产出 |
|---|---|---|---|---|---|
| **L** | lead / 架构 | 拆卡、定 IR、合并、验收、对用户 | `docs/`、根配置、`package.json` | 强 | 方案、任务卡、合并提交 |
| **A** | canvas-dev | Rete 画布、节点/端口渲染、连线规则、选择/删除 | `apps/web/src/editor/**` | 中 | 可操作的画布 |
| **B** | control-dev | C1/C2/C3：控件、显隐、DOMWidget、校验 | `apps/web/src/controls/**` | 中 | 控件库 |
| **C** | bridge-dev | RosClient、参数读写、事件订阅、重连状态机 | `apps/web/src/ros/**`、`services/bridge/**` | 中高 | 稳定连接层 |
| **D** | ros-dev | demo 节点、launch、参数回调、e2e fixture | `ros2/**`、`e2e/fixtures/**` | 中 | 可复现的 ROS 侧 |
| **E** | ir-dev | GraphIR 类型、zod、序列化、迁移 | `packages/ir/**` | 中 | IR v0 + 测试 |
| **R** | reviewer | 只读评审、跑门禁、给 verdict | 无（只读） | 强 | 评审报告 |
| **Q** | e2e-runner | Playwright、脚本、证据归档 | `e2e/**`、`scripts/**` | 低-中 | 绿色流水线 + artifacts |

**最小阵容**：L + B + C + R（4 个）；A/E 在 M1 加入；D/Q 按需。**同时在写的 agent 不超过 3 个**。

### 5.4 任务卡协议

用 `team_task_create` 建卡，字段固定：

```
T-012 | 输入端口内联数字控件
owner: B        scope: apps/web/src/controls/number.tsx, apps/web/src/controls/types.ts
depends: T-010, T-011
背景: 端口未连线时要能直接改默认值，连线后让位给数据流
验收:
  - [ ] 数字控件渲染在 input 行内，未连线可见
  - [ ] 连线后控件隐藏、label 出现（截图 before/after）
  - [ ] 断线后 300ms 内恢复
  - [ ] pnpm check 退出码 0
  - [ ] 无 any、无新增依赖
证据: 命令 + 退出码 + 截图路径
```

状态机：`pending → in_progress → review → done`；`review` 只有 reviewer 能签。

### 5.5 写域与冲突规则

| 路径 | 归属 | 规则 |
|---|---|---|
| `apps/web/src/editor/**` | A | B 不得直接改；需要接口时由 A 提供 props/callback |
| `apps/web/src/controls/**` | B | A 只通过注册表引用 |
| `apps/web/src/ros/**` | C | 对外只暴露 `RosClient` 接口 |
| `packages/ir/**` | E | 类型变更需 L 批准（影响所有人） |
| `ros2/**` | D | 前端不直接依赖 |
| `e2e/**`、`scripts/**` | Q | 其他人只读 |
| `package.json`、`pnpm-lock.yaml`、根配置 | **L 独占** | 子代理提需求，L 来改 |
| `docs/**` | L | 子代理只写自己的 handoff 片段 |

冲突处理：两边都要改同一文件 → 立即停手，L 决定拆分方式或串行。

### 5.6 模型路由与预算（估算，非承诺）

| 角色 | 档位 | 理由 |
|---|---|---|
| L | 强推理 | 拆解、仲裁、合并冲突、验收判断 |
| R | 强推理 | 对抗性评审最吃推理 |
| C | 中高 | 协议细节、重连状态机 |
| A/B/E | 中 | 代码量大但模式清晰 |
| D/Q | 中低 | 模板化、可复制 |

预算护栏：单卡 ≤ 100k tokens / 40 步；单里程碑 ≤ 2.5M tokens；超预算先交付可运行半成品 + handoff，不静默失败。

---

## 6. 流水线：从代码到反馈

### 6.1 一张卡的生命周期

```
① L 拆卡（写 scope/depends/验收） 
② B 领取（team_task_update claim）
③ B 实现 + 自测（pnpm check 局部）
④ B 提 commit（分支 feat/T-012，conventional commit）
⑤ R 评审（读 diff、跑门禁、8 问）
⑥ Q 跑 e2e（若是可视改动）
⑦ L 合并（ squash 到 main）+ 更新任务板
⑧ Demo（截图/录屏进 docs/artifacts）
⑨ 反馈 → 新卡（§6.5）
```

### 6.2 编码规约

- 分支：`feat/M1-controls`、`fix/T-018-...`；一个里程碑一个长分支，卡片用小提交。
- 提交：`feat(controls): inline number control on input port (T-012)`。
- TS `strict: true`，禁止 `any`（确需时 `unknown` + 收窄）。
- 不新增依赖；确需时在卡里写理由，L 批准后由 L 安装。
- 组件必须能被 Storybook/单测单独渲染（不依赖全局 editor 单例）。

### 6.3 评审（reviewer 必答 8 问）

1. 行为是否符合验收条目？逐条对照。
2. 边界：空值、NaN、超范围、重复连线、快速连点。
3. 类型：有没有 `any`、非空断言、隐式 `number|string`。
4. 状态：`showControl` 与真实连接数是否可能不一致？
5. 性能：每次输入是否触发全图重渲染？`area.update` 范围是否最小？
6. 事件：键盘/指针事件有没有冒泡到画布导致拖拽？
7. 越界：有没有改到 scope 外的文件？有没有偷偷加依赖？
8. 可回滚：这个提交单独 revert 会不会破坏别的卡？

verdict 格式：

```
VERDICT: REQUEST_CHANGES
BLOCKING:
- apps/web/src/controls/number.tsx:42 输入空串时 value=NaN，会写坏参数 → 期望保留上次有效值
NON-BLOCKING:
- 建议把 300ms 防抖抽成 hook
EVIDENCE:
- pnpm check → exit 0
- pnpm e2e → 3 passed
```

### 6.4 三级试运行

**L1 静态与单测（每次提交，< 40s）**

```bash
pnpm check   # tsc --noEmit && eslint . && vitest run
```

**L2 无头端到端（每个可视改动，< 3min）**

```bash
scripts/ros-up.sh          # 起 rosbridge + demo 节点，独立 ROS_DOMAIN_ID
pnpm e2e                   # Playwright：加载页 → 改控件 → 断言 param → CLI 改参 → 断言控件
scripts/ros-down.sh
```

断言示例（Playwright）：

```ts
await page.getByTestId('input-control-gain').fill('3.5')
await expect.poll(() => rosParam('/web_editor_node:gain')).toBe(3.5)

execSync('ros2 param set /web_editor_node gain 7.0')
await expect(page.getByTestId('input-control-gain')).toHaveValue('7.0', { timeout: 1000 })
```

**L3 真人演示（每个里程碑，5 分钟）**

`scripts/demo.sh` 依次起：rosbridge → demo 节点 → 前端 → 打开浏览器；打印 5 步 checklist：

1. 看到 `connected` 绿点
2. 拖入 Gain 节点，滑块显示 1.0
3. 拖到 3.5，终端 `ros2 param get` 显示 3.5
4. 从常量节点接线到 gain 端口，控件消失
5. 终端改参数为 7.0，画布 1s 内更新

### 6.5 反馈闭环

每次 L3 后填反馈表（`docs/feedback/Mx.md`）：

| 维度 | 观察 | 期望 | 严重度 | 证据 | 转卡 |
|---|---|---|---|---|---|
| 手感 | 拖动滑块有 200ms 延迟 | < 50ms | P2 | 录屏 00:32 | T-031 |
| 正确 | 连线后值没写回 | 断线时保留最后值 | P1 | 截图 | T-032 |
| 可读 | 断连时只有红点没文案 | 显示「重连中 3s」 | P2 | — | T-033 |
| 稳定 | 杀进程后不重连 | 5s 内自动重连 | P0 | 日志 | T-034 |
| 性能 | 60 节点开始卡 | 100 节点可用 | P3 | Performance | backlog |

分级与时限：P0 当天修；P1 本里程碑内；P2 下一里程碑；P3 进 backlog。

复盘指标（每里程碑记一次）：
- 一次通过率 = 无 REQUEST_CHANGES 的卡 / 总卡（目标 ≥ 70%）
- e2e flake 率（目标 < 5%）
- 反馈闭环时长（目标 ≤ 2 天）
- 演示阻断缺陷数（目标 0）

---

## 7. 质量门禁

| Gate | 时点 | 通过条件 | 不通过怎么办 |
|---|---|---|---|
| **G0 方案冻结** | 开工前 | ADR 5 条 + IR v0 + AC 表确认 | 不开工，先补决策 |
| **G1 代码门** | 每张卡 | `pnpm check` 绿 + reviewer APPROVE | 打回，不合并 |
| **G2 试运行门** | 每里程碑 | `pnpm e2e` 全绿 + demo 5 步无人工干预 | 不计里程碑完成 |
| **G3 验收门** | M4 | 用户按 AC-1..5 逐条打勾 | 进修复卡，不结项 |

---

## 8. 风险登记册

| # | 风险 | 触发信号 | 对策 |
|---|---|---|---|
| R1 | Rete 控件能力不足 | 无法在 input 行内放自定义控件 | 已源码核实可行；真遇阻则 C1 降级为节点底部控件，仍保留 C2 |
| R2 | `setValue` 不刷新 DOM | 外部改值后界面不动 | `setValue(v)` 会调用 `options.change`，但界面是否同步取决于渲染层；外部写入后补 `area.update('control', id)`，显隐变化必须 `area.update('node', id)` |
| R3 | 参数事件噪声 | 控件值闪烁/回跳 | 过滤 node + 首帧丢弃 + 输入中 300ms 不上屏 |
| R4 | 类型不匹配被拒 | `successful=false` | set 前先 get，按原类型写；错误 toast |
| R5 | 断线重连竞态 | 重连后重复订阅/重复写 | RosClient 单例 + 订阅表 + 连接代际号 |
| R6 | 画布快捷键冲突 | 输入框里按空格拖动整个画布 | 控件内 `stopPropagation`，画布快捷键判断 `activeElement` |
| R7 | 缩放模糊 | DOM 控件在高倍缩放下发虚 | 接受（ComfyUI 同样）；必要时 `transform: scale()` 反向补偿 |
| R8 | 子代理改到别人文件 | 合并冲突/回归 | 写域表 + L 独占根配置 + 每卡 review diff |
| R9 | 权限受限 | `NoNewPrivs=1` 导致 sudo/apt 全废 | 走「apt-get download + dpkg-deb -x 到 vendor/prefix」的无 root 方案；产物全落仓库 |
| R10 | 演示环境不安全 | 任意 Origin 可连 9090 | 只绑内网 IP、演示后关闭、后续加反代鉴权 |

---

## 9. 已完成 / 待办（2026-11-24 晚实测更新）

**已落地**（本仓可直接跑）：

```bash
# 仓库已 git init 并推送到 https://github.com/ddyyxx-jpg/Craneus_Origin_ROSUI

# rosbridge：无 root 解包方案（sudo 被 NoNewPrivs 拦住，apt 不可用）
scripts/fetch-rosbridge.sh     # 下载 6 个 deb → vendor/prefix（一次性）
scripts/ros-up.sh              # source /opt/ros/jazzy + 挂前缀 → 起 9090
# 实测：9090 LISTEN；ros2 service call /rosapi/get_param_names 返回 30 个参数名
```

**还差**：

| # | 事项 | 阻塞点 |
|---|---|---|
| 1 | M1 前端骨架（Vite + Rete + 内联控件 + 显隐联动） | 进行中（web-dev） |
| 2 | demo 参数节点（4 类型 + set 回调） | 未开始，M2 验收依赖它 |
| 3 | z-localization 的 `zlio` 参数接入 | 静态参数，需先加 callback（见 docs/integration-target.md） |
| 4 | Playwright e2e | 依赖 1、2 |

> 保留原计划里的一条：`ros2 run demo_nodes_cpp parameter_blackboard` 是验证 `/parameter_events` 事件形态最快的手段，M2 前先跑一次看 `new_parameters` 到底怎么落。

## 10. 附录：提示词模板

### 10.1 主线开工（贴给 lead 自己）

```
你是 ROSUI 项目 lead。工作区 /home/ddyyxx/Origin_ROSUI，方案见 docs/ROSUI-落地方案.md。
本轮目标：完成 M0（骨架 + 链路打通）。
规则：只有你能改 package.json/根配置；子代理只在自己 scope 内写；每张卡必须有验收命令与证据。
先读方案，列出 M0 的 5 张卡（含 scope/依赖/验收），建到任务板，再逐张分派。
```

### 10.2 开发卡 brief（贴给 A/B/C/E）

```
【背景】ROSUI：ROS 2 可视化节点编辑器，参数控件要像 ComfyUI 一样长在端口上。
【方案】docs/ROSUI-落地方案.md 第 2 节（先读，别跳）。
【本卡】T-012：输入端口内联数字控件。验收条目见卡。
【写域】只能改 <scope 内文件>；不得动 package.json、锁文件、他人目录。
【禁止】新增依赖、any、改 IR 类型、改公开接口签名（需先问 L）。
【自测】pnpm check 必须 exit 0；可视改动附 before/after 截图。
【回报】改了哪些文件 + 命令与退出码 + 截图路径 + 未解决项。
```

### 10.3 评审 brief（贴给 reviewer）

```
你是只读评审。目标：对 T-012 的 diff 给出 verdict，不修改任何文件。
先读 docs/ROSUI-落地方案.md §6.3 的 8 问，再逐条对照验收条目。
必须实际运行 pnpm check；可视改动要看截图或跑 pnpm e2e。
输出：VERDICT / BLOCKING（file:line + 期望）/ NON-BLOCKING / EVIDENCE。
不确定的地方标「未验证」，不要猜。
```

### 10.4 交接块（新会话开场必贴）

```
【项目】ROSUI，方案 docs/ROSUI-落地方案.md
【当前里程碑】M2 参数双向（进度 60%）
【已完成】T-021 get/set、T-022 事件订阅；e2e 2/4 绿
【未完成】T-023 重连兜底、T-024 类型校验
【关键文件】apps/web/src/ros/RosClient.ts、packages/ir/src/types.ts
【怎么跑】source /opt/ros/jazzy/setup.bash; scripts/ros-up.sh; pnpm dev
【已知坑】parameter_events 首帧噪声；int64 跨桥是字符串
【下一步】接 T-023，先写失败用例再修
【禁止】改 IR 类型；动 package.json 前先问
```

---

## 11. 待确认

1. 工作区确实是从零开始，还是要接入你已有的 ROS 2 前端仓库？（影响 M0 是「搭骨架」还是「只读接入」）
2. 演示载体：纯 demo 节点，还是要接 Gazebo / 真机？
3. 队形：最小 4 人（L/B/C/R）先跑，还是 M1 就上 6 人？
