# M5 评审复核（第二轮）

## 评审对象

| PR | 分支 | 修复提交 | 上一轮评审 |
| --- | --- | --- | --- |
| #3 M5 保存/加载 | `feat/m5-save-load` → `main` | `7922891` | `docs/reviews/M5-save-load.md`（request-changes） |
| #4 M5 LOD/压测 | `feat/m5-lod-perf` → `feat/m5-save-load`（栈式） | `b5dd9a0` | `docs/reviews/M5-lod.md`（request-changes） |

## 评审方式

- 静态：逐条对照上一轮 15 条问题读修复 diff（`a0d054c..7922891`、`d543650..b5dd9a0`），并由独立只读子代理交叉复核。
- 动态：真 ROS2 Jazzy 栈全量 Playwright（`41 passed / 2 skipped / 0 failed`，perf 默认跳过）、`ROSUI_PERF=1` 单跑压测、独立浏览器探针量 socket 几何/新增节点尺寸/真实点击选中态/Script 提示/扩展名拒绝。
- 门禁：两个 head 分别 `corepack pnpm build`（0）、`corepack pnpm check`（0）。

## 结论

两个 PR 的 P0 均已真实闭环（非 try/catch 吞异常、非仅挪 clear 顺序），可以合并；剩余问题不阻塞，但建议合并前一并处理 P1-A 与 P1-B。

## #3 复核结果

| # | 上一轮问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | P0 含 Inspector 的图加载必崩 | **已修** | `apps/web/src/App.tsx:155-156` 无控件节点前置返回，不是异常吞噬；`e2e/save-load.spec.ts:129` 加载后节点数一致、无 toast |
| 2 | P0 runtime 绑定加载后不写 ROS | **已修** | `apps/web/src/rete/serialize.ts:83-94,154-158` 返回 `runtimeBindings`；`apps/web/src/App.tsx:219-227` 逐条 `bind()`；真栈验证：加载后控件改 2.7 → `ros2 param get /rosui_demo gain` = 2.7（`e2e/save-load-runtime.spec.ts:28`，4.1s 通过；在 #3 head 与 #4 head 各跑一次） |
| 3 | P0 加载无事务性 | **基本修复** | `serialize.ts:129-140` clear 前预建节点并查重 id；`App.tsx:207,239-257` 快照 + 回灌。残留见 P1-A、P2-B |
| 4 | P1 初始 5 节点不清理 / +Inspector 不注册 | **已修** | `App.tsx:105-129` 统一 `allUnregisters`，`:184-187` 加载前清空；Inspector 无 `control`（`rete/nodes.ts:183`），不注册是正确行为 |
| 5 | P1 文件名/大小/扩展名 | **已修** | `App.tsx:196` 下载名 `rosui-graph.rosui.json`；`:273-289` 扩展名 + 8MB + 非 JSON 分别报错；实测 `.txt` 被拒、节点数不变 |
| 6 | P1 不可信 Script code | **部分修** | `serialize.ts:160-162` 统计、`App.tsx:234-235` 提示「已加载脚本节点，运行前请确认来源」（实测复现）；无显式确认门槛，且被 `failedBindings` 提示抢占（P2-A） |
| 7 | P2 Script `x` 值不导出 | **未修（记为已知限制）** | `rete/nodes.ts:259-277` 仍只存取 `code`；探针实测加载后 `x` 回到默认 1 |
| 8 | P2 边 id 不恢复 | **未修（可接受）** | `serialize.ts:167-174` 仍新建 Connection；Rete 重新分配 id，不影响渲染/绑定 |
| 9 | P2 e2e 覆盖不足 | **部分修** | 新增 Inspector / 运行时 / 非法文件 / 空图四例；仍缺位置还原、Script code、中途失败回滚 |
| 10 | P2 README 条数不符 | **已修** | `README.md:5,39` 更新为实际条数 |

## #4 复核结果

