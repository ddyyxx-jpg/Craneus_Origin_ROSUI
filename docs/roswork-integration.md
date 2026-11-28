# ROSWORK「哨兵全栈」接入调研（只读）

## 结论

用户说的「ROSWORK 里面那个全的哨兵代码仓库」应定位为：

- **主目标**：`/home/ddyyxx/ROSWORK/nav2027_ws`
  - 24 个 ROS 2 包，已 `colcon build --symlink-install` 成功。
  - 主启动入口：`/home/ddyyxx/ROSWORK/nav2027_ws/src/bringup/launch/startup.launch.py`
  - 全局配置：`/home/ddyyxx/ROSWORK/nav2027_ws/src/bringup/params/global_config.yaml`
  - 参数总表：`/home/ddyyxx/ROSWORK/nav2027_ws/src/bringup/params/params.yaml`
- **辅助目标**：`/home/ddyyxx/ROSWORK/adaptive_lio_ws`
  - 独立 Adaptive-LIO 工作空间，2 包，构建通过。
- **独立 Git 仓库**：`/home/ddyyxx/ROSWORK/craneus_pcd2pgm_advanced`
  - 大小 2.2 MB，最新提交 `6abfb18 Restructure as multi-method repo: add clearance ground-normalization mapping`。

本次调研**只读**，没有修改 `/home/ddyyxx/ROSWORK`。

---

## 1. 环境/构建事实（直接来自 ROSWORK README）

`/home/ddyyxx/ROSWORK/README_编译说明.md` 记录：

- Ubuntu 24.04 / ROS 2 Jazzy / colcon / 24 线程。
- 本机 `sudo` 被 `no_new_privs` 屏蔽，`apt install` 不可用；依赖走 `apt-get download` + `dpkg-deb -x` 到 `/home/ddyyxx/ROSWORK/ros_deps/root`。
- `source /home/ddyyxx/ROSWORK/setup_nav2027.sh` 可装载完整环境：
  - `/opt/ros/jazzy/setup.bash`
  - `/home/ddyyxx/ROSWORK/ros_deps/setup_deps.sh`
  - `/home/ddyyxx/ROSWORK/nav2027_ws/install/setup.bash`
- 编译结果：
  - Adaptive-LIO：2 packages finished，零错误，7 个 CTest 功能测试通过。
  - nav2027：24 packages finished，零失败。
  - `ros2 launch bringup startup.launch.py --show-args` 可解析。

这非常适合做 Origin_ROSUI 的「VSCode 工作区管理 + Unity Inspector + ROS 节点图」的真实大型样例。

---

## 2. 现有启动图（startup.launch.py）

`/home/ddyyxx/ROSWORK/nav2027_ws/src/bringup/launch/startup.launch.py` 中**实际启用**的主要节点/子 launch：

| 类型 | 节点 / 子 launch | 包 | UI 应显示 |
|---|---|---|---|
| `IncludeLaunchDescription` | `livox_ros_driver2/launch/msg_MID360_launch.py` | livox_ros_driver2 | 驱动节点 / LiDAR |
| `IncludeLaunchDescription` | `adaptive_lio/launch/run.launch.py` | adaptive_lio | 定位节点 |
| `IncludeLaunchDescription` | `map_server/launch/map_server.launch.py` | map_server | 地图服务 |
| `IncludeLaunchDescription` | `bringup/launch/tf.launch.py` | bringup | TF 静态变换 |
| `IncludeLaunchDescription` | `modify_map_to_odom/launch/modify.launch.py` | modify_map_to_odom | TF 修正 |
| `IncludeLaunchDescription` | `rm_serial/launch/rm_serial.launch.py` | rm_serial | 串口/裁判系统驱动 |
| `IncludeLaunchDescription` | `fake_baselink/launch/fake_baselink.launch.py` | fake_baselink | 底盘基坐标系 |
| `Node` | `rviz2`（按阵营 red/blue 条件启动） | rviz2 | RViz 视图 |
| `Node` | `dec_tree/referee_fake`（条件启动） | dec_tree | 模拟裁判 |
| `ComposableNodeContainer` | `container` | rclcpp_components | 组合节点容器 |

