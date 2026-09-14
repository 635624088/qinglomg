#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
深i工（深圳工会 szzgh）每日积分 · yyb 协议版
=========================================
原理：yyb 账号池取 wx.login code → POST getUserInfo 静默登录（响应带新 token）
     → completePointTask 完成每日登录积分任务 → 查询积分余额

token 机制：登录必须携带有效 token（抓包获取的种子 token 或上次运行刷新的 token）。
每次登录成功会返回新 token + 有效期，脚本自动保存到 szg_tokens.json。
只要本任务每天跑一次，token 即可无限续命。若报"token 失效"，
需在手机微信打开一次深i工小程序，然后重新抓包更新种子 token。

环境变量：
  SZG_ACCOUNTS  必填。多账号用 & 分隔，每段：pkMember@mobile加密串[@种子token]
  YYB_HOST      可选，默认 http://172.17.0.1:18080
  YYB_REF       可选，默认 owNAX6jyAVJ6yY3SjyeFpbZqbG1g
"""
import json
import os
import ssl
import sys
import time
import urllib.request
import urllib.error

YYB = os.getenv("YYB_HOST", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "owNAX6jyAVJ6yY3SjyeFpbZqbG1g")
APPID = "wxb7a23c5650537af6"          # 深i工小程序
BASE = "https://lsapp.szzgh.org:99"

# 完整 UA（精简版会触发服务端空响应风控，勿改短）
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
      "MicroMessenger/8.0.6(0x1800062d) NetType/WIFI Language/zh_CN")
REFERER = "https://servicewechat.com/" + APPID + "/409/page-frame.html"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

API_LOGIN = "/api/ebs/member/memberApp/getUserInfo"
API_TASK = "/api/ebs/point/pointTask/completePointTask"
API_POINT = "/api/ebs/point/memberPoint/getUserPoint"
TASK_DAILY = {"apiId": "snlZgkXAFnuxIoLsfZQj7w==",
              "buryingPointType": 101, "systemType": 0}

TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "szg_tokens.json")


def http(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    req.add_header("User-Agent", UA)
    req.add_header("Referer", REFERER)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=25, context=ctx) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return -1, str(e)[:200]


def yyb_get_code():
    for i in range(3):
        st, body = http("POST", f"{YYB}/wxapp/getCode",
                        {"app_id": APPID, "ref": YYB_REF})
        try:
            d = json.loads(body)
            if d.get("code") == 0:
                c = (d.get("data") or {}).get("result", {}).get("code")
                if c:
                    return c
        except Exception:
            pass
        print(f"   yyb取码失败(HTTP {st})，重试{i+2}/3…")
        time.sleep(8 * (i + 1))
    return None


def load_tokens():
    try:
        return json.load(open(TOKEN_FILE, encoding="utf-8"))
    except Exception:
        return {}


def save_tokens(tokens):
    try:
        json.dump(tokens, open(TOKEN_FILE, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
    except Exception as e:
        print("   ! token 保存失败:", str(e)[:80])


def run_account(idx, pk, mobile_enc, seed_token):
    print(f"\n===== 账号{idx} {pk[:8]}… =====")
    tokens = load_tokens()
    token = tokens.get(pk, {}).get("token") or seed_token
    if not token:
        print("   ✗ 无可用 token（SZG_ACCOUNTS 第三段需提供种子 token）")
        return False

    code = yyb_get_code()
    if not code:
        print("   ✗ 取码失败，跳过")
        return False

    st, resp = http("POST", BASE + API_LOGIN,
                    {"pkMember": pk, "wxCode": code, "mobile": mobile_enc},
                    {"token": token})
    if not resp.strip():
        print("   ✗ token 已失效（服务端空响应）。"
              "请在手机上打开一次深i工小程序，然后抓包更新种子 token")
        return False
    try:
        d = json.loads(resp)
    except Exception:
        print(f"   ✗ 登录响应异常 HTTP {st}: {resp[:120]}")
        return False
    if d.get("code") != 0:
        print(f"   ✗ 登录失败: {d.get('msg')} (code={d.get('code')})")
        return False
    data = d.get("data") or {}
    new_token = data.get("token") or token
    name = data.get("realName") or "未知"
    print(f"   ✓ 登录成功: {name}"
          + (f" | token已刷新(有效期至 {data.get('expireTime')})"
             if data.get("token") else " | token未变化"))
    if data.get("token"):
        tokens[pk] = {"token": new_token, "expireTime": data.get("expireTime"),
                      "updated": time.strftime("%Y-%m-%d %H:%M:%S")}
        save_tokens(tokens)

    # 每日登录积分任务
    st, resp = http("POST", BASE + API_TASK, TASK_DAILY,
                    {"token": new_token})
    try:
        d = json.loads(resp)
        if d.get("code") == 0:
            print(f"   ✓ 每日任务: {d.get('data') or d.get('msg')}")
        elif d.get("code") == 202:
            print(f"   ✓ 每日任务: 今天已完成")
        else:
            print(f"   ! 每日任务: {d.get('msg')} (code={d.get('code')})")
    except Exception:
        print(f"   ! 任务响应异常 HTTP {st}: {resp[:120]}")

    # 查积分
    st, resp = http("POST", BASE + API_POINT, None, {"token": new_token})
    try:
        d = json.loads(resp)
        if d.get("code") == 0:
            print(f"   ✓ 当前可用积分: {d.get('data')}")
    except Exception:
        pass
    return True


def main():
    accounts = os.getenv("SZG_ACCOUNTS", "").strip()
    if not accounts:
        print("未配置 SZG_ACCOUNTS（格式: pkMember@mobile加密串[@种子token]，多账号&分隔）")
        sys.exit(1)
    ok = 0
    items = [a.strip() for a in accounts.split("&") if a.strip()]
    for i, item in enumerate(items, 1):
        parts = item.split("@")
        if len(parts) < 2:
            print(f"账号{i} 格式错误: {item[:40]}")
            continue
        pk, mob = parts[0], parts[1]
        seed = parts[2] if len(parts) > 2 else ""
        if run_account(i, pk, mob, seed):
            ok += 1
        time.sleep(3)
    print(f"\n完成 {ok}/{len(items)} 个账号")
    try:
        sys.path.append("/ql/scripts")
        sys.path.append("/ql/data/scripts")
        from notify import send  # noqa
        send("深i工每日积分", f"完成 {ok}/{len(items)} 个账号")
    except Exception:
        pass


if __name__ == "__main__":
    main()
