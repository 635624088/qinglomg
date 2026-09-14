#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
蒙牛低溫商城 好友助力 + 批量抽奖 (YYB版)

入口: 微信小程序搜索"蒙牛低溫商城" (appid: wx75337e78a6e70d40)
功能: 多账号互相助力 + 完成任务 + 转盘抽奖

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
APP_NAME = "蒙牛低溫商城"
APPID = "wx75337e78a6e70d40"
API_BASE = "https://diwen-prod.mengniu.cn"
# ======================

# ====== 通用请求头 ======
def make_headers(token=None):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541b35) XWEB/20089",
        "uuid": str(int(time.time() * 1000)),
        "Content-Type": "application/json",
    }
    if token:
        headers["accessToken"] = token
    return headers
# ==========================


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"[✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    payload = {"ref": ref, "app_id": APPID}
    resp = requests.post(f"{YYB_BASE}/wxapp/getCode", json=payload, timeout=30)
    data = resp.json()
    if data.get("code") == 0:
        result = data.get("data", {}).get("result", {})
        code = result.get("code")
        if code:
            return code
        return None
    return None
# ==========================


# ====== 蒙牛 API 封装 ======
def api_auto_login(code):
    """使用 wx.login code 自动登录，获取 accessToken 和 memberId"""
    url = f"{API_BASE}/buyer/passport/member/auto-login"
    params = {"code": code}
    try:
        resp = requests.get(url, params=params, headers=make_headers(), timeout=15)
        data = resp.json()
        if data.get("success") and data.get("result", {}).get("accessToken"):
            token = data["result"]["accessToken"]
            member_id = None
            try:
                import base64
                payload_b64 = token.split(".")[1]
                payload_b64 += "=" * (4 - len(payload_b64) % 4)
                payload_decoded = json.loads(base64.b64decode(payload_b64))
                user_context = json.loads(payload_decoded.get("userContext", "{}"))
                member_id = user_context.get("id")
            except Exception:
                pass
            return token, member_id
        return None, None
    except Exception as e:
        print(f" [✗] auto-login 请求异常: {e}")
        return None, None


def api_get_member(token):
    """获取会员信息"""
    url = f"{API_BASE}/buyer/passport/member"
    headers = make_headers(token)
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        data = resp.json()
        if data.get("success"):
            return data.get("result")
        return None
    except Exception as e:
        print(f" [✗] 获取会员信息异常: {e}")
        return None


def api_agree_privacy(token):
    """同意隐私协议"""
    url = f"{API_BASE}/buyer/passport/member/agreePrivacy"
    headers = make_headers(token)
    try:
        resp = requests.post(url, headers=headers, json={}, timeout=10)
        data = resp.json()
        if data.get("success"):
            return True
        return False
    except Exception as e:
        print(f" [✗] 同意隐私协议异常: {e}")
        return False


def api_get_draw_chance(token):
    """获取剩余抽奖次数"""
    url = f"{API_BASE}/buyer/activity/turntable-draw/chance"
    headers = make_headers(token)
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        data = resp.json()
        if data.get("success"):
            result = data.get("result", {})
            return result.get("remainDrawTimes", 0), result.get("totalDrawTimes", 0)
        return 0, 0
    except Exception as e:
        print(f" [✗] 获取抽奖次数异常: {e}")
        return 0, 0


def api_get_tasks(token):
    """获取任务列表"""
    url = f"{API_BASE}/buyer/activity/turntable-draw/tasks"
    headers = make_headers(token)
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        data = resp.json()
        if data.get("success"):
            return data.get("result", [])
        return []
    except Exception as e:
        print(f" [✗] 获取任务列表异常: {e}")
        return []


def api_draw(token):
    """执行抽奖"""
    url = f"{API_BASE}/buyer/activity/turntable-draw/draw"
    headers = make_headers(token)
    try:
        resp = requests.post(url, headers=headers, json={}, timeout=10)
        data = resp.json()
        if data.get("success"):
            return data.get("result", {})
        return None
    except Exception as e:
        print(f" [✗] 抽奖请求异常: {e}")
        return None


def api_task_view_point_mall(token):
    """完成任务：浏览商城"""
    url = f"{API_BASE}/buyer/activity/turntable-draw/task/view-point-mall"
    headers = make_headers(token)
    try:
        resp = requests.post(url, headers=headers, json={}, timeout=10)
        data = resp.json()
        if data.get("success"):
            return data.get("result", False)
        return False
    except Exception as e:
        print(f" [✗] 浏览商城任务异常: {e}")
        return False


def api_task_share_help(token, owner_member_id):
    """完成任务：分享好友助力"""
    url = f"{API_BASE}/buyer/activity/turntable-draw/task/share-help"
    headers = make_headers(token)
    payload = {"ownerMemberId": owner_member_id}
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=10)
        data = resp.json()
        if data.get("success"):
            return data.get("result", False)
        return False
    except Exception as e:
        print(f" [✗] 分享助力任务异常: {e}")
        return False
# ============================


def login_account(account):
    """登录一个账号，返回 (token, member_id, display_name)"""
    ref = str(account.get("id", ""))
    nickname = account.get("nickname", "未知")
    openid = account.get("openid", "")
    alias = account.get("alias", "")
    display_name = nickname or alias or openid[:16]

    code = yyb_get_code(ref)
    if not code:
        return None, None, display_name

    token, member_id = api_auto_login(code)
    if not token:
        return None, None, display_name

    api_agree_privacy(token)
    return token, member_id, display_name


