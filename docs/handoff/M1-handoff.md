# 交接块 · M1 骨架（2026-11-24 21:20）

## 一句话状态

编辑器能跑：Rete 画布 + Gain 节点 + 端口内联数字控件 + 连线隐藏/断线恢复；IR v1 类型与 zod 定稿；rosbridge 与 demo 参数节点均可用。**未做**：浏览器端到端验证（无 Playwright）、运行时参数绑定（M2）。

## 现在能跑什么

```bash
cd /home/ddyyxx/Origin_ROSUI
corepack pnpm install      # 已装过，node_modules 就绪
corepack pnpm dev          # Vite，5173/5174
corepack pnpm build        # 退出码 0（345 kB JS / gzip 105 kB）
corepack pnpm check        # 退出码 0（tsc ×2 + 5 个 IR 测试）

scripts/ros-up.sh          # rosbridge :9090（无 root 解包方案）
scripts/test-demo-params.sh # demo 节点参数校验证据（输出已存 docs/artifacts/）
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `apps/web/src/rete/editor.ts` | `createEditor` / `GainNode` / `addGainNode` / `connect` / `toGraphIR` |
| `apps/web/src/App.tsx` | 建 2 个 Gain 并连一条线，工具栏可加节点 |
| `packages/ir/src/index.ts` | GraphIR v1（`version:1`，`valueType: double\|integer\|boolean\|string\|string_array`，`mode: static\|runtime`，`widget: number\|text\|boolean\|select\|pose\|json`） |
| `ros2/rosui_demo/rosui_demo/param_node.py` | gain/enabled/mode/pose 四类参数 + `add_on_set_parameters_callback` 校验 |
| `scripts/fetch-rosbridge.sh`、`scripts/ros-up.sh` | 无 root 跑 rosbridge |

## 本机硬约束（新会话必读）

1. `NoNewPrivs=1` → `sudo` / `apt install` 全废。装系统包只能「`apt-get download` + `dpkg-deb -x` 到 `vendor/prefix`」，然后补 `AMENT_PREFIX_PATH` / `PYTHONPATH` / `LD_LIBRARY_PATH`。
2. `pnpm` 不在 PATH，脚本统一 `corepack pnpm`。
3. 杀进程别用 `pkill -f <pattern>`：pattern 会匹配到自己这条 bash 命令行，把自己 SIGTERM 掉。用 `pkill -f '[p]attern'` 或按端口找 pid。
4. `ros2 param set` 的**整数字面量**会被 rclpy 拒（`expected DOUBLE got INTEGER`），演示/测试要写 `42.0` 而不是 `42`；数组同理要写 `[...]` 里全浮点。

## 已验证事实（可复用）

- `/rosapi/get_param_names` 走 rosbridge 可用，返回 `names=['/node:param', ...]`。
- `/parameter_events`：**首次** set 落 `new_parameters`，**第二次**同参数才落 `changed_parameters`（实测 parameter_blackboard，2 条事件各 1 条）。
- `AreaExtensions.showInputControl(area)` 内部就监听 `connectioncreated`/`connectionremoved` 并 `area.update('node', id)`，不要重复实现。
- `ClassicPreset.InputControl` 仅 text/number；写值走 `setValue()` → `options.change(v)`。

## 下一步（建议顺序）

1. **T-008** 装 Playwright（`PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`），给 C1/C2 拍 before/after 截图 —— 目前的「联动生效」只有代码依据，没有视觉证据。
2. **T-011/T-014** 控件类型映射与校验（select/text/bool 三类），把 Gain 之外第二种节点加进来。
3. **T-006/T-016/T-017** 接 M2：RosClient + 参数绑定，先对 `rosui_demo` 验双向，再接 `z-localization` 的 `zlio`（静态参数，需给它加 callback，见 `docs/integration-target.md`）。
