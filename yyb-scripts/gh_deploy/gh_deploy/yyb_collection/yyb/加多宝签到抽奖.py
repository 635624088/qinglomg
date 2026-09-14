#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
加多宝Club 微信小程序自动签到 + 任务中心 + 宝藏星期五抽奖脚本 (YYB版)

基于 YYB 协议获取微信小程序接口

功能:
  1. 每日自动签到
  2. 每日任务中心: 分享小程序任务 + 浏览商城任务
  3. 每周五自动参与"宝藏星期五"抽奖
"""

import json
import time
import uuid
import warnings
from datetime import datetime

import os
import requests

warnings.filterwarnings("ignore", category=requests.packages.urllib3.exceptions.InsecureRequestWarning)

# ====== 配置 ======
# YYB_BASE_URL  yyb 服务地址 (可选，默认 os.getenv("YYB_BASE_URL", ""))
# YYB_REF       (可选，指定账号 ref，默认遍历所有账号)
YYB_BASE = os.getenv("YYB_BASE_URL", "")
YYB_REF = None
# =================

APP_ID = "wx8371875e443e177f"
CLIENT_CODE = "CLI2113448692"

AUTH_BASE = "https://api-mp.jdbchina.com/geement.authjextra"
SIGN_BASE = "https://api-mp.jdbchina.com/geement.marketingplay"
ACT_BASE = "https://api-mp.jdbchina.com/geement.actjextra"
LOTTERY_BASE = "https://api-mp.jdbchina.com/geement.marketinglottery"

DAILY_TASKS = [
    {"id": "2508121123571", "name": "分享小程序任务", "reward": "10积分"},
    {"id": "2508121124311", "name": "浏览商城任务",   "reward": "1积分"},
]

TREASURE_FRIDAY_ACT_CODE = "ACT2508121127551"
TREASURE_FRIDAY_SCENE_CODE = "SCENE-2508121128271"

# TREASURE_FRIDAY_ACT_CODE  宝藏星期五活动编码
TREASURE_FRIDAY_ACT_CODE = "ACT2508121127551"

# TREASURE_FRIDAY_SCENE_CODE  宝藏星期五场景码
TREASURE_FRIDAY_SCENE_CODE = "SCENE-2508121128271"
# ====================

def yyb_get_accounts():
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"[✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []

def yyb_get_code(ref):
    payload = {"ref": ref, "app_id": APP_ID}
    resp = requests.post(f"{YYB_BASE}/wxapp/getCode", json=payload, timeout=30)
    data = resp.json()
    if data.get("code") == 0:
        result = data.get("data", {}).get("result", {})
        code = result.get("code")
        if code:
            return code
        print(f"    [✗] getCode 返回中没有 code: {json.dumps(result, ensure_ascii=False)}")
        return None
    print(f"    [✗] yyb getCode 失败: {data.get('msg', '未知错误')}")
    return None

def login_with_code(code):
    url = f"{AUTH_BASE}/api/v1/loginsession/2weichatmicroprogram"
    payload = {"jscode": code, "app_id": APP_ID, "client_code": CLIENT_CODE}
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    resp = requests.post(url, data=payload, headers=headers, timeout=15, verify=False)
    result = resp.json()
    if result.get("success") and result.get("data", {}).get("token"):
        token = result["data"]["token"]
        
        return token, result["data"]
    print(f"    [✗] 登录失败: {result.get('msg', '未知错误')}")
    return None, None

def make_headers(apitoken, unique_identity):
    return {
        "apitoken": apitoken,
        "unique_identity": unique_identity,
        "referer": f"https://servicewechat.com/{APP_ID}/41/page-frame.html",
    }

def get_sign_activity(apitoken, unique_identity):
    url = f"{SIGN_BASE}/api/v1/signin"
    params = {"status": "30", "pageNum": "1", "pageSize": "1"}
    resp = requests.get(url, params=params, headers=make_headers(apitoken, unique_identity),
                        timeout=15, verify=False)
    data = resp.json()
    if data.get("success") and data.get("data"):
        activity = data["data"][0]["activitydto"]
        print(f"    [✓] 签到活动: {activity['activity_name']}")
        return activity
    print(f"    [✗] 获取活动失败: {data.get('msg', '未知错误')}")
    return None

def get_user_sign_info(apitoken, unique_identity, activity_id):
    url = f"{SIGN_BASE}/api/v1/signin/userinfo"
    params = {"task_id": activity_id}
    resp = requests.get(url, params=params, headers=make_headers(apitoken, unique_identity),
                        timeout=15, verify=False)
    data = resp.json()
    if data.get("success") and data.get("data"):
        info = data["data"]
        print(f"    [✓] 累计签到: {info.get('total_signindays', 0)} 天, "
              f"连续签到: {info.get('continuity_signindays', 0)} 天")
        return info
    print(f"    [✗] 查询签到信息失败: {data.get('msg', '未知错误')}")
    return None

def is_today_signed(info):
    latest = info.get("latest_signin_time") if info else None
    if not latest:
        return False
    return datetime.now().strftime("%Y-%m-%d") == latest[:10]

def do_sign(apitoken, unique_identity, activity_id):
    url = f"{SIGN_BASE}/api/v1/signin/signbyuser"
    headers = make_headers(apitoken, unique_identity)
    headers["content-type"] = "application/x-www-form-urlencoded"
    resp = requests.post(url, data={"task_id": activity_id}, headers=headers,
                         timeout=15, verify=False)
    result = resp.json()
    if result.get("success"):
        print(f"    [✓] 签到成功! {result.get('data', '')}")
        return True
    print(f"    [✗] 签到失败: {result.get('msg', '未知错误')}")
    return False

def get_task_detail(apitoken, unique_identity, task_id):
    url = f"{SIGN_BASE}/api/v1/task/detail/{task_id}"
    resp = requests.get(url, headers=make_headers(apitoken, unique_identity),
                        timeout=15, verify=False)
    data = resp.json()
    if data.get("success") and data.get("data"):
        return data["data"]
    print(f"    [✗] 查询任务详情失败: {data.get('msg', '未知错误')}")
    return None

def do_task_join(apitoken, unique_identity, task_id):
    url = f"{SIGN_BASE}/api/v1/task/join"
    resp = requests.get(url, params={"task_id": task_id},
                        headers=make_headers(apitoken, unique_identity),
                        timeout=15, verify=False)
    data = resp.json()
    if data.get("success"):
        print(f"    [✓] 任务完成! {data.get('data', '')}")
        return True
    print(f"    [✗] 任务失败: {data.get('msg', '未知错误')}")
    return False

def process_daily_tasks(apitoken, unique_identity):
    print(f"  [→] 任务中心 ({len(DAILY_TASKS)} 个每日任务)...")
    task_ok = 0
    for task_cfg in DAILY_TASKS:
        detail = get_task_detail(apitoken, unique_identity, task_cfg["id"])
        if not detail:
            continue
        if detail.get("complete_status") == 1 and detail.get("complete_count", 0) >= detail.get("allow_complete_count", 1):
            print(f"    [✓] {task_cfg['name']} ({task_cfg['reward']}) → 今日已完成")
            task_ok += 1
        else:
            print(f"    [→] {task_cfg['name']} ({task_cfg['reward']}) → 未完成, 执行中...")
            if do_task_join(apitoken, unique_identity, task_cfg["id"]):
                task_ok += 1
    return task_ok

def is_friday():
    return datetime.now().weekday() == 4

def treasure_friday_check(apitoken, unique_identity):
    headers = make_headers(apitoken, unique_identity)

    print(f"    [→] 数据上报...")
    try:
        resp = requests.post(f"{ACT_BASE}/api/v1/act/data/pu", data="a=1",
                             headers={**headers, "content-type": "application/x-www-form-urlencoded"},
                             timeout=15, verify=False)
        if resp.json().get("success"):
            print(f"    [✓] 数据上报成功")
    except Exception as e:
        print(f"    [⚠] 数据上报异常: {e}")

    print(f"    [→] 检查活动状态...")
    resp = requests.get(f"{ACT_BASE}/api/v1/act/check",
                        params={"act_code": TREASURE_FRIDAY_ACT_CODE},
                        headers=headers, timeout=15, verify=False)
    check_data = resp.json()
    if not check_data.get("success"):
        print(f"    [✗] 活动检查失败: {check_data.get('msg', '未知错误')}")
        return False, None

    act_check = check_data.get("data", {})
    if act_check.get("act_status") != 1:
        print(f"    [✗] 活动未在进行中, 跳过")
        return False, None
    print(f"    [✓] 活动进行中, 抽奖时段: {act_check.get('lottery_stime')} ~ {act_check.get('lottery_etime')}")

    print(f"    [→] 查询今日抽奖次数...")
    resp = requests.get(f"{ACT_BASE}/api/v1/act/lottery/data/todaycount",
                        params={"act_code": TREASURE_FRIDAY_ACT_CODE},
                        headers=headers, timeout=15, verify=False)
    count_data = resp.json()
    if count_data.get("success"):
        today_count = count_data.get("data", 0)
        max_count = act_check.get("user_max_scan_count_perday", 1)
        print(f"    [✓] 今日已抽: {today_count}/{max_count} 次")
        if today_count >= max_count:
            print(f"    [✓] 今日抽奖次数已用完")
            return False, None
    return True, act_check

def do_treasure_friday_lottery(apitoken, unique_identity):
    headers = make_headers(apitoken, unique_identity)
    headers["content-type"] = "application/json"
    payload = {"code": TREASURE_FRIDAY_SCENE_CODE, "scene_code": TREASURE_FRIDAY_SCENE_CODE}
    resp = requests.post(f"{LOTTERY_BASE}/api/v1/marketinglottery", json=payload,
                         headers=headers, timeout=15, verify=False)
    result = resp.json()
    if result.get("success"):
        prizedto = result.get("data", {}).get("prizedto", {})
        print(f"    [🎉] 抽奖成功! 奖品: {prizedto.get('prize_name', '未知')} ({prizedto.get('prize_level', '')})")
        return True
    msg = result.get("msg", "未知错误")
    if "次数已经达到最大" in msg:
        print(f"    [✓] 今日抽奖次数已用完")
    else:
        print(f"    [✗] 抽奖失败: {msg}")
    return False

def process_account(account):
    ref = str(account.get("id", ""))
    nickname = account.get("nickname", "未知")
    openid = account.get("openid", "")
    alias = account.get("alias", "")
    display_name = nickname or alias or openid[:16]
    print(f"\n  📱 账号: {display_name}")

    
    code = yyb_get_code(ref)
    if not code:
        print(f"  [✗] 获取 code 失败, 跳过此账号")
        return False

    print(f"  [2/6] 登录加多宝...")
    apitoken, _ = login_with_code(code)
    if not apitoken:
        return False

    unique_identity = uuid.uuid5(uuid.NAMESPACE_DNS, f"jdb-{openid}").hex

    print(f"  [3/6] 查询签到活动...")
    activity = get_sign_activity(apitoken, unique_identity)
    if not activity:
        return False

    print(f"  [4/6] 检查签到状态...")
    info = get_user_sign_info(apitoken, unique_identity, activity["id"])
    sign_ok = True
    if is_today_signed(info):
        print(f"  [✓] 今天已签到, 无需重复操作")
    else:
        print(f"  [→] 今日未签到, 执行签到...")
        sign_ok = do_sign(apitoken, unique_identity, activity["id"])

    print(f"  [5/6] 每日任务中心...")
    process_daily_tasks(apitoken, unique_identity)

    if is_friday():
        print(f"  [6/6] 🎰 今天是星期五! 参与宝藏星期五抽奖...")
        available, _ = treasure_friday_check(apitoken, unique_identity)
        if available:
            do_treasure_friday_lottery(apitoken, unique_identity)
        else:
            print(f"  [✓] 宝藏星期五: 无需操作")
    else:
        print(f"  [6/6] 跳过 (宝藏星期五仅在每周五开放)")

    return sign_ok

def main():
    print("=" * 56)
    print("  加多宝Club 自动签到 (YYB版)")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    today_name = ["一", "二", "三", "四", "五", "六", "日"][datetime.now().weekday()]
    print(f"  星期{today_name}", end="")
    if is_friday():
        print(" 🎰 宝藏星期五!", end="")
    print()
    print("=" * 56)

    print("\n[1/2] 获取 YYB 账号列表...")
    accounts = yyb_get_accounts()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        print(f"  请先通过 yyb 扫码登录添加账号: POST {YYB_BASE}/qr")
        return

    # 如果指定了 YYB_REF，只处理指定账号
    if YYB_REF:
        accounts = [a for a in accounts if str(a.get("id")) == YYB_REF or a.get("openid") == YYB_REF]
        if not accounts:
            print(f"[✗] 未找到 ref={YYB_REF} 的账号")
            return
        print(f"[✓] 指定账号, 共 1 个\n")
    else:
        print(f"[✓] 共 {len(accounts)} 个账号\n")

    success_count = 0
    for i, account in enumerate(accounts, 1):
        print(f"[{i}/{len(accounts)}] {'=' * 40}")
        if process_account(account):
            success_count += 1
        if i < len(accounts):
            time.sleep(2)

    print("\n" + "=" * 56)
    print(f"  完成! {success_count}/{len(accounts)} 个账号签到成功")
    print("=" * 56)

if __name__ == "__main__":
    main()