| # | 上一轮问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | P1 占位 socket 几何失真（≈88px 横移） | **已修** | 独立探针（k=1 → k=0.2）：full `dx=178/2, dy=57/93, w=36`，placeholder 完全相同，差值 `ddx=0.0, ddy=0.0, dw=0.0`；`styles.css:312-325` 的 −18px 与 plugin `$socketsize=24`/`$socketmargin=6` 一致；`e2e/lod.spec.ts:5` 断言 ≤2px |
| 2 | P1 占位无选中态 | **已修（但 UI 不可达）** | `LodNode.tsx:47,52,56` + `styles.css:303-305` 与 classic 一致；但实测 full 与 placeholder 下真实点击都不产生 `node.selected`（本应用只做端口选中），新 e2e 直接写 `node.selected` 再 `area.update`，测的是渲染分支而非用户可达路径 → P2-C |
| 3 | P1 无 hysteresis | **已修** | `lod.ts:4,6,40-52` 双阈值 0.32/0.38；`e2e/lod.spec.ts:68` 覆盖 0.35/0.3/0.39/0.32 序列 |
| 4 | P1 生产路径不采样尺寸 | **部分修** | `editor.ts:109-118` 在 `render`/`noderesized` 管道采样，生产 `addNode`/加载均覆盖；但 placeholder 模式下采样到的是占位尺寸本身（`LodNode.tsx:46` `placeholderSize ?? FALLBACK_SIZE`），见 P1-B |
| 5 | P1 perf 断言测不出退化 | **已修（方向正确）** | `e2e/perf.spec.ts:112-113` 改为同次运行对比：实测 full firstFrame 746ms vs placeholder 383.6ms（0.51 < 0.85 ✓）、drag 16.09 vs 16.15ms；拖动仍受 vsync 限制（P2-D） |
| 6 | P1 压测只加 gain、无边、走钩子 | **已修** | 实测 `connectionCount=149`、`kinds=["Gain","Pose","Inspector","Script"]`，`editor.ts:130-159` 走生产 `addNode` |
| 7 | P1 栈式依赖未写明 | **已修** | `docs/adr/ADR-008-lod.md:35-39` 明确先合 #3 |
| 8 | P2 截图写脏跟踪文件 / perf 进默认门禁 / socket 无 testid | **已修** | `e2e/perf.spec.ts:8` `ROSUI_PERF=1` 才跑；`:116` 只写 `testInfo.outputPath`；`LodNode.tsx:71,86` 补 `data-testid` |
| 9 | P2 模块级单例 | **未修（已记录）** | `lod.ts:11-14` 仍模块级；ADR-008:30-33 记为已知限制 |

## 本轮新发现

### P1-A 回滚路径不恢复 runtime 绑定（#3）

`apps/web/src/App.tsx:239-257` 的 catch 回灌只 `loadGraph(before)` + `registerDynamic()`，不像成功路径 `:219-227` 那样消费 `runtimeBindings` 调 `bind()`。快照里的 runtime 元数据仍写回 `restoredBinding`，IR 显示 `"mode": "runtime"`，但订阅未重建 → 回滚后图表看起来正常、改值不写 ROS。触发条件：schema 合法但加载中途抛错（目前只有重复节点 id 会被前置拦截，故概率低）。

### P1-B 低缩放下新增节点的占位尺寸仍是 fallback（#4）

占位模式下 `render` 管道采样的是占位节点自身 `offsetWidth/Height`，来源是 `FALLBACK_SIZE`。独立探针：k=0.2 下点 `+ Pose` 新建节点渲染为 180×119，切回 k=1 后同一节点为 180×144（Pose 真实高度）→ 低缩放期间该节点端口位置与真实 full 尺寸不一致（高度差 25px），进 full 时再回正。属于上一轮问题 4 的核心场景未真正闭环。

### P2

- A：`App.tsx:232-235` `failedBindings > 0` 时 Script 来源提示被 else-if 覆盖。
- B：缺「schema 合法、中途失败 → 快照回滚」的自动化用例；回滚分支未被任何 e2e 覆盖。
- C：`e2e/lod.spec.ts:98` 通过直接置 `node.selected` 制造选中态；真实点击（full 与 placeholder 都）不会选中节点，该样式实际不可达，测试与 UX 脱节。
- D：perf 拖动成本仍用相邻 rAF 时间戳，vsync 锁 16ms，1.2× 阈值只能抓严重退化。
- E：全量 e2e 全部用例通过后进程不退出（`EXIT=124`，修复前同样存在），CI 不能依赖退出码，需 timeout 包装或修 webServer/demo-stack 回收。

## 已核对无问题

- 快照 `serializeGraph` 在 clear 前执行，未修改画布状态。
- `parseParamRef` 对 `/ns/node:param` 的拆分与 M4 运行时编码一致；`string_array` 被显式判为不兼容而非误绑。
- 双阈值下 `notify()` 只在真正跨阈值时触发，不会每帧 setState。
- 占位节点保留 `RefSocket`，未卸载 Rete NodeView，socket 唯一性未破。
- 回灌失败时给出兜底提示并 `setGraph(null)`，不会静默留半截图。

## 门禁实测

