#!/usr/bin/env bash
# 起 rosbridge websocket（端口 9090），无 root、环境自包含。
# 用法: scripts/ros-up.sh          # 前台运行，Ctrl-C 退出
#      ROSBRIDGE_PORT=9091 scripts/ros-up.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$ROOT/vendor/prefix"
PORT="${ROSBRIDGE_PORT:-9090}"
export ROS_LOG_DIR="${ROS_LOG_DIR:-/tmp/roslog}"
mkdir -p "$ROS_LOG_DIR"

[ -f "$PREFIX/opt/ros/jazzy/share/rosbridge_server/package.xml" ] || {
  echo "缺少 rosbridge 运行时，先跑 scripts/fetch-rosbridge.sh" >&2; exit 1; }

set +u
source /opt/ros/jazzy/setup.bash
set -u
export AMENT_PREFIX_PATH="$PREFIX/opt/ros/jazzy:${AMENT_PREFIX_PATH:-}"
export PYTHONPATH="$PREFIX/opt/ros/jazzy/lib/python3.12/site-packages:$PREFIX/usr/lib/python3/dist-packages:${PYTHONPATH:-}"
export LD_LIBRARY_PATH="$PREFIX/opt/ros/jazzy/lib:${LD_LIBRARY_PATH:-}"

exec ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:="$PORT"
