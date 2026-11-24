#!/usr/bin/env bash
# T-007 证据脚本：验证 rosui_demo 四个参数的类型与运行时校验。
# 不依赖 colcon build：直接以 PYTHONPATH 方式跑包内模块。
set +u
source /opt/ros/jazzy/setup.bash
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-42}"
export ROS_LOG_DIR="${ROS_LOG_DIR:-/tmp/roslog}"
export PYTHONPATH="$ROOT/ros2/rosui_demo:${PYTHONPATH:-}"
mkdir -p "$ROS_LOG_DIR"

python3 -m rosui_demo.param_node >"$ROS_LOG_DIR/rosui_demo.log" 2>&1 &
NP=$!
trap 'kill $NP 2>/dev/null' EXIT
sleep 3

run() { printf '\n--- %s\n' "$1"; timeout 12 bash -c "$2" 2>&1 | tail -2; }

run "合法 gain 3.5（应成功）"        "ros2 param set /rosui_demo gain 3.5"
run "越界 gain 42.0（应被拒）"       "ros2 param set /rosui_demo gain 42.0"
run "非法 mode turbo（应被拒）"      "ros2 param set /rosui_demo mode turbo"
run "坏四元数（应被拒）"             "ros2 param set /rosui_demo pose \"[0.0,0.0,0.0,0.0,0.0,0.0,0.0]\""
run "合法 pose（应成功）"            "ros2 param set /rosui_demo pose \"[1.0,2.0,0.0,0.0,0.0,0.0,1.0]\""
run "enabled false（应成功）"        "ros2 param set /rosui_demo enabled false"
run "读回 gain"                      "ros2 param get /rosui_demo gain"
run "类型不匹配 gain 42（int→double 应被拒）" "ros2 param set /rosui_demo gain 42"
