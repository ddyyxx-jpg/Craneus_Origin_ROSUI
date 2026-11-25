# M3 评审 · Pose 复杂控件与 double_array 双向绑定

## 评审对象

- PR：`feat/m3-pose-control` → `main`（16 文件，+392/−15，HEAD `dbbbc9b`）
- 范围：`docs/backlog.md` 的 T-021 / T-022 / T-023
- 对照契约：`docs/milestones.md` M3、`docs/spec/` 既有 IR/binding 规范、M2 评审（`docs/reviews/M2-review.md`）

## 评审方式

1. 逐文件读 diff（16 个文件全读，含 `docs/artifacts/m3-pose-control.png` 的生成来源 `e2e/capture-m3.mjs`）；
2. 本机静态门禁与单测实跑（见末节）；
3. 真机栈 e2e 实跑（rosbridge + demo-stack，`node node_modules/@playwright/test/cli.js test`）；
4. 浏览器行为探针（Playwright，临时 spec，用后删除）：Tab 遍历、字段命中区、重复 `+ Pose`；
5. 独立 reviewer 子代理只读复核 + lead 复核，两方结论一致。

## 结论

**request-changes**。功能主线（IR 双向绑定、真栈读写、非数字拦截）实测成立，但 M3 自己的 e2e 在本机真栈下必红（P0），控件还有三处用户可感知的交互缺陷（P1）。修完 P0/P1 即可合并，P2 可随 M4 处理。

## 首轮 verdict

