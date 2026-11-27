# M5 验收报告：AC-1..5 逐条勾稽（T-033）

- 验收对象：分支 `feat/m5-toast-acceptance`（base `a36f2ca`），对应 `docs/ROSUI-落地方案.md:45-53` 的 5 条验收口径。
- 验收方式：真 rosbridge + 真 rclpy `/rosui_demo` 参数节点（无 mock）、真 `ros2` CLI 读回、真 Playwright 浏览器、Vite dev server 5180；AC-5 用浏览器 `PerformanceObserver('longtask')` 采样，200 节点 LOD 压测用 `ROSUI_PERF=1` 旁证。
- 结论：**AC-1..5 全部通过**。AC-4 暴露的产品缺口（transport `close` 未接重连）已修，不弱化验收口径。

## 1. AC 映射表

| AC | 判定口径（方案原文） | 证据 | 结果 |
|---|---|---|---|
| AC-1 | 未连线数字端口输入 `3.5`，IR 中 `value=3.5`，`ros2 param get` 返回 `3.5` | `e2e/ac-acceptance.spec.ts:145` 同一用例：`fill('3.5')+blur()` → `expect.poll(ros2('ros2 param get /rosui_demo gain')).toMatch(/value is: 3\.5$/)` → `save-graph` 下载 JSON → `params['gain'].value === 3.5`；不读 window 内部字段 | ✅ 通过（最终门禁 12.4s；首轮 11.8s） |
| AC-2 | 连线后控件 DOM 消失、label 出现；断线后 300ms 内恢复 | `e2e/m1-controls.spec.ts:56` C2 断言 `.input-title` label 出现 + 全局仅 1 个 number 控件；`e2e/m1-controls.spec.ts:40` C2b 删连线后 `toHaveCount(2, {timeout:300})`；前后截图 `docs/artifacts/m1-connected.png`、`docs/artifacts/m1-disconnected.png`（`e2e/capture-m1.mjs`，断线后等 400ms） | ✅ 通过（e2e C2b 232ms / C2 207ms） |
| AC-3 | CLI 改参数后 1s 内画布控件值更新 | `e2e/binding.spec.ts:63` `toHaveValue('6.25', {timeout:1_000})`；`e2e/m3-pose.spec.ts:64` 两处 `toHaveValue('2', {timeout:1_000})`（原 5s/2s 均收紧到 1s，标题同步改「1 秒内」） | ✅ 通过（1.4s / 2.4s 含建栈与前置写值；断言窗口本身 1s） |
| AC-4 | 杀掉 rosbridge 再拉起，页面 5s 内自动重连且状态可见 | `e2e/ac-acceptance.spec.ts:173`：`pgrep -f rosbridge_websocket` → SIGKILL → 等 9090 断开 → `scripts/ros-up.sh` 单独拉起（保留 `/rosui_demo`）→ `MutationObserver` 记 `data-status` 轨迹，poll 要求「非 connected 后再 connected」+ `data-detail === 'connected:reconnected'` + 从 SIGKILL 起 `elapsedMs <= 5_000` → `ros2 node list` 含 `/rosui_demo`；`finally` 保证 9090 健康 | ✅ 通过（杀 bridge→页面可见重连 1539ms / 整条用例 3.5s；轨迹 `connected → disconnected → connecting → disconnected → connecting → connected`） |
| AC-5 | 100 节点拖动/缩放假死不超过 200ms | `e2e/capture-ac.mjs`：100 节点混合图 + `setZoom(0.5)` + 滚轮缩放 ×3 + 12 步画布拖动，交互前挂 `PerformanceObserver('longtask')`；产物 `docs/artifacts/ac5-100-nodes.png` + `docs/artifacts/ac5-100-nodes.json`（`{"maxLongTaskMs":0,"nodeCount":100}`）；先落盘证据，>200ms 则 throw 使脚本非 0 退出 | ✅ 通过（最长 longtask 0.0ms ≤ 200ms） |

## 2. AC-4 发现的产品缺口与修复（本轮真实反馈闭环）

`t033-ac` 写 AC-4 用例时预警：生产路径只订阅了 transport 的 `'message'`，`handleTransportClose()` 全仓只有单测显式调用，杀 rosbridge 后页面会卡在 stale `connected`；且 `onStatus('connected','reconnected')` 只写进 `statusDetail` state，DOM/console 都观测不到。没有弱化验收口径去迁就现状，而是补了三处产品代码：

1. `apps/web/src/ros/RosClient.ts:218` `subscribeParamEvents()` 增加
   `transport.on('close', () => this.handleTransportClose(generation));`（`:229`）。
   核实依据：roslib 2.1.0 的 `WsWebSocketTransport-6-v9C0gj.js:25-32` 与
   `NativeWebSocketTransport-CF_ebnyS.js:24-31` 都在 `socket.onclose` 里 `emit("close", e)`。
   `scheduleReconnect` 的 `intentionalClose || failedGeneration !== this.generation || retryTimer` 三重守卫保证主动 `close()` 不误重连。
2. `apps/web/src/App.tsx:389` 把 `binding.statusDetail` 暴露成 `data-detail="${status}:${detail}"`，
   让 `connected:reconnected` 从「只在单测里」变成页面可观测状态；AC-4 因此能真实断言重连原因，而不是只断言 `data-status` 轨迹。
3. `apps/web/src/ros/RosClient.test.ts:242` 新增单测
   `transport 的 close 事件走标准重连；主动 close 与旧代际事件不误重连`：锁住 close→disconnected→connected、
   旧代际 close 丢弃、主动 close 后末状态 `disconnected:closed`，并验证断线瞬间待回包调用立即以
   `RosClient 连接断开` 拒绝而非挂到 5s 超时。
