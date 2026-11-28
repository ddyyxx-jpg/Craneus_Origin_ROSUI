# ROSUI 工作区与 UI 架构草案（Unity + VSCode 风格）

> 状态：架构调研与落地建议，只读调研产出；不包含代码实现。
> 对应需求：`m04415`。目标是在现有 Rete 画布、参数绑定、保存/加载、LOD、撤销/重做基础上，把 ROSUI 从“单画布参数编辑器”升级成“ROS2 工作区 IDE”。

## 1. 目标与边界

### 1.1 用户目标（m04415）

用户要求：

1. 完成现有 PR #6 后继续“审查 → 修 → 再审查”的闭环。
2. UI 和工作区管理参考：
   - Unity：节点/代码编辑、Inspector、Console、项目结构；**不做 Game View**。
   - VSCode：便捷工作区管理、文件树、Tab、多面板、状态栏。
3. 用 ROSUI 打开 `/home/ddyyxx/ROSWORK` 中“全的哨兵代码仓库”，检查是否有问题。
4. ROS 对象做成 UI 里的小节点：
   - 参数：可展开查看和编辑，建议侧边栏/Inspector。
   - 驱动：显示有该节点即可，节点上带启动入口。
   - 话题：打开后能看到所有发布/订阅节点、QoS 和信息流。
5. 软件内一键编译运行，可自动拉起 Gazebo 或 RViz（让用户选）。
6. 每个节点 UI 上有单独的节点启动能力。

### 1.2 本轮明确的假设

这些假设需要在实现前向 lead/用户确认；本文件先按此设计：

- **工作区根**：ROSWORK 是多 workspace 目录，`nav2027_ws` 是“哨兵/全仓库”的主候选，`adaptive_lio_ws` 作为第二 root；UI 采用 VSCode 式“多根工作区”，不是只读一个目录。
- **哨兵仓库**：没有名为 `sentinel` 的目录；最可能是 `/home/ddyyxx/ROSWORK/nav2027_ws`，其中 `decision/Sentry_state`、`rm_serial`、`dec_tree` 等含 sentry/哨兵语义。
- **浏览器不能直接编译/启动本机进程**：需要本机 companion agent（`rosui-agent`），只监听 `127.0.0.1`，浏览器只通过受控 API 调用。
- **首版不引入 Monaco/CodeMirror**：代码编辑先用带行号/文件树/Tab 的轻量 textarea；若用户坚持 VSCode 级体验，再第二阶段引入 CodeMirror 6。理由是当前 bundle/性能门禁敏感，LOD perf 已证明 CurrentIR 重渲染会放大成本。
- **不修改当前 GraphIR v1 语义**：工作区、包、launch、topic/QoS、进程状态用 sidecar 状态和独立模型，避免破坏 `.rosui.json` 严格 schema 和现有 e2e。
- **不自动 apt/rosdep 安装**：编译/运行只使用当前机器已装的 ROS2 Jazzy 与 ROSWORK 本地 `ros_deps/root`；缺失依赖在 Problem 面板提示。

### 1.3 非目标

- 不做 Game View / 3D 游戏预览。
- 不做远程云端编译，不做任意命令执行器。
- 不做 ROS 包自动生成（原方案已明确为非目标）。
- 不做完整 VSCode 插件体系。
- 不把 rosbridge 暴露到公网；安全边界仍是内网/本机。

---

## 2. 现状差距

| 能力 | 当前实现 | 差距 |
|---|---|---|
| 画布 | 单 `.canvas` + Rete，`App.tsx:836-850` | 无可停靠面板、无 Tab、无 Workspace Explorer |
| 工具栏 | 一行 toolbar，`App.tsx:679-830` | 按钮拥挤，缺工作区、构建、运行、可视化选择、状态栏 |
| 参数 | `ParamBrowser.tsx` 右侧列表，连接时拉取参数并支持绑定/解绑 | 无按节点分组、展开/折叠编辑、参数小节点 |
| 驱动 | 无 | 无包/可执行/launch 节点模型，无启动按钮 |
| 话题 | 无 | `RosClient` 只有参数 API，无 topic graph / QoS / pub-sub introspection |
| 代码编辑 | Script 节点内 textarea | 无项目文件Tab、无 docked code editor |
| 编译运行 | 无 | 无 colcon build、进程管理、日志流 |
| Gazebo/RViz | 无 | 无选择器和自动拉起 |
| 工作区管理 | 仅“保存图/加载图” | 无 VSCode 式 workspace/file tree/recent |
| 审查闭环 | PR #1–#6 已走过多轮 review | 新功能仍必须保持独立 review + fix + re-review |