同文件里定义但**当前注释掉**的启动项：

- `point_lio_with_grid_map`（pointlio）
- `small_gicp_localization`（gicp）
- `cmd_vel_speed_test`
- `region_behavior`
- `dec_tree/root`、`root_radical`、`root_simple`
- `check_invincible`
- `calculate_attack_pose_if_available`
- `Sentry_state/sentry_state`
- `TimerAction` 包裹的若干延迟启动项

**UI 要求**：节点图里应把这些「已定义但未启用」的项显示为灰色/禁用态，旁边给出「在 launch 中启用」按钮，而不是直接丢掉。

---

## 3. 参数接入点

### 3.1 YAML 参数表

`/home/ddyyxx/ROSWORK/nav2027_ws/src/bringup/params/params.yaml` 顶层已有完整节点命名空间：

- `map_server`：地图/代价地图/动态障碍参数（含 `roi`、`voxel_size`、`sor`、`memory` 等嵌套结构）。
- `map_client`：地图客户端与 TF/超时参数。
- `nav_executor`：导航执行器、路线监控、路径平滑、MPC 参数。
- `topology_planner`：拓扑规划、Grid/A*、FMM 参数。

`/home/ddyyxx/ROSWORK/nav2027_ws/src/bringup/params/global_config.yaml` 是 launch 层配置：

- `self_color: red|blue`
- `use_fake_referee: false`
- `rviz.red/blue`
- `map.red/blue`
- `pcd_map.red/blue`
- `region_map.red/blue`
- `buff.red/blue`、`outpost.red/blue`

### 3.2 源码 declare_parameter 热点

`grep declare_parameter` 计数（前几名）：

| 文件 | 数量 |
|---|---:|
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/localization/small_gicp_localization/src/small_gicp_localization.cpp` | 61 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/localization/Point-LIO-grid_map_ros2/src/parameters.cpp` | 59 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/map_server/ros/map_server_node.cpp` | 48 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/nav_executor/src/nav_executor_node.cpp` | 39 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/decision/Sentry_state/Sentry_state/mock_referee_server.py` | 18 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/navigation/fake_baselink/src/fake_baselink.cpp` | 9 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/localization/sc_relocalization/src/sc_relocalization_node.cpp` | 9 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/localization/pcd2pgm/src/pcd2pgm.cpp` | 9 |
| `/home/ddyyxx/ROSWORK/nav2027_ws/src/livox_ros_driver2/src/livox_ros_driver2.cpp` | 9 |

**UI 侧栏参数节点建议**：按 `workspace > package > node > parameter group > parameter` 分层；参数行显示：

- 名称、类型、当前值、默认值、来源文件/行号。
- 是否 runtime settable（能否通过 `/rosapi/set_param` 改）。
- 嵌套结构（如 `nav_executor.MPC`）用可折叠树，避免 61 个参数平铺。
- 对 launch-only 参数（如 `self_color`）标记 `launch_arg`，不是 ROS parameter。

---

## 4. 驱动/话题信息流

### 4.1 驱动节点

代码中明显的驱动/硬件边界：

- `livox_ros_driver2`：LiDAR 驱动，发布 `livox/lidar/pointcloud` / `CustomMsg` / IMU 等（具体 topic 由 launch/config 决定）。
- `rm_serial`：串口/裁判系统驱动。
  - `/home/ddyyxx/ROSWORK/nav2027_ws/src/serial/rm_serial/rm_serial/ReceiveFromC_Board.py:113-118` 发布 `/serial/gimbal_status`、`Referee`、连接时间。
  - `/home/ddyyxx/ROSWORK/nav2027_ws/src/serial/rm_serial/rm_serial/SendToC_Board.py:80-94` 订阅 `/serial/process_gimbal_aft_inv`、`/cmd_vel_chassis`、`/serial/uphill`、`/serial/gimbal_region_cmd` 等。
