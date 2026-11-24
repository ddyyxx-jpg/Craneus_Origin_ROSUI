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
5. ~~**断连即只读**~~ → 实现后修正为 **断连不锁控件，只停止下发**（见下方「补记 2026-11-25」）。

## 后果

- 正面：不轮询、延迟低（事件驱动），和 rqt_reconfigure 行为一致；重连后补一次全量 `get_param_names` + `get_param` 兜底。
- 负面：`/parameter_events` 是全局 topic，节点多时会刷得非常凶（每个节点启动都刷一批），必须做 node 级过滤，别在 JS 里遍历全量。
- 风险：若某个节点用 `set_parameters_atomically` 一次改多个，事件仍是一条消息里多个 entry，过滤逻辑要按 entry 循环，不能只看第一条。

## 附：类型坑

`ros2 param set /n gain 42`（整数字面量）会在类型检查阶段被 rclpy 拒：`Wrong parameter type, expected 'Type.DOUBLE' got 'Type.INTEGER'`，回调根本没进。前端写值必须按 `get_param` 返回的原类型走（double 就写 number、integer 就写整数、double_array 就写浮点数组），否则会得到与「值非法」完全不同的错误。

---

## 补记 2026-11-25（M2 实现后修订）

### 一、断线不锁控件（推翻决策 5）

原方案「`status !== 'connected'` 即 readonly」在真机上很别扭：ROS 没起时所有已绑定控件都不能编辑，连摆节点、调默认值都做不了。设计态不该被外部服务的可用性锁死。改为：

- `register()` 与 `applyStatus()` 一律 `setReadonly(false)`；
- 断线只调 `deactivateEntry()`：取消参数订阅、`active=false`（`onControlChange` 直接 return，不发 `set_param`）；
- 值仍写进 IR，用户能看到自己改了什么；重连时 `activateEntry()` 用节点值覆盖并重新订阅（服务端为准）。

也就是说：**「不下发」由 active 状态保证，「可编辑」由 UI 保证**，两者解耦。代价是断线期间画布值与节点值可能不一致——这在断线时本来就是事实，不假装同步比禁止编辑更诚实。

### 二、`NumberControl` 的 change 必须走 `this.onChange`

`NumberControl extends ClassicPreset.InputControl`，最初把 `change` 回调交给 `super('number', { change })`；基类把它存进闭包，`super.setValue()` 直接调闭包，**任何对 `control.onChange` 的包装都不生效**。绑定层正是靠包装 `onChange` 区分「程序写值 / 用户改值」，结果 number 控件改值完全不回灌 ROS（IR 却更新了——最难查的那种）。

修法：构造时不再传 change，`override setValue()` 里值真变化时 `this.onChange?.({ value, text, valid: true })`，与 Text/Select/Boolean 三个控件行为统一。教训：**继承第三方基类时，回调别交给基类闭包，否则后置包装全部失效。**

### 三、校验分两层，各有各的测试

- 前端约束（Gain `max=10`）在 `commitText` 就拦下：红框 + 行内错误，不发 `set_param`。
- 服务端拒绝（如类型不符、回调 veto）只在绕过前端约束时才出现，用单测的 mock client 覆盖回滚 + toast，e2e 只验证「本地拦下、不发 ROS」。
