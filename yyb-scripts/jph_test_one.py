#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""君品汇端到端验证: 对单个账号跑完整流程(登录+答题+抽奖), 验证 614 题库能真实得分。
用法: docker exec qinglong python3 /ql/data/scripts/jph_test_one.py
"""
import sys
sys.path.insert(0, "/ql/data/scripts")
import junpinhui_dati_yyb as J
REF = "999134"  # momo, 今日额度未动
print(f"===== 端到端验证 账号 ref={REF} =====")
try:
    res = J.run_account(REF)
    print("RESULT:", res)
except Exception as e:
    print("EXC:", e)