---

## 3. 总体 UX 布局

建议采用 Unity + VSCode 混合布局，保留现有 Rete 画布作为核心编辑器：

```
┌────────────────────────────────────────────────────────────┐
│ Menu / Toolbar: Workspace | Build | Run | Visualizer | ROS │
├───────────────┬──────────────────────────────┬──────────────┤
│ Explorer      │ Editor Area (Tabs)           │ Inspector    │
│ - Workspace   │ - Graph Editor (Rete)        │ - Selection  │
│ - Packages    │ - Code Editor                │ - Param      │
│ - Launch      │ - Topic Graph                │ - Topic/QoS  │
│ - Params      │ - Build Log / Diff           │ - Node       │
│ - Diagnostics │                              │              │
├───────────────┴──────────────────────────────┴──────────────┤
│ Bottom Panel: Problems | Output | Terminal | Process Logs   │
├────────────────────────────────────────────────────────────┤
│ Status Bar: ROS status | Domain | RMW | Workspace | Branch  │
└────────────────────────────────────────────────────────────┘
```

### 3.1 Unity 参考点

- **Graph Editor**：当前 Rete 画布继续作为核心。
- **Inspector**：右侧统一属性面板，选中节点/边/参数/话题时显示可编辑属性。
- **Project/Explorer**：左侧文件树/工作区树。
- **Console/Output**：底部日志与 Problem 面板。
- **Play/Run**：顶部 Build/Run 控制。
- **不做 Game View**。

### 3.2 VSCode 参考点

- 多根工作区：ROSWORK 下 `nav2027_ws` 与 `adaptive_lio_ws` 同时可见。
- Tab：图、代码文件、Topic Graph、构建日志均可 tab 化。
- Command Palette（可选）：后续再做，首版以菜单/按钮为主。
- 状态栏：ROS bridge、ROS_DOMAIN_ID、当前 workspace、进程数。
- Explorer 折叠/过滤：包、launch、参数、话题按类型分组。

### 3.3 兼容性要求

现有 e2e 依赖的 `data-testid` 必须保留：

- `canvas-status`、`gain-readout`
- `ros-url`、`ros-connect`、`ros-disconnect`、`ros-status`
- `add-gain`、`add-pose`、`add-inspector`、`add-script`
- `save-graph`、`load-graph`、`load-graph-input`
- `ros-toast`
- `current-ir`

因此 UI 改造应是“把现有 App 拆成面板组件”，而不是直接重写替换所有 DOM。

---

## 4. 信息架构与数据模型

### 4.1 保持 GraphIR v1 不变

当前 `packages/ir/src/index.ts`：

- `GraphIR { version: 1; nodes; edges }`
- `NodeIR { id; type; position; params }`
- `ParamBinding { node; param; valueType; mode; widget; value?; constraints? }`

这是一张“图”的持久化格式，不承担工作区/包/进程/launch 信息。新增内容建议放 sidecar：

- `.rosui.workspace.json`：工作区根、打开的文件、活跃 tab、visualizer 选择、launch target。
- `.rosui.index.json`：扫描缓存，包、可执行、launch、参数 YAML、问题列表。
- 运行时内存：topic graph、QoS、进程状态、实时日志，不默认落盘。

这样可避免破坏 `parseGraph().strict()`、现有保存/加载 e2e 与 runtime 绑定恢复逻辑。

### 4.2 新增前端模型（建议）

```
WorkspaceRoot {
  id: string
  path: string                 // /home/ddyyxx/ROSWORK/nav2027_ws
  label: string
  kind: 'colcon' | 'ament' | 'generic'
  setupScripts: string[]       // setup_adaptive_lio.sh / setup_nav2027.sh
}

PackageIndex {
  name: string
  path: string
  executables: ExecutableSpec[]
  launchFiles: LaunchSpec[]
  params: ParamFileSpec[]
  diagnostics: Diagnostic[]
}

ExecutableSpec {
  package: string
  name: string
  kind: 'node' | 'driver' | 'tool'
  launchCommand: string        // 由 agent 构造，不在 UI 拼 shell
}

TopicEdge {
  topic: string
  type: string
  publisher: EndpointInfo
  subscriber: EndpointInfo
  qos: QoSProfile
}

ProcessHandle {
  id: string
  command: string[]
  cwd: string
  state: 'starting' | 'running' | 'exited' | 'failed'
  pid?: number
}
```

