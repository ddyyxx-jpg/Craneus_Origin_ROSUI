#!/usr/bin/env bash
# 一条命令起 M2 演示环境：rosbridge(9090) + rosui_demo 参数节点。
# 用法: scripts/demo-stack.sh        # 前台，Ctrl-C 一起退出
#       scripts/demo-stack.sh --check # 起完自检 4 项后保持运行
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-0}"
export ROS_LOG_DIR="${ROS_LOG_DIR:-/tmp/roslog}"
mkdir -p "$ROS_LOG_DIR"

set +u
source /opt/ros/jazzy/setup.bash
set -u

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

if ! ss -lnt 2>/dev/null | grep -q ':9090 '; then
  echo "[stack] 启动 rosbridge :9090"
  "$ROOT/scripts/ros-up.sh" >"$ROS_LOG_DIR/rosbridge.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 40); do ss -lnt 2>/dev/null | grep -q ':9090 ' && break; sleep 0.5; done
else
  echo "[stack] 9090 已在监听，复用"
fi

echo "[stack] 启动 rosui_demo"
PYTHONPATH="$ROOT/ros2/rosui_demo:${PYTHONPATH:-}" python3 -m rosui_demo.param_node \
  >"$ROS_LOG_DIR/rosui_demo.log" 2>&1 &
PIDS+=($!)
sleep 2

if [ "${1:-}" = "--check" ]; then
  echo "[check] 参数列表里是否有 /rosui_demo:gain"
  timeout 20 ros2 param list /rosui_demo 2>&1 | sed 's/^/  /'
  echo "[check] gain 合法写入"
  timeout 15 ros2 param set /rosui_demo gain 3.5 2>&1 | sed 's/^/  /'
  echo "[check] gain 越界（应被拒）"
  timeout 15 ros2 param set /rosui_demo gain 42.0 2>&1 | sed 's/^/  /' || true
fi

echo "[stack] 就绪：rosbridge=$(ss -lnt | grep -c ':9090 ') 个监听，日志在 $ROS_LOG_DIR"
wait
