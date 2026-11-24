# T-006 RosClient 连接层

只负责 `apps/web/src/ros/**` 的 rosbridge 连接与参数读写；不含 UI。

## 对外接口

- `RosClientImpl` — 可实例化客户端（`implements RosClient`）。
- `getSharedClient()` — UI 共用的惰性单例（需要独立连接请 `new RosClientImpl(...)`）。
- 类型：`RosStatus`、`RosClientOptions`、`ParamBindingRef`、`ParamGetResult`、`ParamSetResult`、`ParamValue`、`ParamEventLike`。

`connect()` 建立 WebSocket；断线后按 `reconnect`（默认 500ms、×2、上限 10s）重连。
重连成功后自动重新拉取一次 `getParamNames`，通过 `onReconnected(names)` 以及
`onStatus('connected', 'reconnected')` 通知上层。所有回调都带「连接代际号」，旧连接迟到的
`/parameter_events` 消息不会写进当前订阅。

参数名采用 rosapi 的 `node:param` 形式（如 `/rosui_demo:gain`）；
`getParam` 走 `/rosapi/get_param`，`setParam` 走 `/rosapi/set_param`（失败 `reason` 原样透传）；
变更订阅走 `/parameter_events`，`new_parameters` 与 `changed_parameters` 两个落点都会处理。

## 单测

```bash
corepack pnpm -w exec vitest --run apps/web/src/ros
```

使用注入的假 transport，无需 ROS 环境；覆盖 getParamNames 解析、getParam 成功/失败、
setParam 成功/拒绝、new/changed 事件过滤、重连后代际号丢弃旧回调。

## 真实联调

前提：rosbridge(9090) 已运行，且 **rosapi 与 demo 节点在同一个 ROS domain**（rosbridge
所在 domain 必须与它们一致，否则 rosapi 找不到 `/rosui_demo` 的服务）：

```bash
# 1) rosbridge（若 9090 已在监听可跳过）
scripts/ros-up.sh

# 2) rosapi + demo 节点（与 rosbridge 同 domain；默认 domain 即可）
set +u
source /opt/ros/jazzy/setup.bash
export AMENT_PREFIX_PATH="/home/ddyyxx/Origin_ROSUI/vendor/prefix/opt/ros/jazzy:${AMENT_PREFIX_PATH:-}"
export PYTHONPATH="/home/ddyyxx/Origin_ROSUI/vendor/prefix/opt/ros/jazzy/lib/python3.12/site-packages:/home/ddyyxx/Origin_ROSUI/vendor/prefix/usr/lib/python3/dist-packages:/home/ddyyxx/Origin_ROSUI/ros2/rosui_demo:${PYTHONPATH:-}"
export LD_LIBRARY_PATH="/home/ddyyxx/Origin_ROSUI/vendor/prefix/opt/ros/jazzy/lib:${LD_LIBRARY_PATH:-}"
/home/ddyyxx/Origin_ROSUI/vendor/prefix/opt/ros/jazzy/lib/rosapi/rosapi_node &
python3 -m rosui_demo.param_node &
```

然后运行探针（本仓库的 vite-node 在 pnpm store 里但没有 `.bin` 链接，直接用其入口）：

```bash
corepack pnpm --filter @rosui/web exec node \
  /home/ddyyxx/Origin_ROSUI/node_modules/.pnpm/vite-node@3.2.4/node_modules/vite-node/vite-node.mjs \
  src/ros/dev-probe.ts
```

探针会断言四件事：`getParamNames` 包含 `/rosui_demo:gain`；`setParam gain 3.5` 成功；
`setParam gain 42.0` 被拒且 reason 为 `gain 必须在 [0.0, 10.0]`；
外部 `ros2 param set /rosui_demo gain 6.25` 的值通过 `/parameter_events` 到达订阅回调。
全部通过时最后一行输出 `DEV PROBE PASS`。

> 若 `vite-node` 路径因依赖版本变化而失效，可用 `node --experimental-strip-types` 在
> `apps/web` 目录下运行同一文件（Node ≥ 22，ESM 解析 `roslib` 需从 `apps/web` 作为 cwd）。
