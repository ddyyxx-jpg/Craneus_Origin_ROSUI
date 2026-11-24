#!/usr/bin/env bash
# 无 root 获取 rosbridge_suite：下载 deb 并解包到 vendor/prefix（不装进系统）。
# 背景：本机 sudo 被 NoNewPrivs 拦截，无法 apt install；rosbridge 全是 Python，可纯解包运行。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$ROOT/vendor/prefix"
DEBS="$ROOT/vendor/debs"
PKGS=(
  ros-jazzy-rosbridge-suite ros-jazzy-rosbridge-library ros-jazzy-rosbridge-server
  ros-jazzy-rosapi ros-jazzy-rosbridge-msgs ros-jazzy-rosapi-msgs
  python3-bson python3-cbor2 python3-tornado python3-ujson python3-pymongo
  python3-numpy python3-pil
)

if [ -f "$PREFIX/opt/ros/jazzy/share/rosbridge_server/package.xml" ]; then
  echo "[skip] $PREFIX 已就绪"
  exit 0
fi

mkdir -p "$DEBS" "$PREFIX"
cd "$DEBS"
apt-get download "${PKGS[@]}"
for f in *.deb; do dpkg-deb -x "$f" "$PREFIX"; done
echo "[ok] 解包到 $PREFIX"
