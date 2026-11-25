# M4 评审 · 通用运行时参数绑定 + 节点内嵌面板 + 节点内可编辑代码

## 评审对象

- PR：`feat/m4-runtime-binding` → `main`，HEAD `c4f7847`（含上一提交 `f5b3333` M3 修复）
- M4 增量：`git diff f5b3333..HEAD` 14 文件 +1162/−36；整 PR 28 文件 +1769/−69
- 声称交付：A 通用运行时参数绑定（ParamBrowser + `bind/unbind`）、B 节点内嵌 Inspector 面板、C Script 节点本地可编辑 JS
- 对照：`docs/ROSUI-落地方案.md:380` 的 M4 = 「试运行：e2e 全绿、demo.sh、反馈闭环、文档、5 分钟演示一次跑通」

## 评审方式

1. 逐文件读 M4 diff（14 个文件全读）；
2. 独立 reviewer 子代理只读静态复核（含 `node -e` 小实验）；
3. 动态验证子代理：静态门禁 + 真栈全量 e2e + 浏览器探针；
4. lead 复核代码路径与两份结论，统一严重度。

## 结论

**request-changes**。三个新能力都能跑通（双向绑定 bool/string、Script 求值、Inspector 列值），但 M4 自己的验收标准是「e2e 全绿」，而当前真栈全量 **19 passed / 3 failed / 6 did not run**；另有 3 个 P1 级功能缺陷（动态节点绑定假成功、Inspector 面板滚不动、Script 死循环冻死页面）。

## 首轮 verdict