| # | 位置 | 问题 | 处置 |
|---|------|------|------|
| 1 | `e2e/m3-pose.spec.ts:18-24`、`:56-58` | `poseFromCli()` 与 test2 断言都用行首锚定的 `^Double values are: […]$` 全匹配原始命令输出。本机真栈 `ros2 param get` 的 stdout 会先混入 RTPS 警告（`[RTPS_TRANSPORT_SHM Error] … Permission denied`），第 1 条用例确定性失败，`describe.serial` 连累后两条（`1 failed, 2 did not run`）。M2 的 `e2e/binding.spec.ts` 用的是非锚定 `/value is: 3\.5$/`，本文件倒退。 | **待修（P0）**：改为逐行 `startsWith('Double values are:')` 取最后一行再 match，test2 去掉 `^`（`m3-pose-verify.spec.ts` 已验证这样 `3 passed (10.8s)`）。 |
| 2 | `apps/web/src/App.tsx:186-215`、`:194`、`:205-213` + `apps/web/src/binding/useParamBinding.ts:104-107`、`:259-264` | `+ Pose` 可以无限点，但每次都把所有 Pose 节点绑到同一个 key `Pose:pose`；第二次 `register` 走 `disposeEntry(previous)`：旧节点的订阅被摘掉、`setReadonly(true)`，节点却仍留在画布、仍导出旧 IR 值。实测连点两次 → 14 个字段，恰好 7 个 `readOnly`（可编辑标志 `[false×7, true×7]`）——一整个 Pose 节点变成不可编辑、不再同步的僵尸。全仓无 `removeNode/deleteNode`，所以 `poseUnregisters` 只在画布卸载时被消费，删节点功能一旦加上必漏。 | **待修（P1）**：要么 `disabled={!ready \|\| hasPose}` 只允许一个 Pose，要么绑定 key 带节点 id 并支持随节点删除 `unregister`；`unregister` 文案与注释同步改。 |
| 3 | `apps/web/src/controls/react.tsx:268-274`、`:297`、`:305-317` | 每个字段的 `key={`${index}:${version}:${binding.version}`}` 含 `version`，effect 和 blur 都会 `setVersion(v+1)` → 7 个 `<input>` 整体卸载重挂载。实测：字段 1 输入 1.5 按 Tab，`document.activeElement` 回到 `BODY`，键盘逐字段填写不可用；同理，ROS 侧推送更新到达时 effect 用 `data.fieldTexts` 覆盖 `texts` 并重挂载，正在输入（未 blur）的字段文本被回滚且失焦。 | **待修（P1）**：去掉 `version`/`binding.version` 依赖（`useBindingState` 已经会因 binding version 变化触发重渲染），或只对“已提交值”变化做 `key`，且不要在 blur 里再 `setVersion`。 |
| 4 | `apps/web/src/controls/react.tsx:291`（`type="number"`）+ `apps/web/src/styles.css:111`、`:118-122` | `.rosui-pose-control` 只写了 `max-width:240px` 没给宽度，实测每个输入框只有 **32.75×18 px**；`type="number"` 在这么窄的框上，内置 spinner 占了右半。Playwright 点元素中心（x=16）即命中 spinner：初值 0 被静默减成 **-1**，随后输入 "1.5" 得到 "-11.5"，失焦就提交到 ROS。同仓库 `NumberControlComponent` 用的是 `type="text" inputMode="decimal"`，本控件不一致。 | **待修（P1）**：改 `type="text" inputMode="decimal"`（顺带保住 "1." 这类中间态），并给容器 `width:240px` + 输入框最小高度/字号。 |
| 5 | `apps/web/src/ros/protocol.ts:73-84` | `encodeParamValue` 的整数补 `.0` 缺 finite/安全整数兜底：`Number.isInteger(1e21) === true` → 产出非法字面量 `1e+21.0`；数组分支 `typeof item === 'number'` 放行 NaN/Infinity → `"NaN"`/`"Infinity"`，rclpy 侧会按字符串解析并以类型不符拒收。当前 Pose UI 路径上游有 finite 校验（`model.ts`、`controlAdapter.ts:89-97`），但这是通用导出函数且 IR schema 数组项未 finite 化。 | **待修（P2）**：只对 `Number.isSafeInteger(item)` 补 `.0`，`!Number.isFinite(item)` 直接返回 `String(item)` 或抛错；补 `RosClient.test.ts` 边界用例。 |
| 6 | `apps/web/src/controls/model.ts:309-318`、`:320-337`、`:329` | `commitField` 先算出“多字段 + 长度”的 `this.valid`，随后 `setValue()` 内 `this.valid = true` 无条件覆盖（`:316`）。字段 y 有错时提交字段 x，模型 `valid` 会错判为 true。当前 React 用自己维护的 `errors` 显示红框、`control.valid` 无人读取（仅 `controlAdapter.ts:38` 消费 change.valid），故暂无用户可见后果，但状态语义错误，接 `change.valid` 的消费者会踩。错误恢复靠 `nextErrors.map(...)` 手工回填，脆弱。 | **建议（P2）**：`setValue` 不碰 `valid`，或改名 `setValueValidated`；`commitField` 结束时按 `errors` 统一重算。 |
| 7 | `apps/web/src/rete/nodes.ts:68-73`、`:182` + `apps/web/src/controls/model.ts:299-304` | `buildControl('pose')` 只过滤有限数字，不校验/补齐长度；`PoseControl` 却硬编码 7 字段（`applyControlValue` 要求长度 7 才 `setValue`）。当前 `NODE_REGISTRY.pose.initial` 恰好 7 项不触发；未来导入 IR / 手改初始值就会得到字段数不对、且没有增删 UI 可补救的控件。 | **建议（P2）**：`initial` 按 7 长度对齐（短补 `0`，第 7 位缺省 `1`），或在 `buildControl` 抛错。 |
| 8 | `e2e/m3-pose.spec.ts:39-69` | T-021 三条验收未覆盖：① 非法值红框/错误文案；② 非法值不写 ROS（改值后 `ros2 param get` 不变）；③ 不冒泡画布拖拽/键盘。实现侧有 `Drag.useNoDrag` + keydown/pointerdown capture 拦截（`react.tsx:26-45`）但零断言。另 `:59` 的 `toHaveCount(0)` 紧跟 `setParam`，失败 toast 是异步出现的，属空转断言；`:66-67` 只查第 0/2 个字段，且依赖前一条用例 300ms 预热后的 2s 窗口。 | **建议（P2）**：补 3 条断言（`.invalid` 类、`param get` 不变、canvas 拖拽后坐标不变）；`toHaveCount(0)` 改为等待 500ms 后的稳定断言或正向断言 IR 未变。 |
| 9 | `packages/ir/src/index.ts:93-95`、`packages/ir/test/ir.test.ts` | 数组分支已是 `z.array(z.union([z.number(), z.string()]))`（T-022 通过），但与标量 `z.number().finite()` 不一致：实测 zod 3.25.76 下 `[Infinity]` 通过（NaN 被拒）。IR 层没有数组/Pose 用例。 | **建议（P2）**：数组项改 `z.union([z.number().finite(), z.string()])`，补 1 条 `double_array` round-trip 测试。 |
| 10 | `apps/web/src/binding/controlAdapter.ts:60-73` | `text: JSON.stringify(value)` 把字符串值变成带引号形式（`"abc"` → `"\"abc\""`）。当前全仓只有 `rete/nodes.ts:36-38` 消费 `ControlValueChange` 且只取 `value/valid`，**无显示/IR 回归**；但语义漂移会在未来新消费者处爆。 | **提示（P2）**：保留 `String(value)` 的标量语义，仅数组走 `JSON.stringify`。 |
| 11 | `docs/backlog.md:157`、`README.md` | backlog 给 M3 只挂了实现卡 T-021/022/023 并全部标 ✅，没有评审卡；README 宣称“21 条 Playwright 全绿”，与本次真栈实跑（1 failed / 2 skipped）不符——断言在本机环境不可复现。 | **建议（P2）**：补 T-024 评审卡（引用本文件），README 的“全绿”改为“在本机 rosbridge 环境全绿”或附门禁命令。 |

