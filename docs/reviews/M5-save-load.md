# M5 评审：GraphIR 保存 / 加载（`.rosui.json`）

- 评审对象：PR #3 `feat/m5-save-load` @ `a0d054c`（base `main` = `8f0c9cc`），13 文件 +504/−23
- 评审方式：独立 reviewer 子代理只读审查 + lead 静态复核 + 真 rosbridge 动态探针（`e2e/tmp-m5-load.spec.ts`，评审后已删）
- 结论：**request-changes**（保存方向基本成立，加载方向有三个必修问题）

## verdict

| # | 位置 | 问题 | 级别 |
|---|---|---|---|
| 1 | `apps/web/src/App.tsx:213-226` + `apps/web/src/App.tsx:165-186` | **含 Inspector 节点的图加载必然失败且摧毁当前画布**：`+Inspector` 建的是 `InspectorNode extends ClassicPreset.Node`（`apps/web/src/rete/nodes.ts:183`），没有 `control` 属性；`handleLoadGraph` 加载后无条件 `for (const node of editor.getNodes()) registerDynamic(node)`，`registerDynamic` 把 `control: node.control`（`undefined`）交给 `createControlAdapter`，控件侧 `Drag.useNoDrag` 用 WeakMap 存 key → 抛 `Invalid value used as weak map key`。实测：加载一张只含 Inspector 的合法 IR 后，画布被清空并只留下 Inspector 节点，toast 显示「加载失败：Invalid value used as weak map key」，而右侧 IR 面板仍显示加载前的旧图（`graph` 状态未刷新）。用户路径：点 `+Inspector` → 保存图 → 刷新页面 → 加载图，即可复现并丢图。 | **P0** |
| 2 | `apps/web/src/rete/nodes.ts:124-146`、`apps/web/src/rete/serialize.ts:83-100` | **`mode: 'runtime'` 绑定加载后是「死绑定」**：加载只把绑定信息写回控件值（`applyParamBinding`），从不调用 `setRuntimeBinding`/重新 `bind()`，`RUNTIME_BINDINGS` 不重建。实测：加载一张 `Threshold` 端口绑定 `/rosui_demo:gain` 的 runtime IR → 控件显示 3，改成 7.5 后 `ros2 param get /rosui_demo gain` 仍是 `1.0`，无 toast、无任何提示，IR 里 `mode` 仍写着 `runtime`。等于把 M4 已判过的「绑定假成功」通过持久化又搬了一遍。ADR-007 第 5 条把它写成「有意不自动重订阅」，但 `docs/backlog.md` T-030 标 ✅ 且验收写了「绑定模式还原」。 | **P0** |
| 3 | `apps/web/src/rete/serialize.ts:83-113` | **加载没有事务性**：`parseGraph` 通过后立即 `editor.clear()`，随后逐个 `addNode`/`translate`/`addConnection`；任一步抛错（如上面的 Inspector 崩溃、重复 id、`Object.defineProperty` 覆盖 id 后 Rete 内部键冲突）都只剩 `catch` 里的一行 toast，旧图已清、新图半建、`graph`/`selectedPort`/`lastGain` 状态不回滚。非法 JSON/schema 不受影响（`parseGraph` 在 `clear` 之前），但「schema 合法、加载中途失败」是真实可达的。建议：先在离线 editor 或预检阶段验证全部节点可建，再原子替换；至少 `clear()` 前快照，失败时回灌。 | **P0** |
| 4 | `apps/web/src/App.tsx:186-193,350-358` | 动态注册清理不完整：`clearDynamicRegistrations` 只清 `poseUnregisters`/`dynamicUnregisters`，**初始 5 个节点的 unregister 不在此列**（它们随画布 effect cleanup 才释放）；`+Inspector` 只 `addNode + refresh`，从不 `registerDynamic`，因此 Inspector 在加载路径上是「第一个坏 key」，在新增路径上是「从未注册」。 | P1 |
| 5 | `apps/web/src/App.tsx:196-210` | 文件层细节：保存固定 `rosui-graph.json`，与 README/backlog 宣称的 `.rosui.json` 不一致；无重名处理、空图也照存；加载 `accept=".json,.rosui.json,application/json"` 但不校验扩展名/大小，`file.text()`+`JSON.parse` 无上限，解析失败只给 `JSON.parse` 原生错误文案。 | P1 |
| 6 | `apps/web/src/rete/serialize.ts:83-100` | 不可信 `.rosui.json` 可携带 Script 节点的 `code`，加载后点 Run 就走 `new Function` 执行任意 JS（加载本身不执行，但这等于把「图文件」升级成可执行载体）。M5 范围内建议至少在加载 Script 节点时提示来源，或给 Script code 加「需显式确认」门槛。 | P1 |
| 7 | `apps/web/src/rete/nodes.ts:259-277` | Script 节点的 `x` 控件值不导出（只存 `code`），加载后 `x` 回到默认；ADR 已自认，但 backlog 验收写了「控件值」。 | P2 |
| 8 | `apps/web/src/rete/serialize.ts:56-66` | 边 id 未恢复：导出 `edge.id`，加载时新建 `ClassicPreset.Connection` 忽略原 id，Rete 重新生成。若后续有「按边 id 做选择/撤销」会断链。 | P2 |
| 9 | `e2e/save-load.spec.ts:44-105` | 覆盖不足：只断言节点数/连线数/version/断线后 pose 值，未覆盖位置还原、Script code、runtime 绑定、「含 Inspector 的图」（正是 P0-1 的复现路径）、非法文件不破坏画布、空图。 | P2 |
| 10 | `README.md`、`docs/backlog.md` | 文档数字：README 写「35 条 Playwright 全绿」，实测本分支全量 **34** 条（`36 = 34 + perf 2`，perf 在 #4）；vitest 43 例属实。backlog T-030 标 ✅ 与其验收条款（绑定模式/控件值 100%）不符。 | P2 |

