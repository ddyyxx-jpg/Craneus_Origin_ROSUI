# T-032 撤销/重做 + 复制粘贴验收报告

> 分支：`feat/m5-undo-copy-paste`（从 T-033 `9b4b844` 切出）｜范围：M5 最后一个 backlog 任务。

## 1. 实现边界

- 快照单位是 `serializeGraph()` 产出的 `GraphIR v1`，不是 command log；`apps/web/src/rete/history.ts` 的 `pushSnapshot` 每次 `structuredClone`，`undo`/`redo` 栈深均为 `HISTORY_LIMIT = 100`。
- 初始图（5 节点 + 1 连线）建成后先入栈一条基线；栈顶始终代表当前状态。`undo()` 恢复到栈顶下方快照并把当前快照移入 `redo`，`redo()` 反向移动。
- 自动提交边界：Rete `nodecreated/noderemoved/connectioncreated/connectionremoved/cleared`、`nodedragged`（拖动结束）、控件合法提交、Script 失焦/Ctrl+Enter 执行完成、绑定成功/解绑、文件加载成功、粘贴完成。`scheduleGraphCommit()` 用 80ms 合并 + `JSON.stringify` 去重，避免逐帧或重复事件入栈。自动 commit 只更新 ref 历史栈，不 `setGraph()`：200 节点批量建图时 `CurrentIR` 对整图 `JSON.stringify` 的 React 重渲染会把 LOD placeholder 首帧从约 320ms 拖到约 2.5s；IR 面板仍由用户改值、程序写值、加载/恢复路径显式刷新。
- 控件只在 `commitText`/`commitField`/Select/Boolean 的合法改值回调里经 `createControlAdapter` → `handleUserChange` 提交；仅 `fill()` 不 blur 不入栈。
- 快捷键：`Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`、`Ctrl/Cmd+Y`、`Ctrl/Cmd+C`、`Ctrl/Cmd+V`。`isEditableTarget()` 跳过 `input/textarea/select/contenteditable/[data-testid^="pose-"]`；LOD 既有「点空白画布清选中」语义保持不变。
- undo/redo/粘贴共用 `restoreGraphSilently()`：`clearDynamicRegistrations()` → `loadGraph()` → `restoreGraphBindings()`（先清全局 `RUNTIME_BINDINGS`，再注册控件并重绑 IR 里的 runtime 引用）→ 清选中/端口/读数/`localToast`/`binding.toast`/刷新 IR；整个过程 `restoringRef` 抑制自动入栈与用户改值回灌，且不生成成功 toast。异步动作经 `historyQueueRef` 串行化，`enqueueHistoryAction()` 先定稿 80ms 内 pending commit 再执行，undo/redo 仅在恢复成功后推进栈。
- 复制粘贴：`createClipboard()` 深拷贝选中节点与两端都在集合内的边，把所有参数绑定统一为 `mode:'static'`，保留 `value/valueType/widget/constraints`；`pasteGraph()` 用 `getUID()` 生成新节点/边 id，位置 `+40/+40`，端点重映射，并把 `binding.node`/`binding.param` 重映射到新节点自身，绝不复制 ROS 运行期目标。粘贴后 `setSelectedNodeIds(newIds)` 并强制入栈。

## 2. 验收用例

| 用例 | 文件 | 关键断言 |
|---|---|---|
| 节点增删撤销/重做 | `e2e/undo-copy-paste.spec.ts:73` | 初始 `{undo:1,redo:0}`；`add-gain` 后 6 节点，不等 debounce 立刻 `Ctrl+Z` 回 5/1 + `{undo:1,redo:1}`；`Ctrl+Y` 回 6/1；无 toast |
| 控件提交边界 | `e2e/undo-copy-paste.spec.ts:92` | `fill('4.2')` 不 blur 不入栈；blur 后一次提交且 IR `gain=4.2`；undo 回 `1` 并产生 `redo=1`；redo 回 `4.2` |
| 多选复制粘贴 | `e2e/undo-copy-paste.spec.ts:145` | 真实点选 Gain + Ctrl 点选 Threshold；复制不入栈；粘贴后 7 节点/2 边、`+40/+40`、新 id、静态绑定 `node===copy.id`、内部边端点重映射、选中集合等于新 id；undo/redo 往返；无 toast |
| 栈深 / 输入焦点旁路 | `e2e/undo-copy-paste.spec.ts:231` | DEV `commitHistory()` 连续 120 次后 `{undo:100,redo:0}`；输入框聚焦时三种撤销/重做快捷键都不动历史；blur 后 `Ctrl+Z` 生效 |

配套纯函数单测：`apps/web/src/rete/history.test.ts`（9 例）覆盖 100 栈深、redo 清空/封顶、undo/redo 往返、边界不变、输入不被修改、runtime→static、新 id/偏移/边重映射、静态绑定 node 重映射、自定义 offset。

独立只读复核 `t032-review` 两轮结论均为「未发现阻塞合并的 P0/P1」。首轮 3 条 P2（pending 80ms commit、恢复失败仍推进栈、静默恢复残留 `binding.toast`）已修并二次复核确认；二次复核剩余 3 条低风险 P2：中途 `loadGraph()` 失败画布可能部分重建、`Ctrl+C` 未入串行队列、快速 undo/redo 用例未锁新增节点 position。

## 3. 门禁

