#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1916 mall task job.

Standalone Qinglong script: YYB code -> activity login -> sign -> enter free
games -> liveness boxes. No lottery and no coin exchange are performed here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import random
import re
import secrets
import sys
import tempfile
import time
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from typing import Iterable, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.request import HTTPCookieProcessor


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
PLAY_GAME_LIMIT = max(0, min(20, int(os.environ.get("MALL_PLAY_GAME_LIMIT", "1") or 1)))
PLAY_DELAY = max(0.0, min(10.0, float(os.environ.get("MALL_PLAY_DELAY", "1") or 1)))
COMPLETE_GAME_ID = os.environ.get("MALL_COMPLETE_GAME_ID", "20260001").strip()
ENABLE_ARTICLE = os.environ.get("MALL_ENABLE_ARTICLE", "1").strip().lower() not in {"0", "false", "no", "off"}
GAME_PROGRESS_FILE = os.environ.get("MALL_GAME_PROGRESS_FILE", "").strip()
DRY_RUN = os.environ.get("MALL_DRY_RUN", "").strip().lower() in {"1", "true", "yes", "on"}
TRACE_GAME = os.environ.get("MALL_TRACE_GAME", "").strip().lower() in {"1", "true", "yes", "on"}
ENABLE_EXCHANGE = os.environ.get("MALL_ENABLE_EXCHANGE", "").strip().lower() in {"1", "true", "yes", "on"}
EXCHANGE_NUM = max(1, min(100, int(os.environ.get("MALL_EXCHANGE_NUM", "1") or 1)))


def log(message):
    if message.startswith("[1916任务]"):
        message = message[len("[1916任务]"):].lstrip()
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
    return isinstance(value, str) and bool(value.strip()) and value.strip().lower() not in {"ok", "success", "true", "null"} and not (value.strip().isdigit() and len(value.strip()) <= 6) and len(value.strip()) <= 512


def get_code(payload, raw):
    for key in ("wx_code", "wxCode", "wechatCode", "authCode", "weixinCode", "code"):
        value = find_value(payload, {key})
        if candidate(value):
            return value.strip()
    if isinstance(payload, dict):
        value = payload.get("data")
        if candidate(value):
            return value.strip()
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
    if isinstance(payload, str) and candidate(payload):
        return payload.strip()
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
    ticket_seed = hashlib.md5(open_id.lower().encode()).hexdigest() + hashlib.md5(SALT_KEY.lower().encode()).hexdigest() + salt
    ticket = hashlib.md5(ticket_seed.encode()).hexdigest()
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
                raise MallError("HTTP %s: %s" % (exc.code, (json_load(raw) or {}).get("msg", raw[:120]))) from exc
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
    status, _, raw = http.request(
        method, YYB_URL + path,
        headers={"Authorization": "Basic " + auth, "Accept": "application/json", "User-Agent": YYB_UA},
        body=payload,
        retry=method.upper() == "GET",
    )
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
    selected_game_id = GAME_ID or COMPLETE_GAME_ID
    user_body = {"customerNo": b64(user_id)}
    if selected_game_id:
        user_body["gameId"] = int(selected_game_id) if selected_game_id.isdigit() else selected_game_id
    status, _, raw = http.request("POST", API_BASE + "/api/users", headers={"Referer": ref}, body=user_body)
    payload = json_load(raw) or {}
    if status != 200 or payload.get("code") not in (None, 200):
        raise MallError("/api/users failed: %s" % str(payload.get("msg", raw[:120])))
    user = payload.get("data") or {}
    open_id = find_value(user, {"openId", "openid"})
    if not open_id:
        raise MallError("/api/users did not return openId")
    salt = find_value(user, {"salt"})
    if not salt:
        params = {"gameId": GAME_ID}
        status, _, raw = http.request("GET", API_BASE + "/api/myInfo?" + urlencode(params), headers={"Referer": ref}, retry=True)
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
            headers, open_id = auth_from_user_id(http, cached, include_open_id=True)
            return headers, cached, open_id
        except MallError as exc:
            if not explicit_auth_failure(exc):
                raise
            cache_delete(account_id)
    user_id = login(http, account)
    headers, open_id = auth_from_user_id(http, user_id, include_open_id=True)
    cache_write(account_id, user_id)
    return headers, user_id, open_id


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


