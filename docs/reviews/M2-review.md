# M2 评审：画布控件 ↔ ROS 2 参数双向绑定

- 评审对象：`cfd2c6c` 之后的绑定层改动（`apps/web/src/binding/**`、`App.tsx`、`NumberControl`、`e2e/binding.spec.ts`）
- 评审方式：独立 reviewer 子代理只读审查 + lead 复核修复 + 全量门禁
- 结论：**request-changes → 修完 PASS**

## 首轮 verdict: FAIL

| # | 位置 | 问题 | 处置 |
|---|---|---|---|
| 1 | `apps/web/src/App.tsx:51` | `handleUserChange` 依赖整个 `binding` 对象；status/toast 一变就重建画布、旧订阅泄漏 | **已修**：改为只依赖稳定的 `onControlChange`；effect cleanup 调 `unregister()` |
| 2 | `apps/web/src/binding/useParamBinding.ts:194` | `activateEntry` 先置 `active=true`，迟到的 `getParam` 会覆盖 connect 期间的用户输入 | **已修**：加 `activateToken` + 请求时 `writeSeq` 快照，迟到结果直接丢弃 |
| 3 | `apps/web/src/binding/useParamBinding.ts:134` | 并发 `setParam` 无序号，旧失败回滚会覆盖新输入 | **已修**：每次写值 `++writeSeq`，结果只在 `writeSeq` 仍是最新时生效 |
| 4 | `apps/web/src/binding/useParamBinding.ts:109` | 同 key 重注册直接覆盖 entry，旧订阅泄漏 | **已修**：`set` 前 `disposeEntry(previous)`；补单测断 `listenerCount === 1` |
| 5 | `e2e/binding.spec.ts:42,60` | `toContain('3.5')` 会被 `13.5` 蒙混 | **已修**：改 `/value is: 3\.5$/` 精确匹配 |

## 建议项（未阻塞，已记录）

1. `echoUntil` 目前与 `sameValue` 短路叠加，实际效果是「同值永久忽略」；窗口语义单测再补一条更严格的。
2. `warmupUntil` 的 300ms 会丢掉窗口内所有事件（含外部真改）；更稳的做法是「只丢第一帧 + 用 getParam 结果校验」，M3 处理。
3. `e2e/binding.spec.ts:65` 外部改值紧接 connect，靠 CLI 调用 >300ms 才稳，属于时间耦合型易 flaky 用例。
4. 只测了 double/bool 的部分路径，string（Mode）与 double_array（Pose）未覆盖；`controlAdapter` 把 object 值一律过滤，数组回灌要等 M3。

## 已核对无问题

事件按 `<node>:<param>` 过滤、类型不匹配拒绝、离线可编辑语义、`dispose` 全量清理、`WeakSet` 程序写值标志有 `try/finally` 不会泄漏、无 StrictMode 双挂载问题、int→double 编码、bool/string 控件适配。

## 门禁（修复后实测）

```
corepack pnpm build            # 0
corepack pnpm check            # 0（IR 5 例）
vitest apps/web/src            # 19 passed（含新增 2 条竞态用例）
playwright test                # 18 passed（13 UI + 5 真 ROS 集成）
```
