#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
芙蓉王·主抽奖（只抽奖不验证）

职责：查询剩余抽奖机会并全部抽完（服务端单日限 2 次，超出会提示）。
定时：每天 10:30 / 20:30（10:30 在主验证之后，20:30 兜底重试"拥挤"）
"""
import os
os.environ["FRW_MODE"] = "draw"

_here = os.path.dirname(os.path.abspath(__file__))
_main = os.path.join(_here, "furongwang_qinglong.py")
with open(_main, "r", encoding="utf-8") as _f:
    exec(compile(_f.read(), _main, "exec"))
