"""e2e 用：启动 3 秒后才 declare 一个参数，验证参数浏览器能发现运行中新出现的参数。"""
import os
import time

import rclpy
from rclpy.node import Node


def main() -> None:
    rclpy.init()
    # 名字可由 e2e 传入，避免上一个测试进程残留同名节点互相覆盖。
    node = Node(os.environ.get('ROSUI_LATE_NODE', 'rosui_late'))
    time.sleep(3.0)
    node.declare_parameter('late_param', 7.5)
    node.get_logger().info('declared late_param')
    rclpy.spin(node)


if __name__ == '__main__':
    main()
