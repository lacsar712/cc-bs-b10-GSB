"""桥梁微应变判定：80～220 με 为合格，否则越界。"""

from datetime import time


def judge_microstrain(microstrain: float) -> tuple[str, str]:
    if 80 <= microstrain <= 220:
        return "合格", "微应变处于 80～220 με 设计允许范围内"
    if microstrain < 80:
        return "越界", "微应变低于 80 με 设计下限"
    return "越界", "微应变高于 220 με 设计上限"


def is_in_night_window(start: time, end: time, moment: time) -> bool:
    """夜间时段判定（只吃传入的服务器时刻，不取本地时钟）。

    start < end：当日区间 [start, end)；start > end：跨零点时段；
    start == end：视为未启用，任何时刻都不落入。
    """
    if start == end:
        return False
    if start < end:
        return start <= moment < end
    return moment >= start or moment < end
