#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1916 mall lottery job.

Standalone Qinglong script: YYB code -> activity login -> query lottery count
-> lottery only. It never signs, receives liveness rewards, or exchanges coins.
"""

import base64
import hashlib
import json
import os
import random
import re
import sys
import tempfile
import time
from datetime import datetime
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, HTTPCookieProcessor


# ===== 脚本配置 =====
# MALL_LOTTERY_LIMIT：每个账号本次最多抽几次，范围 1~100。
# 设为 100 表示尽量抽完当前可用次数；实际次数不会超过 /api/myInfo 返回的 sumLuckNum。
# 默认值直接改下面这行；若环境已配置 MALL_LOTTERY_LIMIT，则环境变量优先。
MALL_LOTTERY_LIMIT = 1
LOTTERY_LIMIT = max(1, min(100, int(os.environ.get("MALL_LOTTERY_LIMIT", MALL_LOTTERY_LIMIT) or MALL_LOTTERY_LIMIT)))


API_BASE = os.environ.get("MALL_API_BASE", "https://rmt.hhl1916.com/act/huanghelou1916-mall").rstrip("/")
WEB_BASE = os.environ.get("MALL_WEB_BASE", "https://rmt.hhl1916.com/act/mall/").rstrip("/") + "/"
WX_LOGIN = os.environ.get("MALL_WX_LOGIN_URL", "https://rmt.hhl1916.com/thirdparty/v1/wxLogin")
ACT = os.environ.get("MALL_ACT", "Vjdmh4xz62iq")
SALT_KEY = "MjY7DP0h0NQ42UnI"
UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 MicroMessenger"
# YYB Go 服务对带 MicroMessenger(微信) UA 的请求会返回登录页 HTML 而非 JSON,
# 因此访问 YYB 自身接口(/accounts, /wxapp/getCode)必须使用普通浏览器 UA。
YYB_UA = "Python-urllib/3.11"
TIMEOUT = max(5, min(60, int(os.environ.get("MALL_HTTP_TIMEOUT", "20") or 20)))
RETRIES = max(0, min(4, int(os.environ.get("MALL_HTTP_RETRIES", "2") or 2)))
GAME_ID = os.environ.get("MALL_GAME_ID", "").strip()
YYB_URL = os.environ.get("YYB_URL", "").strip().rstrip("/")
YYB_USER = os.environ.get("YYB_USER", "").strip()
YYB_PASS = os.environ.get("YYB_PASS", "")
YYB_REF = os.environ.get("YYB_REF", "").strip()
WX_APP_ID = os.environ.get("WX_APP_ID", os.environ.get("YYB_APP_ID", "wxbe7126dd88a77df0")).strip()
TOKEN_CACHE = os.environ.get("MALL_TOKEN_CACHE", "").strip()


def log(message):
    if message.startswith("[1916抽奖]"):
        message = message[len("[1916抽奖]"):].lstrip()
    sys.stdout.write("[%s] %s\n" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message))
    sys.stdout.flush()

class MallError(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def http_error_301(self, req, fp, code, msg, headers): return fp
    def http_error_302(self, req, fp, code, msg, headers): return fp
    def http_error_303(self, req, fp, code, msg, headers): return fp
    def http_error_307(self, req, fp, code, msg, headers): return fp


def json_load(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def walk(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def find_value(value, keys):
    for key, item in walk(value):
        if key in keys and item not in (None, ""):
            return item
    return None


def candidate(value):
    value = value.strip() if isinstance(value, str) else ""
    return bool(value) and value.lower() not in {"ok", "success", "true", "null"} and not (value.isdigit() and len(value) <= 6) and len(value) <= 512


def get_code(payload, raw):
    for key in ("wx_code", "wxCode", "wechatCode", "authCode", "weixinCode", "code"):
        value = find_value(payload, {key})
        if candidate(value):
            return value.strip()
    if isinstance(payload, dict) and candidate(payload.get("data")):
        return payload["data"].strip()
    if candidate(raw.strip()):
        return raw.strip()
    raise MallError("YYB response has no WeChat code")


def get_user_id(payload, raw):
    value = find_value(payload, {"userId", "user_id", "userid", "activityUserId"})
    if isinstance(value, list) and value:
        value = value[0]
    if candidate(value):
        return value.strip()
    match = re.search(r"[?&](?:userId|user_id)=([^&#\"']+)", raw)
    if match and candidate(match.group(1)):
        return match.group(1)
    raise MallError("wxLogin response has no userId")


def b64(value):
    try:
        return base64.b64encode(value.encode("latin1")).decode("ascii")
    except UnicodeEncodeError as exc:
        raise MallError("userId is not ASCII; cannot reproduce page encoding") from exc


def make_auth(open_id, salt):
    salt = str(salt)
    if not open_id or len(salt) < 12:
        raise MallError("openId or salt is missing")
    try:
        salt_sum = int(salt[2:4]) + int(salt[8:11]) + int(salt[11])
    except ValueError as exc:
        raise MallError("salt format changed") from exc
    seed = hashlib.md5(open_id.lower().encode()).hexdigest() + hashlib.md5(SALT_KEY.lower().encode()).hexdigest() + salt
    ticket = hashlib.md5(seed.encode()).hexdigest()
    # The mall stores the first Base64 result as the Token. The game's helper
    # returns a second Base64 value, but that return value is not sent as a header.
    token = b64(salt + str(salt_sum) + open_id)
    return token, ticket


class HTTP:
    def __init__(self):
        jar = CookieJar()
        self.normal = build_opener(HTTPCookieProcessor(jar))
        self.no_redirect = build_opener(HTTPCookieProcessor(jar), NoRedirect())

    def request(self, method, url, headers=None, body=None, redirect=True, retry=False):
        req_headers = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
        req_headers.update(headers or {})
        data = None
        if body is not None:
            if isinstance(body, bytes):
                data = body
            else:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                req_headers.setdefault("Content-Type", "application/json;charset=UTF-8")
        attempts = RETRIES if retry and method.upper() == "GET" else 0
        for attempt in range(attempts + 1):
            req = Request(url, data=data, headers=req_headers, method=method.upper())
            try:
                with (self.normal if redirect else self.no_redirect).open(req, timeout=TIMEOUT) as res:
                    return res.status, dict(res.headers), res.read().decode("utf-8", "replace")
            except HTTPError as exc:
                raw = exc.read().decode("utf-8", "replace")
                if attempt < attempts and (exc.code in (408, 429) or exc.code >= 500):
                    time.sleep(min(8, 2 ** attempt) + random.random() / 3)
                    continue
                parsed = json_load(raw) or {}
                raise MallError("HTTP %s: %s" % (exc.code, parsed.get("msg", raw[:120]))) from exc
            except (URLError, TimeoutError, OSError) as exc:
                if attempt < attempts:
                    time.sleep(min(8, 2 ** attempt) + random.random() / 3)
                    continue
                raise MallError("network error: %s" % str(exc)[:120]) from exc
        raise MallError("request failed")


def require_yyb_config():
    missing = [name for name, value in (("YYB_URL", YYB_URL), ("YYB_USER", YYB_USER), ("YYB_PASS", YYB_PASS)) if not value]
    if missing:
        raise MallError("缺少青龙变量：" + ", ".join(missing))


def yyb_request(http, method, path, payload=None):
    require_yyb_config()
    auth = base64.b64encode((YYB_USER + ":" + YYB_PASS).encode("utf-8")).decode("ascii")
    status, _, raw = http.request(method, YYB_URL + path, headers={"Authorization": "Basic " + auth, "Accept": "application/json", "User-Agent": YYB_UA}, body=payload, retry=method.upper() == "GET")
    if status < 200 or status >= 300:
        raise MallError("YYB 请求失败：HTTP %s" % status)
    result = json_load(raw)
    if not isinstance(result, dict):
        raise MallError("YYB 返回了非 JSON 数据")
    return result


def accounts(http):
    result = yyb_request(http, "GET", "/accounts")
    if result.get("code") != 0 or not isinstance(result.get("data"), list):
        raise MallError("YYB 账号列表异常：" + str(result.get("msg") or "返回格式错误"))
    items = [item for item in result["data"] if isinstance(item, dict) and item.get("id") is not None]
    if YYB_REF:
        items = [item for item in items if any(item.get(key) is not None and str(item.get(key)) == YYB_REF for key in ("id", "uin", "openid"))]
        if len(items) != 1:
            raise MallError("YYB_REF 必须唯一匹配一个账号，实际匹配 %d 个" % len(items))
    if not items:
        raise MallError("YYB 没有可用账号")
    return items


def cache_load(account_id):
    """Load only the reusable mall userId; never store a YYB Code."""
    if not TOKEN_CACHE:
        return ""
    try:
        with open(TOKEN_CACHE, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        item = (payload.get("accounts") or {}).get(str(account_id)) or {}
        value = item.get("credential")
        return value.strip() if isinstance(value, str) else ""
    except FileNotFoundError:
        return ""
    except (OSError, ValueError, TypeError) as exc:
        raise MallError("业务登录缓存读取失败：%s" % type(exc).__name__) from exc


def cache_write(account_id, credential):
    if not TOKEN_CACHE:
        return
    payload = {"version": 1, "accounts": {}}
    try:
        with open(TOKEN_CACHE, "r", encoding="utf-8") as handle:
            current = json.load(handle)
        if isinstance(current, dict) and isinstance(current.get("accounts"), dict):
            payload["accounts"].update(current["accounts"])
    except FileNotFoundError:
        pass
    except (OSError, ValueError, TypeError) as exc:
        raise MallError("业务登录缓存读取失败：%s" % type(exc).__name__) from exc
    payload["accounts"][str(account_id)] = {
        "credential": credential,
        "updated_at": int(time.time()),
    }
    directory = os.path.dirname(os.path.abspath(TOKEN_CACHE))
    os.makedirs(directory, exist_ok=True)
    temp_name = ""
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, delete=False) as handle:
            temp_name = handle.name
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp_name, 0o600)
        except OSError:
            pass
        os.replace(temp_name, TOKEN_CACHE)
    finally:
        if temp_name and os.path.exists(temp_name):
            try:
                os.unlink(temp_name)
            except OSError:
                pass


def cache_delete(account_id):
    if not TOKEN_CACHE or not os.path.exists(TOKEN_CACHE):
        return
    try:
        with open(TOKEN_CACHE, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        accounts_data = payload.get("accounts") or {}
        if str(account_id) not in accounts_data:
            return
        del accounts_data[str(account_id)]
        directory = os.path.dirname(os.path.abspath(TOKEN_CACHE))
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, delete=False) as handle:
            temp_name = handle.name
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp_name, 0o600)
        except OSError:
            pass
        os.replace(temp_name, TOKEN_CACHE)
    except (OSError, ValueError, TypeError) as exc:
        raise MallError("业务登录缓存更新失败：%s" % type(exc).__name__) from exc


def yyb_code(http, account):
    result = yyb_request(http, "POST", "/wxapp/getCode", {"app_id": WX_APP_ID, "ref": str(account.get("id"))})
    if result.get("code") != 0:
        raise MallError("YYB 获取 Code 失败：" + str(result.get("msg") or "未知错误"))
    code = ((result.get("data") or {}).get("result") or {}).get("code")
    if not code:
        raise MallError("YYB 响应缺少 data.result.code")
    return str(code)


def login(http, account):
    code = yyb_code(http, account)
    params = {"act": ACT, "code": code, "state": "hhl"}
    if os.environ.get("MALL_WX_IP", "").strip():
        params["ip"] = os.environ["MALL_WX_IP"].strip()
    status, headers, raw = http.request("GET", WX_LOGIN + "?" + urlencode(params), redirect=False)
    payload = json_load(raw)
    try:
        return get_user_id(payload, raw)
    except MallError:
        location = headers.get("Location", "")
        if location:
            return get_user_id(parse_qs(urlparse(location).query), location)
        raise MallError("wxLogin did not return userId (HTTP %s)" % status)


def auth_from_user_id(http, user_id, include_open_id=False):
    ref = WEB_BASE
    status, _, raw = http.request("POST", API_BASE + "/api/users", headers={"Referer": ref}, body={"customerNo": b64(user_id)})
    payload = json_load(raw) or {}
    if status != 200 or payload.get("code") not in (None, 200):
        raise MallError("/api/users failed: %s" % str(payload.get("msg", raw[:120])))
    user = payload.get("data") or {}
    open_id = find_value(user, {"openId", "openid"})
    if not open_id:
        raise MallError("/api/users did not return openId")
    salt = find_value(user, {"salt"})
    if not salt:
        status, _, raw = http.request("GET", API_BASE + "/api/myInfo?" + urlencode({"gameId": GAME_ID}), headers={"Referer": ref}, retry=True)
        payload = json_load(raw) or {}
        data = payload.get("data") or {}
        salt = find_value(data, {"salt"})
    if not salt:
        raise MallError("myInfo did not return salt")
    token, ticket = make_auth(str(open_id), salt)
    headers = {"Token": token, "Ticket": ticket, "Referer": ref}
    return (headers, str(open_id)) if include_open_id else headers


def explicit_auth_failure(exc):
    text = str(exc).lower()
    return any(marker in text for marker in ("http 401", "非法登录", "登录失效", "登录过期", "unauthorized", "token expired"))


def auth(http, account):
    account_id = account.get("id")
    cached = cache_load(account_id)
    if cached:
        try:
            return auth_from_user_id(http, cached, include_open_id=True)
        except MallError as exc:
            if not explicit_auth_failure(exc):
                raise
            cache_delete(account_id)
    user_id = login(http, account)
    headers, open_id = auth_from_user_id(http, user_id, include_open_id=True)
    cache_write(account_id, user_id)
    return headers, open_id


def refresh_auth(headers, open_id, response_data):
    salt = find_value(response_data, {"salt"})
    if salt:
        token, ticket = make_auth(open_id, salt)
        headers["Token"] = token
        headers["Ticket"] = ticket


def api(http, method, path, headers, params=None, body=None, open_id=None):
    url = API_BASE + path
    if params is not None:
        url += "?" + urlencode(params)
    status, _, raw = http.request(method, url, headers=headers, body=body, retry=method == "GET")
    payload = json_load(raw)
    if not isinstance(payload, dict) or payload.get("code") not in (None, 200):
        raise MallError("%s failed: %s" % (path, str((payload or {}).get("msg", raw[:120]))))
    data = payload.get("data") or {}
    if open_id:
        refresh_auth(headers, open_id, data)
    return data


def account_label(account):
    name = re.sub(r"[\x00-\x1f\x7f\[\]|,:]", " ", str(account.get("alias") or account.get("nickname") or ""))
    name = " ".join(name.split())[:24]
    stable = "#" + str(account.get("id")) if account.get("id") is not None else ""
    return (name + "·" + stable).strip("·") if name else "YYB账号" + stable


def prize_text(data):
    if not isinstance(data, dict):
        data = {}
    is_thank = data.get("isThank") in (True, 1, "1", "true", "True")
    name = str(data.get("prizeName") or data.get("prize") or data.get("awardName") or data.get("name") or "").strip()
    if is_thank or not name:
        return "未中奖"
    return "中奖：" + name


def run_account(http, account):
    headers, open_id = auth(http, account)
    params = {"gameId": GAME_ID} if GAME_ID else None
    info = api(http, "GET", "/api/myInfo", headers, params=params, open_id=open_id)
    available = int(info.get("sumLuckNum", 0) or 0)
    count = min(LOTTERY_LIMIT, max(0, available))
    log("[%s] 可抽=%s 本次实抽=%s" % (account_label(account)[:24], available, count))
    for index in range(1, count + 1):
        result = api(http, "POST", "/api/lottery", headers, body={}, open_id=open_id)
        log("[%s] 抽奖第%d次完成，%s" % (account_label(account)[:24], index, prize_text(result)))
        log("[%s] 抽奖第%d次响应：%s" % (account_label(account)[:24], index, json.dumps(result, ensure_ascii=False)))
    info = api(http, "GET", "/api/myInfo", headers, params=params, open_id=open_id)
    remaining = int(info.get("sumLuckNum", 0) or 0)
    return "楼币=%s 活跃度=%s 剩余抽奖次数=%s" % (info.get("score", "?"), info.get("livenessToday", "?"), remaining)


def main():
    bootstrap_http = HTTP()
    try:
        items = accounts(bootstrap_http)
    except MallError as exc:
        log("[1916抽奖] 配置错误：%s" % exc)
        return 2
    failed = 0
    for index, account in enumerate(items, 1):
        label = account_label(account)
        account_http = HTTP()
        try:
            log("[1916抽奖][%s] %s" % (label[:24], run_account(account_http, account)))
        except Exception as exc:
            failed += 1
            log("[1916抽奖][%s] 失败：%s" % (label[:24], str(exc)[:160]))
    log("[1916抽奖] 完成：成功 %d，失败 %d" % (len(items) - failed, failed))
    return 1 if failed == len(items) else 0


if __name__ == "__main__":
    sys.exit(main())