| 项 | 结果 |
| --- | --- |
| `7922891` build / check | 0 / 0 |
| `b5dd9a0` build / check | 0 / 0 |
| 全量 Playwright（`b5dd9a0`） | 41 passed / 2 skipped（perf 默认跳过）/ 0 failed；进程退出挂起 EXIT=124 |
| `#3` 保存/加载 6 例（`7922891`） | 全绿，含真 ROS 写回 4.1s |
| `ROSUI_PERF=1`（`b5dd9a0`） | 2 passed；full 746/16.09，placeholder 383.6/16.15 |
| 独立几何探针 | full↔placeholder socket `ddx=0.0, ddy=0.0, dw=0.0` |

## 二轮处置（2026-11-27，用户「看review修，然后继续」）

结论：**P1-A / P1-B / P2-A..E 共 7 项全部修复**，两个 PR 均可合并；下列修复已分别提交到 `feat/m5-save-load`（#3）与 `feat/m5-lod-perf`（#4），逐条证据与复核门禁如下。

| 项 | PR | 处置 | 证据 |
| --- | --- | --- | --- |
| P1-A 回滚路径不恢复 runtime 绑定 | #3 | 新增 `restoreGraphBindings(result: LoadGraphResult)`（`apps/web/src/App.tsx`）：`clearDynamicRegistrations()` → 逐节点 `registerDynamic()` → 逐条 `bind(type, portKey, ref, valueType, id)`。成功路径与 catch 回滚路径**共用同一函数**；回滚直接消费 `loadGraph(editorHandle, before)` 返回的 `runtimeBindings`（指向重建节点），不再手拼绑定表。回滚成功时最终 toast 仍为「加载失败：…」，绑定失败提示只在成功路径出现 | `e2e/save-load-rollback.spec.ts` 真 ROS 用例：回滚后改 Gain 控件 3.3 → `ros2 param get /rosui_demo gain` = 3.3 |
| P1-B 低缩放新增节点占位尺寸是 fallback | #4 | `editor.ts` 的 `sampleNode` 开头 `if (getLod() !== 'full') return;`，placeholder 不再把自身 `offsetWidth/Height` 回写尺寸缓存；`LodNode.tsx` 新增 `TYPE_SIZES` 按节点类型兜底（一次性 DOM 探针实测：Gain/Threshold/Label/Mode/Switch 180×119、Pose 180×144、Inspector 180×71、Script 252×273） | 修前 k=0.2 新建 Pose 180×119 → 回 k=1 180×144（差 25px）；修后占位即 180×144、切回差 0px；`e2e/lod.spec.ts` 固化「占位高度与 full 差 ≤2px、切回不跳变」 |
| P2-A Script 来源提示被绑定失败覆盖 | #3 | 纯函数 `loadToast(failedBindings, scriptCodeCount)`（`apps/web/src/loadToast.ts`）合并两条提示为一个字符串；四种组合由 `apps/web/src/loadToast.test.ts` 4 例覆盖 | 「N 个运行期绑定未恢复；已加载脚本节点，运行前请确认来源」同时出现，不再 else-if 互相吞 |
| P2-B 缺「schema 合法但中途抛错 → 快照回滚」e2e | #3 | 新增 `e2e/save-load-rollback.spec.ts`（真 ROS 栈、DEV-only `window.__rosui` 钩子让 `editor.addConnection` 抛一次错，不 mock `loadGraph`）。曾尝试「未知 targetPort 的边」触发失败，但 `serialize.ts` 会跳过缺端口边不抛错，故改注入式故障 | 一次性探针：抛错瞬间画布只剩新图 2 节点 `g1,t1`（证明 `clear()` 已发生）、toast `加载失败：rollback probe: addConnection failed once`、最终 5 节点且 IR version 1；正式 2 例断言节点数/IR 完全一致、Inspector 可见、回滚后真 ROS 写回 |
| P2-C 选中态测试与 UX 脱节 | #4 | `editor.ts` 新增 `markSelectedNode`：`nodepicked` 管道给 `[data-testid="node"]`/`.node-shell` 写 `selected` + `data-selected` 并清其它节点，空白 `pointerdown` 清除，LOD 切换 rAF 重放；不读写 `node.selected`、不调 `area.update`（会冲掉 DOM 标记）；`App.tsx` 的 `selectedPort` 绑定逻辑不动 | `e2e/lod.spec.ts` 改真实点击标题 → full/placeholder 黄色高亮 `rgb(255, 217, 44)` → 点空白取消，全部通过 |
| P2-D perf 拖动指标被 vsync 锁死 | #4 | `e2e/perf.spec.ts` 用 `performance.now()` 包住 7 批 × 40 次 `area.translate` 的同步主线程工作量（含 nodetranslated 连线/socket 重算），取 7 批中位数 ÷ 40 记为 ms/次；rAF 只用于批间让出、不计入；保留 `placeholder ≤ full × 1.2`。首版单次口径因 `performance.now()` 量化误差失败（full 0.0833 vs placeholder 0.1167ms）→ 改批测稳定 | `ROSUI_PERF=1` 2 passed：full 首帧 748.9ms / 拖动 0.0175ms·次⁻¹，placeholder 330.7ms / 0.0125ms·次⁻¹（首帧 44.2%、拖动 71.4%） |
| P2-E 全量 e2e 进程不退出 | #3 + #4 | 根因：Playwright 1.56.0 `processLauncher.js` 以 `detached:true`+`shell:true` 启 webServer，teardown `process.kill(-spawnedProcess.pid, 'SIGKILL')`；旧 `corepack pnpm dev` 派生 `sh -c vite`，实测 shell PGID 85811 而 vite 在 PGID 85986，`kill(-85811)` 只杀中间 shell，vite 存活持有 stdio → 全绿后 `EXIT=124`。修法回合进 #3（base 分支）并随 merge 带入 #4：`playwright.config.ts` webServer 改 `cd apps/web && exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5180 --strictPort`（必须 `cd apps/web`，否则 Vite root=cwd 404），`reuseExistingServer: true` 不变；`e2e/demo-stack.ts` 无 diff | #3 全量 e2e `40 passed`、#4 全量 `42 passed + 2 skipped`，均**无外层 timeout 自然 EXIT=0**，5180/9090 无残留进程 |