| # | 位置 | 问题 | 处置 |
|---|------|------|------|
| 1 | `e2e/m3-pose.spec.ts:20-24`；`e2e/binding.spec.ts:69`；`e2e/m4-runtime-binding.spec.ts:74` | 真栈全量 `19 passed / 3 failed / 6 did not run`。三处失败同源：`ros2` CLI 输出混入 `[RTPS_TRANSPORT_SHM Error] … Permission denied` 与带时间戳的 `RTPS_PARTICIPANT` 行。① `m3-pose` 用行首锚定 `^Double values are: […]$` 解析 → `1 failed / 2 did not run`（M3 评审 P0，**`f5b3333` 未修 e2e/**）；② `binding.spec.ts:69`、`m4-runtime-binding.spec.ts:74` 用 `toBe(before)` 逐字比对两次 CLI 输出，警告行时间戳不同（14:54:18.521 vs 14:54:20.767）导致假失败，实际 `Double value is: 6.25`/`0.85` 完全一致。 | **待修（P0）**：`e2e/demo-stack.ts:15-25` 的 `ros2()` 统一过滤 `RTPS_*`/`Permission denied` 行；数值断言改 `toMatch(/value is: …$/)` 或 `toContain`。修完再跑全量，并把结果写进 README/backlog。 |
| 2 | `apps/web/src/App.tsx:218-230`（`+ Gain`）+ `apps/web/src/binding/useParamBinding.ts:212-251` | 动态新增节点没有注册进绑定控制器：`+ Gain` 只 `addNode` + `refresh`，`allNodes` 注册循环（`:104-128`）只覆盖启动时的 5 个节点；`+ Pose` 有手写 adapter/register（`:232-266`），`+ Script/+ Inspector` 没有。结果：对动态 Gain 点「绑定」后，`RUNTIME_BINDINGS` 写入成功、IR 显示 `mode:"runtime"`、参数浏览器显示「解绑」（看似已绑），但 `bind()` 里 `this.controls.get(key)` 为 undefined → 直接 return，**没有任何订阅**，UI 改值不下发、ROS 改值也不上屏。 | **待修（P1）**：抽出 `registerNode(node)` 供所有 addNode 路径复用；`bind()` 找不到 control 时回滚 `clearRuntimeBinding` 并 toast，不能假成功。 |
| 3 | `apps/web/src/rete/nodeRenderers.tsx:73` + `styles.css:216-224` | Inspector 面板 `max-height:160px; overflow-y:auto`，但滚轮事件冒泡到 Rete 画布触发缩放：实测 `panel.hover()+wheel(0,70)` 后 `scrollTop` 仍为 0，节点 box 从 `{y:767,w:193}` 变为 `{y:292,w:174}` —— 面板滚动不了，画布被误缩放。绑定 6 行即溢出（`scrollHeight=214 > clientHeight=158`）。 | **待修（P1）**：面板根节点 `onWheel`/`onPointerDown` `stopPropagation`（与 `controls/react.tsx:26-45` 一致），或对 `scrollHeight > clientHeight` 时阻止冒泡。 |
| 4 | `apps/web/src/rete/nodes.ts:197-221`（`ScriptNode.run`） | `new Function('x','__timeout', …)` 在主 UI 线程同步执行：`deadline = Date.now()+50` 只在用户代码**主动调用** `__timeout()` 时生效，`while(true){}` / 同步死循环永久冻结画布（实测 Ctrl+Enter 后 Playwright `press` 120s 不返回，只能刷新页面）；同一上下文可访问 `fetch/WebSocket/globalThis`，代码还随 IR 持久化（未来「保存/加载 .rosui.json」会把可执行代码带进别人的页面）。注释自称「覆盖常见失控场景」与实际不符；每次 blur 都会自动执行。 | **待修（P1）**：至少把执行搬进 Worker（可 `terminate` 真超时）或用 `setTimeout` 分片；`__timeout` 注入保留但当装饰。若坚持主线程，需在 run 前 `confirm`/显式「运行」按钮，并在文档里写明「不可运行不可信代码」。 |
| 5 | `apps/web/src/rete/nodes.ts:119-132` + `:224-233` | 运行期绑定写进 IR 的语义有损：`node: "/rosui_demo:gain"`（ROS node+param 塞进 `node` 字段），`param` 仍是本地 `inputKey`（如 `value`），IR 里没有实例 id、也没有 `ref.node/ref.param` 分字段；`ScriptNode.toParamBinding()` 把代码放在 `param:'code'`、而 `params` 的键是 `inputKey:'x'`。当前无 import 消费者（`grep fromGraphIR apps/web/src` 空），但一旦做保存/加载，无法还原「哪个实例绑了哪个 ROS 参数」。 | **建议（P2，做保存/加载前必须）**：`ParamBinding` 增 `instanceId?`/`ref?: {node,param}` 可选字段（zod 同步），`node/param` 继续表示本地节点/端口；补一条 runtime round-trip 测试。 |
| 6 | `apps/web/src/ParamBrowser.tsx:78`、`:63-75` | `client.getParamNames()` 无 `.catch`，rosapi 失败/断线时是 unhandled rejection，`rows` 停在空数组，UI 只显示「无匹配参数」，无法区分「没参数」和「拉取失败」，也没有重试。`Promise.all` 对全部参数并发 `getParam`，无并发上限/虚拟列表，参数多时打爆 rosapi 与主线程。 | **建议（P2）**：加 `catch` + 错误态 + 重试按钮；`getParam` 分片（如 8 并发）或只对可视行拉值；参数列表变化时重新 `getParamNames`（目前只在连接时取一次，新参数不出现）。 |
| 7 | `apps/web/src/rete/nodeRenderers.tsx:11-13`、`:45`、`:65-70` | `useParamValues` 在 `client.status !== 'connected'` 时直接 return，且不订阅状态变化：先 `+ Inspector` 再连接 ROS，面板不会刷新（只有绑定集合变化导致 `refsKey` 变才重跑）；`refsKey` 只拼 `node:param`、丢 instanceId，同一参数在两个实例间重绑时 effect 不重建。组件还用 `setInterval(200ms)` 强制 tick 重渲染（`void tick`），每实例 5 次/秒空转。 | **建议（P2）**：改成订阅 `status` 与绑定表版本；去掉定时 tick，值更新走 `subscribeAllParamEvents` 的 throttle。 |
| 8 | `apps/web/src/App.tsx:224` | `+ Gain` 固定坐标 `(300,520)`，连点两次节点完全重叠，第二个节点用真实鼠标点不到（Playwright 报 `subtree intercepts pointer events`）；`+ Pose` 已有 `count*30` 错位逻辑，`+ Gain` 没沿用。 | **建议（P2）**：与 Pose 一致按节点数错位，或做「放在视口中心 + 自动避让」。 |
| 9 | `apps/web/src/binding/bindings.ts:105-119`、`:149-157` | `bindingTypeFromRos` 把 `int/integer` 降级成 `'double'`，而 `BindingValueType`、`matchesBindingType`、`typesCompatible` 都保留了 `'integer'` 分支 → `integer` 实际不可达，整数参数绑定后写回会带 `.0`（当前 encode 逻辑对 number 一律补 `.0`），对 `int` 参数是类型错配。 | **建议（P2）**：ROS `integer` 映射成 `'integer'` 并让 `encodeParamValue` 对 integer 绑定不补 `.0`；补一条 int 参数双向用例。 |
| 10 | `docs/backlog.md:169-171`、`README.md:5,17,38` | 文档与交付脱节：backlog 仍写「M4 先不细化：JSON 编辑器、LOD、200 节点压测、撤销/重做、复制粘贴、保存/加载 .rosui.json、AC-1..5」，本次实际做的是 A/B/C 三项全新能力，没有任何 M4 任务卡/验收清单；README 仍称「M3 完成 / 21 条 e2e 全绿」，而实测全量 19 passed / 3 failed；落地方案里 M4 的定义是「e2e 全绿 + demo.sh + 5 分钟演示」，AC-1..5 在仓库中无定义。 | **建议（P2）**：补 T-024..T-026 三张 M4 卡（含验收与 e2e 映射）+ 一张 M4 评审卡；README 更新 e2e 数字并附门禁命令；`docs/ROSUI-落地方案.md` 的 M4 段与实现对齐（新增能力 vs 试运行打磨需二选一或拆 M5）。 |
| 11 | `apps/web/src/binding/useParamBinding.ts:87`、`:401`、`:414` | `pendingTimers` 只在声明与 `dispose()` 里出现，从未 `add`；`setTimeoutFn` 注入项未使用；toast 定时器不在 React 卸载时清理（可能在卸载后 `setState`）。 | **建议（P2）**：删除死代码，或真正把 toast 定时器登记进 `pendingTimers` 并在 effect cleanup 清理。 |
| 12 | `apps/web/src/rete/nodeRenderers.tsx:117`、`:128-133` | Script 节点的 `x` 输入不参与画布求值：`data.run()` 只读 `this.control.value`（`nodes.ts:208`），不读连线来的值；`Script` 也没进 App 的注册循环，端口无法绑定 ROS 参数。当前标签叫「x 输入」但语义只是本地数字控件。 | **提示（P2）**：若要「连线即输入」，run 时从连接的上游节点取值；否则改文案为本地参数，避免误导。 |

## M3 评审遗留追踪（`f5b3333` 声称修复）

| M3 评审项 | 状态 | 证据 |
|---|---|---|
| P0 e2e 解析容错（`m3-pose` 锚定正则 + RTPS 噪声） | **未修** | `e2e/m3-pose.spec.ts:21` 仍是 `/^Double values are: \[([^\]]+)\]$/`；本次实跑仍 `1 failed / 2 did not run` |
| P1 重复 `+ Pose` 僵尸节点 | 已修 | entry key 带 `instanceId`（`useParamBinding.ts:69`、`App.tsx:238-266`）；`bindings.ts:34-37` 同步 |
| P1 输入 `key` 含 version → Tab 失效 / 外部更新覆盖输入 | **未修** | `controls/react.tsx:297` 仍 `key={`${index}:${version}:${binding.version}`}`，blur 仍 `setVersion` |
| P1 `type="number"` 32.75px 字段点中心命中 spinner | **未修** | `react.tsx:291` 仍 `type="number"`；`styles.css:111` 仍只给 `max-width:240px`（`f5b3333` 未改 styles.css） |
| P2 `encodeParamValue` 非法字面量 | 已修 | `protocol.ts:73-88` 先 `Number.isFinite`，异常回退 `JSON.stringify` |
| P2 `PoseControl.valid` 被 `setValue` 覆盖 | 已修 | `model.ts` +4 行重算；`controls/model.test.ts` 4 例（含 valid 回归） |
| P2 `buildControl('pose')` 无长度 7 兜底 | **未修** | `nodes.ts:69-74` 仍只 filter 有限数字 |
| P2 T-021 验收缺口（红框/不写 ROS/不冒泡断言） | **未修** | `e2e/m3-pose.spec.ts` 未加断言 |
| P2 IR 数组项未 `.finite()` | **未修** | `packages/ir/src/index.ts:93-95` 未变 |
| P2 `text: JSON.stringify` 语义漂移 | **未修** | `controlAdapter.ts:75` 仍 `JSON.stringify(value)` |
| P2 缺评审卡 / README 数字 | 部分 | 评审以 `docs/reviews/M3-review.md` 文件形式入库，backlog 仍无 T-024 卡 |

## 已核对无问题

- **运行时绑定核心状态机**：`register/bind/unbind` 同 key 先 `disposeEntry`（`useParamBinding.ts:131,225`），`activateToken`/`writeSeq` 抑制迟到 `getParam`（`:277-309`），`echoUntil/warmupUntil/sameValue` 在实例 key 下仍成立；bool/string 参数实测双向通（ROS→UI、UI→ROS、外部 set 再同步）。
- **类型检查**：`typesCompatible` 拒绝 string→number（toast「不接受 string」），`matchesBindingType` 与 `controlAdapter.guardedChange` 对数组/标量一致；`controlLastValue` 与控件取值一致。
- **IR schema 兼容**：`paramModeSchema` 早已含 `'runtime'`，`valueType:'integer'` 合法，M4 无需改 schema 即可导出（代价见 #5）。
- **Inspector 渲染在 React 内**：`customize.node` 返回 React 组件/`ReactPresets.classic.Node`（`nodeRenderers.tsx:174-192`），无手工 DOM；参数名/值走 JSX 文本，全仓无 `innerHTML`/`dangerouslySetInnerHTML`，无 XSS 路径。
- **订阅清理**：`subscribeAllParamEvents` 的 unsubscriber 与 timer 都在 effect cleanup（`ParamBrowser.tsx:87-93`、`nodeRenderers.tsx:38-45`）；M3 的 `Pose` 修复未破坏静态绑定（Gain/Mode/Switch 仍走回落表）。
- **单测**：`apps/web` 4 文件 25 passed（新增 `controls/model.test.ts` 4 例、`useParamBinding` 多实例 1 例）；`packages/ir` 5 passed。

## 门禁实测

```bash
corepack pnpm build                       # 退出 0（185 modules，1.17s）
corepack pnpm check                       # 退出 0（tsc ×2 + IR 5 tests）
cd apps/web && corepack pnpm exec vitest --run src   # 4 files / 25 passed
node node_modules/@playwright/test/cli.js test        # 28 tests: 19 passed / 3 failed / 6 did not run（49s）
#   m3-pose.spec.ts           1 failed / 2 did not run   ← P0 #1（M3 遗留）
#   binding.spec.ts:69        1 failed（RTPS 行时间戳差异，数值相同）
#   m4-runtime-binding.spec.ts:74  1 failed（同上）
#   单跑 m4-inspector 1 passed（~50s）
bash scripts/demo-stack.sh --check        # 退出 0（仅 RTPS SHM 噪声）
```

浏览器探针（临时 spec，已删除；工作区干净）：

```
Inspector: scrollHeight=214 > clientHeight=158，wheel 后 scrollTop=0，节点 box y 767→292（画布缩放）
Script:    return x*3+1, x=1 → out: 4.0；x=10 → out: 31.0；while(true){} → press 120s 超时（主线程冻结）
动态绑定:  + Gain → 绑 /rosui_demo:gain → 本地改 5.5 → ros2 param get 仍 1.0（UI→ROS 无效）
重叠:      连点两次 + Gain → 第二个节点被第一个遮挡（subtree intercepts pointer events）
```

## 第二轮闭环（2026-11-25，`feat/m4-runtime-binding` 工作区）

针对上一轮 verdict 的剩余项与用户 m01544「修」：

| 项 | 状态 | 落地 |
| --- | --- | --- |
| 参数浏览器只列首次 `getParamNames` | ✅ | `ParamBrowser.tsx` 新增 `addDiscovered()`：未知 `<node>:<param>` 事件先入 refs + eventValues，再 `getParam` 补类型后追加行；新增 `e2e/m4-param-browser.spec.ts`（晚声明参数节点 + 事件值刷新） |
| 每次执行新建 Worker | ✅ | `scriptRunner.ts` 改单例：`WeakMap<factory, Worker>` + `pendingById` + `runId`；超时只 terminate 该轮并重建；`scriptRunner.test.ts` 6 例（含「工厂只调 1 次」） |
| 动态节点未注册绑定层 → 绑定假成功 | ✅ | `App.tsx` `registerDynamic()` + `dynamicUnregisters`；`bind()` 返回 boolean，未注册时 toast 并回滚 IR（新增 e2e 断「+ Gain 后绑定真写进 ROS」） |
| Inspector 滚轮被画布抢走 | ✅ | `.inspector-panel` `onWheel`/`onPointerDown` stopPropagation |
| 参数浏览器初值拉取打爆 rosapi | ✅ | 默认收起（`param-toggle`）+ 展开才加载 + 4 并发池 + unknown 行退避重试 3 次 |
| 首帧窗口吞掉真实外部改值 | ✅ | warmup 内事件改为补拉权威 `getParam`（`warmupRefresh`），不再丢弃 |
| 订阅建立前的外部改值丢失 | ✅ | 订阅后 300ms `refreshOnce()` 补拉一次 |
| `/parameter_events` 丢事件后永久不同步 | ✅ | `RECONCILE_INTERVAL_MS=5000` 周期对账（connected 时启、断线/销毁停） |
| Pose 字段 `type="number"` 命中 spinner / `key` 含 version 破坏 Tab | ✅ | 改 `type="text" inputMode="decimal"`、`key={label}`、删除仅供重挂的 `version` state |
| `buildControl('pose')` 无 7 元兜底 | ✅ | 短补 0（末位 w 补 1）、超长截断 |
| IR 数组项未 `.finite()` | ✅ | `packages/ir/src/index.ts` 数组分支改 `z.number().finite()` |
| `controlAdapter` 数组 `text: JSON.stringify` | ⏳ 未修 | 语义漂移仍在（数组控件的 IR `text` 是 JSON 串），留待 M5 统一 `text` 语义 |
| M3 e2e 验收缺口（红框/不写 ROS 断言） | ⏳ 未修 | `e2e/m3-pose.spec.ts` 未补断言 |

### 门禁（第二次）

```bash
corepack pnpm build      # 0
corepack pnpm check      # 0（tsc ×2 + IR 5 例）
corepack pnpm -w exec vitest --run apps/web/src packages/ir   # 38 passed（5 + 5 文件）
node node_modules/@playwright/test/cli.js test                # 31 passed，连续 3 轮（1.2–1.3m/轮）
```

### 复现与根因备注

- dynamic-gain 用例填 `2.75` 永远写不进去：Gain 的 `constraints.step=0.1` 要求 0.1 整数倍，`validateNumber` 正确拒绝；测试值改为 `2.7`。**不是产品 bug**。
- 全量 e2e 的「外部改 6.25 → UI 停在 4」只在全量时序下出现：参数浏览器未收起时并发 35 次 `getParam` 挤占 rosapi + `parameter_events` 丢事件；收起 + 对账后消失。