def append_query(url, params):
    return url + ("&" if "?" in url else "?") + urlencode(params)


def refresh_auth(headers, open_id, response_data):
    salt = find_value(response_data, {"salt"})
    if salt:
        token, ticket = make_auth(open_id, salt)
        headers["Token"] = token
        headers["Ticket"] = ticket


def decode_score_data(encoded):
    try:
        raw = base64.b64decode(encoded.strip(), validate=True).decode("utf-8")
        events = json.loads(raw)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MallError("游戏记录不是有效的 Base64 JSON") from exc
    if not isinstance(events, list):
        raise MallError("游戏记录必须是 JSON 数组")
    normalized = []
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get("ts"), (int, float)) or not isinstance(event.get("pl"), str):
            raise MallError("游戏记录包含无效事件")
        if not re.fullmatch(r"\d+@(?:\d+|o)\[-?\d+(?:,-?\d+)*\]", event["pl"]):
            raise MallError("游戏记录包含无法识别的关卡快照")
        normalized.append({"ts": int(event["ts"]), "pl": event["pl"]})
    return normalized


def encode_score_data(events):
    raw = json.dumps(events, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


# scoreData 只上报实际第 2～4 关（记录编号 1～3），教学关不进进度统计。
def summarize_coffee_progress(events, is_success=False, total_levels=3):
    levels = {}
    for event in events:
        match = re.match(r"(\d+)@([^[]+)\[", event["pl"])
        if not match:
            continue
        level = int(match.group(1))
        step = match.group(2)
        item = levels.setdefault(level, {"events": 0, "first_ts": event["ts"], "last_ts": event["ts"], "last_step": step})
        item["events"] += 1
        item["last_ts"] = event["ts"]
        item["last_step"] = step
    reached = max(levels, default=0)
    for level, item in levels.items():
        item["duration_ms"] = max(0, item["last_ts"] - item["first_ts"])
        item["completed"] = bool(is_success or level < reached)
    completed = total_levels if is_success else max(0, reached - 1)
    return {
        "total_levels": total_levels,
        "reached_level": reached,
        "completed_levels": min(total_levels, completed),
        "event_count": len(events),
        "elapsed_ms": max(0, events[-1]["ts"] - events[0]["ts"]) if events else 0,
        "levels": {str(key): value for key, value in sorted(levels.items())},
    }


def save_game_progress(account_id, game_id, progress, result):
    if not GAME_PROGRESS_FILE:
        return
    payload = {"version": 1, "records": []}
    try:
        with open(GAME_PROGRESS_FILE, "r", encoding="utf-8") as handle:
            current = json.load(handle)
        if isinstance(current, dict) and isinstance(current.get("records"), list):
            payload = current
    except FileNotFoundError:
        pass
    except (OSError, ValueError, TypeError) as exc:
        raise MallError("游戏进度文件读取失败：%s" % type(exc).__name__) from exc
    payload["records"].append({
        "account_id": account_id,
        "game_id": game_id,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "progress": progress,
        "result": {
            "record_id": result.get("recordId"),
            "score": result.get("score"),
            "luck_num": result.get("luckNum"),
            "is_success": result.get("isSuccess") is True,
        },
    })
    directory = os.path.dirname(os.path.abspath(GAME_PROGRESS_FILE))
    os.makedirs(directory, exist_ok=True)
    temp_name = ""
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, delete=False) as handle:
            temp_name = handle.name
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, GAME_PROGRESS_FILE)
    finally:
        if temp_name and os.path.exists(temp_name):
            try:
                os.unlink(temp_name)
            except OSError:
                pass


SIZE = 6
CELL_COUNT = SIZE * SIZE
DIRECTIONS = ((-1, 0), (1, 0), (0, -1), (0, 1))

