from setuptools import setup
setup(
    name="rosui_demo",
    version="0.1.0",
    packages=["rosui_demo"],
    entry_points={"console_scripts": ["param_node = rosui_demo.param_node:main"]},
)