def process_account(token, member_id, display_name, all_member_ids):
    """处理单个账号的助力 + 任务 + 抽奖"""
    print(f"\n 📱 账号: {display_name} (memberId: {member_id})")

    # 1. 查看任务列表
    tasks = api_get_tasks(token)
    if tasks:
        for t in tasks:
            print(f" - {t['taskName']}: {t['doneCount']}/{t['dailyLimit']} {'[✓]' if t['completed'] else '[ ]'}")

    # 2. 完成任务：浏览商城
    print(f" [2/4] 执行浏览商城任务...")
    view_task = next((t for t in tasks if t.get("taskType") == "VIEW_POINT_MALL" and not t.get("completed")), None)
    if view_task:
        result = api_task_view_point_mall(token)
        print(f" {'[✓]' if result else '[✗]'} 浏览商城任务{'完成' if result else '失败'}")
    else:
        print(f" [→] 浏览商城任务已完成，跳过")

    # 3. 好友助力
    print(f" [3/4] 好友助力...")
    share_task = next((t for t in tasks if t.get("taskType") == "SHARE_HELP" and not t.get("completed")), None)
    if share_task and member_id:
        print(f" [→] 助力任务将在账号间互相完成")
    elif share_task and not member_id:
        print(f" [✗] 无法获取 memberId，跳过助力")
    else:
        print(f" [→] 助力任务已完成，跳过")

    # 4. 抽奖
    print(f" [4/4] 开始抽奖...")
    remain, total = api_get_draw_chance(token)
    print(f" [📊] 剩余抽奖次数: {remain}/{total}")
    if remain <= 0:
        print(f" [→] 无剩余抽奖次数")
        return

    for i in range(remain):
        print(f" [→] 第 {i+1}/{remain} 次抽奖...")
        result = api_draw(token)
        if result:
            prize_name = result.get("prizeName", "未知")
            prize_type = result.get("prizeType", 0)
            prize_num = result.get("prizeNum", 1)
            type_map = {4: "积分", 1: "优惠券", 2: "实物", 3: "谢谢参与"}
            prize_type_str = type_map.get(prize_type, f"类型{prize_type}")
            print(f" [🎁] 中奖: {prize_name} ({prize_type_str}) x{prize_num}")
        else:
            print(f" [✗] 第 {i+1} 次抽奖失败")
        if i < remain - 1:
            time.sleep(1)


def main():
    print("=" * 56)
    print(f" {APP_NAME} 好友助力 + 批量抽奖 (YYB版)")
    print(f" 时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 56)

    accounts = yyb_get_accounts()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        return

    if YYB_REF:
        accounts = [a for a in accounts if str(a.get("id")) == YYB_REF or a.get("openid") == YYB_REF]
        if not accounts:
            print(f"[✗] 未找到指定 ref: {YYB_REF}")
            return

    print(f"\n[→] 共 {len(accounts)} 个账号")

    # === 第一阶段：所有账号登录 ===
    print(f"\n{'=' * 56}")
    print(f" 第一阶段：登录所有账号")
    print(f"{'=' * 56}")
    session_data = []
    for i, account in enumerate(accounts, 1):
        print(f"\n[{i}/{len(accounts)}] {'=' * 40}")
        token, member_id, display_name = login_account(account)
        if token and member_id:
            session_data.append((token, member_id, display_name))
            print(f" [✓] {display_name} 登录成功")
        else:
            print(f" [✗] {display_name} 登录失败")
        time.sleep(1)

    if len(session_data) < 1:
        print("[✗] 没有账号登录成功")
        return

    all_member_ids = [mid for _, mid, _ in session_data]
    print(f"\n[📊] 成功登录 {len(session_data)}/{len(accounts)} 个账号")

    # === 第二阶段：互相助力 ===
    print(f"\n{'=' * 56}")
    print(f" 第二阶段：好友互相助力")
    print(f"{'=' * 56}")

    for token, member_id, display_name in session_data:
        print(f"\n 📱 为目标账号助力: {display_name}")
        tasks = api_get_tasks(token)
        share_task = next((t for t in tasks if t.get("taskType") == "SHARE_HELP" and not t.get("completed")), None)

        if not share_task:
            print(f" [→] 助力任务已完成，跳过")
            continue

        helped_count = 0
        for other_token, other_mid, other_name in session_data:
            if other_mid == member_id:
                continue
            print(f" [→] 用 {other_name} 助力 {display_name}...")
            result = api_task_share_help(other_token, member_id)
            if result:
                helped_count += 1
                print(f" [✓] 助力成功!")
            else:
                print(f" [✗] 助力失败")
            time.sleep(1)

        print(f" [📊] 共 {helped_count} 个账号助力完成")
        time.sleep(1)

    # === 第三阶段：完成任务 + 抽奖 ===
    print(f"\n{'=' * 56}")
    print(f" 第三阶段：完成任务 + 抽奖")
    print(f"{'=' * 56}")

    for i, (token, member_id, display_name) in enumerate(session_data, 1):
        print(f"\n[{i}/{len(session_data)}] {'=' * 40}")
        try:
            process_account(token, member_id, display_name, all_member_ids)
        except Exception as e:
            print(f" [✗] 账号执行异常: {e}")
        if i < len(session_data):
            time.sleep(2)

    print("\n全部任务执行完毕!")


if __name__ == "__main__":
    main()
