# ADR-007 图文件用 GraphIR 直存，节点 id 原样保留

- 状态：已采纳（M5，2026-11-25）
- 相关：`packages/ir/src/index.ts`、`apps/web/src/rete/serialize.ts`、`apps/web/src/App.tsx`

## 背景

画布需要能存盘再打开（`.rosui.json`）。现有 `toGraphIR()` 只用于测试断言和 IR 面板，字段不全：`params` 的键取 `spec.inputKey`（Script 节点是 `x`，而它的 `toParamBinding().param` 是 `code`），且没有恢复路径。

## 决策

1. **文件格式就是 GraphIR v1**，`parseGraph()` 做 zod 校验，不新增第二套序列化格式。带来的好处是 e2e / IR 面板 / 文件三者同构，坏处是 IR 一旦演进就要兼容旧文件（v1 内只做可选字段扩展）。
2. **`params` 的键用 `binding.param`**（不是 `spec.inputKey`）：这样 Script 的 `code` 绑定能原样存下来。
3. **节点 id 原样保留**：`loadGraph()` 在 `editor.addNode()` 之前用 `Object.defineProperty(node, 'id', …)` 写回文件里的 id。原因是边的 `source/target` 与绑定里的静态 `node` 都引用 id，重新生成 id 就要额外维护一张映射表。
4. **加载不下发 ROS**：`applyParamBinding()` 只写控件值与节点本地值（`restoredBinding`），不碰运行时绑定表，也不调 `setParam`。加载时通常未连接；即便已连接，也应该由用户显式重新绑定，避免打开文件就把别人的节点参数改掉。
5. **运行时引用保留但不自动重订阅**：`mode:'runtime'` 与 `node:"/rosui_demo:gain"` 会随文件保存/恢复，但 `bind()` 表不恢复；UI 上表现为「运行期绑定需重新点一次」。这是有意的——恢复订阅意味着加载文件即向 ROS 写值。
6. **容错边界**：未知 `type` 的节点、缺端口的边跳过而不整体失败；文件整体校验失败则 toast「加载失败：…」，当前画布不动（校验在 `editor.clear()` 之前）。

## 后果

- 存盘 → 刷新 → 加载 → 再存盘，GraphIR 应逐字段稳定（id、位置、绑定值、边端口）。
- Script 节点目前只恢复 `code`，不恢复 `x` 控件值与运行结果；`toParamBinding()` 本身也只暴露 `code`，属于既有模型限制，留待 M5 后续统一。
- 若将来需要「打开文件即恢复 ROS 订阅」，必须加显式开关（例如加载对话框里的「恢复绑定」勾选），不能默认。
