#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 南昌工会 小程序签到 + 积分任务
# 入口: 微信小程序搜索南昌工会
# 使用 YYB 协议获取 code 和 phoneCode
#
# 环境变量:
# 1. YYB_BASE_URL: YYB 协议地址，默认 http://172.17.0.1:18080
# 2. 账号自动从 YYB /accounts 获取，无需手动配置

import base64
import json
import os
import random
import subprocess
import time
from pathlib import Path

import requests
from Crypto.Cipher import PKCS1_v1_5
from Crypto.PublicKey import RSA

# ========== 协议地址 ==========
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")

# YYB 接口
YYB_ACCOUNTS_URL = f"{YYB_BASE_URL}/accounts"
YYB_GET_CODE_URL = f"{YYB_BASE_URL}/wxapp/getCode"
YYB_GET_PHONE_URL = f"{YYB_BASE_URL}/wxapp/getPhoneNumber"

APPID = "wxd4304a23e648be81"
BASE_URL = "https://ncgh.org.cn/nczhgh.interface"

WX_AUTH_URL = f"{BASE_URL}/api/wx/auth"
SIGN_IN_URL = f"{BASE_URL}/points/signIn/"
USER_POINTS_URL = f"{BASE_URL}/shop/log/my/points"
VIEW_COUNT_URL = f"{BASE_URL}/points/task/view/count"
LIKE_COUNT_URL = f"{BASE_URL}/points/task/like/count"
COMMENT_COUNT_URL = f"{BASE_URL}/points/task/comment/count"
WATCH_COUNT_URL = f"{BASE_URL}/points/task/watch/count"
ANSWER_COUNT_URL = f"{BASE_URL}/knowledge/user/info/answer/count"
ARTICLE_LIST_URL = f"{BASE_URL}/api/cms/article/list"
IDS_LIST_URL = f"{BASE_URL}/api/cms/article/getIdsList"