# 键是 scoreData 中的编号；实际关卡号分别为 2、3、4。
LEVEL_PROBABILITIES = {
    1: ((-1, 0.40), (0, 0.10), (1, 0.20), (2, 0.20), (3, 0.10)),
    2: ((-1, 0.20), (0, 0.30), (1, 0.20), (2, 0.20), (3, 0.10)),
    3: ((-1, 0.10), (0, 0.30), (1, 0.20), (2, 0.30), (3, 0.10)),
}


def _is_complete(board: Sequence[int]) -> bool:
    return all(value == -1 or value >= 4 for value in board)


def _deficit(board: Sequence[int]) -> int:
    return sum(4 - value for value in board if value >= 0)


def _completed_cells(board: Sequence[int]) -> int:
    return sum(value >= 4 for value in board)


def _remaining_drops(board: Sequence[int], click_count: int) -> int:
    # 随机初始棋盘不会生成 4，所以完成格数量就是累计爆裂数。
    return 10 - click_count + _completed_cells(board) // 3


def _ray_target(board: Sequence[int], source: int, dr: int, dc: int) -> int | None:
    """返回飞行液滴在一个方向上命中的首个可升级格。

    -1 和已经完成的 4 不吸收液滴，液滴会继续向该方向飞行。
    """
    row, column = divmod(source, SIZE)
    row += dr
    column += dc

    while 0 <= row < SIZE and 0 <= column < SIZE:
        index = row * SIZE + column
        if 0 <= board[index] < 4:
            return index
        row += dr
        column += dc
    return None


def simulate_click(board: Sequence[int], click_index: int) -> tuple[tuple[int, ...], int]:
    """执行一次人工点击以及它产生的全部连锁。

    返回 `(新棋盘, 本次新增爆裂数)`。
    """
    if len(board) != CELL_COUNT:
        raise ValueError("棋盘必须正好包含 36 个格子")
    if not 0 <= click_index < CELL_COUNT:
        raise IndexError("点击索引必须在 0～35 之间")
    if not 0 <= board[click_index] < 4:
        raise ValueError("只能点击状态为 0～3 的格子")

    state = list(board)
    completed_before = _completed_cells(state)
    state[click_index] += 1
    explosion_queue = [click_index] if state[click_index] == 4 else []

    # 按前端的上、下、左、右顺序结算。新爆裂继续进入队列。
    while explosion_queue:
        source = explosion_queue.pop(0)
        for dr, dc in DIRECTIONS:
            target = _ray_target(state, source, dr, dc)
            if target is None:
                continue
            state[target] += 1
            if state[target] == 4:
                explosion_queue.append(target)

    return tuple(state), _completed_cells(state) - completed_before


def _random_board(record_level: int, rng: random.Random) -> tuple[int, ...]:
    distribution = LEVEL_PROBABILITIES[record_level]
    values = [item[0] for item in distribution]
    weights = [item[1] for item in distribution]
    return tuple(rng.choices(values, weights=weights, k=CELL_COUNT))


def _directional_opportunities(board: Sequence[int], index: int) -> int:
    return sum(
        _ray_target(board, index, dr, dc) is not None
        for dr, dc in DIRECTIONS
    )


def _setup_value(board: Sequence[int]) -> float:
    """估算当前棋盘中下一轮连锁的潜力。"""
    score = 0.0
    for index, value in enumerate(board):
        if value == 3:
            score += 1.5 + _directional_opportunities(board, index)
        elif value == 2:
            score += 0.35 * _directional_opportunities(board, index)
    return score


def _candidate_moves(board: Sequence[int], rng: random.Random):
    old_deficit = _deficit(board)
    moves = []

    for index, value in enumerate(board):
        if not 0 <= value < 4:
            continue

        next_board, new_explosions = simulate_click(board, index)
        progress = old_deficit - _deficit(next_board)
        directions = _directional_opportunities(board, index)

        # 主要偏好：状态 3、大连锁、周围可命中目标多。
        score = (
            progress * 7.0
            + new_explosions * 12.0
            + _setup_value(next_board) * 0.65
            + value * 1.7
            + directions * 0.8
        )

        # 真人通常不会优先在没有连锁价值的孤立 0 格上连续浪费液滴。
        if value == 0 and progress == 1 and directions <= 1:
            score -= 10.0

        # 轻微扰动让相同局面也不总选择同一条等价路线。
        score += rng.uniform(-1.2, 7.5)
        moves.append((score, index, next_board))

    moves.sort(key=lambda item: item[0], reverse=True)
    return moves


