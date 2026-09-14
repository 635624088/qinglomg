#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
芙蓉王·主验证（只验证不抽奖）

职责：消费 FRW_TASKS 队列里的 链接|验证码，逐个全自动验证。
     凑满的抽奖机会不在此消耗，由「芙蓉王·主抽奖」任务执行。
定时：每天 09:00（批量补码时可手动多跑/由驱动循环调用）
"""
import os
os.environ["FRW_MODE"] = "verify"

_here = os.path.dirname(os.path.abspath(__file__))
_main = os.path.join(_here, "furongwang_qinglong.py")
with open(_main, "r", encoding="utf-8") as _f:
    exec(compile(_f.read(), _main, "exec"))
