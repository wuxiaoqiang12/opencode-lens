#!/usr/bin/env python3
import importlib.util
from pathlib import Path


def load_watchdog():
    path = Path(__file__).with_name("opencode-watch.py")
    spec = importlib.util.spec_from_file_location("opencode_watch", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_describe_pending_bash_permission():
    watch = load_watchdog()
    assert (
        watch.describe_permission_tool_part(
            {
                "type": "tool",
                "tool": "bash",
                "state": {"status": "running", "input": {"command": "git push origin main"}},
            }
        )
        == "执行命令: git push origin main"
    )


def test_ignore_completed_tool_part():
    watch = load_watchdog()
    assert (
        watch.describe_permission_tool_part(
            {
                "type": "tool",
                "tool": "bash",
                "state": {"status": "completed", "input": {"command": "git status"}},
            }
        )
        is None
    )


def test_short_completion_is_relayed_verbatim():
    watch = load_watchdog()
    text = "任务已完成：RKNN 推理慢的主要原因是首帧初始化和频繁同步。"
    assert watch.format_completion_text(text) == text


def test_long_completion_is_extractive_summary():
    watch = load_watchdog()
    text = "\n".join(
        [
            "背景：" + "x" * 260,
            "原因：NPU 首帧初始化、CPU/GPU fallback、ROS 图像拷贝都会放慢速度。",
            "建议：增加分阶段计时，区分模型推理、图像预处理和动作执行。",
            "风险：不要只看总耗时，否则会误判 RKNN 本身。",
            "补充：" + "y" * 260,
        ]
    )
    result = watch.format_completion_text(text)
    assert result.startswith("内容较长，自动摘取要点：")
    assert "原因：NPU 首帧初始化" in result
    assert "建议：增加分阶段计时" in result
    assert len(result) < len(text)


def test_question_option_keeps_description():
    watch = load_watchdog()
    assert watch.format_question_option({"label": "allow once", "description": "只允许这一次"}) == "allow once（只允许这一次）"


def test_describe_read_permission_with_file_path():
    watch = load_watchdog()
    assert (
        watch.describe_permission_tool_part(
            {
                "type": "tool",
                "tool": "read",
                "state": {"status": "running", "input": {"filePath": "/tmp/review.md"}},
            }
        )
        == "读取文件: /tmp/review.md"
    )


def test_describe_write_permission_with_file_path():
    watch = load_watchdog()
    assert (
        watch.describe_permission_tool_part(
            {
                "type": "tool",
                "tool": "write",
                "state": {"status": "running", "input": {"path": "/tmp/result.txt"}},
            }
        )
        == "写入文件: /tmp/result.txt"
    )


if __name__ == "__main__":
    test_describe_pending_bash_permission()
    test_ignore_completed_tool_part()
    test_short_completion_is_relayed_verbatim()
    test_long_completion_is_extractive_summary()
    test_question_option_keeps_description()
    test_describe_read_permission_with_file_path()
    test_describe_write_permission_with_file_path()