### 4.3 UI 节点分类

现有 `RosuiNode` 用于普通参数控件节点。新增三类“小节点”，都复用 Rete 节点外壳但语义不同：

1. **ParameterNode**
   - 显示参数名/类型/当前值/绑定状态。
   - 展开后显示 `number/text/boolean/select/pose/json` 控件，复用 `apps/web/src/controls/model.ts`。
   - 支持“刷新”“解绑”“编辑”。
   - 与 `ParamBrowser` 共享参数行数据源，避免两套刷新逻辑。

2. **DriverNode**
   - 显示驱动/可执行节点名、包名、运行状态。
   - 节点 UI 上有 `启动/停止` 按钮。
   - 点击右侧 Inspector 显示 command、cwd、环境变量、日志 tab。

3. **TopicNode / TopicGraph**
   - 独立 Tab：话题为中心节点，周围是 publisher/subscriber 节点。
   - 边显示 message type 与 QoS 摘要（Reliability/Durability/History/Depth）。
   - 选中话题后 Inspector 显示全部发布/订阅端点、GID、节点名、namespace、QoS 详情。
   - “信息流”首版用边动画/计数 + `ros2 topic hz` 采样；不做完整 DDS traffic capture。

---

## 5. 本机 Agent 设计

### 5.1 为什么必须有 agent

当前 `RosClient` 通过 rosbridge/rosapi 只能做参数读写和事件订阅。以下能力浏览器无法直接完成：

- 扫描 `/home/ddyyxx/ROSWORK` 文件树与 `package.xml`。
- `colcon build`。
- 启动/停止节点、launch、RViz、Gazebo。
- `ros2 topic info --verbose` 与 QoS 解析。
- 读取进程日志。

因此新增 `rosui-agent`，建议 Python 3 实现，首版用标准库 HTTP + SSE，避免新 npm/Python 重依赖。

### 5.2 安全边界

- 只监听 `127.0.0.1`，不监听 `0.0.0.0`。
- 本地 token 文件鉴权，浏览器启动时从本地配置读取；不写进聊天/仓库。
- 允许根目录白名单：默认 `/home/ddyyxx/ROSWORK`，可由用户在设置中添加，仍只允许 `/` 盘。
- 不提供任意 shell API；所有命令由 agent 根据预定义 `command` 模板构造。
- 启动进程必须在允许 root 下，参数来自扫描结果/用户表单，禁止 `; && | $()` 等 shell 元字符。
- 进程使用 detached process group，停止时整组 kill，并用 `/proc/<pid>/stat` starttime 防 PID 复用误杀（复用现有 e2e 经验）。
- 不走 sudo；需要 root 的操作直接报“需要用户手动执行”。

### 5.3 建议 API

```
GET  /api/health
GET  /api/workspaces
POST /api/workspace/scan        { root }
GET  /api/workspace/diagnostics { root }

POST /api/build                 { root, packages?, symlinkInstall? }  // SSE logs
POST /api/process/start         { cwd, command, env?, label }         // 受控 command
POST /api/process/stop          { id }
GET  /api/processes
GET  /api/process/logs?id=...                                       // SSE/log tail

GET  /api/topics
GET  /api/topic/info?name=/topic
GET  /api/topic/hz?name=/topic&seconds=3

POST /api/visualizer/start      { kind: 'rviz' | 'gazebo' | 'none', config? }
POST /api/visualizer/stop
```

### 5.4 构建与运行

构建命令建议：

```bash
source /opt/ros/jazzy/setup.bash
source /home/ddyyxx/ROSWORK/setup_nav2027.sh   # 或对应 workspace setup
colcon build --symlink-install --packages-select ... --event-handlers console_direct+
```

注意：

