"""ROSUI 演示节点：4 类参数 + 运行时校验，用来验证编辑器 ↔ ROS 参数双向绑定。

参数：
  gain   double  [0, 10]      增益
  enabled bool                开关
  mode   string  low|normal|high
  pose   double_array(7)      x y z qx qy qz qw
"""
import math

import rclpy
from rclpy.node import Node
from rcl_interfaces.msg import SetParametersResult
from std_msgs.msg import String

MODES = ("low", "normal", "high")
GAIN_MIN, GAIN_MAX = 0.0, 10.0


def _pose_ok(values):
    if len(values) != 7:
        return False, "pose 需要 7 个数 [x,y,z,qx,qy,qz,qw]"
    quat = values[3:]
    norm = math.sqrt(sum(v * v for v in quat))
    if abs(norm - 1.0) > 0.05:
        return False, f"四元数模长 {norm:.3f} 偏离 1 超过 0.05"
    return True, ""


class ParamDemo(Node):
    def __init__(self):
        super().__init__("rosui_demo")
        self.declare_parameter("gain", 1.0)
        self.declare_parameter("enabled", True)
        self.declare_parameter("mode", "normal")
        self.declare_parameter("pose", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0])
        self.add_on_set_parameters_callback(self._validate)
        self.pub = self.create_publisher(String, "/rosui_demo/status", 10)
        self.timer = self.create_timer(1.0, self._tick)
        self.get_logger().info("rosui_demo ready: gain/enabled/mode/pose")

    def _validate(self, params):
        for p in params:
            if p.name == "gain" and not (GAIN_MIN <= float(p.value) <= GAIN_MAX):
                return SetParametersResult(
                    successful=False, reason=f"gain 必须在 [{GAIN_MIN}, {GAIN_MAX}]")
            if p.name == "mode" and p.value not in MODES:
                return SetParametersResult(
                    successful=False, reason=f"mode 必须是 {MODES} 之一")
            if p.name == "pose":
                ok, reason = _pose_ok([float(v) for v in p.value])
                if not ok:
                    return SetParametersResult(successful=False, reason=reason)
        return SetParametersResult(successful=True)

    def _tick(self):
        gain = self.get_parameter("gain").value
        enabled = self.get_parameter("enabled").value
        mode = self.get_parameter("mode").value
        self.pub.publish(String(data=f"enabled={enabled} mode={mode} gain={gain:.2f}"))


def main():
    rclpy.init()
    node = ParamDemo()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