def _choose_human_move(moves, rng: random.Random):
    """大多数时候选最优项，偶尔选择前几名中的次优项。"""
    top = moves[: min(6, len(moves))]
    weights = [1.0 / math.pow(rank + 1, 1.85) for rank in range(len(top))]
    return rng.choices(top, weights=weights, k=1)[0]


def _find_solution(
    initial_board: tuple[int, ...],
    rng: random.Random,
    rollout_count: int,
) -> list[int] | None:
    """使用带随机扰动的策略反复搜索一条液滴预算内的路径。"""
    for _ in range(rollout_count):
        board = initial_board
        path: list[int] = []

        while not _is_complete(board):
            if _remaining_drops(board, len(path)) <= 0:
                break

            moves = _candidate_moves(board, rng)
            if not moves:
                break

            _, click_index, board = _choose_human_move(moves, rng)
            path.append(click_index)

        if _is_complete(board):
            return path

    return None


def _solve_random_level(
    record_level: int,
    rng: random.Random,
    max_board_tries: int,
    rollout_count: int,
) -> tuple[tuple[int, ...], list[int]]:
    for _ in range(max_board_tries):
        board = _random_board(record_level, rng)
        # 极端空棋盘虽然符合概率，但不像正常游戏局面，重新生成。
        if sum(value >= 0 for value in board) < 8:
            continue
        path = _find_solution(board, rng, rollout_count)
        if path is not None:
            return board, path

    raise RuntimeError(
        f"未能为记录关卡 {record_level} 找到通关路径；"
        "可增大 max_board_tries 或 rollout_count"
    )


def _compact_board(board: Iterable[int]) -> str:
    return "[" + ",".join(str(value) for value in board) + "]"


def _human_delay_ms(rng: random.Random, new_explosions: int) -> int:
    if new_explosions == 0:
        # 普通思考/补液点击约 0.7～2.5 秒。
        delay = rng.randint(720, 2450)
    else:
        # 连锁越大，动画和观察时间越长。
        delay = rng.randint(2700, 4700)
        delay += new_explosions * rng.randint(650, 1100)

    # 少量自然犹豫，避免形成过于整齐的节奏。
    if rng.random() < 0.11:
        delay += rng.randint(1200, 4300)
    return delay


def _validate_level(initial_board: tuple[int, ...], path: Sequence[int]) -> None:
    board = initial_board
    for click_count, click_index in enumerate(path, 1):
        if _remaining_drops(board, click_count - 1) <= 0:
            raise AssertionError("点击前液滴已经耗尽")
        board, _ = simulate_click(board, click_index)
    if not _is_complete(board):
        raise AssertionError("路径回放后棋盘未完成")


def generate_score_data(
    *,
    base_ts: int | None = None,
    seed: int | None = None,
    max_board_tries: int = 300,
    rollout_count: int = 12_000,
) -> list[dict[str, int | str]]:
    """生成一次完整、随机、可回放验证的 scoreData。

    参数：
        base_ts: 第一条记录的毫秒时间戳；默认使用当前时间。
        seed: 随机种子；默认使用系统随机数，每次结果不同。
        max_board_tries: 每关最多尝试多少个随机棋盘。
        rollout_count: 每个棋盘最多尝试多少条随机策略路径。

    返回：
        与抓包示例相同结构的 list[dict]。教学关不写入结果。
    """
    actual_seed = secrets.randbits(64) if seed is None else seed
    rng = random.Random(actual_seed)
    timestamp = int(time.time() * 1000) if base_ts is None else int(base_ts)
    score_data: list[dict[str, int | str]] = []

    for record_level in (1, 2, 3):
        initial_board, path = _solve_random_level(
            record_level,
            rng,
            max_board_tries=max_board_tries,
            rollout_count=rollout_count,
        )
        _validate_level(initial_board, path)

        board = initial_board
        score_data.append({
            "ts": timestamp,
            "pl": f"{record_level}@0{_compact_board(board)}",
        })

        # 进入新关后先观察棋盘，@1 仍记录点击生效前状态。
        timestamp += rng.randint(8500, 17_500)

        for step, click_index in enumerate(path, 1):
            score_data.append({
                "ts": timestamp,
                "pl": f"{record_level}@{step}{_compact_board(board)}",
            })
            board, new_explosions = simulate_click(board, click_index)
            timestamp += _human_delay_ms(rng, new_explosions)

        score_data.append({
            "ts": timestamp,
            "pl": f"{record_level}@o{_compact_board(board)}",
        })

        # 与前端卸载旧棋盘、创建新棋盘时的极短记录间隔一致。
        timestamp += rng.randint(3, 15)

    return score_data


