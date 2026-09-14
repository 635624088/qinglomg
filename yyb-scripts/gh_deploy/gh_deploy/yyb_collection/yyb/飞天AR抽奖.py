#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞天AR(LZ飞天) 自动签到 + 抽奖 + 领卡 + 开宝箱 + 勋章合成 (YYB版)

入口: 微信小程序搜索"LZ飞天"
功能: 每日签到 + code登录 + 分享 + 拍照 + 观看 + 领卡 + 宝箱开奖 + 勋章合成

环境变量:
  YYB_BASE_URL  YYB 服务地址 (默认 http://172.17.0.1:18080)
  YYB_REF       指定账号 ref (可选，默认遍历所有账号)
  SHARE_TIMES   分享次数 (默认 1)
  PHOTO_TIMES   拍照触发次数 (默认 2)
  WATCH_TIMES   观看视频触发次数 (默认 2)
  BUSINESS_BASE_URL  业务服务器地址 (默认 https://gszy.baijqr.cn)
"""

import json
import os
import random
import time
from datetime import datetime

import requests
import hashlib

# ====== YYB 配置 ======
YYB_BASE = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "") or None
# ======================

# ====== 业务常量 ======
APP_NAME = "飞天AR"
APPID = "wxda7924fb8811699c"
ACTIVITY_ID = "505"
SOURCE = "20260608"
CLAIM_TYPE = 1
POINT = "800"
LNG = "113.67161781151727"
LAT = "34.7496537875549"
CHANCE_SOURCE = "points"
GAME_DELAY = 1
BUSINESS_BASE_URL = os.getenv("BUSINESS_BASE_URL", "https://gszy.baijqr.cn")
# ======================

# ====== 可配置参数 ======
def get_env_int(key, default):
    val = os.getenv(key, "")
    try:
        return int(val) if val else default
    except:
        return default

SHARE_TIMES = get_env_int("SHARE_TIMES", 1)
SHARE_INTERVAL = get_env_int("SHARE_INTERVAL", 90)
PHOTO_TIMES = get_env_int("PHOTO_TIMES", 2)
WATCH_TIMES = get_env_int("WATCH_TIMES", 2)
TRIGGER_INTERVAL = get_env_int("TRIGGER_INTERVAL", 5)
WATCH_INTERVAL = get_env_int("WATCH_INTERVAL", 3)
# ======================

# ====== 基础请求头 ======
BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/19201 miniProgram/wxda7924fb8811699c",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Origin": "https://gszy.baijqr.cn",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Accept-Language": "zh-CN,zh;q=0.9"
}


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    """从 YYB 服务获取已保存的微信账号列表"""
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"  [✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    """通过 YYB 服务获取微信小程序 code"""
    payload = {"ref": ref, "app_id": APPID}
    resp = requests.post(f"{YYB_BASE}/wxapp/getCode", json=payload, timeout=30)
    data = resp.json()
    if data.get("code") == 0:
        result = data.get("data", {}).get("result", {})
        code = result.get("code")
        if code:
            return code
        print(f"    [✗] getCode 返回中没有 code: {json.dumps(result, ensure_ascii=False)}")
        return None
    print(f"    [✗] YYB getCode 失败: {data.get('msg', '未知错误')}")
    return None
# ==========================


# ====================== 星河风格 code 登录 ======================
def login_with_code(wxcode):
    """
    星河风格登录：code -> openid -> 业务服务器wxLogin -> userToken
    返回 userToken，失败返回 None
    """
    try:
        # 1. 获取 openid
        url = f"{BUSINESS_BASE_URL}/api/cloud2.member.api/wx/getOpenId"
        params = {"code": wxcode, "t": int(time.time() * 1000)}
        print(f"    [→] 请求 getOpenId...")
        resp = requests.get(url, params=params, timeout=10)
        if resp.status_code != 200:
            print(f"    [✗] getOpenId HTTP {resp.status_code}")
            return None
        openid_data = resp.json()
        if openid_data.get("code") != 200:
            print(f"    [✗] getOpenId 业务失败: {openid_data.get('msg', '')}")
            return None
        openid = openid_data["data"]["openid"]
        unionid = openid_data["data"].get("unionid", "")
        print(f"    [✓] 获取到 openid: {openid[:16]}...")

        # 2. 使用 openid 登录业务服务器
        login_data = {
            "openId": openid,
            "comId": "164",
            "nickname": "微信用户",
            "sex": "0",
            "accessToken": "",
            "refreshToken": "",
            "headImgUrl": "",
            "province": "",
            "city": "",
            "unionId": unionid,
            "materialsId": "",
            "provinceUser": "",
            "cityUser": "",
            "barcode": "",
            "inviterId": "",
            "source": "routine",
        }
        resp = requests.post(
            f"{BUSINESS_BASE_URL}/api/cloud2.member.api/member/userInfo/wxLogin",
            data=login_data,
            timeout=10,
        )
        if resp.status_code != 200:
            print(f"    [✗] wxLogin HTTP {resp.status_code}")
            return None
        login_result = resp.json()
        if login_result.get("code") == 200 and login_result.get("data"):
            userToken = login_result["data"].get("userToken")
            if userToken:
                print(f"    [✓] 登录成功, userToken: {userToken[:20]}...")
                return userToken
        print(f"    [✗] wxLogin 业务失败: {login_result.get('msg', '')}")
        return None
    except Exception as e:
        print(f"    [✗] 登录异常: {e}")
    return None


# ====================== 签到功能 ======================
def daily_sign_in_from_token(user_token, wxcode):
    """每日签到（登录后调用，用 userToken + 当前账号的 wx.login code）"""
    try:
        # 1. 检查签到记录
        url = f"{BUSINESS_BASE_URL}/api/cloud2.member.api/userSignInPointMall/getSignInRecord"
        params = {"time": int(time.time() * 1000), "userToken": user_token}
        resp = requests.get(url, params=params, timeout=10)
        data = resp.json()
        if data.get("code") == 200:
            sign_flag = data["data"].get("signFlag", True)
            keep_days = data["data"].get("keepSignInDays", 0)
            if not sign_flag:
                print(f"    [✓] 今日已签到 (连续 {keep_days} 天), 跳过")
                return True
        else:
            print(f"    [⚠] 获取签到记录失败: {data.get('msg', '')}")

        # 2. 检查是否断签
        check_url = f"{BUSINESS_BASE_URL}/api/cloud2.member.api/userSignInPointMall/checkSignInInterrupt"
        check_params = {"time": int(time.time() * 1000), "userToken": user_token}
        requests.get(check_url, params=check_params, timeout=10)

        # 3. 执行签到（用当前账号的 code，不是硬编码的）
        sign_url = f"{BUSINESS_BASE_URL}/api/cloud2.member.api/userSignInPointMall/signIn"
        sign_params = {"code": wxcode, "userToken": user_token}
        resp = requests.get(sign_url, params=sign_params, timeout=10)
        result = resp.json()
        if result.get("code") == 200:
            config_name = result["data"].get("configName", "")
            prize_num = result["data"].get("prizeNum", 0)
            keep_days = result["data"].get("keepSignInDays", 0)
            print(f"    [✓] 签到成功: {result.get('msg', '')} (连续{keep_days}天)")
            return True
        else:
            print(f"    [✗] 签到失败: {result.get('msg', '')}")
            return False
    except Exception as e:
        print(f"    [✗] 签到异常: {e}")
        return False


# ====================== 业务函数 ======================
def get_share_id(user_token):
    url = f"{BUSINESS_BASE_URL}/cloud2.activity.api/common/activity/getShareInfo"
    params = {"activityId": ACTIVITY_ID, "source": SOURCE, "userToken": user_token}
    try:
        resp = requests.get(url, params=params, headers=BASE_HEADERS, timeout=15)
        res = resp.json()
        if res.get("code") == 200:
            return res["data"]["shareId"]
        print(f"    [✗] 获取shareId失败: {res.get('msg', '')}")
        return None
    except Exception as e:
        print(f"    [✗] 获取shareId异常: {e}")
        return None


def do_share(user_token, share_id):
    url = f"{BUSINESS_BASE_URL}/cloud2.activity.api/common/activity/share"
    params = {"activityId": ACTIVITY_ID, "source": SOURCE, "userToken": user_token, "shareId": share_id}
    try:
        resp = requests.get(url, params=params, headers=BASE_HEADERS, timeout=15)
        res = resp.json()
        code = res.get("code")
        if code == 200:
            print(f"      [✓] 分享请求成功")
            return True
        elif code == 202:
            print(f"      [⚠] 触发限流: {res.get('msg', '')}")
            return False
        print(f"      [✗] 分享失败: {res.get('msg', '')}")
        return False
    except Exception as e:
        print(f"      [✗] 分享接口异常: {e}")
        return False


def trigger_once(user_token, trigger_type):
    url = f"{BUSINESS_BASE_URL}/api/cloud2.activity.api/market/postStation/redisVideo"
    params = {"userToken": user_token, "actId": ACTIVITY_ID, "type": trigger_type, "init": "false"}
    try:
        resp = requests.post(url, params=params, headers=BASE_HEADERS, timeout=15)
        res = resp.json()
        return res.get("code") == 200
    except Exception:
        return False


def claim_next_card(user_token, unowned_ids, all_ids, juan_list):
    if unowned_ids:
        target_id = unowned_ids[0]
        is_new = True
    else:
        target_id = random.choice(all_ids)
        is_new = False
    target_name = next((j["name"] for j in juan_list if j["id"] == target_id), f"ID{target_id}")
    wait_time = WATCH_INTERVAL + random.randint(0, 5)
    time.sleep(wait_time)
    url = f"{BUSINESS_BASE_URL}/api/cloud2.activity.api/market/postStation/save"
    params = {"userToken": user_token, "actId": ACTIVITY_ID, "postId": target_id, "type": CLAIM_TYPE}
    try:
        resp = requests.post(url, params=params, headers=BASE_HEADERS, timeout=15)
        res = resp.json()
        success = res.get("code") == 200
        msg = res.get("msg", "")
        is_limit = "兑换达到上限" in msg
        return success, msg, is_new, target_id, target_name, is_limit
    except Exception as e:
        return False, str(e), is_new, target_id, target_name, False


def get_collect_info(user_token):
    url = f"{BUSINESS_BASE_URL}/api/cloud2.activity.api/market/postStation/query"
    params = {"userToken": user_token, "actId": ACTIVITY_ID}
    try:
        resp = requests.post(url, params=params, headers=BASE_HEADERS, timeout=15)
        res = resp.json()
        if res.get("code") == 200:
            data = res["data"]
            return {
                "juan_has_count": data["juanHasCount"],
                "juan_total": data["juanTotal"],
                "percent": data["percent"],
                "xz_has_count": data["xzHasCount"],
                "juan_list": data["juanArray"],
                "xz_list": data["xzArray"]
            }
        return None
    except Exception:
        return None


def open_game_box(user_token, box_id):
    url = f"{BUSINESS_BASE_URL}/cloud2.activity.api/common/activity/openGame"
    data = {"activityId": ACTIVITY_ID, "userToken": user_token, "special": box_id}
    try:
        resp = requests.post(url, headers=BASE_HEADERS, data=data, timeout=15)
        res = resp.json()
        if res.get("code") == 200:
            return res.get("data", {}).get("gameId")
        print(f"        [✗] 开启失败: {res.get('msg', '')}")
        return None
    except Exception as e:
        print(f"        [✗] 开启异常: {e}")
        return None


def end_game_draw(user_token, game_id, point=None, chance_source=None):
    url = f"{BUSINESS_BASE_URL}/cloud2.activity.api/common/activity/endGame"
    headers = BASE_HEADERS.copy()
    headers["notCatch"] = "true"
    data = {
        "userToken": user_token,
        "activityId": ACTIVITY_ID,
        "source": SOURCE,
        "gameId": game_id,
        "point": point or POINT,
        "lng": LNG,
        "lat": LAT,
        "chanceSource": chance_source or CHANCE_SOURCE
    }
    try:
        resp = requests.post(url, headers=headers, data=data, timeout=15)
        res = resp.json()
        if res.get("code") == 200:
            return res.get("data", {}).get("prizeName", "未知奖品")
        print(f"        [✗] 开奖失败: {res.get('msg', '')}")
        return None
    except Exception as e:
        print(f"        [✗] 开奖异常: {e}")
        return None


def open_all_unlocked_boxes(user_token, xz_list, xz_has_count):
    """开宝箱 - 注意 xzArray 目前是勋章数据，非宝箱"""
    prize_list = []
    if xz_has_count is not None and xz_has_count <= 0:
        print(f"    [📦] 暂无宝箱")
        return prize_list

    # xz_list 当前版本是勋章数据（3个勋章），不再有传统宝箱
    # 如果有 xz_has_count > 0，尝试开启（需要 sey 参数）
    unlocked = [box for box in xz_list if box.get("has", 0) == 1]
    if unlocked:
        print(f"    [📦] 检测到 {len(unlocked)} 个未合成勋章（不是宝箱），跳过宝箱开奖")
        return prize_list

    print(f"    [📦] 暂无已解锁的宝箱")
    return prize_list


def do_synthesis(user_token, post_id, box_name):
    """合成指定勋章，postId: 1/2/3
    返回 (success, synthesis_data)
    判断依据：API 返回 data 以 synthesis: 开头才算真正合成成功"""
    url = f"{BUSINESS_BASE_URL}/api/cloud2.activity.api/market/postStation/synthesis"
    params = {"userToken": user_token, "actId": ACTIVITY_ID, "postId": post_id}
    try:
        resp = requests.post(url, params=params, headers=BASE_HEADERS, timeout=15)
        res = resp.json()
        msg = res.get("msg", "")
        synthesis_data = res.get("data") or ""

        if "请勿重复合成" in msg or "已拥有" in msg:
            print(f"      [→] 合成【{box_name}】已完成，跳过")
            return False, None

        if res.get("code") == 200 and synthesis_data and str(synthesis_data).startswith("synthesis:"):
            print(f"      [🎖] 合成【{box_name}】成功!")
            return True, synthesis_data
        elif res.get("code") == 200:
            # 返回成功但没合成数据（材料不够等情况）
            print(f"      [⚠] 合成【{box_name}】未生效: {msg[:30]}")
            return False, None
        else:
            print(f"      [✗] 合成【{box_name}】失败: {msg}")
            return False, None
    except Exception as e:
        print(f"      [✗] 合成【{box_name}】异常: {e}")
        return False, None


def claim_medal_prize(user_token, medal_id, synthesis_data, medal_name):
    """合成成功后领取勋章奖励
    openGame + endGame 流程"""
    try:
        open_url = f"{BUSINESS_BASE_URL}/cloud2.activity.api/common/activity/openGame"
        open_data = {
            "activityId": ACTIVITY_ID,
            "userToken": user_token,
            "special": medal_id,
            "sey": synthesis_data
        }
        print(f"      [→] 打开勋章奖励...")
        resp = requests.post(open_url, headers=BASE_HEADERS, data=open_data, timeout=15)
        res = resp.json()
        code = res.get("code")
        if code != 200:
            print(f"      [✗] 打开奖励失败: {res.get('msg', '')} (code={code})")
            return None

        data = res.get("data")
        if data is None:
            print(f"      [✗] 打开奖励返回空数据")
            return None

        # data 可能是 dict 或 int
        if isinstance(data, dict):
            game_id = data.get("gameId")
            max_score = data.get("maxScoreLimit", 800)
            is_free = data.get("isFree", False)
        elif isinstance(data, (int, str)):
            # data 直接是 gameId
            game_id = int(data)
            max_score = 800
            is_free = True
        else:
            print(f"      [✗] 无法解析 openGame 响应: {str(data)[:80]}")
            return None

        if not game_id:
            print(f"      [✗] 打开奖励返回无 gameId")
            return None

        print(f"      [✓] gameId={game_id}")

        # 2. endGame - 领取奖励
        time.sleep(1)
        cs_value = "free" if is_free else "points"
        prize = end_game_draw(user_token, game_id, point=max_score, chance_source=cs_value)
        if prize:
            print(f"      [🎁] 【{medal_name}】奖励: {prize}")
            return prize
        else:
            print(f"      [✗] 【{medal_name}】领取奖励失败")
            return None
    except Exception as e:
        print(f"      [✗] 领取奖励异常: {e}")
        return None


def try_synthesis_all(user_token, xz_list):
    """尝试合成所有勋章并领取奖励 - 优先合成3(飞天至尊), 再2(探秘), 再1(初行)
    不管 has 值，都尝试合成，API 会告诉我们是否成功"""
    result = []
    names = {}
    for box in xz_list:
        names[box["id"]] = box.get("name", f"勋章{box['id']}")
    for post_id in [3, 2, 1]:
        box_name = names.get(post_id, f"勋章{post_id}")
        print(f"    [→] 尝试合成【{box_name}】...")
        success, synth_data = do_synthesis(user_token, post_id, box_name)
        if success and synth_data:
            # 合成成功且有合成数据，领取奖励
            time.sleep(1)
            prize = claim_medal_prize(user_token, post_id, synth_data, box_name)
            result.append(f"{box_name}" + (f"({prize})" if prize else ""))
        elif success and not synth_data:
            print(f"      [⚠] 合成成功但无合成数据，无法领取奖励")
        time.sleep(2)


def force_claim_card(user_token, unowned_ids, all_ids, juan_list, card_count, new_juan_count):
    success, msg, is_new, card_id, card_name, is_limit = claim_next_card(user_token, unowned_ids, all_ids, juan_list)
    if is_limit:
        print(f"      [✗] 领取【{card_name}】失败 - {msg}，今日兑换已达上限")
        return card_count, new_juan_count, True
    if success:
        card_count += 1
        if is_new and card_id in unowned_ids:
            new_juan_count += 1
            unowned_ids.remove(card_id)
            print(f"      [✓] 解锁新卡【{card_name}】")
        else:
            print(f"      [✓] 领取【{card_name}】成功（重复卡）")
    else:
        print(f"      [✗] 领取【{card_name}】失败 - {msg}")
    return card_count, new_juan_count, False


# ====================== 单账号处理 ======================
def process_account(account):
    """处理单个账号"""
    ref = str(account.get("id", ""))
    nickname = account.get("nickname", "未知")
    openid = account.get("openid", "")
    alias = account.get("alias", "")
    display_name = nickname or alias or openid[:16]
    print(f"\n  📱 账号: {display_name}")

    # [0/6] 每日签到（用 openid 可独立签到，不需要 userToken）

    # [1/6] 获取 wx.login code
    print(f"  [1/6] 获取 wx.login code...")
    code = yyb_get_code(ref)
    if not code:
        print(f"  [✗] 获取 code 失败, 跳过此账号")
        return
    print(f"  [✓] code 获取成功: {code[:10]}...")

    # [2/6] 登录飞天AR
    print(f"  [2/6] 登录 {APP_NAME}...")
    user_token = login_with_code(code)
    if not user_token:
        print(f"  [✗] 登录失败, 跳过此账号")
        return

    # 签到（登录后调用，用 userToken + 新获取的 wx.login code）
    print(f"  [签到] 每日签到...")
    sign_code = yyb_get_code(ref)
    if sign_code:
        sign_result = daily_sign_in_from_token(user_token, sign_code)
    else:
        print(f"    [✗] 获取签到 code 失败, 跳过签到")
    time.sleep(1)

    # 获取初始进度
    init_info = get_collect_info(user_token)
    if init_info:
        print(f"  [📊] 初始进度: 券卡 {init_info['juan_has_count']}/{init_info['juan_total']} 种, 进度 {init_info['percent']}%, 宝箱 {init_info['xz_has_count']} 个")
    else:
        print(f"  [📊] 无法获取初始进度，继续执行")

    # 检查是否3个勋章都已合成——已合成就跳过集券任务
    all_medals_done = False
    if init_info and init_info["xz_list"]:
        medals = init_info["xz_list"]
        all_medals_done = all(box.get("has", 0) == 1 for box in medals)
        if all_medals_done:
            print(f"  [📊] 3个勋章已全部合成，跳过集券任务")

    juan_list = init_info["juan_list"] if init_info else []
    unowned_ids = [j["id"] for j in juan_list if j.get("has", 0) == 0]
    all_ids = [j["id"] for j in juan_list] if juan_list else list(range(1, 15))

    card_count = 0
    new_juan_count = 0
    is_day_limit = False
    share_success_count = 0

    # [3/6] 分享任务（勋章全合成则跳过）
    if not all_medals_done:
        # [3/6] 分享任务
        print(f"  [3/6] 分享任务 (共{SHARE_TIMES}次)")
        if not is_day_limit:
            share_id = get_share_id(user_token)
            if share_id:
                for i in range(SHARE_TIMES):
                    if do_share(user_token, share_id):
                        share_success_count += 1
                    if i < SHARE_TIMES - 1:
                        time.sleep(SHARE_INTERVAL + random.randint(0, 10))
                # 分享后领卡
                card_count, new_juan_count, is_day_limit = force_claim_card(user_token, unowned_ids, all_ids, juan_list, card_count, new_juan_count)

        # [4/6] 拍照 + 观看任务
        if not is_day_limit:
            print(f"\n  [4/6] 拍照任务 (共{PHOTO_TIMES}次) + 观看视频 (共{WATCH_TIMES}次)")
            # 拍照
            for i in range(PHOTO_TIMES):
                print(f"    第{i+1}次拍照触发")
                trigger_once(user_token, 0)
                time.sleep(TRIGGER_INTERVAL)
                card_count, new_juan_count, is_day_limit = force_claim_card(user_token, unowned_ids, all_ids, juan_list, card_count, new_juan_count)
                if is_day_limit:
                    break

            # 观看视频
            if not is_day_limit:
                for i in range(WATCH_TIMES):
                    print(f"    第{i+1}次观看触发")
                    trigger_once(user_token, 1)
                    time.sleep(TRIGGER_INTERVAL)
                    card_count, new_juan_count, is_day_limit = force_claim_card(user_token, unowned_ids, all_ids, juan_list, card_count, new_juan_count)
                    if is_day_limit:
                        break

        print(f"\n  [📊] 本轮领卡: 成功 {card_count} 张, 新增 {new_juan_count} 种")

        # [5/6] 宝箱开奖
        print(f"  [5/6] 宝箱开奖...")
        final_info = get_collect_info(user_token)
        prize_result = []
        if final_info:
            add_juan = final_info["juan_has_count"] - init_info["juan_has_count"] if init_info else 0
            print(f"  [📊] 当前进度: 券卡 {final_info['juan_has_count']}/{final_info['juan_total']} 种, 进度 {final_info['percent']}%, 本次新增 {add_juan} 种")
            prize_result = open_all_unlocked_boxes(user_token, final_info["xz_list"], final_info.get("xz_has_count"))

        print(f"\n  [📊] 账号【{display_name}】任务完成: 分享{share_success_count}次, 领卡{card_count}张")
        if prize_result:
            print(f"  [🎁] 宝箱中奖: {' | '.join(prize_result)}")
    else:
        print(f"  [→] 勋章已全部合成，跳过集券任务（分享/拍照/观看/宝箱）")

    # [6/6] 勋章合成（直接尝试合成 postId 1-3，已合成的 API 会拒绝）
    print(f"  [6/6] 勋章合成...")
    synthesis_info = get_collect_info(user_token)
    if synthesis_info:
        xz_list = synthesis_info["xz_list"]
        print(f"    [→] 尝试合成 3 个勋章...")
        synth_result = try_synthesis_all(user_token, xz_list)
        if synth_result:
            print(f"    [🎖] 勋章合成 + 领奖完成")
            for r in synth_result:
                print(f"      {r}")
        else:
            print(f"    [→] 全部勋章已合成完成或无法合成")
    else:
        print(f"    [✗] 获取勋章信息失败")

    # 最终进度
    final_info2 = get_collect_info(user_token)
    if final_info2:
        print(f"\n  [📊] 最终进度: 券卡 {final_info2['juan_has_count']}/{final_info2['juan_total']} 种, 进度 {final_info2['percent']}%")


# ====================== 主入口 ======================
def main():
    print("=" * 56)
    print(f"  {APP_NAME} 自动签到+抽奖+领卡+开宝箱+勋章合成 (YYB版)")
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

    print("功能: 每日签到 → 分享/拍照/观看领卡 → 宝箱开奖 → 勋章合成")

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