| 命令 | 结果 |
|---|---|
| `corepack pnpm build` | `BUILD_EXIT=0`，`dist/assets/index-*.js` 465.11 kB（gzip 138.64 kB） |
| `corepack pnpm check` | `CHECK_EXIT=0`（web tsc + ir tsc + IR vitest 5/5） |
| `corepack pnpm -w exec vitest --run apps/web/src packages/ir` | 10 files / **61 passed**（新增 `history.test.ts` 9 例） |
| focused `node ... test e2e/undo-copy-paste.spec.ts` | **4 passed (13.4s)**，覆盖 P2 修补后的 pending commit 窗口 |
| `node node_modules/@playwright/test/cli.js test` | **52 tests, 50 passed + 2 skipped, `E2E_EXIT=0`** (2.2m)；e2e 后 ROS 进程/端口均干净 |
| `node e2e/capture-m1.mjs` / `node e2e/capture-ac.mjs` | M1 两张截图与 AC-5 100 节点证据重生成，见第 5 节最终实测 |
| `ROSUI_PERF=1 node ... test e2e/perf.spec.ts` | 200 节点 LOD 压测 2 passed；最终 full 745.5ms / placeholder 326.8ms，见第 5 节 |
| `git diff --check` | `DIFF_CHECK_EXIT=0` |

## 4. 已知限制（沿用 M5 既有范围）

- 快照恢复仍受 `loadGraph()` 已记录限制约束：边 id 不恢复（Rete 重建生成）、`ScriptNode` 保存/恢复 `code` 但不恢复 `x` 输入值；本任务不改 GraphIR schema，也不做 command pattern/localStorage。
- LOD 的 `lod.ts` 单例与低缩放占位尺寸缓存沿用 T-031 实现；T-032 只把选中态从单值扩成 `Set<string>`，未破坏 `e2e/lod.spec.ts` 的单节点高亮/空白清选中断言。
- DEV-only `window.__rosui` 新增 `commitHistory/getHistoryState` 等验收入口，仅用于 e2e；生产构建不挂 API。
- 二次复核记录的 3 条低风险 P2 不阻塞合并：内部快照已经过 `parseGraph` 校验；`Ctrl+C` 与异步恢复极限连按未覆盖；快速 undo/redo 用例只锁节点/边数量，未锁新增节点 position。

## 5. 性能回归定位与收尾门禁

- **问题**：T-032 集成后 `e2e/perf.spec.ts` 的 200 节点 LOD 首帧断言稳定失败：`full` 约 0.73–0.96s、`placeholder` 约 2.5–2.7s，而基线 `9b4b844` 为 `full 759.5ms / placeholder 322.7ms`。连续两次从干净环境（Playwright 自管 dev server）复跑均失败，排除一次性冷启动/前置 `capture-ac.mjs` 扰动。
- **二分**：基线 worktree 分别套用 `editor.ts` 与 App 侧补丁，确认 `editor.ts` 的 Set 多选/渲染改动单独 2 passed（745.6/323.3ms），App.tsx + `history.ts`/`nodeRenderers.tsx`/`useParamBinding.ts` 单独失败（737.7/2481.7ms）。进一步三组变体验证：仅删 `commitGraphIfChanged()` 末尾 `refresh();` 即恢复 2 passed（742.5/312.3ms）；删自动 pipes 也恢复；两者都删亦恢复。根因是 200 节点/149 连线批量添加时 80ms 自动提交触发 `setGraph()` → `CurrentIR` 对整张 GraphIR `JSON.stringify(graph, null, 2)`，使 placeholder 相对 full 的首帧比从 ~0.43 恶化到 ~3.4。
- **修复**：保留 T-032 自动提交与快捷键语义，只让 `commitGraphIfChanged()` 更新 ref 历史栈，不再 `setGraph()`；IR 面板继续由用户改值 `onValue`、程序写值 `setValue`、加载成功与 `restoreGraphSilently()` 显式刷新。`apps/web/src/rete/editor.ts` 另把 render 热路径的选中标记从全图扫描改成 O(1) 单节点标记，避免批量建图 O(n²)；全图扫描保留给显式改选中集合/缩放切换。
- **最小回归**：`CHECK_EXIT=0`；`VITEST_EXIT=0`（10 files / 61 passed）；`ROSUI_PERF=1` 2 passed（full 749.2ms / placeholder 318.1ms，dragAvg 0.015/0.010）；focused `e2e/undo-copy-paste.spec.ts + e2e/controls.spec.ts + e2e/lod.spec.ts` 17 passed（含 `current-ir` 控件断言、T-032 4 例与 LOD 选中态）；`git diff --check` 0；进程/端口均干净。
- **最终全量门禁**（`/tmp/rosui-t032-finalgate.summary`）：`BUILD_EXIT=0`、`CHECK_EXIT=0`、`VITEST_EXIT=0`（61 例）、`VITE_READY_EXIT=0`、`SHOTS_EXIT=0`、`AC5_EXIT=0`（`docs/artifacts/ac5-100-nodes.json` = `{"maxLongTaskMs":0,"nodeCount":100}`）、全量 `E2E_EXIT=0`（52 tests / 50 passed + 2 skipped，2.1m；AC-4 1544ms 完成 `connected → disconnected → connecting → disconnected → connecting → connected`）、`PERF_EXIT=0`（full 745.5ms / placeholder 326.8ms，2 passed）、`DIFF_CHECK_EXIT=0`、最终进程/端口均干净。父脚本被 harness SIGKILL 后 e2e 作为孤儿完成，收尾 perf/diff 在同一工作树补跑并把汇总拼接完整；所有日志路径为 `/tmp/rosui-t032-finalgate-*.log`。