def generate_coffee_game_plan():
    """Generate a complete human-like scoreData and its total play duration."""
    events = generate_score_data()
    elapsed_ms = max(0, events[-1]["ts"] - events[0]["ts"]) if events else 0
    return events, elapsed_ms


def complete_coffee_game(http, headers, open_id, account_id, game_id):
    """Start the game, generate human-like steps, wait, then submit success."""
    game_started_at = time.monotonic()
    api(http, "POST", "/api/startGame", headers, body={"gameId": game_id}, open_id=open_id)
    log("[1916任务] 冰咖相随 开始游戏成功")
    events, elapsed_ms = generate_coffee_game_plan()
    score_data = encode_score_data(events)
    remaining_seconds = max(0.0, elapsed_ms / 1000.0 - (time.monotonic() - game_started_at))
    log("[1916任务] 冰咖相随 已生成%d条真人步骤，模拟游玩约%.0f秒" % (len(events), remaining_seconds))
    if remaining_seconds:
        time.sleep(remaining_seconds)
    log("[1916任务] 冰咖相随 模拟游玩完成，提交游戏记录")
    recorded = api(http, "POST", "/api/gameRecord", headers, body={
        "gameId": game_id,
        "isSuccess": True,
        "scoreData": score_data,
        "remark": "",
    }, open_id=open_id)
    progress = summarize_coffee_progress(events, True)
    save_game_progress(account_id, game_id, progress, recorded)
    log("[1916任务] 冰咖相随 记录提交成功 isSuccess=True")
    return recorded, progress


def claim_article_game_attempt(http, headers, open_id, game_id, current_info):
    """Claim the daily article-reading game attempt using the mall's own flow."""
    if current_info.get("signToday") is True:
        return current_info, "阅读推文今日已领取"
    before = int(current_info.get("surplusNum", 0) or 0)
    if DRY_RUN:
        return current_info, "计划阅读推文领取游戏次数"
    result = api(
        http, "POST", "/api/sign", headers,
        body={"gameId": game_id}, open_id=open_id,
    )
    after = int(result.get("surplusNum", before) or 0)
    link = str(result.get("link") or "").strip()
    confirmed = result.get("signToday") is True or after > before or bool(link)
    if not confirmed:
        raise MallError("阅读推文接口成功但未确认增加游戏次数")
    merged = dict(current_info)
    merged.update(result)
    merged["signToday"] = True
    if after > before:
        return merged, "阅读推文领取游戏次数(%d→%d)" % (before, after)
    return merged, "阅读推文领取游戏次数"


def trace_game_page(http, entry_url, game_id, headers):
    """只读取一个游戏页面和静态脚本，寻找完成接口线索。"""
    status, _, raw = http.request(
        "GET", entry_url, headers={"Referer": headers["Referer"]}, retry=False
    )
    if status >= 400:
        return ["游戏%s页面读取失败 HTTP %s" % (game_id, status)]

    scripts = re.findall(r"<script[^>]+src=[\"']([^\"']+)[\"']", raw, re.I)
    script_urls = [urljoin(entry_url, src) for src in scripts[:8]]
    clue_pattern = re.compile(r"(?:/|https?://)[A-Za-z0-9_./:${}?&=\\-]{2,160}")
    clue_words = ("start", "begin", "finish", "complete", "submit", "score", "settle", "gameover", "result", "success")
    clues = set()

    def collect(text):
        for value in clue_pattern.findall(text):
            lower = value.lower()
            if any(word in lower for word in clue_words):
                clues.add(value.split("?")[0][:160])

    collect(raw)
    for script_url in script_urls:
        try:
            script_status, _, script_raw = http.request("GET", script_url, retry=True)
            if script_status < 400:
                collect(script_raw)
        except MallError:
            continue

    lines = ["游戏%s探针：HTML=%d字节，脚本=%d个" % (game_id, len(raw), len(scripts))]
    if script_urls:
        lines.append("脚本：" + " | ".join(urlparse(url)._replace(query="", fragment="").geturl() for url in script_urls))
    lines.append("完成线索：" + (" | ".join(sorted(clues)[:30]) if clues else "未识别，需要浏览器网络记录"))
    return lines