## 已核对无问题

- `packages/ir`：`graphIRSchema` 全对象 `.strict()`、`version: z.literal(1)`、数值 `.finite()`、`parseGraph` 一次性报全部 issue；`z.array(z.union([z.number().finite(), z.string()]))` 覆盖 double_array。
- 非法 JSON 不破坏画布：实测 `before=5 / after=5`，toast 为解析错误原文，`editor.clear()` 未执行（`parseGraph` 先于 clear）。
- 未知 `type` 静默跳过、缺端点/缺端口的边跳过，不会让整图加载失败——与注释一致。
- `editor.clear()` 走 Rete remove 管道，`area` 同步移除视图；`nodeViews` 未泄漏。
- `restoreBinding` 只在 `applyParamBinding` 存在时调用，对未知节点类型安全跳过。
- `bindingForNode` 对 Script 优先取 `code` 绑定的逻辑正确；`collectBindings` 对空 `params` 回退 registry 默认值，向后兼容历史文档。
- `e2e/m3-pose.spec.ts:73-92` 新增的 T-021 非法值用例（红框、不写 ROS、不弹 toast）实测通过，补上了 M3 评审的验收缺口。

## 门禁（a0d054c 实测）

```
corepack pnpm build                               # 0
corepack pnpm check                               # 0
pnpm -w exec vitest --run apps/web/src packages/ir # 7 files / 43 passed
playwright: m3-pose + save-load + m4-runtime-binding + 3 条动态探针 # 13 passed
```

## 备注

- 本机全量 `playwright test` 在「用例全过」后进程不退出（450s 超时被 kill，`EXIT=124`），单文件运行可正常退出；该问题在 #3/#4 上都出现，暂记为环境/teardown 问题，不阻塞评审，但建议单独排查（疑似 demo-stack 或 webServer 子进程未被回收）。
- 建议合入顺序：本 PR → #4（#4 的 `apps/web/src/rete/editor.ts:9` 直接 import `./serialize`，base 也搭在本分支上）。

## 二轮处置（2026-11-25，lead 复核 + 真 ROS 探针）

