#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
拼多多果园 - 自动浇水领水滴

功能:
  ✔ 每日签到
  ✔ 自动浇水 (每次最多50次，每次消耗10水滴)
  ✔ 领取/接受任务奖励
  ✔ 偷好友水滴 (自动尝试3个狗位)
  ✔ 多账号支持



环境变量:

  YYB_BASE_URL  - wx_server 地址 (方式二)


依赖:
  pip install requests
  可选: pip install curl_cffi
"""

import os
import sys
import json
import time
import random
import re
import warnings
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any

try:
    import requests as _requests
except ImportError:
    print("[错误] 请先安装 requests: pip install requests")
    sys.exit(1)

# 尝试导入 curl_cffi (更好的指纹模拟)
USE_CFFI = False
try:
    from curl_cffi import requests as _curl_requests
    USE_CFFI = True
except ImportError:
    pass

# ============================================================
#  配置区 —— 可直接修改下方变量，或通过环境变量传入
# ============================================================

# APP 信息
PDD_MINI_APP_ID = "wx32540bd863b27570"
PDD_XCX_VERSION = "v8.6.21"
PDD_APP_ID = 33

# API 端点
MANOR_BASE = "https://mobile.yangkeduo.com/proxy/api/api"
LOGIN_BASE = "https://api.pinduoduo.com"

# 用户代理 (模拟微信小程序 Windows 环境)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) "
    "NetType/WIFI MiniProgramEnv/Windows "
    "WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf254193e) XWEB/19841"
)

# === 方式一: 直接填写 Cookie ===
# 包含 PDDAccessToken; pdd_user_id; pdd_user_uin 等
# 示例: "PDDAccessToken=xxx; pdd_user_id=123456; pdd_user_uin=xxx; ..."
COOKIE = ""

# === 或者分开填写 ===
PDD_USER_ID = ""
PDD_USER_UIN = ""
PDD_ACCESS_TOKEN = ""

# 缓存文件
TOKEN_CACHE = "./pdd_token_cache.json"
COOKIE_CACHE = "./pdd_cookie_cache.json"

# ============================================================
#  读取环境变量
# ============================================================

OPENID_RAW = os.environ.get("PDD_OPENID", "").strip()
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080").strip().rstrip("/")
WX_AUTH = os.environ.get("wx_auth", "").strip()

def build_cookie_from_parts(user_id: str, access_token: str, user_uin: str = "") -> str:
    """用分开的字段组装 Cookie"""
    user_id, access_token, user_uin = user_id.strip(), access_token.strip(), user_uin.strip()
    if not user_id or not access_token:
        return ""
    parts = [f"PDDAccessToken={access_token}", f"pdd_user_id={user_id}"]
    if user_uin:
        parts.append(f"pdd_user_uin={user_uin}")
    return "; ".join(parts)

COOKIE_STR = (
    os.environ.get("PDD_COOKIE", "").strip()
    or COOKIE
    or build_cookie_from_parts(PDD_USER_ID, PDD_ACCESS_TOKEN, PDD_USER_UIN)
).strip()

# Cookie 来源说明 (仅用于日志)
COOKIE_SOURCE = (
    "PDD_COOKIE 环境变量" if os.environ.get("PDD_COOKIE", "").strip()
    else "文件内 COOKIE" if COOKIE
    else "文件内用户信息" if build_cookie_from_parts(PDD_USER_ID, PDD_ACCESS_TOKEN, PDD_USER_UIN)
    else ""
)

# ============================================================
#  工具函数
# ============================================================

def log(msg: str):
    """带时间戳的日志输出"""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

def mask(s: Any, head: int = 4, tail: int = 4) -> str:
    """脱敏显示: 只显示头尾"""
    s = str(s)
    return s if len(s) <= head + tail else s[:head] + "***" + s[-tail:]

def parse_openids(raw: str) -> List[str]:
    """解析多个 openId (支持 & 和换行分隔)"""
    if not raw:
        return []
    result = []
    for line in raw.replace("\r", "\n").split("\n"):
        for part in line.split("&"):
            p = part.strip()
            if p:
                result.append(p)
    return result

def cookie_str_to_dict(cookie_str: str) -> Dict[str, str]:
    """Cookie 字符串转字典"""
    cookies = {}
    for item in cookie_str.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies

def cookie_dict_to_str(cookies: Dict[str, str]) -> str:
    """Cookie 字典转字符串"""
    return "; ".join(f"{k}={v}" for k, v in cookies.items())

def extract_uid(cookie_str: str) -> str:
    """从 Cookie 中提取 pdd_user_id"""
    m = re.search(r'pdd_user_id=(\d+)', cookie_str)
    return m.group(1) if m else ""

# ============================================================
#  缓存
# ============================================================

def read_cache(path: str) -> Dict:
    try:
        p = Path(path)
        return json.loads(p.read_text("utf-8")) if p.exists() else {}
    except Exception:
        return {}

def write_cache(path: str, data: Dict):
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    except Exception as e:
        log(f"[缓存写入失败] {e}")

def cached_cookie(openid: str) -> str:
    entry = read_cache(COOKIE_CACHE).get(openid, {})
    return entry.get("cookie_str", "")

def save_cookie_cache(openid: str, cookie_str: str):
    c = read_cache(COOKIE_CACHE)
    c[openid] = {"cookie_str": cookie_str, "updatedAt": datetime.now().isoformat()}
    write_cache(COOKIE_CACHE, c)

# ============================================================
#  HTTP 会话
# ============================================================

def make_session():
    if USE_CFFI:
        s = _curl_requests.Session(impersonate="chrome")
    else:
        s = _requests.Session()
        s.headers.update({
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
        })
    s.headers.update({"User-Agent": UA})
    return s

# ============================================================
#  微信 Code 获取 (通过 wx_server)
# ============================================================

def get_wx_code(openid: str) -> Optional[str]:
    """通过 wx_server 获取微信小程序 code"""
    try:
        s = _requests.Session()
        headers = {"content-type": "application/json"}
        if WX_AUTH:
            headers["Authorization"] = f"Bearer {WX_AUTH}"
        r = s.post(
            f"{YYB_BASE_URL}/wxapp/getCode",
            json={"app_id": PDD_MINI_APP_ID, "ref": openid},
            headers=headers,
            timeout=30,
        )
        if r.status_code != 200:
            log(f"  [wx_server] HTTP {r.status_code}: {r.text[:200]}")
            return None
        d = r.json()
        if d.get("code") != 0:
            log(f"  [wx_server] 业务错误: {d.get('msg', '')}")
            return None
        wxcode = d.get("data", {}).get("result", {}).get("code")
        if not wxcode:
            log(f"  [wx_server] 未获取到 code: {json.dumps(d, ensure_ascii=False)[:200]}")
            return None
        return wxcode
    except Exception as e:
        log(f"  [wx_server] 异常: {e}")
        return None

def assemble_cookie(session, pdda: str, uid: str, uin: str, acid: str = "") -> str:
    """
    从登录 session 中收集所有 Cookie 字段，组装完整 Cookie 字符串。
    """
    response_cookies = {}
    try:
        for cookie in session.cookies:
            response_cookies[cookie.name] = cookie.value
    except AttributeError:
        for cookie in session.cookies:
            if hasattr(cookie, "name"):
                response_cookies[cookie.name] = cookie.value
            elif isinstance(cookie, str) and "=" in cookie:
                k, v = cookie.split("=", 1)
                response_cookies[k.strip()] = v.strip()

    parts = [f"PDDAccessToken={pdda}", f"pdd_user_id={uid}", f"pdd_user_uin={uin}"]
    if acid:
        parts.append(f"acid={acid}")
    api_uid = response_cookies.get("api_uid", "")
    if api_uid:
        parts.append(f"api_uid={api_uid}")
    for k, v in response_cookies.items():
        if k not in ("api_uid",):
            parts.append(f"{k}={v}")
    return "; ".join(parts)

def visit_garden_page(cookie_str: str) -> str:
    """
    访问果园首页以收集额外 Cookie (如 tubetoken)。
    返回更新后的 Cookie 字符串。
    """
    cookies = cookie_str_to_dict(cookie_str)
    garden_url = (
        "https://mobile.yangkeduo.com/garden_index_lz_0.html"
        "?_pdd_fs=1&_pdd_tc=676666&_pdd_sbs=1&fun_id=wechat_app_home"
    )
    try:
        s = make_session()
        s.headers.update({
            "Referer": "https://servicewechat.com/wx32540bd863b27570/1840/page-frame.html",
        })
        s.get(garden_url, cookies=cookies, timeout=15, allow_redirects=True)
        for pc in s.cookies:
            try:
                cookies[pc.name] = pc.value
            except AttributeError:
                if isinstance(pc, str) and "=" in pc:
                    k, v = pc.split("=", 1)
                    cookies[k.strip()] = v.strip()
        updated = cookie_dict_to_str(cookies)
        log(f"  [页面] 访问果园首页成功 (共 {len(cookies)} 项 Cookie)")
        return updated
    except Exception as e:
        log(f"  [页面] 访问果园首页异常 (可忽略): {e}")
        return cookie_str

# ============================================================
#  登录流程 (简化版 - 单次 /login 直接获取 access_token)
# ============================================================

def try_extract_login_result(result: dict) -> Optional[dict]:
    """
    尝试从登录响应中提取 uid/uin/access_token。
    返回 dict 或 None。
    """
    uid = result.get("uid") or result.get("data", {}).get("uid")
    access_token = result.get("access_token") or result.get("data", {}).get("access_token")
    if uid and access_token:
        return {
            "uid": str(uid),
            "uin": result.get("uin", "") or result.get("data", {}).get("uin", ""),
            "access_token": access_token,
            "acid": result.get("acid", "") or result.get("data", {}).get("acid", ""),
        }
    return None

def pdd_code_login(openid: str, max_retries: int = 3) -> Optional[Tuple[str, str, str]]:
    """
    拼多多 Code 登录 (简化版):
    单次 POST /login 即可直接获取 access_token。
    去掉 x-xcx-queries / anti_content 后登录基本100%成功。
    54002 为偶发风控, 多试几次即可。
    返回 (cookie_str, uid, uin)
    """
    for attempt in range(max_retries):
        log(f"  --- Code登录 openId={mask(openid)} 第{attempt+1}/{max_retries}次 ---")

        # 获取微信 code
        code = get_wx_code(openid)
        if not code:
            log(f"  [登录] 获取 code 失败")
            if attempt < max_retries - 1:
                time.sleep(random.uniform(3, 8))
            continue
        log(f"  [登录] code: {mask(code, 6, 6)}")

        login_body = {
            "code": code,
            "has_auth": False,
            "app_id": PDD_APP_ID,
            "support_enhance_type": 3,
            "xcx_version": PDD_XCX_VERSION,
        }
        login_headers = {
            "Content-Type": "application/json;charset=UTF-8",
            "User-Agent": UA,
            "Referer": f"https://servicewechat.com/{PDD_MINI_APP_ID}/1840/page-frame.html",
        }

        try:
            s = make_session()
            r = s.post(f"{LOGIN_BASE}/login", json=login_body, headers=login_headers,
                       timeout=20, verify=False)
            result = r.json()
        except Exception as e:
            log(f"  [登录] 请求异常: {e}")
            if attempt < max_retries - 1:
                time.sleep(random.uniform(3, 8))
            continue

        error_code = result.get("error_code", 0)

        # === 直接成功 ===
        if error_code == 0 or "access_token" in str(result):
            direct = try_extract_login_result(result)
            if direct:
                log(f"  [登录] 成功! uid={direct['uid']}")
                cookie_str = assemble_cookie(s, direct["access_token"], direct["uid"],
                                             direct["uin"], direct["acid"])
                cookie_str = visit_garden_page(cookie_str)
                return cookie_str, direct["uid"], direct["uin"]

        # === 54002 风控验证 (偶发,重试即可) ===
        if error_code == 54002:
            log(f"  [登录] 54002 风控验证, 将重试")
            if attempt < max_retries - 1:
                wait = (attempt + 1) * random.uniform(5, 15)
                log(f"  [登录] 等待 {wait:.0f}s...")
                time.sleep(wait)
            continue

        # === 43042 身份验证 ===
        if error_code == 43042:
            log(f"  [登录] 43042 需身份验证, 将重试")
            if attempt < max_retries - 1:
                wait = (attempt + 1) * random.uniform(10, 30)
                log(f"  [登录] 等待 {wait:.0f}s...")
                time.sleep(wait)
            continue

        log(f"  [登录] 失败 error_code={error_code} {result.get('error_msg', '')[:80]}")
        if attempt < max_retries - 1:
            time.sleep(random.uniform(3, 8))

    log(f"  [登录] {max_retries}次重试后仍失败")
    return None

# ============================================================
#  果园 API
# ============================================================

def make_manor_headers(pdduid: str, cookie_str: str) -> Tuple[Dict, Dict]:
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": "https://mobile.yangkeduo.com",
        "Referer": "https://mobile.yangkeduo.com/garden_index_lz_0.html",
    }
    return headers, cookie_str_to_dict(cookie_str)

def post_manor(api_path: str, pdduid: str, cookie_str: str, body: dict) -> dict:
    """通用果园 API POST 请求"""
    url = f"{MANOR_BASE}{api_path}"
    headers, cookies = make_manor_headers(pdduid, cookie_str)
    s = make_session()
    r = s.post(f"{url}?pdduid={pdduid}", headers=headers, cookies=cookies, json=body, timeout=15)
    return r.json()

def get_water(pdduid: str, cookie_str: str) -> int:
    """查询当前水滴数量"""
    result = post_manor("/manor-gateway/manor/query/user/water", pdduid, cookie_str, {})
    return result.get("water_amount", 0)

def get_home_page(pdduid: str, cookie_str: str, tubetoken: str) -> Tuple[Optional[str], int]:
    """获取果园首页数据，刷新 tubetoken"""
    result = post_manor("/manor-query/proxy/home/page", pdduid, cookie_str, {
        "mission_type": 0,
        "fun_id": "wechat_app_home",
        "message_source": None,
        "page_type": "HOME_PAGE",
        "push_source_mission_type": 0,
        "fruit_config_version": "",
        "unlock_scene_version": "",
        "app_home_click_icon_type": None,
        "tubetoken": tubetoken,
        "push_act_source": None,
        "need_show_home_popup": True,
        "fun_pl": 2,
    })
    if result.get("error_code") == 40001:
        log("  [首页] 验证失败，Cookie 可能已过期")
        return None, 0
    new_token = result.get("tubetoken", tubetoken)
    water = result.get("water_amount", 0)
    log(f"  [首页] 水滴: {water}")
    return new_token, water

# ============================================================
#  浇水
# ============================================================

def water_tree(pdduid: str, cookie_str: str, tubetoken: str, max_times: int = 50):
    """浇水: 每次消耗10水滴"""
    water = get_water(pdduid, cookie_str)
    log(f"  [浇水] 当前水滴: {water}")
    if water < 10:
        log("  [浇水] 水滴不足10颗，跳过")
        return 0

    count = min(max_times, water // 10)
    watered = 0

    for i in range(count):
        body = {
            "atw": True,
            "location_auth": False,
            "last_stay_time": 10 + i * 4,
            "can_trigger_random_mission": False,
            "product_scene": 0,
            "minor": False,
            "ext_params": {"can_trigger201824": True},
            "mission_type": 0,
            "cost_water_amount": 10,
            "merge_cost": False,
            "fun_id": "wechat_app_home",
            "lower_end_device": False,
            "cost_water_competition_in_scene_icon": False,
            "is_small_screen": True,
            "tubetoken": tubetoken,
            "fun_pl": 2,
        }
        result = post_manor("/manor/water/cost", pdduid, cookie_str, body)
        left = result.get("now_water_amount")
        if left is not None and left < water:
            water = left
            watered += 1
            log(f"  [浇水] {watered}/{count}, 剩余: {left}")
            if left < 10:
                break
            time.sleep(0.3)
        else:
            log(f"  [浇水] 水滴未扣除，停止")
            break

    final = get_water(pdduid, cookie_str)
    log(f"  [浇水] 完成! 浇水 {watered} 次, 剩余水滴: {final}")
    return watered

# ============================================================
#  任务
# ============================================================

def get_mission_list(pdduid: str, cookie_str: str, tubetoken: str) -> Tuple[List, List]:
    """获取任务列表，返回 (可领取列表, 可接受列表)"""
    log("  [任务] 获取任务列表...")
    body = {
        "activity_id_list": [201015, 201036],
        "mission_types": [
            38160, 38242, 38090, 38451, 37859, 38428,
            38500, 38501, 38502, 38503, 38504, 38505,
            38600, 38601, 38700, 38701, 38800, 38900,
            37900, 37950, 38000, 38050, 38100, 38150,
        ],
        "request_params": {"act201015EntryInfo": {}, "act201036EntryInfo": {}},
        "lower_end_device": False,
        "tubetoken": tubetoken,
        "fun_pl": 2,
    }
    for i in range(1, 9):
        body["request_params"]["act201015EntryInfo"][str(i)] = {"needRefresh": True}
        body["request_params"]["act201036EntryInfo"][str(i)] = {"needRefresh": True}

    result = post_manor("/manor/mission/list", pdduid, cookie_str, body)
    activity_map = result.get("activity_vo_map", {})

    tasks = []
    for act_id_str, act_data in activity_map.items():
        act_id = int(act_id_str)
        for mission_id_str, m in act_data.get("mission_list", {}).items():
            mission_id = int(mission_id_str)
            reward_info = m.get("reward_info") or []
            reward_amount, reward_type = 0, ""
            for ri in reward_info:
                if ri.get("reward_type") == 1:
                    reward_amount = ri.get("min_reward_amount", 0)
                    reward_type = "水滴"
                    break
            if not reward_amount and reward_info:
                reward_amount = reward_info[0].get("min_reward_amount", 0)
                reward_type = f'T{reward_info[0].get("reward_type", "?")}'

            tasks.append({
                "activity_id": act_id,
                "mission_id": mission_id,
                "is_draw": m.get("is_draw", False),
                "is_open": m.get("is_open", False),
                "finished_count": m.get("finished_count", 0),
                "max_count": m.get("max_count", 0),
                "reward_amount": reward_amount,
                "reward_type": reward_type,
            })

    can_claim = [t for t in tasks
                 if not t["is_draw"] and t["is_open"] and t["finished_count"] >= 1]
    need_accept = [t for t in tasks
                   if not t["is_draw"] and not t["is_open"] and t["finished_count"] >= 1]

    if tasks:
        log(f"  [任务] 共 {len(tasks)} 个, 可领取: {len(can_claim)}, 需接受: {len(need_accept)}")
        for t in tasks:
            flag = ""
            if not t["is_draw"] and t["is_open"] and t["finished_count"] >= 1:
                flag = " [可领]"
            elif not t["is_draw"] and not t["is_open"] and t["finished_count"] >= 1:
                flag = " [需接]"
            log(f"    act={t['activity_id']} id={t['mission_id']} "
                f"done={t['finished_count']}/{t['max_count']} "
                f"+{t['reward_amount']}{t['reward_type']}{flag}")

    return can_claim, need_accept

def accept_mission(pdduid: str, cookie_str: str, tubetoken: str,
                   activity_id: int, mission_id: int) -> bool:
    """接受任务"""
    result = post_manor("/manor/mission/accept", pdduid, cookie_str, {
        "mission_id": mission_id, "activity_id": activity_id,
        "tubetoken": tubetoken, "fun_pl": 2,
    })
    if result.get("success"):
        log(f"  [任务] 接受成功 act={activity_id} id={mission_id}")
        return True
    log(f"  [任务] 接受失败: {result.get('error_msg', '')}")
    return False

def claim_mission(pdduid: str, cookie_str: str, tubetoken: str,
                  activity_id: int, mission_id: int) -> bool:
    """领取任务奖励"""
    result = post_manor("/manor/mission/draw", pdduid, cookie_str, {
        "mission_id": mission_id, "activity_id": activity_id,
        "tubetoken": tubetoken, "fun_pl": 2,
    })
    if result.get("success"):
        reward = result.get("water", result.get("reward_amount", 0))
        log(f"  [任务] 领取成功: +{reward} 水滴")
        return True
    log(f"  [任务] 领取失败: {result.get('error_msg', '')}")
    return False

# ============================================================
#  每日签到
# ============================================================

def daily_checkin(pdduid: str, cookie_str: str, tubetoken: str) -> bool:
    log("  [签到] 签到中...")
    result = post_manor("/manor/common/apply/activity", pdduid, cookie_str, {
        "type": 201811,
        "params": {"ui_id": 3, "type": 2},
        "fun_id": "wechat_app_home",
        "tubetoken": tubetoken,
        "fun_pl": 2,
    })
    if result.get("success"):
        log("  [签到] 成功!")
        return True
    log("  [签到] 今日已签到")
    return False

# ============================================================
#  偷水
# ============================================================

def get_friend_list(pdduid: str, cookie_str: str, tubetoken: str) -> List[Dict]:
    """获取好友列表 (含可偷水标记)"""
    log("  [偷水] 获取好友列表...")
    result = post_manor("/manor-query/friend/list/page", pdduid, cookie_str, {
        "page_num": 1, "tubetoken": tubetoken, "fun_pl": 2,
    })
    can_steal = []
    for f in result.get("friend_list", []):
        if (f.get("steal_water_status") or {}).get("status") == 2:
            can_steal.append({
                "uid": f.get("uid"),
                "nickname": f.get("nickname", "未知"),
                "amount": f.get("amount", 0),
            })
    log(f"  [偷水] 可偷好友: {len(can_steal)} 人")
    for f in can_steal:
        log(f"    uid={f['uid']} {f['nickname']} 水量={f['amount']}")
    return can_steal

def get_steal_chances(pdduid: str, cookie_str: str, tubetoken: str) -> Tuple[int, List]:
    """获取偷水次数和机器人列表"""
    result = post_manor("/manor/steal/chance/lack", pdduid, cookie_str, {
        "tubetoken": tubetoken, "fun_pl": 2,
    })
    steal_info = (result.get("activity_vo_map", {})).get("201423", {})
    rest_chance = steal_info.get("rest_chance", 0)
    robots = [(r.get("uid"), r.get("nickname", "机器人"), r.get("water", 0))
              for r in steal_info.get("robots", [])]
    log(f"  [偷水] 剩余偷水次数: {rest_chance}, 机器人: {len(robots)} 个")
    return rest_chance, robots

def steal_water(pdduid: str, cookie_str: str, tubetoken: str,
                friend_uid: str, dog_status: int) -> Tuple[int, int, str]:
    """对单个目标执行偷水, 返回 (偷得水量, 被咬损失, 原因)"""
    result = post_manor("/manor/steal/water", pdduid, cookie_str, {
        "friend_uid": friend_uid, "steal_type": 10,
        "dog_status": dog_status, "tubetoken": tubetoken, "fun_pl": 2,
    })
    stolen = result.get("steal_amount", 0) or 0
    bitten = result.get("bitten_water", 0) or 0
    reason = (result.get(k) for k in ("error_msg", "msg", "message", "toast", "prompt", "status_msg"))
    reason = next((r for r in reason if r), "")
    code = result.get("error_code") or result.get("code") or result.get("status")
    if code and reason:
        reason = f"{code}: {reason}"
    elif code:
        reason = str(code)
    return stolen, bitten, reason

def steal_from_friends(pdduid: str, cookie_str: str, tubetoken: str):
    """偷水主流程"""
    try:
        friends = get_friend_list(pdduid, cookie_str, tubetoken)
        rest_chance, robots = get_steal_chances(pdduid, cookie_str, tubetoken)
    except Exception as e:
        log(f"  [偷水] 获取信息失败: {e}")
        return

    targets = [(f["uid"], f["nickname"], f["amount"]) for f in friends]
    targets.extend(robots)
    if not targets:
        log("  [偷水] 没有可偷目标")
        return

    max_steals = min(rest_chance, len(targets)) if rest_chance > 0 else len(targets)
    log(f"  [偷水] 开始偷水, 最多 {max_steals} 次...")

    total_stolen, steal_count = 0, 0
    for target_uid, nickname, water in targets[:max_steals]:
        if water <= 0:
            continue

        stolen = 0
        dog_tried = 0
        last_reason = ""
        dog_list = [1, 2, 3]
        random.shuffle(dog_list)
        for dog in dog_list:
            dog_tried = dog
            amount, bitten, reason = steal_water(pdduid, cookie_str, tubetoken,
                                                  target_uid, dog)
            last_reason = reason
            if amount > 0:
                stolen = amount
                break
            if bitten > 0:
                last_reason = f"被咬损失{bitten}滴"
                time.sleep(0.15)
                continue
            time.sleep(0.15)

        if stolen > 0:
            total_stolen += stolen
            steal_count += 1
            log(f"  [偷水] {nickname} dog={dog_tried}: +{stolen}滴")
        else:
            suffix = f"，原因: {last_reason}" if last_reason else ""
            log(f"  [偷水] {nickname} dog={dog_tried}: 未偷到{suffix}")
        time.sleep(0.3)

    log(f"  [偷水] 完成! 共偷 {steal_count} 次, 获得 {total_stolen} 水滴")

# ============================================================
#  单账号处理
# ============================================================

def update_tubetoken_in_cookie(cookie_str: str, new_token: str) -> str:
    """更新 Cookie 中的 tubetoken"""
    cookies = cookie_str_to_dict(cookie_str)
    if new_token and new_token != cookies.get("tubetoken"):
        cookies["tubetoken"] = new_token
        return cookie_dict_to_str(cookies)
    return cookie_str

def process_account(openid: str, idx: int, total: int):
    """处理单个账号"""
    log(f"\n{'=' * 48}")
    log(f"账号 [{idx}/{total}] openId={mask(openid)}")

    # 尝试使用缓存 Cookie
    cookie_str = cached_cookie(openid)
    pdduid = ""

    if cookie_str:
        pdduid = extract_uid(cookie_str)
        if pdduid:
            cookies = cookie_str_to_dict(cookie_str)
            new_token, _ = get_home_page(pdduid, cookie_str, cookies.get("tubetoken", ""))
            if new_token is not None:
                log(f"  缓存 Cookie 有效, uid={pdduid}")
                cookie_str = update_tubetoken_in_cookie(cookie_str, new_token)
            else:
                log("  缓存 Cookie 失效, 重新登录")
                cookie_str = ""
        else:
            cookie_str = ""

    # 登录
    if not cookie_str:
        result = pdd_code_login(openid)
        if not result:
            log("[失败] 登录失败, 跳过")
            return
        cookie_str, pdduid, pdd_uin = result
        save_cookie_cache(openid, cookie_str)

    if not pdduid:
        pdduid = extract_uid(cookie_str)
    if not pdduid:
        log("[失败] Cookie 中无 pdd_user_id")
        return

    log(f"UID: {pdduid}")

    # 刷新首页数据
    cookies = cookie_str_to_dict(cookie_str)
    tubetoken = cookies.get("tubetoken", "")
    new_token, water = get_home_page(pdduid, cookie_str, tubetoken)
    if new_token is None:
        log("[失败] Cookie 无效")
        return

    tubetoken = new_token or tubetoken
    cookie_str = update_tubetoken_in_cookie(cookie_str, tubetoken)
    log(f"当前水滴: {water}")

    # 签到
    daily_checkin(pdduid, cookie_str, tubetoken)
    time.sleep(1)

    # 浇水
    water_tree(pdduid, cookie_str, tubetoken, max_times=50)
    time.sleep(1)

    # 任务
    can_claim, need_accept = get_mission_list(pdduid, cookie_str, tubetoken)
    if need_accept:
        log(f"\n  [任务] 正在接受 {len(need_accept)} 个任务...")
        for t in need_accept:
            accept_mission(pdduid, cookie_str, tubetoken, t["activity_id"], t["mission_id"])
            time.sleep(0.5)
    if can_claim:
        log(f"\n  [任务] 正在领取 {len(can_claim)} 个任务...")
        for t in can_claim:
            claim_mission(pdduid, cookie_str, tubetoken, t["activity_id"], t["mission_id"])
            time.sleep(0.5)

    # 偷水
    steal_from_friends(pdduid, cookie_str, tubetoken)

    final = get_water(pdduid, cookie_str)
    log(f"\n最终水滴: {final}")

# ============================================================
#  Cookie 直连模式
# ============================================================

def process_direct_cookie():
    """使用已有的 Cookie 直接执行任务"""
    log("=" * 48)
    log(f"Cookie 直连模式: {COOKIE_SOURCE or '未知'}")

    pdduid = extract_uid(COOKIE_STR)
    if not pdduid:
        log("[错误] Cookie 缺少 pdd_user_id")
        return
    log(f"UID: {pdduid}")

    cookies = cookie_str_to_dict(COOKIE_STR)
    tubetoken = cookies.get("tubetoken", "")
    new_token, water = get_home_page(pdduid, COOKIE_STR, tubetoken)
    if new_token is None:
        log("[失败] Cookie 无效")
        return
    tubetoken = new_token or tubetoken
    log(f"当前水滴: {water}")

    daily_checkin(pdduid, COOKIE_STR, tubetoken)
    time.sleep(1)

    water_tree(pdduid, COOKIE_STR, tubetoken, max_times=50)
    time.sleep(1)

    can_claim, need_accept = get_mission_list(pdduid, COOKIE_STR, tubetoken)
    if need_accept:
        log(f"\n  [任务] 正在接受 {len(need_accept)} 个任务...")
        for t in need_accept:
            accept_mission(pdduid, COOKIE_STR, tubetoken,
                           t["activity_id"], t["mission_id"])
            time.sleep(0.5)
    if can_claim:
        log(f"\n  [任务] 正在领取 {len(can_claim)} 个任务...")
        for t in can_claim:
            claim_mission(pdduid, COOKIE_STR, tubetoken,
                          t["activity_id"], t["mission_id"])
            time.sleep(0.5)

    steal_from_friends(pdduid, COOKIE_STR, tubetoken)

    final = get_water(pdduid, COOKIE_STR)
    log(f"\n最终水滴: {final}")

# ============================================================
#  入口
# ============================================================

def fetch_accounts_from_server():
    """从 wx_server 获取所有账号 openid 列表"""
    try:
        s = _requests.Session()
        headers = {"content-type": "application/json"}
        if WX_AUTH:
            headers["Authorization"] = f"Bearer {WX_AUTH}"
        r = s.get(f"{YYB_BASE_URL}/accounts", headers=headers, timeout=10)
        d = r.json()
        if d.get("code") != 0:
            log(f"[获取账号] 失败: {d.get('msg', '')}")
            return []
        accounts = d.get("data", [])
        openids = []
        for acc in accounts:
            oid = acc.get("openid")
            if oid:
                openids.append(oid)
        log(f"[获取账号] 从服务器获取到 {len(openids)} 个账号")
        return openids
    except Exception as e:
        log(f"[获取账号] 异常: {e}")
        return []

def main():
    warnings.filterwarnings("ignore", message="Unverified HTTPS request")
    log("=" * 48)
    log("拼多多果园 - 自动浇水领水滴 (独立版)")
    log(f"HTTP: {'curl_cffi' if USE_CFFI else 'requests'}")

    if COOKIE_STR:
        process_direct_cookie()
        return

    if not YYB_BASE_URL:
        log("[错误] 未配置登录信息!")
        log("  方式一: 在文件顶部填写 COOKIE / PDD_USER_ID + PDD_ACCESS_TOKEN")
        log("  方式二: 设置环境变量 YYB_BASE_URL + wx_auth + PDD_OPENID")
        return

    openids = fetch_accounts_from_server()
    if not openids:
        log("[错误] 未配置 PDD_OPENID")
        return

    log(f"共 {len(openids)} 个账号")
    for i, oid in enumerate(openids, 1):
        try:
            process_account(oid, i, len(openids))
        except Exception as e:
            log(f"[账号异常] {e}")
            traceback.print_exc()

    log("\n" + "=" * 48)
    log("全部账号处理完毕")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"[异常] {e}")
        traceback.print_exc()
        sys.exit(1)
