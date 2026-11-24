# ADR-006：参数变更只订阅 `/parameter_events`，带回声抑制与首帧丢弃

- 状态：已接受（2026-11-24）
- 关联：T-006（RosClient）、T-017（双向同步）

## 背景

rqt_reconfigure 的对标能力要求：UI 改参数 → 节点变；别人（`ros2 param set`、节点自身）改参数 → UI 跟着变。

rosapi 提供 `get_param` / `set_param` / `get_param_names`，**没有**任何「参数变更通知」服务，所以变更只能从 topic 侧拿。实测（Jazzy，rosbridge 2.7.1，`demo_nodes_cpp parameter_blackboard`）：

```
事件 1: node=/parameter_blackboard  new_parameters=[{name: int_param ...}]  changed_parameters=[]  deleted_parameters=[]
事件 2: node=/parameter_blackboard  new_parameters=[]  changed_parameters=[{name: int_param ...}]  deleted_parameters=[]
```

即：**同一参数第一次被 set 落在 `new_parameters`，第二次及以后才落在 `changed_parameters`**。只监听 changed 会漏掉第一次赋值——而这恰好是「新建节点、参数还没被写过」的最常见场景。

## 决策

1. 订阅 `/parameter_events`（`rcl_interfaces/msg/ParameterEvent`），三个列表**全部**处理：`new_parameters` 与 `changed_parameters` 都按 binding 过滤后上屏；`deleted_parameters` 只记日志（参数被删后控件应置灰，M3 再做）。
2. 按 `<node>:<param>` 精确过滤，且 node 名要区分 `/rosui_demo` 与 `rosui_demo`（rosbridge 回来的字段带前导 `/`，binding 里也统一带）。
3. **首帧丢弃**：订阅建立后的 300ms 内收到的该参数事件不写 UI（节点启动会刷一批初始事件，否则控件会闪）。
4. **回声抑制**：自己 `set_param` 时记录 `(param, value, 时间戳)`，2s 内收到同值事件直接丢弃，避免「输入中每敲一个字符就被服务端事件回写一次」的抖动。比时间戳更稳的做法是值相等判定 + 短窗口，不做全局锁。
5. **断连即只读**：`status !== 'connected'` 时控件不允许写（UI 层置灰 + 顶部横幅），避免「离线时改了 IR 但节点根本没收到」的假绿。

## 后果

- 正面：不轮询、延迟低（事件驱动），和 rqt_reconfigure 行为一致；重连后补一次全量 `get_param_names` + `get_param` 兜底。
- 负面：`/parameter_events` 是全局 topic，节点多时会刷得非常凶（每个节点启动都刷一批），必须做 node 级过滤，别在 JS 里遍历全量。
- 风险：若某个节点用 `set_parameters_atomically` 一次改多个，事件仍是一条消息里多个 entry，过滤逻辑要按 entry 循环，不能只看第一条。

## 附：类型坑

`ros2 param set /n gain 42`（整数字面量）会在类型检查阶段被 rclpy 拒：`Wrong parameter type, expected 'Type.DOUBLE' got 'Type.INTEGER'`，回调根本没进。前端写值必须按 `get_param` 返回的原类型走（double 就写 number、integer 就写整数、double_array 就写浮点数组），否则会得到与「值非法」完全不同的错误。