- 不自动 `rosdep install`；缺失依赖进 Problem 面板。
- ROSWORK README 已说明 rosdep 未初始化，依赖靠本地 `ros_deps/root` 手工解包；agent 应 source/注入相关环境。
- Gazebo/RViz 由用户选择；若 `gz`/`gazebo`/`rviz2` 不存在，启动前给出明确诊断，不伪装成功。
- 一键运行建议顺序：选择 workspace → 选择 launch target → 选择 visualizer → build（可跳过）→ source → launch → attach logs → 打开 Topic Graph。

---

## 6. ROSWORK 哨兵仓库接入方案

### 6.1 已知事实

来自并行调研：

- ROSWORK 根：`/home/ddyyxx/ROSWORK`
- 主要 workspace：
  - `/home/ddyyxx/ROSWORK/nav2027_ws`
  - `/home/ddyyxx/ROSWORK/adaptive_lio_ws`
- `nav2027_ws/src/decision/Sentry_state/package.xml` 含 sentry/哨兵语义。
- `README_编译说明.md` 记录 `nav2027_ws` 有约 24 个包，编译零失败。
- `ros2 launch bringup startup.launch.py --show-args` 可解析。
- 已知问题：
  - `auto_aim_interfaces` 在 `serial/rm_serial`、`decision/dec_tree` 的 package.xml 声明，但源码/CMakeLists 未引用，源码缺失不影响当前编译。
  - `bringup/README.md` 提到 `mapping.launch.py`，实际不存在；只有 `startup.launch.py`、`tf.launch.py`。
  - rosdep 未初始化，依赖靠 `ros_deps/root` 手工解包。

### 6.2 用 ROSUI 打开后的预期展示

1. **Workspace Explorer**
   - `ROSWORK`
     - `nav2027_ws`
       - `packages/`
       - `launch/`
       - `params/`
       - `diagnostics/`
     - `adaptive_lio_ws`

2. **Graph Editor**
   - 自动/手动生成一张“工作区总览图”：
     - Package 节点
     - Driver 节点（可执行/launch）
     - Parameter 节点（可展开）
     - Topic 节点（运行后）
   - 默认不把整个 ROSWORK 直接塞满画布；按包/launch 分组过滤。

3. **Diagnostics**
   - 红色问题：`mapping.launch.py` 缺失。
   - 黄色警告：`auto_aim_interfaces` 源码缺失但未被构建引用。
   - 黄色警告：rosdep 未初始化。
   - 信息：本地 `ros_deps/root` 已注入。

4. **Inspector**
   - 选中 `Sentry_state` 显示 package.xml、依赖、可执行、launch 引用、参数/话题关联。
   - 选中 driver 节点显示启动按钮。

---

## 7. 实施分层

### Phase 1：UI Shell 与面板解耦

改动范围：`apps/web/src/App.tsx`、`styles.css`、新 `workbench/` 组件。

- 保持 Rete 画布和全部现有 `data-testid` 不变。
- 抽出 `Toolbar`、`WorkspacePanel`、`EditorTabs`、`InspectorPanel`、`BottomPanel`、`StatusBar`。
- CSS grid 实现可调整宽度/高度，首版不做完整 docking 库。
- 验收：现有 build/check/vitest/e2e/perf 全绿，截图有新布局。

### Phase 2：Workspace Explorer 与本地 Agent

改动范围：`apps/web/src/workspace/**`、`services/rosui-agent/**`。

- 打开 ROSWORK 多根工作区。
- 扫描包、launch、参数文件、诊断。
- 验收：mock agent 单测 + 真扫 `/home/ddyyxx/ROSWORK/nav2027_ws`，Diagnostics 能列出已知三问题，未启动任何进程。

### Phase 3：参数/驱动/话题节点

改动范围：`rete/nodes.ts` 扩展、`ParamBrowser` 复用、Topic Graph 新视图。

- ParameterNode 展开编辑。
- DriverNode 单节点启动。
- TopicGraph 显示 pub/sub/QoS/flow。
- 验收：真 ROS 参数读写不回退；driver 启动/停止用 mock agent；topic graph 用 rosbridge/CLI 数据。

### Phase 4：一键编译运行与可视化选择

改动范围：`rosui-agent` build/run/visualizer API、顶部 Run 控制、底部日志。

- 用户选择 `RViz / Gazebo / None`。
- 一键 build → source → launch → visualizer。
- 验收：至少 RViz 路径可真跑；Gazebo 若未安装要给出清晰诊断；进程可停止且端口/进程干净。

### Phase 5：审查、修复、再审查