### 复核门禁（各分支修复完成后）

| 门禁 | #3 `feat/m5-save-load` | #4 `r2-lod-fix`（修复分支） |
| --- | --- | --- |
| `corepack pnpm build` | 0（`✓ built in 1.04s`） | 0（`dist/index.js 457.90kB`） |
| `corepack pnpm check` | 0（IR 5 passed） | 0 |
| 全量 vitest | 8 files / 47 passed（新增 `loadToast` 4 例） | 7 files / 43 passed |
| 全量 Playwright | **40 passed / EXIT=0**（2.1m） | **42 passed + 2 skipped / EXIT=0**（1.9m）；合入 #3 后复跑 **44 passed + 2 skipped / EXIT=0**（2.0m） |
| `ROSUI_PERF=1 e2e/perf.spec.ts` | 本分支无 perf spec | 2 passed（12.7s）；整合后复跑 2 passed（12.8s），full 首帧 740.9ms / 拖动 0.015ms·次⁻¹，placeholder 298.9ms / 0.0125ms·次⁻¹ |

合并后门禁（2026-11-27，`feat/m5-lod-perf` 合入 `feat/m5-save-load` 后）：`build` 0（`✓ built in 1.05s`，dist/index 457.96kB）、`check` 0、全量 vitest 8 files / 47 passed、全量 Playwright 44 passed + 2 skipped / EXIT=0、`ROSUI_PERF=1` 2 passed / EXIT=0。两条 PR 分支已推送：`feat/m5-save-load`=`36dcf80`、`feat/m5-lod-perf`=`5f066ff`。

说明：#3 指定 e2e 首跑曾出现一次 `ros2 param get` 回读 0.75 的时序 flake，单跑与整体重跑均 6 passed；lead 独立全量复跑 40 passed 无 flake。P2-B 属 DEV-only 注入式故障（不 mock `loadGraph`、不依赖 zod 失败路径），因为现有实现里 schema 合法后唯一自然抛错点是重复 id 前置拦截；真 ROS 写回断言已落地。

### 仍为已知限制（不阻塞合并）

- `apps/web/src/rete/lod.ts` 仍是模块级单例，不支持多 editor 实例；ADR-008 记未来改 `WeakMap<AreaPlugin, Store>`。
- perf 单次 `area.translate` ~0.02ms 接近 `performance.now()` 量化下限，靠 7×40 批测量摊薄，跨机器复现保留 1.2 倍余量。
- `apps/web/src/rete/nodes.ts` 的 `ScriptNode.applyParamBinding` 只恢复 `code` 不恢复 `x`；`serialize.ts` 不恢复边 id（二轮未扩大范围）。
- `vendor/prefix` 为 gitignored 的本地 rosbridge 运行时，隔离 worktree 靠 `cp -al` 硬链补齐；5180/9090 共用，全量验证须串行。
