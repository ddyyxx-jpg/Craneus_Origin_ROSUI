# 试运行目标仓库：z-localization

> 决定：M1/M2 的试运行对象选 `z-localization`（用户 ROS 工作区里最小、语义最清晰的一个工作区），**不改它的代码**，编辑器通过 rosbridge 只读/只写参数。

## 1. 为什么是它

| 候选 | src 体积 | 包数 | 结论 |
|---|---:|---:|---|
| `z-localization` | 3.8 MB | 5（frontend/backend/bringup/localization_interfaces/livox_ros_driver2） | **选中**：最小、参数集中在 `zlio` 一个节点、README 有参数表 |
| `origin_nav2026_developing` | 138 MB | 多 | 太大，构建慢，不适合当首个联调对象 |
| `sentry-localization-study` | 4 KB | 0 | 空仓库/笔记，没法跑 |
| `dual-livox-calib` / `odin1-scan` | 2.8 / 3.4 GB | 多 | 带数据与 build 产物，太重 |

路径：`/home/ddyyxx/snap/dsh-linux/1/ros/z-localization`（工作区根在 `src/` 下）。

## 2. 目标节点

`src/frontend/apps/node.cpp:39` 的 `OdometryNode`，节点名 **`zlio`**，`declare_parameter` 共 19 个。首批接入的子集（语义明确、默认值安全、改了不影响安全）：

| 参数 | 类型 | 默认值 | 建议控件 | 备注 |
|---|---|---|---|---|
| `world_frame` | string | `odom` | text | 坐标系名 |
| `body_frame` | string | `imu` | text | 坐标系名 |
| `input_type` | string | `pointcloud2` | **select**：`pointcloud2` \| `livox` | `node.cpp:198` 明确只接受这两个值，非法值抛异常 → 正好当校验样例 |
| `input_type` 之外：`lidar_topic` / `imu_topic` | string | `/livox/lidar` / `/livox/imu` | text | 话题名 |
| `output_resolution` | double | `0.10` | number（step 0.01，0.02–0.5） | 地图分辨率 |
| `publish_tf` | bool | `true` | switch | `node.cpp:126` |
| `wait_for_start` | bool | `false` → `armed_` | switch | 启动即跑 vs 等指令 |

单选/开关两类正好覆盖 C1 的三种控件形态（text/number/bool/select），够 M1 演示。

## 3. 已知缺口（必须先说清）

**`zlio` 的参数是构造时读一次的静态参数**：`node.cpp` 里没有 `add_on_set_parameters_callback`，全仓 grep 只在文档里提到 `/parameter_events`。也就是说：

- 通过 `/rosapi/set_param` 改 `output_resolution` **会成功返回**，但节点不会重新加载配置 → UI 变了、算法不变。
- 这会让 M2 的「双向同步」验收假绿（rqt_reconfigure 也会遇到同样问题）。

两条路，建议**先 A 后 B**：

**A（M2 验收用）**：先做 `ros2/rosui_demo` 小节点，4 个参数各一种类型，带 `add_on_set_parameters_callback` 做范围校验 + 真实副作用（打印/改变输出频率）。M2 的 AC 全在它身上验，可复现、不依赖 z-localization 构建。

**B（M2 之后，接真仓库）**：给 `zlio` 加一个最小 callback，只允许热更新白名单参数（`output_resolution` 等），其余参数拒绝并返回 reason。改动落在 z-localization 自己的仓库、单独一张卡、单独评审，不由本仓提交。

## 4. 联调前置（本机已具备）

| 项 | 状态 | 命令 |
|---|---|---|
| rosbridge 9090 | ✅ 已可无 root 跑通（本仓 `scripts/ros-up.sh`） | `scripts/ros-up.sh` |
| rosapi 服务 | ✅ `/rosapi/get_param_names` 实测返回参数列表 | `ros2 service call /rosapi/get_param_names ...` |
| z-localization 构建 | ❓ 未验证（需要 colcon build，是否可跑取决于其依赖是否装齐） | `colcon build --packages-select ...` |
| 参数绑定 | 待 M2 | — |

注意：本机 `sudo` 被 `NoNewPrivs` 拦截，`apt install` 不可用；rosbridge 是用 `scripts/fetch-rosbridge.sh` 下载 deb 解包到 `vendor/prefix` 后跑的（纯 Python，无编译）。同理，若 z-localization 缺依赖，只能走「下载 deb 解包」或源码构建，不能 apt。

## 5. 写域

- 本仓（`Origin_ROSUI`）：编辑器、IR、脚本、文档。
- `z-localization`：**只读**。需要改它时（路线 B），在它自己仓库里开分支，由用户决定是否合并。