- `fake_baselink`：调试/仿真底盘基座。
- `pointcloud_to_laserscan`：本地依赖，提供 `/livox/scan` 转换（map_server 参数里的 `cloud_topic: /livox/scan`）。

### 4.2 QoS 观察

静态 grep 已看到几类 QoS：

- 普通 depth 10：`create_publisher(..., 10)` / `create_subscription(..., 10)` 大量存在。
- Sensor QoS：
  - `SendToC_Board.py:80` `/serial/process_gimbal_aft_inv` 用 `rclpy.qos.qos_profile_sensor_data`
  - `SendToC_Board.py:83` `/cmd_vel_chassis` 用 sensor data QoS
- Transient-local reliable：
  - `topology_global_planner/src/planner_lifecycle.cpp:120-121` `TopoPlanner/connector_debug_markers` 用 `rclcpp::QoS(1).transient_local().reliable()`
- `check_invincible.py:10` `/Referee` 用 `qos_profile_system_default`

**UI 要求**：话题详情需要显示类型、发布者、订阅者、QoS（reliability/durability/history/depth）和信息流箭头，并对可能不兼容的 pub/sub QoS 警告。静态分析拿不全时应调用运行时 `ros2 topic info --verbose <topic>` / `ros2 node info <node>` 补齐。

---

## 5. 发现的潜在问题（供 UI 高亮，不在本次改代码）

1. **`self_color` 双来源不一致风险**
   - `startup.launch.py` 里 `self_color_yaml` 来自 `global_config.yaml`，而 `self_color` launch arg 可单独覆盖。
   - `start_rviz_red/blue` 的 `IfCondition(PythonExpression(["'", self_color, "' == 'red'"]))` 用 launch arg；map/pcd/region 路径用 `self_color_yaml`。
   - 如果运行时传 `self_color:=blue` 但 yaml 仍是 red，RViz 配置与地图/区域配置可能不一致。
2. **`load_map_server_red` 硬编码地图**
   - `/home/ddyyxx/ROSWORK/nav2027_ws/src/bringup/launch/startup.launch.py` 中 `load_map_server_red` 用 `os.path.join(bringup_dir, 'map', '601_left.yaml')`，不是前面算出的 `map_red_path`（来自 `global_config.yaml` 的 `map.red`）。
3. **注释节点很多**
   - `pointlio`、`gicp`、`region`、`dec_*`、`check_invincible`、`calculatepose`、`state` 等在 launch 中定义但注释；软件应显示禁用态，不要误判为已连接节点。
4. **文档缺口**
   - `/home/ddyyxx/ROSWORK/README_编译说明.md` 已指出：`bringup/README.md` 提到 `mapping.launch.py`，但 `src/bringup/launch/` 只有 `startup.launch.py` 与 `tf.launch.py`。
5. **接口包缺口**
   - 同一 README 指出 `auto_aim_interfaces` 在 `serial/rm_serial`、`decision/dec_tree` 的 package.xml 中声明，但源码与 CMakeLists 未引用，缺失不影响当前编译；若以后启用相关节点需补接口包。
6. **RViz 自动启动**
   - `startup.launch.py` 已按阵营启动 `rviz2`。一键运行时若 UI 再自动拉 RViz，需要去重；建议让 UI 显示「沿用 launch 内置 RViz」/「另开自定义 RViz」两个选项。
7. **Gazebo**
   - 当前 ROSWORK README 与 launch 未发现 Gazebo 入口；如果 UI 要「用户选 Gazebo 或 Rviz」，Gazebo 应作为可选外部可视化后端，不应假设该工作区已有 Gazebo world。

---

## 6. Origin_ROSUI 接入建议（数据模型）

建议在现有 GraphIR 之外增加「工作区模型」：