RSA_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0lvxLoTo4OnnHldcIonuq/W7y
wppxTqsK4IxHcPvSNd7U3vC7l8IHM5dNUElN31X6vWcxKIUmgVW9qZfF9AdSEXzo
N5uQwUNsP+8V5NR745N7Cgb+x/+CSYs95/JVqp3EWF1Nyqq/YZJeAnrU7kHqsYqd
OjL5oC/LozDMiQil0wIDAQAB
-----END PUBLIC KEY-----"""

_rsa_cipher = PKCS1_v1_5.new(RSA.import_key(RSA_PUBLIC_KEY))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027"
)


# ========== 账号获取 ==========

def fetch_accounts_from_yyb():
    """从 YYB 协议获取账号列表，返回 [(nickname, openid), ...]"""
    try:
        resp = requests.get(YYB_ACCOUNTS_URL, timeout=15)
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            accounts = []
            for acc in data["data"]:
                openid = acc.get("openid", "")
                nickname = acc.get("nickname", "") or acc.get("alias", "") or openid
                if openid:
                    accounts.append((nickname, openid))
            return accounts
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []


def parse_accounts():
    """从 YYB 获取账号列表"""
    yyb_accounts = fetch_accounts_from_yyb()
    if not yyb_accounts:
        print("错误：YYB 无账号")
        return []
    print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
    return [{"nickname": nick, "openid": oid} for nick, oid in yyb_accounts]


# ========== RSA 加密 ==========

def _encrypt_long_py(text):
    """纯 Python 实现 jsencrypt 的 encryptLong"""
    chunks = [text[i:i + 117] for i in range(0, len(text), 117)] or [""]
    hex_join = ""
    for part in chunks:
        encrypted = _rsa_cipher.encrypt(part.encode("utf-8"))
        hex_join += encrypted.hex()
    return base64.b64encode(bytes.fromhex(hex_join)).decode("utf-8")


def encrypt_long(text):
    """RSA 加密，与小程序 jsencrypt encryptLong 兼容"""
    for _ in range(12):
        out = _encrypt_long_py(text)
        if out.endswith("=="):
            return out
    return out


def _shorten(value, limit=200):
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "..."


def _extract_first(payload, target_keys):
    if isinstance(payload, dict):
        for key in target_keys:
            value = payload.get(key)
            if value not in (None, "", [], {}):
                return value
        for value in payload.values():
            result = _extract_first(value, target_keys)
            if result not in (None, "", [], {}):
                return result
    elif isinstance(payload, list):
        for item in payload:
            result = _extract_first(item, target_keys)
            if result not in (None, "", [], {}):
                return result
    return None


# ========== HTTP 请求 ==========

def build_headers(token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
        token_obj = json.dumps(
            {"token": token, "timestamp": int(time.time() * 1000)},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        headers["token"] = encrypt_long(token_obj)
    return headers


def request_json(method, url, token=None, params=None, data=None, json_body=None):
    headers = build_headers(token)
    try:
        response = requests.request(
            method=method.upper(),
            url=url,
            params=params,
            data=data,
            json=json_body,
            headers=headers,
            timeout=20,
        )
        try:
            result = response.json()
        except ValueError:
            result = response.text
        return response.status_code, result
    except requests.exceptions.ConnectionError:
        return None, f"连接失败 | {url}"
    except requests.exceptions.Timeout:
        return None, f"请求超时 | {url}"
    except Exception as exc:
        return None, f"请求异常 | {exc}"


# ========== YYB 协议：获取 code & phoneCode ==========

def fetch_app_code(wxid):
    """通过 YYB 协议获取小程序 code"""
    payload = {"ref": wxid.strip(), "app_id": APPID}
    try:
        resp = requests.post(
            YYB_GET_CODE_URL,
            json=payload,
            headers={"Content-Type": "application/json", "User-Agent": UA},
            timeout=30,
        )
        result = resp.json()
        if isinstance(result, dict):
            data = result.get("data") or {}
            if isinstance(data, dict):
                res = data.get("result")
                if isinstance(res, dict):
                    code = res.get("code")
                    if code:
                        return True, str(code)
                code = data.get("code") or data.get("Code")
                if code:
                    return True, str(code)
            if result.get("code") == 0:
                data2 = result.get("data")
                if isinstance(data2, str) and data2:
                    return True, data2
        return False, f"取code失败 | {_shorten(result)}"
    except Exception as e:
        return False, f"取code异常 | {e}"


def fetch_valid_app_code(wxid, retries=4, wait_seconds=2):
    """多次重试获取 code"""
    last_result = "未获取到有效 app_code"
    for attempt in range(1, retries + 1):
        ok, result = fetch_app_code(wxid)
        if ok and str(result) not in ("", "0", "None"):
            return True, result
        last_result = f"第{attempt}次取code失败: {result}"
        if attempt < retries:
            time.sleep(wait_seconds)
    return False, last_result


def fetch_phone_code(wxid):
    """通过 YYB 协议获取手机号 phoneCode"""
    payload = {"ref": wxid.strip(), "app_id": APPID}
    try:
        resp = requests.post(
            YYB_GET_PHONE_URL,
            json=payload,
            headers={"Content-Type": "application/json", "User-Agent": UA},
            timeout=30,
        )
        result = resp.json()
        if isinstance(result, dict):
            data = result.get("data") or {}
            if isinstance(data, dict):
                res = data.get("result")
                if isinstance(res, dict):
                    code = res.get("code")
                    if code:
                        return True, str(code)
        return False, f"取phoneCode失败 | {_shorten(result)}"
    except Exception as e:
        return False, f"取phoneCode异常 | {e}"


# ========== 南昌工会 API ==========

def login_by_code(app_code, phone_code):
    params = {"code": app_code, "phoneCode": phone_code}
    status_code, result = request_json("GET", WX_AUTH_URL, params=params)
    if status_code != 200:
        return False, f"登录失败 | status={status_code} | {_shorten(result.get('msg') or result)}"
    token = result.get("data")
    if not token:
        return False, f"登录失败 | token为空 | {_shorten(result)}"
    return True, str(token)


def get_count(url, token):
    status_code, result = request_json("GET", url, token=token)
    if status_code != 200 or not isinstance(result, dict):
        return False, f"查询失败 | HTTP:{status_code} | {_shorten(result)}"
    if str(result.get("code")) != "200":
        return False, f"查询失败 | {_shorten(result)}"
    count = _extract_first(result.get("data", {}), ("count",))
    try:
        return True, int(count or 0)
    except Exception:
        return True, 0


def fetch_article_ids(token, category_id, limit=12):
    params = {"pageNum": 1, "pageSize": limit, "categoryId": str(category_id), "orderBy": "created"}
    status_code, result = request_json("GET", ARTICLE_LIST_URL, token=token, params=params)
    if status_code != 200 or not isinstance(result, dict) or str(result.get("code")) != "200":
        return []
    data = result.get("data", {}) or {}
    lst = data.get("list", []) or []
    return [item.get("id") for item in lst if item.get("id")]


def fetch_watch_category_id():
    status_code, result = request_json("GET", IDS_LIST_URL, params={"categoryId": "174"})
    if status_code != 200 or not isinstance(result, dict):
        return "174"
    data = result.get("data", []) or []
    if isinstance(data, list) and data:
        first_id = data[0].get("id")
        if first_id:
            return str(first_id)
    return "174"


def do_sign(token):
    status_code, result = request_json("GET", SIGN_IN_URL, token=token)
    if status_code != 200 or not isinstance(result, dict):
        return False, f"签到失败 | HTTP:{status_code} | {_shorten(result)}"
    code = str(result.get("code"))
    if code == "200":
        return True, "签到结果: 签到成功"
    msg = str(result.get("msg", ""))
    if "已签到" in msg or "已打过卡" in msg or "已经打过卡" in msg:
        return True, "签到结果: 今日已签到"
    return False, f"签到结果: {msg or _shorten(result)}"


def do_view_task(token, article_ids, target=3):
    ok, count = get_count(VIEW_COUNT_URL, token)
    if not ok:
        return False, f"浏览任务查询失败: {count}"
    if count >= target:
        return True, f"浏览任务: {count}/{target}"
    for article_id in article_ids:
        if count >= target:
            break
        url = f"{BASE_URL}/points/task/view/{article_id}"
        status_code, result = request_json("GET", url, token=token)
        if status_code == 200 and isinstance(result, dict) and str(result.get("code")) == "200":
            changed = _extract_first(result.get("data", {}), ("changed",))
            if str(changed) == "1":
                count += 1
        time.sleep(0.5)
    return True, f"浏览任务: {count}/{target}"


def do_like_task(token, article_ids, target=3):
    ok, count = get_count(LIKE_COUNT_URL, token)
    if not ok:
        return False, f"点赞任务查询失败: {count}"
    if count >= target:
        return True, f"点赞任务: {count}/{target}"
    for article_id in article_ids:
        if count >= target:
            break
        status_code, result = request_json(
            "GET",
            f"{BASE_URL}/points/task/like",
            token=token,
            params={"articleId": article_id, "status": "true"},
        )
        if status_code == 200 and isinstance(result, dict) and str(result.get("code")) == "200":
            changed = _extract_first(result.get("data", {}), ("changed",))
            if str(changed) == "1":
                count += 1
        time.sleep(0.5)
    return True, f"点赞任务: {count}/{target}"


def do_comment_task(token, article_ids, target=3):
    ok, count = get_count(COMMENT_COUNT_URL, token)
    if not ok:
        return False, f"评论任务查询失败: {count}"
    if count >= target:
        return True, f"评论任务: {count}/{target}"
    templates = ["每日打卡", "学习一下", "内容不错", "支持一下", "工会加油"]
    for article_id in article_ids:
        if count >= target:
            break
        content = random.choice(templates) + str(int(time.time()) % 1000)
        status_code, result = request_json(
            "GET",
            f"{BASE_URL}/points/task/comment",
            token=token,
            params={"articleId": article_id, "pid": "", "content": content},
        )
        if status_code == 200 and isinstance(result, dict) and str(result.get("code")) == "200":
            changed = _extract_first(result.get("data", {}), ("changed",))
            if str(changed) == "1":
                count += 1
        time.sleep(0.8)
    return True, f"评论任务: {count}/{target}"


def do_watch_task(token, article_ids, target=3):
    ok, count = get_count(WATCH_COUNT_URL, token)
    if not ok:
        return False, f"观看任务查询失败: {count}"
    if count >= target:
        return True, f"观看任务: {count}/{target}"
    for article_id in article_ids:
        if count >= target:
            break
        status_code, result = request_json(
            "GET",
            f"{BASE_URL}/points/task/watch/{article_id}",
            token=token,
        )
        if status_code == 200 and isinstance(result, dict) and str(result.get("code")) == "200":
            changed = _extract_first(result.get("data", {}), ("changed",))
            if str(changed) == "1":
                count += 1
        time.sleep(0.8)
    return True, f"观看任务: {count}/{target}"


def get_user_points(token):
    status_code, result = request_json("GET", USER_POINTS_URL, token=token)
    if status_code != 200 or not isinstance(result, dict):
        return False, f"积分查询失败 | HTTP:{status_code} | {_shorten(result)}"
    if str(result.get("code")) != "200":
        return False, f"积分查询失败 | {_shorten(result)}"
    points = _extract_first(result.get("data", {}), ("points",))
    return True, f"当前积分: {points if points is not None else '未知'}"


def get_answer_task_status(token):
    ok, count = get_count(ANSWER_COUNT_URL, token)
    if not ok:
        return f"答题任务: 查询失败 ({count})"
    return f"答题任务: {count}/1"


# ========== 主流程 ==========

def run():
    accounts = parse_accounts()
    if not accounts:
        print("错误：未找到可用账号")
        raise SystemExit(1)

    watch_category_id = fetch_watch_category_id()
    print(f"========== 南昌工会 | YYB模式 | 数量: {len(accounts)} ==========")

    for idx, account in enumerate(accounts, 1):
        nickname = account.get("nickname", "")
        openid = account["openid"]
        title = f"{nickname}({openid})" if nickname else openid

        # 1. 获取 code（YYB）
        code_ok, code_result = fetch_valid_app_code(openid)
        if not code_ok:
            print(f"[{idx}/{len(accounts)}] {title}")
            print(f"结果: {_shorten(code_result, 120)}")
            print("-" * 80)
            continue

        # 2. 获取 phoneCode（YYB）
        p_ok, p_result = fetch_phone_code(openid)
        if p_ok:
            phone_code = p_result
        else:
            print(f"[{idx}/{len(accounts)}] {title}")
            print(f"结果: 已获取code，但自动取phoneCode失败 | {_shorten(p_result, 120)}")
            print("-" * 80)
            continue

        # 3. 登录
        login_ok, login_result = login_by_code(code_result, phone_code)
        if not login_ok:
            print(f"[{idx}/{len(accounts)}] {title}")
            print(f"结果: {_shorten(login_result, 120)}")
            print("-" * 80)
            continue

        token = login_result

        # 4. 签到
        sign_ok, sign_result = do_sign(token)

        # 5. 获取文章列表
        news_ids = fetch_article_ids(token, category_id="3", limit=12)
        watch_ids = fetch_article_ids(token, category_id=watch_category_id, limit=12)
        if not watch_ids:
            watch_ids = news_ids

        # 6. 执行积分任务
        view_ok, view_result = do_view_task(token, news_ids)
        like_ok, like_result = do_like_task(token, news_ids)
        comment_ok, comment_result = do_comment_task(token, news_ids)
        watch_ok, watch_result = do_watch_task(token, watch_ids)
        answer_status = get_answer_task_status(token)
        points_ok, points_result = get_user_points(token)

        # 7. 输出结果
        print(f"[{idx}/{len(accounts)}] {title}")
        print(sign_result if sign_ok else f"签到失败: {_shorten(sign_result, 120)}")
        print(view_result if view_ok else f"浏览失败: {_shorten(view_result, 120)}")
        print(like_result if like_ok else f"点赞失败: {_shorten(like_result, 120)}")
        print(comment_result if comment_ok else f"评论失败: {_shorten(comment_result, 120)}")
        print(watch_result if watch_ok else f"观看失败: {_shorten(watch_result, 120)}")
        print(answer_status)
        print(points_result if points_ok else f"积分失败: {_shorten(points_result, 120)}")
        print("-" * 80)


if __name__ == "__main__":
    run()
