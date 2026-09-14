#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""君品汇登录诊断: 打印每个账号 YYB getCode 原始返回 + (非空code时) 静默登录完整响应。
用法: docker exec qinglong python3 /ql/data/scripts/jph_diag.py
"""
import sys, json
sys.path.insert(0, "/ql/data/scripts")
import junpinhui_dati_yyb as J
import requests

def main():
    r = requests.get(f"{J.YYB_BASE_URL}/accounts", timeout=15)
    accounts = (r.json().get("data") or [])
    print(f"账号池 {len(accounts)} 个 (YYB_BASE_URL={J.YYB_BASE_URL}, APPID={J.APPID})")
    for a in accounts:
        ref = str(a.get("id") or a.get("uin") or a.get("openid") or "?")
        nick = a.get("nickname") or a.get("remark") or "?"
        print(f"\n----- {nick}  ref={ref}  status={a.get('status')} -----")
        try:
            gc = requests.post(f"{J.YYB_BASE_URL}/wxapp/getCode",
                               json={"app_id": J.APPID, "ref": ref}, timeout=60).json()
            code_val = (((gc.get("data") or {}).get("result") or {}).get("code") or "").strip()
            print(f"  getCode: code={gc.get('code')} msg={gc.get('msg')}")
            print(f"  getCode.data.result.code = {'<EMPTY>' if not code_val else code_val[:16]+'...'}")
        except Exception as e:
            print(f"  getCode EXC: {e}")
            continue
        if not code_val:
            print("  => YYB 下发的 code 为空, 静默登录必败(授权code不能为空)")
            continue
        # 非空 code: 看静默登录完整返回
        hdrs = {"Content-Type":"application/json","X-Access-Token":"","AppID":J.APPID,
                "Authorization":J.BASIC_AUTH,"App-Version":J.APP_VERSION,
                "User-Agent":"Mozilla/5.0 MicroMessenger/7.0.20.1781(0x6700143B) MiniProgramEnv/Windows",
                "Referer":f"https://servicewechat.com/{J.APPID}/248/page-frame.html"}
        try:
            resp = requests.post(f"{J.FM_BASE}/api/v2/login/wxMiniSilentLogin",
                                 json={"code": code_val}, headers=hdrs, timeout=20)
            sl = resp.json()
            print(f"  silent_login 完整返回: {json.dumps(sl, ensure_ascii=False)[:400]}")
            print(f"  silent_login 响应头: {dict(resp.headers)}")
        except Exception as e:
            print(f"  silent_login EXC: {e}")

if __name__ == "__main__":
    main()