每个 Phase 都走：

1. 实现方自检：build、check、vitest、focused e2e。
2. 独立 reviewer：UI/产品/ROS/安全四个视角。
3. 修复所有 P0/P1。
4. re-review：确认无 P0/P1 后才开/更新 PR。
5. 全量门禁：build/check/vitest/e2e/perf/diff check。
6. push/PR 必须按当前对话重新授权。

---

## 8. 测试策略

### 8.1 单元测试

- workspace 扫描解析：`package.xml`、launch 文件发现、诊断规则。
- agent command builder：禁止 shell 元字符、cwd 白名单、env 注入。
- QoS 文本解析：`ros2 topic info --verbose` 输出样例。
- sidecar 工作区文件加载/保存。

### 8.2 e2e

先 mock agent，避免每次测试真编译：

- 打开工作区，树中出现 nav2027_ws/adaptive_lio_ws。
- Diagnostics 显示三个已知问题。
- 参数节点展开、编辑、绑定、解绑。
- Driver 节点启动/停止按钮状态流转。
- Topic Graph 显示 pub/sub/QoS。
- Build/Run 选择 RViz/Gazebo/None，日志流可见。

真机 smoke（非默认 e2e）：

- 打开 `/home/ddyyxx/ROSWORK/nav2027_ws`。
- 扫描包并打开 `Sentry_state`。
- 选择 `bringup/startup.launch.py` 与 RViz。
- 启动后 Topic Graph 能看到实际话题；停止后进程干净。

### 8.3 性能门禁

- 继续保留 `ROSUI_PERF=1` 下 `0.85 * full` 断言。
- 新面板必须 lazy mount/virtualize；Explorer 列表超过阈值只渲染可见区。
- 禁止在自动 commit 中 `setGraph()`；延续 T-032 的 perf 修复结论。
- `CurrentIR` 可折叠/可关闭，默认不在大 workspace 扫描时刷新。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 任意命令执行导致安全问题 | agent 白名单 root + 固定命令模板 + 本地 token + 无 sudo |
| 改动 App.tsx 引发既有 e2e 回归 | 先抽组件，不改 data-testid；每 Phase focused e2e |
| GraphIR strict schema 被破坏 | 工作区/进程/topic 用 sidecar 和内存状态，不改 GraphIR v1 |
| 大 workspace 扫描卡 UI | agent 后台扫描，SSE 增量更新，列表虚拟化 |
| Topic/QoS 解析不稳 | 基于 ROS2 CLI 输出样例做解析器 + fixtures；失败显示 raw output |
| Gazebo/RViz 未安装 | 启动前探测命令，缺失进 Problem 面板，不伪造成功 |
| 用户把“哨兵仓库”指成别的目录 | Workspace Explorer 支持多根/最近工作区，先用 ROSWORK 全根扫描，再由用户选择 |

---

## 10. 待确认问题

1. “哨兵代码仓库”是否就是 `nav2027_ws`，还是 `/home/ddyyxx/ROSWORK` 整体？建议先按多根工作区打开。
2. 一键运行的默认 launch 是 `bringup/startup.launch.py` 吗？`tf.launch.py` 是否也要一起？
3. RViz 配置文件路径是否有默认项？Gazebo 使用哪个 world/launch？
4. 代码编辑是否首版接受“轻量 textarea + 文件树”，还是必须引入 CodeMirror 6/Monaco？
5. local agent 是否允许作为独立后台服务常驻？若不允许，可改为 UI 内“启动本地 Agent”按钮拉起。

---

## 11. 结论

当前 ROSUI 已经具备画布、参数控件、ROS 参数绑定、保存加载、LOD、撤销/重做等基础，但距离用户期望的“Unity + VSCode 风格 ROS 工作区 IDE”还有明显结构性差距。最小且稳妥的路线是：

1. 保留现有 Rete 画布和 `data-testid`，先做 UI Shell/多面板；
2. 新增本机 `rosui-agent` 承担文件扫描、编译、进程、topic/QoS introspection；
3. 用 sidecar 模型承载 workspace/package/launch/process/topic 信息，不破坏 GraphIR v1；
4. 把参数、驱动、话题做成小节点和右侧 Inspector；
5. 每个 Phase 都经过独立审查、修复、再审查和全量门禁，未经当前对话授权不 push。
