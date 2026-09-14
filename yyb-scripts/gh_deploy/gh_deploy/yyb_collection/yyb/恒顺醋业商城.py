#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
恒顺醋业商城 每日签到 (YYB版)

入口: 微信小程序"恒顺醋业商城"(有赞零售 wsc)
功能: 每日签到领顺顺豆

环境变量:
  YYB_BASE_URL  YYB 服务地址 (默认 http://172.17.0.1:18080)
  YYB_REF       指定账号 ref (可选，默认遍历所有账号)
  YZ_KDT_ID     门店 kdt_id (默认 19011618)
"""

import json
import os
import sys
import time
from datetime import datetime

import requests

# ====== YYB 配置 ======
YYB_BASE = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "") or None
# ======================

# ====== 业务常量 ======
APP_NAME = "恒顺醋业商城"
APPID = "wx7f708d01faee0624"
KDT_ID = os.getenv("YZ_KDT_ID", "19011618")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
      "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
      "MiniProgramEnv/Windows WindowsWechat/WMPF "
      "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541b35) "
      "XWEB/20089")
REFERER = f"https://servicewechat.com/{APPID}/2/page-frame.html"
# ======================


def build_extra_data(sid):
    """extra-data 头里的 sid(sessionId) 是识别用户身份的关键"""
    return json.dumps({
        "is_weapp": 1, "sid": sid,
        "version": "2.228.6.101", "client": "weapp",
        "bizEnv": "wsc",
        "uuid": "mbopvn6LjoKe7ng1784297010258",
        "ftime": int(time.time() * 1000),
    }, separators=(",", ":"))


def make_headers(sid=None):
    headers = {
        "User-Agent": UA,
        "Content-Type": "application/json",
        "Referer": REFERER,
    }
    if sid:
        headers["extra-data"] = build_extra_data(sid)
    return headers


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"  [✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    payload = {"ref": ref, "app_id": APPID}
    resp = requests.post(f"{YYB_BASE}/wxapp/getCode",
                         json=payload, timeout=30)
    data = resp.json()
    if data.get("code") == 0:
        result = data.get("data", {}).get("result", {})
        code = result.get("code")
        if code:
            return code
        print(f"    [✗] getCode 返回中没有 code: "
              f"{json.dumps(result, ensure_ascii=False)}")
        return None
    print(f"    [✗] YYB getCode 失败: "
          f"{data.get('msg', '未知错误')}")
    return None
# ==========================


# ====== 有赞接口 ======
def login_with_code(code):
    """code 换 accessToken + sessionId (恒顺醋业版)"""
    url = (f"https://uic.youzan.com/passport/general/auth.json"
           f"?kdt_id={KDT_ID}&app_id={APPID}")
    body = {
        "appId": APPID, "code": code, "platformName": "weapp",
        "signature": "android", "clientId": "4d65249d377b2c3ed8",
        "grantType": "yz_union", "inWsc": True,
        "kdtId": KDT_ID,
        "extraBizData": {
            "enterOptions": {
                "extKdtId": int(KDT_ID),
                "path": "packages/usercenter/dashboard/index",
                "query": {}, "scene": 1008,
                "referrerInfo": {}, "chatType": 3,
                "mode": "default", "apiCategory": "default",
            },
            "guideBizDataMap": {"from_params": ""},
            "sceneData": {},
        },
    }
    try:
        resp = requests.post(url, json=body,
                             headers=make_headers(), timeout=15)
        data = resp.json()
        if data.get("code") == 0 and data.get("data", {}).get("accessToken"):
            d = data["data"]
            return {
                "token": d["accessToken"],
                "sid": d["sessionId"],
                "nickname": d.get("nickname", ""),
                "userId": d.get("userId"),
            }
        print(f"    [✗] 登录失败: "
              f"{data.get('msg', json.dumps(data, ensure_ascii=False))}")
        return None
    except requests.RequestException as e:
        print(f"    [✗] 登录异常: {e}")
        return None


def get_checkin_info(sid, token):
    """查 checkInId"""
    url = (f"https://h5.youzan.com/wscump/checkin/"
           f"check-in-info.json"
           f"?app_id={APPID}&kdt_id={KDT_ID}&access_token={token}")
    try:
        resp = requests.get(url, headers=make_headers(sid), timeout=15)
        data = resp.json()
        if data.get("code") == 0:
            return data.get("data", {}).get("checkInId")
        print(f"    [✗] 查签到信息失败: "
              f"{data.get('msg', json.dumps(data, ensure_ascii=False))}")
        return None
    except requests.RequestException as e:
        print(f"    [✗] 查签到信息异常: {e}")
        return None


def get_checkin_activity(sid, token, checkin_id):
    """查签到状态"""
    url = (f"https://h5.youzan.com/wscump/checkin/"
           f"get_activity_by_yzuid_v2.json"
           f"?checkinId={checkin_id}&app_id={APPID}"
           f"&kdt_id={KDT_ID}&access_token={token}")
    try:
        resp = requests.get(url, headers=make_headers(sid), timeout=15)
        data = resp.json()
        if data.get("code") == 0:
            return data.get("data", {})
        print(f"    [✗] 查签到状态失败: "
              f"{data.get('msg', json.dumps(data, ensure_ascii=False))}")
        return None
    except requests.RequestException as e:
        print(f"    [✗] 查签到状态异常: {e}")
        return None


def do_checkin(sid, token, checkin_id):
    """执行签到"""
    url = (f"https://h5.youzan.com/wscump/checkin/"
           f"checkinV2.json"
           f"?checkinId={checkin_id}&app_id={APPID}"
           f"&kdt_id={KDT_ID}&access_token={token}")
    try:
        resp = requests.get(url, headers=make_headers(sid), timeout=15)
        return resp.json()
    except requests.RequestException as e:
        print(f"    [✗] 签到异常: {e}")
        return None
# ====================


def process_account(account):
    ref = str(account.get("id", ""))
    nickname = account.get("nickname", "未知")
    openid = account.get("openid", "")
    display_name = nickname or openid[:16]
    print(f"\n  📱 账号: {display_name}")

    print(f"  [1/5] 获取 wx.login code...")
    code = yyb_get_code(ref)
    if not code:
        print(f"  [✗] 获取 code 失败, 跳过此账号")
        return
    print(f"  [✓] code: {code[:16]}...")

    print(f"  [2/5] 登录 {APP_NAME}...")
    login = login_with_code(code)
    if not login:
        return
    print(f"  [✓] 登录成功: {login['nickname']}(uid={login['userId']})")

    print(f"  [3/5] 查询签到活动 checkInId...")
    checkin_id = get_checkin_info(login["sid"], login["token"])
    if not checkin_id:
        print(f"  [✗] 未获取到 checkInId, 跳过")
        return
    print(f"  [✓] checkInId: {checkin_id}")

    print(f"  [4/5] 查询今日签到状态...")
    act = get_checkin_activity(login["sid"], login["token"], checkin_id)
    if not act:
        return
    if act.get("isCheckin"):
        days = act.get("continuesDay", 0)
        print(f"  [⚠] 今日已签到, 连续{days}天, 跳过")
        return
    print(f"  [→] 今日未签到, 执行签到...")

    print(f"  [5/5] 执行签到...")
    res = do_checkin(login["sid"], login["token"], checkin_id)
    if not res:
        return
    if res.get("code") == 0 and res.get("data", {}).get("success"):
        rewards_list = res["data"].get("list", [])
        rewards = ", ".join(
            i.get("infos", {}).get("title", "") or i.get("type", "")
            for i in rewards_list
        )
        times = res["data"].get("times", "")
        print(f"  [✓] 签到成功! 奖励: {rewards or '无'} (第{times}次)")
    else:
        print(f"  [✗] 签到失败: "
              f"{res.get('msg', json.dumps(res, ensure_ascii=False))}")


def main():
    print("=" * 56)
    print(f"  {APP_NAME} 每日签到 (YYB版)")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 56)

    print("\n[1/2] 获取 YYB 账号列表...")
    accounts = yyb_get_accounts()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        print(f"  请先通过 YYB 扫码登录添加账号: POST {YYB_BASE}/qr")
        return

    if YYB_REF:
        accounts = [
            a for a in accounts
            if str(a.get("id")) == YYB_REF or a.get("openid") == YYB_REF
        ]
        if not accounts:
            print(f"[✗] 未找到 ref={YYB_REF} 的账号")
            return
        print(f"[✓] 指定账号, 共 1 个\n")
    else:
        print(f"[✓] 共 {len(accounts)} 个账号\n")

    for i, account in enumerate(accounts, 1):
        print(f"[{i}/{len(accounts)}] {'=' * 40}")
        try:
            process_account(account)
        except Exception as e:
            print(f"  [✗] 账号执行异常: {e}")
        if i < len(accounts):
            time.sleep(2)

    print("\n" + "=" * 56)
    print("  全部任务执行完毕!")
    print("=" * 56)


if __name__ == "__main__":
    main()
