# -*- coding: utf-8 -*-
"""
梦百合「梦粉家族」小程序 每日签到
接口来源: StormSniffer 抓包 (2026-09-12)

环境变量:
  MLILY_TOKEN  会员 token (多账号用换行或 @ 分隔)
               获取: 抓包 mfapi.mlily.com 任意请求 URL 里 token= 参数
               token 有效期约 1 年 (JWT exp), 过期后重新抓包更新
  ※ 也可不放环境变量, 直接编辑脚本同目录的 mlily_token.txt (一行一个 token)
可选:
  MLILY_PUSHPLUS_TOKEN  PushPlus 推送 token

流程: 查账号信息(昵称/积分) -> 查签到状态 -> 未签到则签到 -> 显示结果与最新余额
"""
import os
import sys
import time
import requests
import urllib3

urllib3.disable_warnings()

BASE = "https://mfapi.mlily.com"
APPID = "wxac481dbea7d77e73"   # 梦百合小程序
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.78(0x18004e25) NetType/WIFI")
HEADERS = {
    "User-Agent": UA,
    "content-type": "application/json",
    "Referer": f"https://servicewechat.com/{APPID}/26/page-frame.html",
}

PUSHPLUS_TOKEN = os.environ.get("MLILY_PUSHPLUS_TOKEN", "")


def pushplus(title, content):
    if not PUSHPLUS_TOKEN:
        return
    try:
        requests.post("https://www.pushplus.plus/send", timeout=15,
                      json={"token": PUSHPLUS_TOKEN, "title": title,
                            "content": content, "template": "txt"})
    except Exception as e:
        print(f"[推送失败] {e}")


def api(method, path, token, params=None):
    qs = f"ajax=true&platform=weapp&token={token}"
    if params:
        qs += "&" + "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{BASE}{path}?{qs}"
    try:
        if method == "GET":
            r = requests.get(url, headers=HEADERS, timeout=15)
        else:
            r = requests.post(url, headers=HEADERS, timeout=15)
        return r.json()
    except Exception as e:
        return {"code": -1, "msg": str(e)[:80]}


def run_account(idx, token):
    # 1. 账号信息
    d = api("GET", "/v1/account/info", token)
    if d.get("code") != 1:
        return f"账号{idx}: ❌ token 无效或过期 ({str(d.get('msg'))[:40]})"
    info = (d.get("data") or {})
    auth = info.get("authInfo") or info
    nick = auth.get("nickName") or ""
    mobile = str(auth.get("mobile") or "")
    masked = mobile[:3] + "****" + mobile[7:] if len(mobile) >= 7 else mobile
    label = f"{nick}({masked})" if nick else f"账号{idx}"
    old_integral = auth.get("integral", "?")

    # 2. 签到状态
    d = api("GET", "/v1/marketing/checkin/info", token)
    data = d.get("data") or {}
    days = data.get("checkInDays", "?")
    if d.get("code") == 1 and data.get("isCheckInToday"):
        return (f"{label}: ✅ 今日已签到 (累计{days}天), "
                f"积分{old_integral}")
    if d.get("code") != 1:
        return f"{label}: ❌ 查询签到状态失败 ({str(d.get('msg'))[:40]})"

    # 3. 签到
    time.sleep(1)
    d = api("POST", "/v1/marketing/checkin", token)
    if d.get("code") == 1:
        gained = d.get("data")
        tail = f", +{gained}积分" if gained is not None else ""
        # 4. 最新余额
        time.sleep(1)
        d2 = api("GET", "/v1/account/info", token)
        auth2 = ((d2.get("data") or {}).get("authInfo") or {}) if d2.get("code") == 1 else {}
        new_integral = auth2.get("integral", "?")
        return (f"{label}: ✅ 签到成功{tail} (累计{days + 1 if isinstance(days, int) else days}天), "
                f"积分{old_integral}→{new_integral}")
    if "已" in str(d.get("msg", "")):
        return f"{label}: ✅ {d.get('msg')} (累计{days}天), 积分{old_integral}"
    return f"{label}: ❌ 签到失败 ({str(d.get('msg'))[:40]})"


def main():
    raw = os.environ.get("MLILY_TOKEN", "").strip()
    if not raw:
        # 环境变量为空时, 回退读脚本同目录 mlily_token.txt
        try:
            f = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mlily_token.txt")
            with open(f, encoding="utf-8") as fp:
                raw = fp.read().strip()
        except OSError:
            pass
    if not raw:
        print("❌ 未配置 token (环境变量 MLILY_TOKEN 或 mlily_token.txt)")
        return
    tokens = [t.strip() for t in raw.replace("@", "\n").splitlines() if len(t.strip()) > 40]
    if not tokens:
        print("❌ MLILY_TOKEN 格式错误，未解析到有效 token")
        return
    print(f"===== 梦百合签到 共 {len(tokens)} 个账号 {time.strftime('%Y-%m-%d %H:%M:%S')} =====")

    results = []
    for i, token in enumerate(tokens, 1):
        try:
            results.append(run_account(i, token))
        except Exception as e:
            results.append(f"账号{i}: ❌ 异常 {e.__class__.__name__}: {str(e)[:60]}")
        if i < len(tokens):
            time.sleep(2)

    print("\n===== 执行完毕 =====")
    for s in results:
        print(" ", s)
    pushplus("梦百合签到", "\n".join(results))


if __name__ == "__main__":
    main()