4. `apps/web/src/ros/RosClient.ts:121` 抽出 `rejectPendingCalls(message: string): void`，
   供 `close()` 与 `handleTransportClose()` 共用；`:193` `waitForOpen` 在 open/error 后清理连接超时 timer。

AC-4 e2e 不用裸 `toHaveAttribute('connected')`（stale connected 会假通过）；`scripts/demo-stack.sh` 的 cleanup 会杀全部 PIDS，因此只按进程组杀 rosbridge 本体、不整栈 teardown，并在 `finally` 补拉 9090。全量运行中的 flake 根因是 `findBridgePids()` 只按 `rosbridge_websocket` 命中 launch/websocket，遗留了孤儿 `rosapi`，第二次运行出现重复 `/rosapi` 抢答 `rosapi/set_param`。`e2e/demo-stack.ts:10` 的 `DetachedGroup` 记录 detached 进程组 leader 的 PID + `/proc/<pid>/stat` starttime，`killDetachedGroup()` 整组回收且防止 PID 复用误杀；`e2e/ac-acceptance.spec.ts:19` 用 `Set<DetachedGroup>` 登记所有 `startBridge()`，`finally` 先回收本次替换 bridge，`afterAll` 再兜底回收 fallback bridge。实测全量 e2e 后 `ROS procs: none`、`5180/9090: closed`。

与方案原文的一处口径说明：AC-4 的「录屏」以 `MutationObserver` 状态轨迹日志（e2e console）+ 可断言的 `data-status`/`data-detail` 取代，AC-2 的「前后截图」落地为两张 PNG；两者都保留了「状态可见」的可复核性，但没有产出 mp4 录屏。AC-5 的「Performance 面板截图」以脚本化的 `PerformanceObserver('longtask')` 采样 + 100 节点截图 + JSON 数值取代（自动可复跑，比手工面板截图更可回归）。

## 3. T-033 的 toast 统一（附属于本轮）

`apps/web/src/toast.ts` 新增纯函数 `formatFailure({kind, param, reason})`，`FailureKind = 'connect'|'load'|'bind'|'write'|'type'|'validate'`，前缀 连接失败/加载失败/绑定失败/写入被拒/类型不匹配/参数错误；`App.tsx` 的 10 处 `setLocalToast` 全走 `pushToast`，`ParamBrowser.onTypeReject(reason, param?)` 补参数名，`useParamBinding` 三处 `onError` 统一带 `${nodeType}.${portKey}`。保留 `binding.toast || localToast`、`data-testid="ros-toast"`、`role="alert"`、8s 自动清 timer；内联 `control-error`/`script-error`/`param-error` 不合并、不新增连接/断开 toast。四条既有 e2e 子串断言（`加载失败`、`文件不是合法 JSON`、`加载失败：rollback probe: addConnection failed once`、`不接受 string`）逐字保留且全量回归通过。

## 4. 门禁记录（本分支）

| 命令 | 结果 |
|---|---|
| `corepack pnpm build` | `BUILD_EXIT=0`，`dist/assets/index-*.js` 458.57 kB（gzip 136.74 kB） |
| `corepack pnpm check` | `CHECK_EXIT=0`（web tsc + ir tsc + IR vitest），`git diff --check` 亦为 0 |
| `corepack pnpm -w exec vitest --run apps/web/src packages/ir` | 9 files / **52 passed**（含 `RosClient.test.ts` 9、`toast.test.ts` 4、`useParamBinding.test.ts` 12） |
| `node node_modules/@playwright/test/cli.js test` | **48 tests, 46 passed + 2 skipped, `E2E_EXIT=0`** (2.3m)，AC-1 12.4s / AC-4 3.5s；e2e 后 ROS 进程/端口均干净 |
| `node e2e/capture-ac.mjs`（5180 dev server） | `AC5_EXIT=0`，`maxLongTaskMs=0`、`nodeCount=100`；>200ms 会先落盘证据再非 0 退出 |
| `ROSUI_PERF=1 node node_modules/@playwright/test/cli.js test e2e/perf.spec.ts` | 2 passed；最终门禁 full 首帧 756.2ms / placeholder 341.0ms（0.45×），拖动均 0.0125ms 每步 |

`ROSUI_PERF=1` 首跑曾失败在 `e2e/perf.spec.ts:123`：`Expected: <= 0.015`、`Received: 0.015000000037252903`。原因是 `dragAvgMs` = 一批 40 次 `area.translate` 耗时 / 40，`0.6/40` 与 `(0.5/40)*1.2` 在 IEEE754 下相差 3.7e-11，纯浮点舍入而非性能退化。已在断言加 `+1e-6` 绝对容差（=40ns/批，只吸收舍入，不放宽「占位反而慢 20% 以上」的判定）后复跑通过。

## 5. 已知限制（不在 T-033 范围）

- `lod.ts` 为模块单例；`ScriptNode` 加载只恢复 `code` 不恢复 `x`；边 id 加载后由 Rete 重新生成。三者均为 M5 save/load 评审已记录的限制，T-032 的 `restoreSnapshot` 会复用同一 `loadGraph()` 路径，需一并知悉。
- `ros-status` 只暴露当前状态与 detail，不保留完整历史轨迹（轨迹由 e2e 的 `MutationObserver` 记录）。
- AC-5 的 `maxLongTaskMs=0` 表示采样窗口内没有 >50ms 的 longtask 条目，是「无长任务」而非「0ms 工作量」；200 节点首帧指标见 `docs/reviews/M5-perf.md`。