## 建议项（非阻断）

- 给 `PoseControl` 补单测：`commitField` 的多字段错误叠加、`setValue` 长度/非有限值拒绝、`valueTypeForControl('pose') === 'double_array'`；当前 web 单测只新增了 `RosClient` 的 encode 用例。
- `pnpm test` 只跑 IR；根目录 `pnpm exec vitest --run` 会把 `e2e/*.spec.ts` 收进单测（4 failed，既有问题，非本 PR 引入）。建议 vitest 配置里 `exclude: ['e2e/**']`，或把单测入口固定成 `vitest --dir apps/web/src`。
- `App.tsx:205-213` 里 `setValue` 包一层 `refresh()` 才让画布预览刷新，说明控件值 → 节点视图的联动仍靠手动触发；若 M4 要做实时预览，建议把这条路径统一到 `controlState` 的订阅里。
- e2e 里 `poseFromCli()` 解析失败时的错误信息建议带上原始输出首行与长度，便于下次一眼定位噪声来源。

## 已核对无问题

- **程序写值不回灌 ROS**：`controlAdapter.ts:32-43` 的 `WeakSet` 标记 + `controlState.ts:57-70` 的 `try/finally` 正确；`applyControlValue` 对 pose 的长度与 finite 检查到位（`controlAdapter.ts:89-97`）。
- **外部更新 → UI 同步链路**：`useParamBinding` 的 `sameValue` 对数组逐元素比较，echo 抑制生效；噪声容忍版 e2e 的 test3 实测外部 `param set` 后 UI 在 2s 内更新为 2,2,2,0,0,0,1。
- **IR 层接受数组**：`paramValueTypeSchema` 加 `'double_array'` 后 `toGraphIR`/`fromGraphIR` round-trip 正常，demo-stack 导出的 `.rosui.yaml` 与 M2 兼容（T-022 通过）。
- **不冒泡**：`useControlEvents()` 的 `Drag.useNoDrag` + `keydown/pointerdown` capture `stopPropagation` 被 Pose 输入复用（`react.tsx:26-45`），静态上成立；缺的只是断言（见 #8）。
- **`text: JSON.stringify` 无回归**：见 #10，确认当前无消费者。
- **真栈功能主线成立**：仅修断言解析（不改实现）后，`e2e/m3-pose-verify.spec.ts` 三条全过（`3 passed (10.8s)`）：初值 `[1,2,3,0,0,0,1]` 正确显示、x 改 4.5 后 `ros2 param get` 得到 `[4.5, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0]`、外部 set 2,2,2 同步回 UI。
- **静态门禁全绿**：`corepack pnpm build` 退出 0；`corepack pnpm check` 退出 0（tsc ×2 + IR 5 tests）；`apps/web` vitest 20 passed。

## 门禁实测

```bash
corepack pnpm build                                          # 退出 0
corepack pnpm check                                          # 退出 0（tsc ×2 + IR 5 tests）
cd apps/web && corepack pnpm exec vitest --run src           # 3 files / 20 passed
bash scripts/demo-stack.sh --check                           # 退出 0（仅 RTPS SHM 噪声）
node node_modules/@playwright/test/cli.js test e2e/m3-pose.spec.ts
# → 1 failed, 2 did not run（问题 #1，本机确定性复现）
# 仅修解析后的临时副本 m3-pose-verify.spec.ts → 3 passed (10.8s)，已删除
node node_modules/@playwright/test/cli.js test               # 建议 #1 修后重跑全量 21 条
```

浏览器探针（临时 spec，已删除，工作树干净）：

```
ACTIVE_AFTER_TAB= BODY            # 问题 #3
BOX= {"x":470,"y":754,"width":32.75,"height":18}   # 问题 #4；点中心 0 → -1
readonly-flags= [false×7, true×7] # 问题 #2，连点两次 + Pose
```