def play_games(http, headers, user_id, open_id, account_id, home):
    """Use the selected game's published start and normal-exit record flow."""
    games = home.get("list", []) if isinstance(home, dict) else []
    if not isinstance(games, list):
        return ["游戏列表格式异常"]
    actions = []
    played = 0
    for game in games:
        if played >= PLAY_GAME_LIMIT:
            break
        if not isinstance(game, dict) or not game.get("status"):
            continue
        game_id = str(game.get("gameId") or "")
        game_link = str(game.get("gameLink") or "")
        if not game_id or not game_link:
            continue
        if COMPLETE_GAME_ID and game_id != COMPLETE_GAME_ID:
            continue

        # 与网页点击“开始”完全一致：先检查今天是否允许进入。
        can_enter = api(http, "GET", "/api/isCanInto", headers, {"gameId": game_id}, open_id=open_id)
        if not can_enter.get("isTodayInto"):
            skip_action = "跳过%s(无免费次数)" % game_id
            actions.append(skip_action)
            log("[1916任务] %s" % skip_action)
            continue

        entry_url = append_query(game_link, {
            "userId": user_id,
            "gameId": game_id,
            "tt": int(time.time() * 1000),
        })
        if DRY_RUN:
            plan_action = "计划完成%s" % game_id
            actions.append(plan_action)
            log("[1916任务] %s" % plan_action)
        elif TRACE_GAME:
            trace_lines = trace_game_page(http, entry_url, game_id, headers)
            for line in trace_lines:
                log("[1916任务] %s" % line)
            actions.extend(trace_lines)
        elif game_id == "20260001":
            result, progress = complete_coffee_game(http, headers, open_id, account_id, game_id)
            info = api(http, "GET", "/api/myInfo", headers, {"gameId": game_id}, open_id=open_id)
            actions.append(
                "游戏%s进度=%d/%d关,完成=%d关,得分=%s,抽奖次数=%s" % (
                    game_id, progress["reached_level"], progress["total_levels"],
                    progress["completed_levels"], result.get("score", 0),
                    info.get("sumLuckNum", 0),
                )
            )
        else:
            unknown_action = "跳过%s(尚未实现其专用记录格式)" % game_id
            actions.append(unknown_action)
            log("[1916任务] %s" % unknown_action)
        played += 1
        if PLAY_DELAY:
            time.sleep(PLAY_DELAY)
    return actions


def account_label(account):
    name = re.sub(r"[\x00-\x1f\x7f\[\]|,:]", " ", str(account.get("alias") or account.get("nickname") or ""))
    name = " ".join(name.split())[:24]
    stable = "#" + str(account.get("id")) if account.get("id") is not None else ""
    return (name + "·" + stable).strip("·") if name else "YYB账号" + stable


def select_game_id(home):
    if GAME_ID:
        return GAME_ID
    games = home.get("list", []) if isinstance(home, dict) else []
    if COMPLETE_GAME_ID:
        for game in games if isinstance(games, list) else []:
            if (
                isinstance(game, dict) and game.get("status")
                and str(game.get("gameId") or "") == COMPLETE_GAME_ID
            ):
                return COMPLETE_GAME_ID
    for game in games if isinstance(games, list) else []:
        if isinstance(game, dict) and game.get("status") and game.get("gameId") not in (None, ""):
            return str(game["gameId"])
    raise MallError("首页没有可用游戏，无法自动确定 gameId")


