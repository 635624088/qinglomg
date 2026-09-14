#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
汤星球会员中心 每日签到 (YYB版)

入口: 微信小程序搜索"汤星球会员中心"
功能: 每日签到 + 积分乐园信息

环境变量:
 YYB_BASE_URL YYB 服务地址 (默认 http://172.17.0.1:18080)
 YYB_REF 指定账号 ref (可选，默认遍历所有账号)
"""

import json
import os
import time
from datetime import datetime

import requests

# ====== YYB 配置 ======
YYB_BASE = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "") or None
# ======================

# ====== 业务常量 ======
APP_NAME = "汤星球会员中心"
APPID = "wx9bb6d5ac457bd69d"
API_BASE = "https://vip.by-health.com/vip-api"
# ======================


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"[✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def fetch_accounts_from_yyb():
    """获取账号列表，返回 [(nickname/openid, ref), ...]"""
    raw = yyb_get_accounts()
    if not raw:
        return []
    accounts = []
    for a in raw:
        ref = str(a.get("id", ""))
        nickname = a.get("nickname") or a.get("alias") or a.get("openid", "")[:16]
        accounts.append((nickname, ref))
    # 如果指定了 YYB_REF，过滤
    if YYB_REF:
        accounts = [(n, r) for n, r in accounts if r == YYB_REF or YYB_REF in r]
    return accounts


def yyb_get_code(ref):
    payload = {"ref": ref, "app_id": APPID}
    resp = requests.post(f"{YYB_BASE}/wxapp/getCode", json=payload, timeout=30)
    data = resp.json()
    if data.get("code") == 0:
        result = data.get("data", {}).get("result", {})
        code = result.get("code")
        if code:
            return code
        print(f" [✗] getCode 返回中没有 code")
        return None
    print(f" [✗] YYB getCode 失败: {data.get('msg', '未知错误')}")
    return None
# ==========================


def login_with_code(code):
    """微信 code 换 token"""
    payload = {"appId": APPID, "code": code}
    try:
        resp = requests.post(f"{API_BASE}/auth/ma/login", json=payload, timeout=15)
        data = resp.json()
        if data.get("success") and data.get("data", {}).get("rspCode") == "00":
            result = data["data"]["result"]
            return result.get("token")
        print(f" [✗] 登录失败: {data.get('data', {}).get('rspMsg', '未知错误')}")
        return None
    except Exception as e:
        print(f" [✗] 登录请求异常: {e}")
        return None


def get_signed_dates(token):
    """获取签到日历"""
    now = datetime.now()
    headers = {"Authorization": token, "Content-Type": "application/json"}
    payload = {"startDate": f"{now.year}-{now.month:02d}-01", "endDate": f"{now.year}-{now.month:02d}-31"}
    try:
        resp = requests.post(f"{API_BASE}/sign/activity/calender", json=payload, headers=headers, timeout=15)
        data = resp.json()
        if data.get("success") and data.get("data", {}).get("rspCode") == "00":
            return data["data"]["result"].get("signDateList", [])
        return []
    except Exception:
        return []


def sign_daily(token, activity_id=11):
    """执行每日签到"""
    headers = {"Authorization": token, "Content-Type": "application/json"}
    payload = {"activityId": activity_id}
    try:
        resp = requests.post(f"{API_BASE}/sign/daily/create", json=payload, headers=headers, timeout=15)
        data = resp.json()
        if data.get("success") and data.get("data", {}).get("rspCode") == "00":
            result = data["data"]["result"]
            point = result.get("dailyPointReward", 0)
            day = result.get("accumulateDay", 0)
            print(f" [✓] 签到成功! +{point}积分, 本月累计{day}天")
            return result
        rsp_msg = data.get("data", {}).get("rspMsg", "")
        if "已签到" in rsp_msg:
            print(f" [→] 今日已签到")
            return True
        print(f" [✗] 签到失败: {rsp_msg}")
        return None
    except Exception as e:
        print(f" [✗] 签到请求异常: {e}")
        return None


def park_process(token, display_name):
    """处理积分乐园"""
    # 状态
    headers = {"Authorization": token}
    try:
        resp = requests.get(f"{API_BASE}/point/park/status", headers=headers, timeout=15)
        data = resp.json()
        if data.get("success") and data.get("data", {}).get("rspCode") == "00":
            status = data["data"]["result"]
            if status.get("rewardFlag") == 1:
                # 有奖励可领
                r2 = requests.post(f"{API_BASE}/point/park/reward", json={}, headers={**headers, "Content-Type": "application/json"}, timeout=15)
                rdata = r2.json()
                if rdata.get("success") and rdata.get("data", {}).get("rspCode") == "00":
                    print(f" [✓] 领取首登奖励成功!")
                elif "已领取" in rdata.get("data", {}).get("rspMsg", ""):
                    print(f" [→] 首登奖励已领取")
    except Exception:
        pass


def process_account(display_name, ref):
    code = yyb_get_code(ref)
    if not code:
        return

    token = login_with_code(code)
    if not token:
        return

    # --- 每日签到 ---
    today = datetime.now().strftime("%Y-%m-%d")
    signed_dates = get_signed_dates(token)
    already_signed = any(s.get("date") == today and s.get("effectiveFlag") == 1 for s in signed_dates)

    if already_signed:
        print(f" → 今日({today})已签到")
    else:
        sign_daily(token)

    # --- 积分乐园 ---
    park_process(token, display_name)

    # --- 积分资产 ---
    assets = None
    try:
        resp = requests.get(f"{API_BASE}/member/assets?forceRefresh=1", headers={"Authorization": token}, timeout=15)
        data = resp.json()
        if data.get("success") and data.get("data", {}).get("rspCode") == "00":
            assets = data["data"]["result"]
    except Exception:
        pass

    if assets:
        print(f" [📊] 积分: {assets.get('point', 0)} | 成长值: {assets.get('growth', 0)} | 等级: {assets.get('gradeName', '')}")


def main():
    print("=" * 56)
    print(f" 汤星球会员中心 签到")
    print(f" 时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 56)

    accounts = fetch_accounts_from_yyb()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        return

    for i, (nickname, ref) in enumerate(accounts, 1):
        display_name = nickname or ref[:16]
        print(f"\n[{i}/{len(accounts)}] {display_name}")
        try:
            process_account(display_name, ref)
        except Exception as e:
            print(f" [✗] 执行异常: {e}")
        if i < len(accounts):
            time.sleep(2)

    print("\n全部任务执行完毕!")


if __name__ == "__main__":
    main()