| # | 处置 | 证据 |
|---|---|---|
| 1 P0 | 已修：`registerDynamic` 跳过无控件节点（Inspector）；加载失败路径统一 `refresh()`，IR 面板不再停在旧图 | `App.tsx` `registerDynamic` 首行守卫；e2e「含 Inspector 的图：保存 → reload → 加载不崩」断言 `ros-toast` 为空 |
| 2 P0 | 已修：`loadGraph` 返回 `runtimeBindings`，加载后按 `<节点:参数>` 重新 `bind()`；未连接只登记不下发；恢复失败计数值 toast「N 个运行期绑定未恢复」 | 新增 `e2e/save-load-runtime.spec.ts`：真 rosbridge 下新增 Gain → 绑 `/rosui_demo:gain` → 存盘 → reload → 加载 → 改 2.7 → `ros2 param get` 为 2.7 |
| 3 P0 | 已修：`clear()` 前 `serializeGraph` 快照；失败用快照重建并回滚 `graph/selectedPort/lastGain`；重建再失败 toast「画布已重置，请用备份恢复」 | e2e「非法文件」两条断画布节点数不变 |
| 4 P1 | 已修：`allUnregisters` 统一收口初始 5 节点与动态节点；`clearDynamicRegistrations` 全量清理 | `App.tsx` `allUnregisters` |
| 5 P1 | 已修：下载名 `rosui-graph.rosui.json`；>8MB 拒绝；`JSON.parse` 失败给中文文案；扩展名校验仅在文件名带扩展名时生效（Playwright 临时文件无扩展名按内容校验） | `App.tsx` `handleLoadGraph` |
| 6 P1 | 已修：加载后存在非空 Script code 时 toast「已加载脚本节点，运行前请确认来源」 | `loadGraph` 返回 `scriptCodeCount` |
| 7 P2 | 不改（已知限制）：Script 只恢复 `code`，`x` 控件回默认；backlog T-030 验收已按此口径标注 | `docs/backlog.md` |
| 8 P2 | 不改：边 id 未进 IR schema，重新生成；若后续做按边选择/撤销再引入 | `packages/ir` schema 未含边 id |
| 9 P2 | 已修：`e2e/save-load.spec.ts` 5 条 + `e2e/save-load-runtime.spec.ts` 1 条（覆盖 runtime 恢复） | 全量 38 passed |
| 10 P2 | 已修：README 数字与 backlog 验收口径按实测更新 | 本分支全量 38 条（#4 perf 2 条另计） |

二轮门禁：`build` 0、`check` 0、`vitest` 43 passed、`playwright` 38 passed。

## 二轮处置（review-round2：P1-A / P2-A / P2-B）

| # | 判定 | 证据 |
|---|---|---|
| P1-A 快照回滚未恢复 runtime 绑定 | 已修：新增 `restoreGraphBindings(result)`（`apps/web/src/App.tsx`），先 `clearDynamicRegistrations()` 清残留，再 `registerDynamic()` 注册控件并显式 `bind(type, portKey, ref, valueType, id)`；成功路径与回滚路径都调用。回滚直接复用 `loadGraph(editorHandle, before)` 返回的结果（节点即重建后的实例），不再手拼绑定表。回滚成功时最终 toast 仍为「加载失败：…」，绑定失败提示只在成功路径出现；`setSelectedPort(null)` / `setLastGain(null)` / `refresh()` 与「画布已重置」兜底保留 | `e2e/save-load-rollback.spec.ts` 真 ROS 用例「中途加载失败回滚后：runtime 绑定改值仍能写进 ROS」：回滚后改控件 3.3，`ros2 param get /rosui_demo gain` 为 3.3 |
| P2-A 脚本来源提示被绑定失败覆盖 | 已修：纯函数 `loadToast(failedBindings, scriptCodeCount)`（`apps/web/src/loadToast.ts`），两者并存时合并为「N 个运行期绑定未恢复；已加载脚本节点，运行前请确认来源」，只有一个时只显示对应提示，都没有时清空 | `apps/web/src/loadToast.test.ts` 4 例覆盖四种组合；`App.tsx` 成功路径统一调用 `setLocalToast(loadToast(...))` |
| P2-B 缺「schema 合法但加载中途抛错 → 快照回滚」e2e | 已修：新增 `e2e/save-load-rollback.spec.ts`（真 ROS 栈）。走真实 `load-graph-input` 加载合法 IR，用 DEV 钩子让 `editor.addConnection` 抛一次错。一次性探针实测：抛错瞬间画布只剩新图 2 节点 `g1,t1`（证明 `clear()` 已发生），toast 为 `加载失败：probe: addConnection failed once`，最终画布 5 节点、IR version 1。正式用例断言：toast 含「加载失败」、节点数/IR 与快照一致、Inspector 面板可见不崩；真 ROS 用例另断言回滚后 runtime 改值写入 ROS | 探针输出 `{"toast":"加载失败：probe: addConnection failed once","nodeCount":5,"irVersion":true,"evidence":"{\"nodesAtThrow\":2,\"ids\":[\"g1\",\"t1\"]}"}`；`node node_modules/@playwright/test/cli.js test e2e/save-load-rollback.spec.ts` 2 passed |
