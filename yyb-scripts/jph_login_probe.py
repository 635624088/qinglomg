#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""君品汇登录探测: 遍历 YYB 账号池, 只做 wxMiniSilentLogin 拿 token, 不答题(零额度消耗)。
用法: docker exec qinglong python3 /ql/data/scripts/jph_login_probe.py
"""
import sys, json
sys.path.insert(0, "/ql/data/scripts")
import junpinhui_dati_yyb as J
import requests

def probe():
    try:
        r = requests.get(f"{J.YYB_BASE_URL}/accounts", timeout=15)
        accounts = (r.json().get("data") or [])
    except Exception as e:
        print("!! 拉取账号池失败:", e)
        return
    print(f"账号池返回 {len(accounts)} 个 (YYB_BASE_URL={J.YYB_BASE_URL})")
    ok = fail = 0
    print("\n===== 登录探测结果 =====")
    for a in accounts:
        ref = str(a.get("id") or a.get("uin") or a.get("openid") or "?")
        base_nick = a.get("nickname") or a.get("remark") or a.get("alias") or "?"
        status = a.get("status")
        try:
            code = J.yyb_get_code(ref)
            token = J.silent_login(code)
            try:
                md = J.Api(token).member_login().get("data") or {}
                nick = md.get("wechatNickName") or md.get("nickName") or base_nick
            except Exception:
                nick = base_nick
            ok += 1
            print(f"  [OK]   {nick}  ref={ref}  status={status}  token={len(token)}字符")
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {base_nick}  ref={ref}  status={status}  -> {str(e)[:140]}")
    print(f"\n汇总: 成功 {ok} / 失败 {fail} / 共 {len(accounts)}")

if __name__ == "__main__":
    probe()
