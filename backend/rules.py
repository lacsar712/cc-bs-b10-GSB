"""桥梁微应变判定：80～220 με 为合格，否则越界。另含夜间低采样提醒的时段判定。"""

from datetime import time


def judge_microstrain(microstrain: float) -> tuple[str, str]:
    if 80 <= microstrain <= 220:
        return "合格", "微应变处于 80～220 με 设计允许范围内"
    if microstrain < 80:
        return "越界", "微应变低于 80 με 设计下限"
    return "越界", "微应变高于 220 με 设计上限"


def in_night_window(moment: time, start: time, end: time) -> bool:
    """墙钟时刻是否落入夜间时段。

    支持跨零点时段（如 22:00～06:00）；起止相等视为未启用，永不落入。
    传入的 moment 必须是服务器侧时刻，不得使用浏览器本地时间。
    """
    if start == end:
        return False
    if start < end:
        return start <= moment < end
    return moment >= start or moment < end
