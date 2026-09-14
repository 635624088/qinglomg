#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
必填:
1. YYB_BASE_URL 地址，默认: http://172.17.0.1:18080
2. ADI_DELAY_MIN
   随机延迟最小秒数，默认: 3
3. ADI_DELAY_MAX
   随机延迟最大秒数，默认: 5
4. ADI_ENABLE_FOOTBALL
   是否执行足球活动流程，1开启，0关闭，默认: 1
5. ADI_ENABLE_WORLDCUP_H5
   是否执行足球街区H5流程，1开启，0关闭，默认: 1
6. ADI_WORLDCUP_ACTIVITY_CODE
   指定足球街区活动 code，不填则自动取
7. ADI_WORLDCUP_TEAM_ID
   指定主队 id，不填则自动取
8. ADI_WORLDCUP_TRY_EXCHANGE
   是否尝试积分兑换抽奖次数，1开启，0关闭，默认: 0
9. ADI_WORLDCUP_AUTO_LOTTERY
   是否自动抽奖，1开启，0关闭，默认: 1
10. ADI_WORLDCUP_LOTTERY_ACTIVITY_ID
    抽奖 activityId，默认: 1
11. ADI_WORLDCUP_LOTTERY_POOL_NO
    抽奖 poolNo，默认: 2
12. ADI_SINGLE_CAMPAIGNS
    单次任务 campaignCode，默认: BABYMONSTER
13. ADI_SHOW_DELAY
    是否输出延迟日志，1显示，0不显示，默认: 0