def find_game_free_num(home, game_id):
    games = home.get("list", []) if isinstance(home, dict) else []
    for game in games if isinstance(games, list) else []:
        if isinstance(game, dict) and str(game.get("gameId") or "") == str(game_id):
            return game.get("freeNum", "?")
    return "?"


def run_account(http, account):
    headers, user_id, open_id = auth(http, account)
    home = api(http, "GET", "/api/home", headers, open_id=open_id)
    selected_game_id = select_game_id(home)
    info = api(http, "GET", "/api/myInfo", headers, {"gameId": selected_game_id}, open_id=open_id)
    actions = []

    if TRACE_GAME:
        actions.append("探针模式：不签到/不兑换/不领奖")
        actions.extend(play_games(http, headers, user_id, open_id, account.get("id"), home))
        return "楼币=%s 活跃度=%s 抽奖次数=%s 动作=%s" % (
            info.get("score", "?"), info.get("livenessToday", "?"),
            info.get("sumLuckNum", "?"), ",".join(actions) or "无"
        )

    if ENABLE_ARTICLE:
        info, article_action = claim_article_game_attempt(
            http, headers, open_id, selected_game_id, info
        )
        log("[1916任务][%s] %s" % (account_label(account)[:24], article_action))
        home = api(http, "GET", "/api/home", headers, open_id=open_id)
        log("[1916任务][%s] 当前游戏次数=%s" % (account_label(account)[:24], find_game_free_num(home, selected_game_id)))
        actions.append(article_action)

    if ENABLE_EXCHANGE:
        if DRY_RUN:
            exchange_action = "计划兑换%d次游戏机会" % EXCHANGE_NUM
            actions.append(exchange_action)
            log("[1916任务][%s] %s" % (account_label(account)[:24], exchange_action))
        else:
            # 网页 ExchangeAlert 使用 POST /api/buy {buyNum}；每次消耗 50 楼币。
            api(http, "POST", "/api/buy", headers, body={"buyNum": EXCHANGE_NUM}, open_id=open_id)
            exchange_action = "兑换%d次游戏机会" % EXCHANGE_NUM
            actions.append(exchange_action)
            log("[1916任务][%s] %s" % (account_label(account)[:24], exchange_action))
    actions.extend(play_games(http, headers, user_id, open_id, account.get("id"), home))
    # 进入游戏后重新读取，确保日志反映最新活跃度/抽奖次数。
    info = api(http, "GET", "/api/myInfo", headers, {"gameId": selected_game_id}, open_id=open_id)
    live = int(info.get("livenessToday", 0) or 0)
    boxes = info.get("livenessBox") or {}
    for threshold, box in ((50, "A"), (80, "B"), (100, "C")):
        if live >= threshold and boxes.get(box) is False:
            if DRY_RUN:
                reward_action = "计划领取活跃度奖励" + box
                actions.append(reward_action)
                log("[1916任务][%s] %s" % (account_label(account)[:24], reward_action))
            else:
                api(http, "POST", "/api/receiveBox/" + box, headers, body={}, open_id=open_id)
                reward_action = "活跃度奖励" + box
                actions.append(reward_action)
                log("[1916任务][%s] %s" % (account_label(account)[:24], reward_action))
    return "楼币=%s 活跃度=%s 抽奖次数=%s 动作=%s" % (info.get("score", "?"), live, info.get("sumLuckNum", "?"), ",".join(actions) or "无")


def main():
    bootstrap_http = HTTP()
    try:
        items = accounts(bootstrap_http)
    except MallError as exc:
        log("[1916任务] 配置错误：%s" % exc)
        return 2
    failed = 0
    for index, account in enumerate(items, 1):
        label = account_label(account)
        account_http = HTTP()
        try:
            log("[1916任务][%s] %s" % (label[:24], run_account(account_http, account)))
        except Exception as exc:
            failed += 1
            log("[1916任务][%s] 失败：%s" % (label[:24], str(exc)[:160]))
    log("[1916任务] 完成：成功 %d，失败 %d" % (len(items) - failed, failed))
    return 1 if failed == len(items) else 0


if __name__ == "__main__":
    sys.exit(main())