```ts
type WorkspaceRoot = {
  path: string;                 // /home/ddyyxx/ROSWORK
  setupScript?: string;         // setup_nav2027.sh
  buildCommand?: string;        // colcon build --symlink-install
  packages: PackageInfo[];
  launchFiles: LaunchInfo[];
}

type PackageInfo = {
  name: string;
  path: string;                 // 相对 workspace
  executables: string[];
  dependencies: string[];
}

type LaunchInfo = {
  path: string;
  enabledNodes: LaunchNodeInfo[];
  disabledNodes: LaunchNodeInfo[];  // 注释掉的 Node/Include
  arguments: LaunchArgumentInfo[];
}

type ParamInfo = {
  node: string;                 // /map_server
  name: string;                 // update_frequency
  valueType: 'double'|'integer'|'boolean'|'string'|'array'|'nested';
  value: unknown;
  source: string;               // params.yaml:line or declare_parameter file:line
  runtimeSettable?: boolean;
}

type TopicInfo = {
  name: string;
  type: string;
  publishers: EndpointInfo[];
  subscribers: EndpointInfo[];
  qos: QosInfo;
}

type EndpointInfo = {
  node: string;
  qos: QosInfo;
  source: string;               // create_publisher/create_subscription file:line
}
```

UI 映射：

- **侧边栏**：Workspace → packages → launch files → nodes → params/topics。
- **Inspector**：选中节点后显示参数、驱动状态、启动按钮、日志尾部。
- **节点图小节点**：参数节点、驱动节点、话题节点都是图上的小卡片；话题节点展开后显示 pub/sub 节点与信息流。
- **代码编辑**：launch/config/源码只读预览优先；可写编辑后续再加权限与备份机制。

---

## 7. 一键编译运行方案

建议后端 executor（Node/Python 均可）提供：

1. `loadWorkspace(path)`：扫描 `src/**/package.xml`、`launch/*.py`、`params/*.yaml`。
2. `buildWorkspace(workspace)`：
   - `bash -lc 'source /home/ddyyxx/ROSWORK/setup_nav2027.sh && cd /home/ddyyxx/ROSWORK/nav2027_ws && colcon build --symlink-install'`
   - 返回结构化日志（package、status、duration、error line）。
3. `runLaunch(launchFile, options)`：
   - 用户选项：`visualizer: rviz|gazebo|none`、`useFakeReferee`、`selfColor red|blue`、`dryRun`。
   - 对 `startup.launch.py`：默认沿用 launch 内置 RViz，避免重复；若选 `rviz:none`，可加参数或过滤 RViz Node（需谨慎，不应静默改 ROSWORK 文件）。
4. `startNode(package, executable, params?)`：
   - 每个 UI 节点卡片上的启动按钮调用 `ros2 run <pkg> <exe>`。
   - 每个进程用独立 PGID，UI 保存 pid/starttime 做安全回收（延续 T-033/T-032 的进程组经验）。
5. `inspectTopics()`：
   - 运行时用 `ros2 topic list -t`、`ros2 topic info --verbose`、`ros2 node info`。
   - 与静态分析合并，形成话题节点的信息流视图。

---

## 8. 分阶段建议（不破坏 PR #3-#6）

- **M6a 工作区导入（只读）**：VSCode 式打开 `/home/ddyyxx/ROSWORK`，显示文件树、package 列表、launch 列表。
- **M6b 静态 ROS 图谱**：解析 launch/package/params/source，生成节点、驱动、参数、话题小节点；先只读。
- **M6c Inspector 与侧栏**：Unity 式面板选中节点展开参数/话题；参数可编辑但先作用在 IR/草稿，不直接写 ROS。
- **M6d 启动控制**：每节点 UI 启动按钮 + 一键 colcon build + launch 选择 Gazebo/Rviz。
- **M6e 运行时同步**：把现有 RosClient 绑定到参数节点，话题信息通过 rosbridge/ros2 CLI 混合获取。
- 所有改动建议从 `feat/m5-undo-copy-paste` 或用户指定的新分支切出，避免直接动 PR #3-#6 的 base 链。

TASK AS OF THIS BLOCK: 已完成 ROSWORK 哨兵全栈的只读定位、启动图/参数/驱动/话题/QoS 初查与 UI 数据模型建议。未修改 ROSWORK。
Open objectives: 等 lead 汇总 UI 架构调研后，按用户 m04415 需求继续设计与实施。