"""

import os
import time
import json
import base64
import random
import importlib
from pathlib import Path
from urllib.parse import urlencode

import requests
import urllib3

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
PAGE_API_URL = f"{YYB_BASE_URL}/api/document/page_api.json"
APP_CODE_URL = f"{YYB_BASE_URL}/api/v1/wx/app/get/code"

WECHAT_APPID = "wx771a28fa51fa2b99"

# ── Bridge (本地 API 服务器) ─────────────────────────────────────
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
BRIDGE_KEY = os.getenv("BRIDGE_KEY", "")

def bridge_headers():
    h = {"Content-Type": "application/json"}
    if BRIDGE_KEY:
        h["Authorization"] = f"Bearer {BRIDGE_KEY}"
    return h

def fetch_accounts():
    try:
        r = requests.get(f"{YYB_BASE_URL}/accounts", headers=bridge_headers(), timeout=15)
        data = r.json()
        accounts = []
        for acc in data.get("data", []):
            openid = (acc.get("openid") or "").strip()
            name = (acc.get("nickname") or acc.get("name") or "账号").strip()
            if openid:
                accounts.append({"remark": name, "wxid": openid})
        print(f"共获取到 {len(accounts)} 个账号")
        for i, a in enumerate(accounts, 1):
            print(f"   {i}. {a['remark']} (openid: {a['wxid'][:12]}...)")
        return accounts
    except Exception as e:
        print(f"获取账号失败: {e}")
        return []

def bridge_get_code(openid):
    r = requests.post(f"{YYB_BASE_URL}/wxapp/getCode",
                      json={"app_id": WECHAT_APPID, "ref": openid},
                      headers=bridge_headers(), timeout=90)
    if r.status_code != 200:
        return False, f"bridge HTTP {r.status_code}"
    data = r.json()
    if data.get("code") != 0:
        return False, f"bridge 拒绝: {data}"
    code = data.get("data", {}).get("result", {}).get("code", "")
    if not code:
        return False, "bridge 未返回 code"
    return True, code
ANA_URL = "https://auth.api.adidas.com.cn"
CRM_URL = "https://consumer-hub.adidas.com.cn"
ADICLUB_URL = "https://adiclub.adidas.com.cn"
WORLDCUP_URL = "https://worldcuphub.adidas.com.cn"

ANA_API_KEY = "IGKGyiqaNnLLJrvEc4k5C66VXxMSZDcx"
ANA_SOURCE = "M003"

DEFAULT_RULE_CODE = "IP240320080"
DEFAULT_CAMPAIGNS = "BABYMONSTER"
DEFAULT_FOOTBALL_CATEGORY = "FOOTBALL"
DEFAULT_FOOTBALL_SUBCATEGORY = "FOOTBALL"

CRM_CHANNEL = "MemberHub"
CRM_SUB_CHANNEL = "AdiClub"
CRM_STORE_CODE = "WECHAT"

WX_TIMEOUT = 20
COMMON_UA = (
    "Mozilla/5.0 (Linux; Android 10; Redmi K30 Pro Build/QKQ1.191222.002) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.50.2701(0x28003239) WeChat/arm64 Weixin NetType/WIFI "
    "MiniProgramEnv/android"
)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def _shorten(value, limit=280):
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "..."

def _is_empty_value(value):
    return value in (None, "", [], {}, 0, "0")

def _extract_first(payload, target_keys):
    if isinstance(payload, dict):
        for key in target_keys:
            value = payload.get(key)
            if not _is_empty_value(value):
                return value
        for value in payload.values():
            result = _extract_first(value, target_keys)
            if not _is_empty_value(result):
                return result
    elif isinstance(payload, list):
        for item in payload:
            result = _extract_first(item, target_keys)
            if not _is_empty_value(result):
                return result
    return None

def print_and_collect(lines, text=""):
    line = str(text)
    print(line)
    lines.append(line)

def random_sleep(label="", min_seconds=None, max_seconds=None, lines=None):
    min_v = float(os.getenv("ADI_DELAY_MIN", str(min_seconds if min_seconds is not None else 3)))
    max_v = float(os.getenv("ADI_DELAY_MAX", str(max_seconds if max_seconds is not None else 5)))
    if max_v < min_v:
        min_v, max_v = max_v, min_v
    delay = round(random.uniform(min_v, max_v), 2)
    if os.getenv("ADI_SHOW_DELAY", "0") == "1":
        text = f"随机延迟[{label or 'default'}]: {delay}s"
        if lines is not None:
            print_and_collect(lines, text)
        else:
            print(text)
    time.sleep(delay)

def get_feishu_webhook():
    webhook = os.getenv("FEISHU_WEBHOOK", "").strip()
    if webhook:
        return webhook
    fs_key = os.getenv("FS_KEY", "").strip()
    if fs_key:
        if fs_key.startswith("http://") or fs_key.startswith("https://"):
            return fs_key
        return f"https://open.feishu.cn/open-apis/bot/v2/hook/{fs_key}"
    return ""

def send_feishu_notify(title, content):
    webhook = get_feishu_webhook()
    if not webhook:
        return False, "未配置飞书 webhook"

    at_all = os.getenv("FEISHU_AT_ALL", "0") == "1"
    text = content
    if at_all:
        text = f"<at user_id=\"all\"></at>\n{text}"

    payload = {
        "msg_type": "post",
        "content": {
            "post": {
                "zh_cn": {
                    "title": title,
                    "content": [[{"tag": "text", "text": text}]],
                }
            }
        },
    }

    try:
        response = requests.post(webhook, json=payload, timeout=15)
        result = response.json() if "application/json" in response.headers.get("Content-Type", "") else response.text
        if response.status_code != 200:
            return False, f"HTTP: {response.status_code} | 响应: {_shorten(result)}"
        if isinstance(result, dict) and result.get("code", 0) not in (0, "0", None):
            return False, f"响应: {_shorten(result)}"
        return True, "发送成功"
    except Exception as exc:
        return False, f"发送异常: {exc}"

def send_qinglong_notify(title, content):
    module_names = ("notify", "sendNotify")
    errors = []
    for module_name in module_names:
        try:
            module = importlib.import_module(module_name)
            send_func = getattr(module, "send", None) or getattr(module, "sendNotify", None)
            if callable(send_func):
                send_func(title, content)
                return True, f"已调用青龙通知模块: {module_name}"
        except Exception as exc:
            errors.append(f"{module_name}: {exc}")
    return False, " ; ".join(errors) if errors else "未找到青龙通知模块"

def post_json(url, payload, headers=None):
    merged_headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": COMMON_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Origin": "https://servicewechat.com",
        "Referer": "https://servicewechat.com/",
    }
    if headers:
        merged_headers.update(headers)
    try:
        response = requests.post(url, json=payload, headers=merged_headers, timeout=WX_TIMEOUT, verify=False)
        try:
            result = response.json()
        except ValueError:
            result = response.text
        return response.status_code, result
    except Exception as exc:
        return None, f"请求异常 | {url} | {exc}"

def post_form(url, payload, headers=None):
    merged_headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": COMMON_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Origin": "https://servicewechat.com",
        "Referer": "https://servicewechat.com/",
    }
    if headers:
        merged_headers.update(headers)
    try:
        response = requests.post(url, data=urlencode(payload), headers=merged_headers, timeout=WX_TIMEOUT, verify=False)
        try:
            result = response.json()
        except ValueError:
            result = response.text
        return response.status_code, result
    except Exception as exc:
        return None, f"请求异常 | {url} | {exc}"

def get_json(url, headers=None, params=None):
    merged_headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": COMMON_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Origin": "https://servicewechat.com",
        "Referer": "https://servicewechat.com/",
    }
    if headers:
        merged_headers.update(headers)
    try:
        response = requests.get(url, headers=merged_headers, params=params, timeout=WX_TIMEOUT, verify=False)
        try:
            result = response.json()
        except ValueError:
            result = response.text
        return response.status_code, result
    except Exception as exc:
        return None, f"请求异常 | {url} | {exc}"

def ana_headers():
    return {
        "api-key": ANA_API_KEY,
        "source": ANA_SOURCE,
        "x-requested-with": "com.tencent.mm",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "Referer": "https://servicewechat.com/wx771a28fa51fa2b99/",
    }

def business_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "api-key": ANA_API_KEY,
        "source": ANA_SOURCE,
        "x-requested-with": "com.tencent.mm",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "Referer": "https://servicewechat.com/wx771a28fa51fa2b99/",
    }

def decode_jwt_payload(token):
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode()).decode("utf-8"))
    except Exception:
        return {}

def detect_appid():
    current_dir = Path(__file__).resolve().parent
    for path in current_dir.iterdir():
        if path.is_dir() and path.name.startswith("wx") and len(path.name) >= 10:
            return path.name
    return WECHAT_APPID

def fetch_app_code(wxid, appid):
    return bridge_get_code(wxid.strip())

def fetch_valid_app_code(wxid, retries=4, wait_seconds=2):
    last_result = "未获取到有效 app_code"
    for attempt in range(1, retries + 1):
        ok, result = fetch_app_code(wxid, WECHAT_APPID)
        if ok:
            return True, result
        last_result = result
        if attempt < retries:
            time.sleep(wait_seconds)
    return False, last_result

def check_user_exist(app_code):
    status_code, result = post_json(
        f"{ANA_URL}/ana/v1/users/exist",
        {"type": "unionId1", "value": app_code},
        headers=ana_headers(),
    )
    if status_code != 200:
        return False, f"exist 检查失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, dict):
        return False, f"exist 响应异常 | {_shorten(result)}"
    return True, data

def login_member(app_code):
    status_code, result = post_form(
        f"{ANA_URL}/ana/v1/users/login/mini",
        {
            "accessCode": app_code,
            "approach": "mini",
            "crmChannel": CRM_CHANNEL,
            "crmSubChannel": CRM_SUB_CHANNEL,
            "crmStoreCode": CRM_STORE_CODE,
        },
        headers=ana_headers(),
    )
    if status_code != 200:
        return False, f"登录失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    data = result.get("data") if isinstance(result, dict) else None
    token = data.get("access_token") if isinstance(data, dict) else None
    if not token:
        return False, f"登录成功态未取到 access_token | 响应: {_shorten(result)}"
    return True, {"token": token, "raw": result}

def fetch_member_info(token):
    status_code, result = get_json(
        f"{CRM_URL}/v1/adiclub/public/consumer/query",
        headers=business_headers(token),
        params={"channel": CRM_CHANNEL, "subChannel": CRM_SUB_CHANNEL},
    )
    if status_code != 200:
        return False, f"查询会员信息失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and str(result.get("resultCode")) == "200":
        return True, result.get("data") or {}
    return False, f"查询会员信息失败 | {_shorten(result)}"

def worldcup_headers(user=None, platform="ADICLUB", wms_user_id="1"):
    headers = {}
    if user:
        if user.get("id"):
            headers["userId"] = str(user["id"])
        if user.get("token"):
            headers["token"] = str(user["token"])
    if platform:
        headers["platform"] = platform
    headers["wmsuserid"] = str(wms_user_id or "1")
    return headers

def worldcup_post(path, data=None, user=None, platform="ADICLUB", wms_user_id="1"):
    payload = dict(data or {})
    payload["timestamp"] = int(time.time() * 1000)
    merged_headers = worldcup_headers(user, platform, wms_user_id)
    try:
        response = requests.post(
            f"{WORLDCUP_URL}{path}",
            data=payload,
            headers=merged_headers,
            timeout=WX_TIMEOUT,
            verify=False,
        )
        try:
            result = response.json()
        except ValueError:
            result = response.text
        return response.status_code, result
    except Exception as exc:
        return None, f"请求异常 | {path} | {exc}"

def worldcup_login(member_id, union_id, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/user/login",
        {
            "consumerCode": member_id,
            "unionId": union_id,
        },
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区登录失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        data = result.get("data") or {}
        return True, {
            "id": data.get("user", {}).get("id") if isinstance(data.get("user"), dict) else data.get("id"),
            "token": data.get("token"),
            "user": data.get("user") or {},
            "raw": result,
        }
    return False, f"足球街区登录失败 | {_shorten(result)}"

def worldcup_user_exists(member_id, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/user/exists",
        {"consumerCode": member_id},
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区 exists 失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        return True, result.get("data") or {}
    return False, f"足球街区 exists 失败 | {_shorten(result)}"

def worldcup_task_info(user_id, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/userTask/info",
        {"userId": user_id},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区任务查询失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        return True, result.get("data") or {}
    return False, f"足球街区任务查询失败 | {_shorten(result)}"

def worldcup_task_finish(user_id, task_type, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/userTask/finished",
        {"userId": user_id, "type": task_type},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区任务上报失败 | type={task_type} | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def worldcup_exchange_chance(user_id, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/userTask/exchangeChance",
        {"userId": user_id},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区积分兑换抽奖机会失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def worldcup_team_list(user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/team/list",
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区球队列表失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        return True, result.get("data") or []
    return False, f"足球街区球队列表失败 | {_shorten(result)}"

def worldcup_select_team(user_id, team_id, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/team/selected",
        {"userId": user_id, "teamId": team_id},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区选主队失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def worldcup_team_help(user_id, team_id, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/team/help",
        {"userId": user_id, "teamId": team_id},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区助力失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def worldcup_activity_list(user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/activityOffline/list",
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区活动列表失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        return True, result.get("data") or []
    return False, f"足球街区活动列表失败 | {_shorten(result)}"

def worldcup_activity_info(activity_code, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/activityOffline/info",
        {"activityCode": activity_code},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区活动详情失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        return True, result.get("data") or {}
    return False, f"足球街区活动详情失败 | {_shorten(result)}"

def worldcup_activity_apply(user_id, activity_code, sign_source="", user=None, platform="ADICLUB", wms_user_id="1"):
    data = {"userId": user_id, "activityCode": activity_code}
    if sign_source:
        data["signSource"] = sign_source
    status_code, result = worldcup_post(
        "/api/activityOffline/apply",
        data,
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区活动报名失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def worldcup_activity_apply_detail(user_id, activity_code, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/activityOffline/applyDetail",
        {"userId": user_id, "activityCode": activity_code},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区活动报名详情失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        return True, result.get("data") or {}
    return False, f"足球街区活动报名详情失败 | {_shorten(result)}"

def worldcup_activity_signin(user_id, activity_code, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/activityOffline/signIn",
        {"userId": user_id, "activityCode": activity_code},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区活动签到失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def worldcup_user_info(user_id, refresh_points=False, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/user/info",
        {"id": user_id, "refreshPoints": refresh_points},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区用户信息失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 200:
        return True, result.get("data") or {}
    return False, f"足球街区用户信息失败 | {_shorten(result)}"

def worldcup_lottery(user_id, activity_id=1, pool_no=2, user=None, platform="ADICLUB", wms_user_id="1"):
    status_code, result = worldcup_post(
        "/api/lotteryPrizeRecord/lottery",
        {"activityId": activity_id, "poolNo": pool_no, "userId": user_id},
        user=user,
        platform=platform,
        wms_user_id=wms_user_id,
    )
    if status_code != 200:
        return False, f"足球街区抽奖失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def summarize_lottery_result(payload):
    if not isinstance(payload, dict):
        return _shorten(payload, 180), False
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    prize_type = data.get("type")
    title = data.get("title") or data.get("remark") or "未知奖品"
    amount = data.get("amount")
    coupon = data.get("couponCode") or data.get("couponRecordCode")
    if prize_type == 0:
        return "谢谢参与", False
    if prize_type == 1:
        return f"实物: {title}", True
    if prize_type == 2:
        return f"积分: {title}{(' (' + str(amount) + ')') if amount not in (None, '') else ''}", True
    if prize_type == 3:
        return f"券码: {title}{(' | ' + str(coupon)) if coupon else ''}", True
    if prize_type == 4:
        return f"壁纸: {title}", True
    if prize_type == 5:
        return f"海报: {title}", True
    return f"奖品(type={prize_type}): {title}", True

def daily_sign_judge(token, rule_code):
    status_code, result = get_json(
        f"{CRM_URL}/v1/adiclub/public/points/check-in/judge",
        headers=business_headers(token),
        params={
            "ruleCode": rule_code,
            "channel": CRM_CHANNEL,
            "subChannel": CRM_SUB_CHANNEL,
        },
    )
    if status_code != 200:
        return False, f"查询每日签到状态失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and str(result.get("resultCode")) == "200":
        return True, result.get("data") or {}
    return False, f"查询每日签到状态失败 | {_shorten(result)}"

def daily_sign(token, rule_code):
    status_code, result = post_json(
        f"{CRM_URL}/v1/adiclub/public/points/points-add",
        {
            "ruleCode": rule_code,
            "channel": CRM_CHANNEL,
            "subChannel": CRM_SUB_CHANNEL,
        },
        headers=business_headers(token),
    )
    if status_code != 200:
        return False, f"每日签到失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def query_campaign(token, campaign_code):
    status_code, result = get_json(
        f"{ADICLUB_URL}/campaignservice/public/visitor/thematic/querycampaign",
        headers=business_headers(token),
        params={"campaignCode": campaign_code},
    )
    if status_code != 200:
        return False, f"查询活动失败 | {campaign_code} | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("code") == 0:
        return True, result.get("data") or {}
    return False, f"查询活动失败 | {campaign_code} | {_shorten(result)}"

def sign_campaign(token, campaign_code, bid):
    status_code, result = post_json(
        f"{ADICLUB_URL}/campaignservice/public/thematic/sign",
        {
            "campaignCode": campaign_code,
            "thematicCampaignBid": bid,
        },
        headers=business_headers(token),
    )
    if status_code != 200:
        return False, f"活动签到失败 | {campaign_code} | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def parse_daily_result(payload):
    text = _shorten(payload, 180)
    lowered = text.lower()
    if "already" in lowered or "已签到" in text:
        return "每日签到: 今日已签到", True
    if "success" in lowered or "200" in lowered or "成功" in text:
        return "每日签到: 签到成功", True
    if "over limit" in lowered or "104122" in text:
        return None, True  # Skip printing - already signed in
    return f"每日签到: {text}", False

def parse_campaign_result(campaign_code, payload):
    if isinstance(payload, dict):
        code = payload.get("code")
        msg = payload.get("msg") or payload.get("message") or ""
        if code == 0:
            return f"单次任务[{campaign_code}]: 完成成功", False
        if code == 1012:
            return f"单次任务[{campaign_code}]: 今日或本轮已完成", True
        if code == 1010:
            return f"单次任务[{campaign_code}]: 活动未开始", True
        if code == 1011:
            return f"单次任务[{campaign_code}]: 活动已结束", True  # Skip printing - campaign ended
        if msg:
            return f"单次任务[{campaign_code}]: {msg}", False
    return f"单次任务[{campaign_code}]: {_shorten(payload, 180)}", False

def list_exercises(category, subcategory, limit_num=20):
    status_code, result = get_json(
        f"{CRM_URL}/v1/adiclub/public/visitor/exercise/list",
        headers=ana_headers(),
        params={
            "category": category,
            "subCategory": subcategory,
            "limitNum": limit_num,
            "channel": CRM_CHANNEL,
            "subChannel": CRM_SUB_CHANNEL,
        },
    )
    if status_code != 200:
        return False, f"查询活动列表失败 | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("resultCode") == "200":
        return True, result.get("data") or []
    return False, f"查询活动列表失败 | {_shorten(result)}"

def fetch_exercise_detail(campaign_code):
    status_code, result = get_json(
        f"{CRM_URL}/v1/adiclub/public/visitor/exercise/common/detail",
        headers=ana_headers(),
        params={
            "campaignCode": campaign_code,
            "channel": CRM_CHANNEL,
            "subChannel": CRM_SUB_CHANNEL,
        },
    )
    if status_code != 200:
        return False, f"查询活动详情失败 | {campaign_code} | HTTP: {status_code} | 响应: {_shorten(result)}"
    if isinstance(result, dict) and result.get("resultCode") == "200":
        return True, result.get("data") or {}
    return False, f"查询活动详情失败 | {campaign_code} | {_shorten(result)}"

def signup_exercise(token, campaign_code):
    payload = {
        "campaignCode": campaign_code,
        "agreeCampaignTerms": True,
        "channel": CRM_CHANNEL,
        "subChannel": CRM_SUB_CHANNEL,
    }
    status_code, result = post_json(
        f"{CRM_URL}/v1/adiclub/public/activation/exercise/signup",
        payload,
        headers=business_headers(token),
    )
    if status_code != 200:
        return False, f"活动报名失败 | {campaign_code} | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def fetch_exercise_signin_detail(token, campaign_code):
    status_code, result = get_json(
        f"{CRM_URL}/v1/adiclub/public/activation/exercise/sign-in/detail",
        headers=business_headers(token),
        params={
            "campaignCode": campaign_code,
            "channel": CRM_CHANNEL,
            "subChannel": CRM_SUB_CHANNEL,
        },
    )
    if status_code != 200:
        return False, f"查询活动签到详情失败 | {campaign_code} | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def exercise_signin(token, campaign_code):
    payload = {
        "campaignCode": campaign_code,
        "channel": CRM_CHANNEL,
        "subChannel": CRM_SUB_CHANNEL,
    }
    status_code, result = post_json(
        f"{CRM_URL}/v1/adiclub/public/activation/exercise/campaign/sign-in",
        payload,
        headers=business_headers(token),
    )
    if status_code != 200:
        return False, f"活动签到失败 | {campaign_code} | HTTP: {status_code} | 响应: {_shorten(result)}"
    return True, result

def parse_exercise_signup_result(campaign_code, payload):
    text = _shorten(payload, 180)
    if isinstance(payload, dict):
        code = payload.get("resultCode") or payload.get("code")
        message = payload.get("resultMessage") or payload.get("msg") or payload.get("message") or ""
        if str(code) in ("200", "0"):
            return f"足球活动[{campaign_code}]报名: 成功", False
        if message:
            return f"足球活动[{campaign_code}]报名: {message}", True  # Skip on failure
    return f"足球活动[{campaign_code}]报名: {text}", False

def parse_exercise_signin_result(campaign_code, payload):
    text = _shorten(payload, 180)
    if isinstance(payload, dict):
        code = payload.get("resultCode") or payload.get("code")
        message = payload.get("resultMessage") or payload.get("msg") or payload.get("message") or ""
        if str(code) in ("200", "0"):
            return f"足球活动[{campaign_code}]签到: 成功"
        if message:
            return f"足球活动[{campaign_code}]签到: {message}"
    lowered = text.lower()
    if "already" in lowered or "已签到" in text:
        return f"足球活动[{campaign_code}]签到: 已完成"
    return f"足球活动[{campaign_code}]签到: {text}"

def choose_football_campaign(category, subcategory, preferred_code=""):
    if preferred_code:
        detail_ok, detail_result = fetch_exercise_detail(preferred_code)
        if detail_ok:
            return True, detail_result
        return False, detail_result

    list_ok, list_result = list_exercises(category, subcategory, 20)
    if not list_ok:
        return False, list_result
    if not list_result:
        return False, f"未查询到 {category}/{subcategory} 活动"

    active_statuses = {"ongoing", "signing", "signing_up", "not_started", "signup_in_progress"}
    for item in list_result:
        status = str(item.get("exerciseStatus", "")).strip().lower()
        if status and status != "ended" and status in active_statuses:
            return True, item
    for item in list_result:
        status = str(item.get("exerciseStatus", "")).strip().lower()
        if status != "ended":
            return True, item
    return True, list_result[0]

def load_accounts_from_env():
    raw = (
        os.getenv("adidas", "")
        or os.getenv("adi", "")
        or os.getenv("adiclub", "")
        or os.getenv("kklb", "")
    )
    if not raw:
        bridge_accounts = fetch_accounts()
        if bridge_accounts:
            return bridge_accounts
        return []
    accounts = []
    seen = set()
    for item in raw.split("\n"):
        text = item.strip()
        if not text:
            continue
        if "#" in text:
            remark, wxid = text.split("#", 1)
            remark = remark.strip() or wxid.strip()
            wxid = wxid.strip()
        else:
            remark = text
            wxid = text
        if not wxid or wxid in seen:
            continue
        seen.add(wxid)
        accounts.append({"remark": remark, "wxid": wxid})
    return accounts

def load_campaign_codes():
    raw = os.getenv("ADI_SINGLE_CAMPAIGNS", DEFAULT_CAMPAIGNS).strip()
    result = []
    seen = set()
    for item in raw.replace("|", ",").replace("&", ",").split(","):
        code = item.strip()
        if code and code not in seen:
            seen.add(code)
            result.append(code)
    return result or [DEFAULT_CAMPAIGNS]

def parse_worldcup_result(title, payload):
    text = _shorten(payload, 180)
    if isinstance(payload, dict):
        code = payload.get("code")
        msg = payload.get("message") or payload.get("msg") or ""
        if code == 200:
            return f"{title}: 成功"
        if msg:
            return f"{title}: {msg}"
    return f"{title}: {text}"

def run_default_mode():
    accounts = load_accounts_from_env()
    if not accounts:
        print("错误：未找到环境变量 adidas / adi / adiclub / kklb")

        raise SystemExit(1)

    rule_code = os.getenv("ADI_RULE_CODE", DEFAULT_RULE_CODE).strip() or DEFAULT_RULE_CODE
    campaign_codes = load_campaign_codes()
    football_category = os.getenv("ADI_FOOTBALL_CATEGORY", DEFAULT_FOOTBALL_CATEGORY).strip() or DEFAULT_FOOTBALL_CATEGORY
    football_subcategory = os.getenv("ADI_FOOTBALL_SUBCATEGORY", DEFAULT_FOOTBALL_SUBCATEGORY).strip() or DEFAULT_FOOTBALL_SUBCATEGORY
    football_campaign_code = os.getenv("ADI_FOOTBALL_CAMPAIGN_CODE", "").strip()
    football_enabled = os.getenv("ADI_ENABLE_FOOTBALL", "1") != "0"
    football_try_signin = os.getenv("ADI_FOOTBALL_TRY_SIGNIN", "1") != "0"
    worldcup_enabled = os.getenv("ADI_ENABLE_WORLDCUP_H5", "1") != "0"
    worldcup_sign_source = os.getenv("ADI_WORLDCUP_SIGN_SOURCE", "").strip()
    worldcup_activity_code = os.getenv("ADI_WORLDCUP_ACTIVITY_CODE", "").strip()
    worldcup_team_id = os.getenv("ADI_WORLDCUP_TEAM_ID", "").strip()
    worldcup_try_exchange = os.getenv("ADI_WORLDCUP_TRY_EXCHANGE", "0") == "1"
    worldcup_auto_lottery = os.getenv("ADI_WORLDCUP_AUTO_LOTTERY", "1") != "0"
    worldcup_lottery_activity_id = int(os.getenv("ADI_WORLDCUP_LOTTERY_ACTIVITY_ID", "1"))
    worldcup_lottery_pool_no = int(os.getenv("ADI_WORLDCUP_LOTTERY_POOL_NO", "2"))
    notify_lines = []

    print_and_collect(notify_lines, f"adidas会员中心 | 账号数: {len(accounts)}")

    for idx, account in enumerate(accounts, 1):
        wxid = account["wxid"]
        remark = account["remark"]

        print_and_collect(notify_lines, f"[{idx}/{len(accounts)}] 账号: {remark} | wxid: {wxid}")
        random_sleep("账号开始", 2, 6, notify_lines)

        code_ok, code_result = fetch_valid_app_code(wxid)
        if not code_ok:
            print_and_collect(notify_lines, f"获取 code: {_shorten(code_result, 180)}")
            print_and_collect(notify_lines, "-" * 80)
            continue

        exist_ok, exist_result = check_user_exist(code_result)
        if exist_ok:
            existed = exist_result.get("existed")
            first_login = exist_result.get("firstLogin")
            print_and_collect(
                notify_lines,
                f"账号状态: existed={existed} | firstLogin={first_login}",
            )
        else:
            print_and_collect(notify_lines, f"账号状态: {_shorten(exist_result, 160)}")

        token_ok, token_result = login_member(code_result)
        if not token_ok:
            print_and_collect(notify_lines, f"业务登录: {_shorten(token_result, 180)}")
            print_and_collect(notify_lines, "-" * 80)
            continue

        token = token_result["token"]
        jwt_payload = decode_jwt_payload(token)
        random_sleep("登录后", 1, 3, notify_lines)

        member_before_ok, member_before = fetch_member_info(token)
        if member_before_ok:
            print_and_collect(
                notify_lines,
                f"当前积分: {member_before.get('availablePoints')} | 会员等级: {member_before.get('memberTier')}",
            )
        else:
            print_and_collect(notify_lines, f"当前积分: {_shorten(member_before, 140)}")

        judge_ok, judge_result = daily_sign_judge(token, rule_code)
        if judge_ok:
            sign_flag = _extract_first(judge_result, ("signFlag",))
            print_and_collect(notify_lines, f"每日签到状态: signFlag={sign_flag}")
        else:
            print_and_collect(notify_lines, f"每日签到状态: {_shorten(judge_result, 140)}")

        daily_ok, daily_result = daily_sign(token, rule_code)
        daily_msg, daily_skip = parse_daily_result(daily_result) if daily_ok else (f"每日签到: {_shorten(daily_result, 180)}", False)
        if daily_msg and not daily_skip:
            print_and_collect(notify_lines, daily_msg)
        random_sleep("每日签到后", 1, 3, notify_lines)

        member_after_ok, member_after = fetch_member_info(token)
        if member_after_ok:
            print_and_collect(
                notify_lines,
                f"签到后积分: {member_after.get('availablePoints')} | 即将过期积分: {member_after.get('expiringPoints')}",
            )
        else:
            print_and_collect(notify_lines, f"签到后积分: {_shorten(member_after, 140)}")

        if football_enabled:
            football_ok, football_result = choose_football_campaign(
                football_category,
                football_subcategory,
                football_campaign_code,
            )
            if not football_ok:
                print_and_collect(notify_lines, f"足球活动: {_shorten(football_result, 180)}")
            else:
                football_code = football_result.get("campaignCode")
                football_name = football_result.get("campaignName")
                football_status = football_result.get("exerciseStatus")
                football_signup_status = football_result.get("signUpStatus")
                football_begin = football_result.get("signBeginTime")
                football_end = football_result.get("signEndTime")
                print_and_collect(
                    notify_lines,
                    f"足球活动命中: {football_name} | code={football_code} | status={football_status} | signUpStatus={football_signup_status}",
                )
                if football_begin or football_end:
                    print_and_collect(
                        notify_lines,
                        f"足球活动报名期: {football_begin or '-'} -> {football_end or '-'}",
                    )

                signup_ok, signup_result = signup_exercise(token, football_code)
                if signup_ok:
                    msg, skip = parse_exercise_signup_result(football_code, signup_result)
                    if not skip:
                        print_and_collect(notify_lines, msg)
                else:
                    print_and_collect(notify_lines, f"足球活动[{football_code}]报名: {_shorten(signup_result, 180)}")
                random_sleep("足球活动报名后", 2, 5, notify_lines)

                if football_try_signin:
                    signin_detail_ok, signin_detail_result = fetch_exercise_signin_detail(token, football_code)
                    if signin_detail_ok:
                        print_and_collect(
                            notify_lines,
                            f"足球活动[{football_code}]签到详情: {_shorten(signin_detail_result, 180)}",
                        )
                    else:
                        print_and_collect(
                            notify_lines,
                            f"足球活动[{football_code}]签到详情: {_shorten(signin_detail_result, 180)}",
                        )

                    signin_ok, signin_result = exercise_signin(token, football_code)
                    print_and_collect(
                        notify_lines,
                        parse_exercise_signin_result(football_code, signin_result)
                        if signin_ok
                        else f"足球活动[{football_code}]签到: {_shorten(signin_result, 180)}",
                    )
                    random_sleep("足球活动签到后", 1, 3, notify_lines)

        if worldcup_enabled:
            wc_member_id = jwt_payload.get("member_id")
            if not wc_member_id and member_before_ok and isinstance(member_before, dict):
                wc_member_id = member_before.get("consumerCode") or member_before.get("memberCode")
            wc_union_id = jwt_payload.get("union_id_1")
            wc_open_id = jwt_payload.get("adiclub_open_id")
            wc_user_claim = jwt_payload.get("user_id") or "1"
            wc_platform = "ADICLUB"

            print_and_collect(
                notify_lines,
                f"足球街区参数: member_id={wc_member_id or '-'} | union_id={wc_union_id or '-'} | open_id={wc_open_id or '-'}",
            )

            if not wc_member_id or not wc_union_id:
                print_and_collect(notify_lines, "足球街区: 未从 ANA token 中解析到 member_id/union_id，跳过")
            else:
                wc_exists_ok, wc_exists_result = worldcup_user_exists(wc_member_id, wc_platform, wc_user_claim)
                if wc_exists_ok:
                    print_and_collect(notify_lines, f"足球街区 exists: {_shorten(wc_exists_result, 160)}")
                else:
                    print_and_collect(notify_lines, f"足球街区 exists: {_shorten(wc_exists_result, 180)}")

                wc_login_ok, wc_login_result = worldcup_login(wc_member_id, wc_union_id, wc_platform, wc_user_claim)
                if not wc_login_ok:
                    print_and_collect(notify_lines, f"足球街区登录: {_shorten(wc_login_result, 180)}")
                else:
                    wc_user = {
                        "id": wc_login_result.get("id"),
                        "token": wc_login_result.get("token"),
                    }
                    wc_user_id = wc_login_result.get("id")
                    account_lottery_results = []
                    print_and_collect(notify_lines, f"足球街区登录: 成功 | userId={wc_user_id}")

                    task_ok, task_result = worldcup_task_info(wc_user_id, wc_user, wc_platform, wc_user_claim)
                    if task_ok:
                        print_and_collect(
                            notify_lines,
                            "足球街区任务: "
                            f"selectedTeam={task_result.get('selectedTeam')} | "
                            f"fansInfo={task_result.get('fansInfo')} | "
                            f"addWechat={task_result.get('addWechat')} | "
                            f"shareActivity={task_result.get('shareActivity')} | "
                            f"helpCount={task_result.get('helpCount')} | "
                            f"visitShop={task_result.get('visitShop')} | "
                            f"visitCustomShirt={task_result.get('visitCustomShirt')} | "
                            f"playVideo={task_result.get('playVideo')} | "
                            f"exchangeChance={task_result.get('exchangeChance')}"
                        )
                    else:
                        print_and_collect(notify_lines, f"足球街区任务: {_shorten(task_result, 180)}")
                        task_result = {}

                    if task_result.get("selectedTeam", 0) == 0:
                        team_ok, team_result = worldcup_team_list(wc_user, wc_platform, wc_user_claim)
                        if team_ok and team_result:
                            selected_team = None
                            if worldcup_team_id:
                                for item in team_result:
                                    if str(item.get("id")) == str(worldcup_team_id):
                                        selected_team = item
                                        break
                            if not selected_team:
                                selected_team = team_result[0]
                            select_ok, select_result = worldcup_select_team(
                                wc_user_id,
                                selected_team.get("id"),
                                wc_user,
                                wc_platform,
                                wc_user_claim,
                            )
                            print_and_collect(
                                notify_lines,
                                parse_worldcup_result(
                                    f"足球街区选主队[{selected_team.get('name') or selected_team.get('id')}]",
                                    select_result,
                                )
                                if select_ok
                                else f"足球街区选主队: {_shorten(select_result, 180)}",
                            )
                            random_sleep("足球街区选主队后", 2, 5, notify_lines)
                        else:
                            print_and_collect(notify_lines, f"足球街区球队列表: {_shorten(team_result, 180)}")

                    if task_result.get("shareActivity", 0) == 0:
                        share_ok, share_result = worldcup_task_finish(
                            wc_user_id, 4, wc_user, wc_platform, wc_user_claim
                        )
                        print_and_collect(
                            notify_lines,
                            parse_worldcup_result("足球街区任务[分享活动]", share_result)
                            if share_ok
                            else f"足球街区任务[分享活动]: {_shorten(share_result, 180)}",
                        )
                        random_sleep("足球街区分享任务后", 2, 4, notify_lines)

                    if task_result.get("visitShop", 0) == 0:
                        shop_ok, shop_result = worldcup_task_finish(
                            wc_user_id, 5, wc_user, wc_platform, wc_user_claim
                        )
                        print_and_collect(
                            notify_lines,
                            parse_worldcup_result("足球街区任务[浏览世界杯商品15s]", shop_result)
                            if shop_ok
                            else f"足球街区任务[浏览世界杯商品15s]: {_shorten(shop_result, 180)}",
                        )
                        random_sleep("足球街区商品任务后", 3, 8, notify_lines)

                    if task_result.get("visitCustomShirt", 0) == 0:
                        shirt_ok, shirt_result = worldcup_task_finish(
                            wc_user_id, 10, wc_user, wc_platform, wc_user_claim
                        )
                        print_and_collect(
                            notify_lines,
                            parse_worldcup_result("足球街区任务[浏览印号球衣定制15s]", shirt_result)
                            if shirt_ok
                            else f"足球街区任务[浏览印号球衣定制15s]: {_shorten(shirt_result, 180)}",
                        )
                        random_sleep("足球街区定制任务后", 3, 8, notify_lines)

                    if task_result.get("playVideo", 0) == 0:
                        video_ok, video_result = worldcup_task_finish(
                            wc_user_id, 7, wc_user, wc_platform, wc_user_claim
                        )
                        print_and_collect(
                            notify_lines,
                            parse_worldcup_result("足球街区任务[观看最新影片15s]", video_result)
                            if video_ok
                            else f"足球街区任务[观看最新影片15s]: {_shorten(video_result, 180)}",
                        )
                        random_sleep("足球街区视频任务后", 3, 8, notify_lines)

                    if int(task_result.get("helpCount", 0) or 0) < 3:
                        team_ok, team_result = worldcup_team_list(wc_user, wc_platform, wc_user_claim)
                        if team_ok and team_result:
                            help_team = None
                            desired_id = worldcup_team_id or str(team_result[0].get("id"))
                            for item in team_result:
                                if str(item.get("id")) == str(desired_id):
                                    help_team = item
                                    break
                            if not help_team:
                                help_team = team_result[0]
                            help_ok, help_result = worldcup_team_help(
                                wc_user_id, help_team.get("id"), wc_user, wc_platform, wc_user_claim
                            )
                            print_and_collect(
                                notify_lines,
                                parse_worldcup_result(
                                    f"足球街区任务[助力冲榜:{help_team.get('name') or help_team.get('id')}]",
                                    help_result,
                                )
                                if help_ok
                                else f"足球街区任务[助力冲榜]: {_shorten(help_result, 180)}",
                            )
                            random_sleep("足球街区助力后", 2, 5, notify_lines)

                    if worldcup_try_exchange and int(task_result.get("exchangeChance", 0) or 0) == 0:
                        exch_ok, exch_result = worldcup_exchange_chance(
                            wc_user_id, wc_user, wc_platform, wc_user_claim
                        )
                        print_and_collect(
                            notify_lines,
                            parse_worldcup_result("足球街区任务[150积分兑换抽奖机会]", exch_result)
                            if exch_ok
                            else f"足球街区任务[150积分兑换抽奖机会]: {_shorten(exch_result, 180)}",
                        )
                        random_sleep("足球街区兑换后", 2, 5, notify_lines)

                    wc_list_ok, wc_list_result = worldcup_activity_list(wc_user, wc_platform, wc_user_claim)
                    if not wc_list_ok:
                        print_and_collect(notify_lines, f"足球街区活动列表: {_shorten(wc_list_result, 180)}")
                    else:
                        target_activity = None
                        for item in wc_list_result:
                            if worldcup_activity_code and str(item.get("activityCode")) == worldcup_activity_code:
                                target_activity = item
                                break
                        if not target_activity and wc_list_result:
                            target_activity = wc_list_result[0]

                        if target_activity:
                            activity_code = target_activity.get("activityCode")
                            detail_ok, detail_result = worldcup_activity_info(
                                activity_code, wc_user, wc_platform, wc_user_claim
                            )
                            if detail_ok:
                                print_and_collect(
                                    notify_lines,
                                    f"足球街区活动: {detail_result.get('title') or detail_result.get('activityName') or activity_code} | "
                                    f"activityCode={activity_code} | offlineState={detail_result.get('offlineState')} | activityState={detail_result.get('activityState')}",
                                )
                            else:
                                print_and_collect(notify_lines, f"足球街区活动详情: {_shorten(detail_result, 180)}")

                            apply_ok, apply_result = worldcup_activity_apply(
                                wc_user_id,
                                activity_code,
                                worldcup_sign_source,
                                wc_user,
                                wc_platform,
                                wc_user_claim,
                            )
                            print_and_collect(
                                notify_lines,
                                parse_worldcup_result(f"足球街区活动报名[{activity_code}]", apply_result)
                                if apply_ok
                                else f"足球街区活动报名[{activity_code}]: {_shorten(apply_result, 180)}",
                            )
                            random_sleep("足球街区活动报名后", 2, 5, notify_lines)

                            apply_detail_ok, apply_detail_result = worldcup_activity_apply_detail(
                                wc_user_id, activity_code, wc_user, wc_platform, wc_user_claim
                            )
                            if apply_detail_ok:
                                print_and_collect(
                                    notify_lines,
                                    f"足球街区活动报名详情[{activity_code}]: {_shorten(apply_detail_result, 180)}",
                                )
                            else:
                                print_and_collect(
                                    notify_lines,
                                    f"足球街区活动报名详情[{activity_code}]: {_shorten(apply_detail_result, 180)}",
                                )

                            signin_ok, signin_result = worldcup_activity_signin(
                                wc_user_id, activity_code, wc_user, wc_platform, wc_user_claim
                            )
                            print_and_collect(
                                notify_lines,
                                parse_worldcup_result(f"足球街区活动签到[{activity_code}]", signin_result)
                                if signin_ok
                                else f"足球街区活动签到[{activity_code}]: {_shorten(signin_result, 180)}",
                            )
                            random_sleep("足球街区活动签到后", 2, 5, notify_lines)

                    if worldcup_auto_lottery:
                        wc_userinfo_ok, wc_userinfo_result = worldcup_user_info(
                            wc_user_id, True, wc_user, wc_platform, wc_user_claim
                        )
                        if wc_userinfo_ok:
                            lottery_change = int(wc_userinfo_result.get("lotteryChange", 0) or 0)
                            lottery_today = int(wc_userinfo_result.get("lotteryCountToday", 0) or 0)
                            print_and_collect(
                                notify_lines,
                                f"足球街区抽奖次数: lotteryChange={lottery_change} | lotteryCountToday={lottery_today}",
                            )
                            draw_round = 0
                            while lottery_change > 0 and lottery_today > 0:
                                draw_round += 1
                                random_sleep(f"足球街区第{draw_round}次抽奖前", 3, 5, notify_lines)
                                draw_ok, draw_result = worldcup_lottery(
                                    wc_user_id,
                                    worldcup_lottery_activity_id,
                                    worldcup_lottery_pool_no,
                                    wc_user,
                                    wc_platform,
                                    wc_user_claim,
                                )
                                if draw_ok:
                                    summary, _ = summarize_lottery_result(draw_result)
                                    account_lottery_results.append(summary)
                                    print_and_collect(notify_lines, f"足球街区抽奖[{draw_round}]: {summary}")
                                else:
                                    print_and_collect(
                                        notify_lines,
                                        f"足球街区抽奖[{draw_round}]: {_shorten(draw_result, 180)}",
                                    )
                                    break
                                random_sleep(f"足球街区第{draw_round}次抽奖后", 3, 5, notify_lines)
                                wc_userinfo_ok, wc_userinfo_result = worldcup_user_info(
                                    wc_user_id, True, wc_user, wc_platform, wc_user_claim
                                )
                                if not wc_userinfo_ok:
                                    print_and_collect(
                                        notify_lines,
                                        f"足球街区抽奖后刷新失败: {_shorten(wc_userinfo_result, 180)}",
                                    )
                                    break
                                lottery_change = int(wc_userinfo_result.get("lotteryChange", 0) or 0)
                                lottery_today = int(wc_userinfo_result.get("lotteryCountToday", 0) or 0)

                            if account_lottery_results:
                                win_only = [item for item in account_lottery_results if item != "谢谢参与"]
                                print_and_collect(
                                    notify_lines,
                                    f"足球街区抽奖结果: {' | '.join(win_only or account_lottery_results)}",
                                )
                            else:
                                print_and_collect(notify_lines, "足球街区抽奖结果: 无抽奖记录")
                        else:
                            print_and_collect(
                                notify_lines,
                                f"足球街区抽奖后刷新失败: {_shorten(wc_userinfo_result, 180)}",
                            )

        for campaign_code in campaign_codes:
            query_ok, query_result = query_campaign(token, campaign_code)
            if not query_ok:
                print_and_collect(notify_lines, f"单次任务[{campaign_code}]查询: {_shorten(query_result, 180)}")
                continue

            bid = _extract_first(query_result, ("bid", "thematicCampaignBid"))
            if _is_empty_value(bid):
                print_and_collect(
                    notify_lines,
                    f"单次任务[{campaign_code}]查询成功，但未发现 bid | {_shorten(query_result, 180)}",
                )
                continue

            sign_ok, sign_result = sign_campaign(token, campaign_code, bid)
            if sign_ok:
                msg, skip = parse_campaign_result(campaign_code, sign_result)
                if not skip:
                    print_and_collect(notify_lines, msg)
            else:
                print_and_collect(notify_lines, f"单次任务[{campaign_code}]: {_shorten(sign_result, 180)}")
            random_sleep(f"单次任务{campaign_code}后", 1, 3, notify_lines)

        print_and_collect(notify_lines, "-" * 80)

    title = f"adidas会员中心任务通知 | 共{len(accounts)}个账号"
    notify_text = "\n".join(notify_lines)
    ql_ok, ql_result = send_qinglong_notify(title, notify_text)
    print(f"青龙通知: {'成功' if ql_ok else '跳过/失败'} | {ql_result}")
    if not ql_ok:
        ok, result = send_feishu_notify(title, notify_text)
        print(f"飞书通知: {'成功' if ok else '跳过/失败'} | {result}")

if __name__ == "__main__":
    run_default_mode()
