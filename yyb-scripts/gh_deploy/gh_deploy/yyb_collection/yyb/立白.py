#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Author: A
Name: Liby sign/task script
#小程序://立乐家/QzvvFc1oKCoPYvb
Notes:
- The current HAR only exposes the task-center flow. No standalone sign endpoint
  was captured. `--mode sign` therefore filters sign-like tasks from taskList.
- Task APIs require a fresh business token. The script refreshes it from wxid
  login when possible and keeps HAR headers only as a fallback.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")

WECHAT_APPID = "wxb9f68ca2da513bb2"
PLATFORM_CODE = "LiLeJia"

# ── Bridge (本地 API 服务器) ─────────────────────────────────────
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
BRIDGE_KEY = os.getenv("BRIDGE_KEY", "")

def bridge_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if BRIDGE_KEY:
        h["Authorization"] = f"Bearer {BRIDGE_KEY}"
    return h

def fetch_accounts() -> list[dict[str, str]]:
    try:
        req = Request(f"{YYB_BASE_URL}/accounts", headers=bridge_headers(), method="GET")
        with urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
        accounts: list[dict[str, str]] = []
        for acc in data.get("data", []):
            openid = (acc.get("openid") or "").strip()
            name = (acc.get("nickname") or acc.get("name") or "账号").strip()
            if openid:
                accounts.append({"remark": name, "wxid": openid, "unionid": ""})
        print(f"共获取到 {len(accounts)} 个账号")
        for i, a in enumerate(accounts, 1):
            print(f"   {i}. {a['remark']} (openid: {a['wxid'][:12]}...)")
        return accounts
    except Exception as e:
        print(f"获取账号失败: {e}")
        return []

def bridge_get_code(openid: str, timeout: int = 90) -> tuple[bool, str]:
    try:
        payload = json.dumps({"app_id": WECHAT_APPID, "ref": openid}).encode("utf-8")
        h = bridge_headers()
        h["Content-Type"] = "application/json"
        req = Request(f"{YYB_BASE_URL}/wxapp/getCode", data=payload, headers=h, method="POST")
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
        if data.get("code") != 0:
            return False, f"bridge 拒绝: {data}"
        code = data.get("data", {}).get("result", {}).get("code", "")
        if not code:
            return False, f"bridge 未返回 code: {data}"
        return True, code
    except Exception as e:
        return False, f"bridge 错误: {e}"

API_BASE = "https://clubwx.hm.liby.com.cn"
LOGIN_PATH = "/miniprogram/auth/loginMiniProgramB2cV2.htm"
TASK_LIST_PATH = "/b2cMiniApi/task/taskList.htm"
TASK_REWARD_PATH = "/b2cMiniApi/task/getTaskReward.htm"
TASK_EXECUTE_PATH = "/miniprogram/benefits/activity/stander/execute.htm"
USER_DATA_PATH = "/b2cMiniApi/me/getUserData.htm"
ADD_COINS_PATH = "/b2cMiniApi/micropage/addCoins.htm"
MICRO_PAGE_INFO_PATH = "/b2cMiniApi/micropage/getMicroPageInfo.htm"
LOTTERY_COIN_PATH = "/b2cMiniApi/micro/lottery/getLotteryCoin.htm"
LOTTERY_ACTION_PATH = "/b2cMiniApi/micro/lottery/lotteryAction.htm"
LOTTERY_COMPONENT_UNIT = "lotteryComponts"

DEFAULT_REFERER = f"https://servicewechat.com/{WECHAT_APPID}/120/page-frame.html"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf2541917) XWEB/19749"
)

ACCOUNT_ENV_KEYS = ("liby", "LIBY_ACCOUNTS")
SCRIPT_AUTHOR = "A"
SCRIPT_NAME = "立白任务脚本"
MINI_PROGRAM_NAME = "立乐家商城"
MINI_PROGRAM_HINT = f"{MINI_PROGRAM_NAME}/{WECHAT_APPID}"
SIGN_KEYWORDS = ("签到", "打卡", "checkin", "check-in", "sign")
UNIONID_KEYS = (
    "unionid",
    "unionId",
    "_unionId",
    "wechatUnionId",
    "wechat_union_id",
    "auth_uid",
    "weixin_unionID",
    "weixin_unionId",
)
OPENID_KEYS = ("openid", "openId", "_openId", "wechatOpenId", "wechat_open_id")
CODE_KEYS = ("code", "Code", "app_code", "appCode")
SESSION_KEYS = ("sessionid", "sessionId", "session_id")
TOKEN_KEYS = ("token", "Token", "accessToken", "access_token", "sessionid", "sessionId", "session_id", "Data62")
TASK_STATUS_LABELS = {
    0: "未完成",
    1: "可领奖",
    2: "已领奖",
}

@dataclass
class HarContext:
    unionid: str = ""
    openid: str = ""
    appid: str = WECHAT_APPID
    platformcode: str = PLATFORM_CODE
    referer: str = DEFAULT_REFERER
    user_agent: str = DEFAULT_USER_AGENT
    token_header_name: str = ""
    token_header_value: str = ""
    har_path: pathlib.Path | None = None

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="立白 wxid 任务脚本")
    parser.add_argument("--wxid", default="", help="单个 wxid")
    parser.add_argument("--unionid", default="", help="单个 unionid 兜底")
    parser.add_argument("--har", default=os.getenv("LIBY_HAR", ""), help="HAR 文件路径")
    parser.add_argument(
        "--mode",
        choices=("all", "sign", "tasks"),
        default="all",
        help="all=全部, sign=签到类任务, tasks=其他自动任务",
    )
    parser.add_argument("--status-only", action="store_true", help="只查询状态，不执行任务")
    parser.add_argument("--timeout", type=int, default=20, help="HTTP 超时秒数")
    parser.add_argument("--verbose", action="store_true", help="输出详细日志")
    return parser.parse_args()

def _shorten(value: Any, limit: int = 280) -> str:
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "..."

def _is_empty_value(value: Any) -> bool:
    return value in (None, "", [], {}, (), False)

def _maybe_json(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{") or text.startswith("["):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return value
    return value

def _extract_first(payload: Any, target_keys: tuple[str, ...]) -> Any:
    normalized = {key.lower() for key in target_keys}
    payload = _maybe_json(payload)

    if isinstance(payload, dict):
        for key, value in payload.items():
            if str(key).lower() in normalized and not _is_empty_value(value):
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

def _extract_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

def _extract_bool_success(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("Success") is True or payload.get("success") is True:
        return True
    code = payload.get("Code")
    if code in (0, "0"):
        return True
    ret = payload.get("ret")
    if ret in (0, "0"):
        return True
    status = payload.get("status")
    if isinstance(status, bool):
        return status and code in (None, 0, "0")
    return False

def script_dir() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent

def pick_har_file(explicit_path: str) -> pathlib.Path | None:
    if explicit_path:
        har_path = pathlib.Path(explicit_path).expanduser()
        if not har_path.exists():
            raise FileNotFoundError(f"HAR file not found: {har_path}")
        return har_path

    candidates = list(script_dir().glob("*.har"))
    if candidates:
        return sorted(candidates)[0]

    cwd_candidates = list(pathlib.Path(".").glob("*.har"))
    return sorted(cwd_candidates)[0] if cwd_candidates else None

def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        if not path.exists():
            raise RuntimeError(f"HAR file not found: {path}")
        if path.stat().st_size == 0:
            raise RuntimeError(f"HAR file is empty: {path}")
        with path.open("r", encoding="utf-8-sig") as file:
            return json.load(file)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"HAR file is not valid JSON: {path} | {exc}") from exc
    except OSError as exc:
        raise RuntimeError(f"Failed to read HAR file: {path} | {exc}") from exc

def header_map(headers: list[dict[str, Any]]) -> dict[str, str]:
    mapped: dict[str, str] = {}
    for item in headers:
        name = str(item.get("name", "")).lower()
        value = str(item.get("value", ""))
        if name:
            mapped[name] = value
    return mapped

def parse_post_json(entry: dict[str, Any]) -> dict[str, Any]:
    text = entry.get("request", {}).get("postData", {}).get("text", "")
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}

def extract_har_context(har_path: pathlib.Path) -> HarContext:
    data = load_json(har_path)
    entries = data.get("log", {}).get("entries", [])
    context = HarContext(har_path=har_path)

    for entry in reversed(entries):
        request = entry.get("request", {})
        url = str(request.get("url", ""))
        headers = header_map(request.get("headers", []))

        if API_BASE in url:
            if not context.unionid and headers.get("unionid"):
                context.unionid = headers["unionid"].strip()
            if not context.appid and headers.get("appid"):
                context.appid = headers["appid"].strip()
            if headers.get("appid"):
                context.appid = headers["appid"].strip()
            if headers.get("platformcode"):
                context.platformcode = headers["platformcode"].strip()
            if headers.get("referer"):
                context.referer = headers["referer"].strip()
            if headers.get("user-agent"):
                context.user_agent = headers["user-agent"].strip()
            for name, value in headers.items():
                if name.startswith("x-") and name.endswith("-token") and value:
                    context.token_header_name = name
                    context.token_header_value = value
                    break

        if not context.unionid:
            payload = parse_post_json(entry)
            unionid = _extract_first(payload, UNIONID_KEYS)
            if unionid:
                context.unionid = str(unionid).strip()
            if not context.openid:
                openid = _extract_first(payload, OPENID_KEYS)
                if openid:
                    context.openid = str(openid).strip()

        if context.unionid and context.referer and context.user_agent:
            break

    return context

def try_extract_har_context(har_path: pathlib.Path | None) -> tuple[HarContext, str | None]:
    if not har_path:
        return HarContext(), None

    try:
        return extract_har_context(har_path), None
    except RuntimeError as exc:
        return HarContext(har_path=har_path), str(exc)

def http_json(
    method: str,
    url: str,
    timeout: int,
    headers: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
) -> tuple[int | None, Any]:
    merged_headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "User-Agent": DEFAULT_USER_AGENT,
    }
    if headers:
        merged_headers.update(headers)

    data = None
    if payload is not None:
        merged_headers.setdefault("Content-Type", "application/json")
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = Request(url=url, data=data, headers=merged_headers, method=method.upper())
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            text = raw.decode(charset, errors="replace")
            try:
                return response.status, json.loads(text)
            except json.JSONDecodeError:
                return response.status, text
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(text)
        except json.JSONDecodeError:
            return exc.code, text
    except URLError as exc:
        return None, f"网络错误: {exc}"

def wx_loader_post(path: str, payload: dict[str, Any], timeout: int) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = http_json(
        "POST",
        f"{YYB_BASE_URL}{path}",
        timeout=timeout,
        headers={"Referer": f"{YYB_BASE_URL}/api/document/page"},
        payload=payload,
    )
    if status_code != 200:
        return False, f"微信加载器请求失败 | path={path} | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict):
        return False, f"微信加载器返回异常 | path={path} | resp={_shorten(result)}"
    if not _extract_bool_success(result):
        message = _extract_first(result, ("Message", "message", "msg", "detail")) or result
        return False, f"微信加载器拒绝请求 | path={path} | resp={_shorten(message)}"
    return True, result

def fetch_app_code(wxid: str, timeout: int) -> tuple[bool, str]:
    return bridge_get_code(wxid.strip(), timeout)

def fetch_session_data(wxid: str, timeout: int) -> tuple[bool, dict[str, Any] | str]:
    return False, "bridge 未提供 session 接口"

def fetch_self_openid_data(wxid: str, timeout: int) -> tuple[bool, dict[str, Any] | str]:
    return False, "bridge 未提供 openid 接口"

def build_business_token_header_name(appid: str) -> str:
    return f"x-{(appid or WECHAT_APPID).strip()}-token"

def business_login_headers(context: HarContext) -> dict[str, str]:
    appid = context.appid or WECHAT_APPID
    platformcode = context.platformcode or PLATFORM_CODE
    return {
        "Accept": "*/*",
        "Content-Type": "application/json",
        "User-Agent": context.user_agent or DEFAULT_USER_AGENT,
        "Referer": context.referer or DEFAULT_REFERER,
        "xweb_xhr": "1",
        "appId": appid,
        "platformCode": platformcode,
    }

def login_ok(result: Any) -> bool:
    return isinstance(result, dict) and result.get("code") in (200, "200")

def business_login_with_code(
    app_code: str,
    timeout: int,
    context: HarContext,
    login_type: int = 1,
) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = http_json(
        "POST",
        f"{API_BASE}{LOGIN_PATH}",
        timeout=timeout,
        headers=business_login_headers(context),
        payload={
            "type": login_type,
            "code": app_code.strip(),
            "flag": 0,
            "registerChannel": "",
            "userInfo": {},
        },
    )
    if status_code != 200:
        return False, f"业务登录失败 | type={login_type} | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict):
        return False, f"业务登录返回异常 | type={login_type} | resp={_shorten(result)}"
    if not login_ok(result):
        message = result.get("msg") or result.get("message") or result
        return False, f"业务登录被拒绝 | type={login_type} | resp={_shorten(message)}"

    data = _maybe_json(result.get("data", {}))
    if not isinstance(data, dict):
        data = {}

    user_info = _maybe_json(data.get("userInfo", {}))
    combined_payload = [data, user_info]
    parsed = {
        "login_type": login_type,
        "unionid": str(_extract_first(combined_payload, UNIONID_KEYS) or "").strip(),
        "openid": str(_extract_first(combined_payload, OPENID_KEYS) or "").strip(),
        "token": str(_extract_first(data, TOKEN_KEYS) or "").strip(),
        "mobile": str(_extract_first(combined_payload, ("mobile", "phone")) or "").strip(),
        "session_key": str(_extract_first(data, ("session_key", "sessionKey")) or "").strip(),
        "has_avatar": _extract_first(combined_payload, ("hasAvatar", "headimgurl", "avatarUrl")),
        "user_info": user_info if isinstance(user_info, dict) else {},
    }
    return True, parsed

def resolve_unionid_from_wxid(
    wxid: str,
    timeout: int,
    verbose: bool,
    context: HarContext,
) -> tuple[bool, dict[str, Any] | str]:
    debug_lines: list[str] = []
    identity: dict[str, Any] = {
        "wxid": wxid.strip(),
        "appid": WECHAT_APPID,
        "unionid": "",
        "openid": "",
        "sessionid": "",
        "app_code": "",
        "token": "",
        "loader_token": "",
        "login_type": "",
        "login_error": "",
        "mobile": "",
    }

    attempts: list[tuple[str, Any]] = []

    ok, result = fetch_app_code(wxid, timeout)
    attempts.append(("取登录code", result))
    if ok:
        identity["app_code"] = str(result)
        debug_lines.append("取登录 code => 成功")
        for login_type in (1, 0):
            login_ok_flag, login_result = business_login_with_code(
                identity["app_code"],
                timeout,
                context,
                login_type=login_type,
            )
            attempts.append((f"业务登录type{login_type}", login_result))
            if login_ok_flag and isinstance(login_result, dict):
                if login_result.get("unionid"):
                    identity["unionid"] = str(login_result["unionid"]).strip()
                if login_result.get("openid"):
                    identity["openid"] = str(login_result["openid"]).strip()
                if login_result.get("token"):
                    identity["token"] = str(login_result["token"]).strip()
                if login_result.get("mobile"):
                    identity["mobile"] = str(login_result["mobile"]).strip()
                if login_result.get("session_key"):
                    identity["session_key"] = str(login_result["session_key"]).strip()
                identity["login_type"] = str(login_type)
                debug_lines.append(
                    f"业务登录 type={login_type} => "
                    f"unionid={'有' if identity['unionid'] else '无'} "
                    f"openid={'有' if identity['openid'] else '无'} "
                    f"token={'有' if identity['token'] else '无'} "
                    f"mobile={'有' if identity['mobile'] else '无'}"
                )
                if identity["unionid"] and identity["token"]:
                    identity["source"] = f"wx_loader_code_login_type_{login_type}"
                    if verbose:
                        identity["debug"] = debug_lines
                        identity["attempts"] = attempts
                    return True, identity
            else:
                identity["login_error"] = str(login_result)
                debug_lines.append(f"业务登录 type={login_type} => {_shorten(login_result)}")
    else:
        debug_lines.append(f"取登录 code => {_shorten(result)}")

    ok, result = fetch_session_data(wxid, timeout)
    attempts.append(("取sessionid", result))
    if ok and isinstance(result, dict):
        unionid = _extract_first(result, UNIONID_KEYS)
        openid = _extract_first(result, OPENID_KEYS)
        sessionid = _extract_first(result, SESSION_KEYS)
        token = _extract_first(result, TOKEN_KEYS)
        if unionid:
            identity["unionid"] = str(unionid).strip()
        if openid:
            identity["openid"] = str(openid).strip()
        if sessionid:
            identity["sessionid"] = str(sessionid).strip()
        if token:
            identity["loader_token"] = str(token).strip()
        debug_lines.append(
            f"取 sessionid => unionid={'有' if identity['unionid'] else '无'} "
            f"openid={'有' if identity['openid'] else '无'} "
            f"sessionid={'有' if identity['sessionid'] else '无'} "
            f"token={'有' if identity['loader_token'] else '无'}"
        )
        if identity["unionid"]:
            identity["source"] = "wx_loader_sessionid"
    else:
        debug_lines.append(f"取 sessionid => {_shorten(result)}")

    ok, result = fetch_self_openid_data(wxid, timeout)
    attempts.append(("取用户openid", result))
    if ok and isinstance(result, dict):
        unionid = _extract_first(result, UNIONID_KEYS)
        openid = _extract_first(result, OPENID_KEYS)
        token = _extract_first(result, TOKEN_KEYS)
        if unionid:
            identity["unionid"] = str(unionid).strip()
        if openid:
            identity["openid"] = str(openid).strip()
        if token:
            identity["loader_token"] = str(token).strip()
        debug_lines.append(
            f"取用户 openid => unionid={'有' if identity['unionid'] else '无'} "
            f"openid={'有' if identity['openid'] else '无'} "
            f"token={'有' if identity['loader_token'] else '无'}"
        )
        if identity["unionid"]:
            identity["source"] = "wx_loader_get_user_openid"
    else:
        debug_lines.append(f"取用户 openid => {_shorten(result)}")

    if verbose:
        identity["debug"] = debug_lines
        identity["attempts"] = attempts

    if identity["unionid"]:
        identity["source"] = identity.get("source") or "wx_loader_fallback"
        return True, identity

    if identity["app_code"]:
        return False, (
            "微信加载器已拿到 code，但业务登录没有返回可用身份。"
            " "
            f"app_code={identity['app_code'] or '-'} "
            f"openid={identity['openid'] or '-'} "
            f"sessionid={identity['sessionid'] or '-'} "
            f"login_error={identity['login_error'] or '-'}"
        )

    if identity["openid"] or identity["sessionid"]:
        return False, (
            "微信加载器只返回了部分身份信息，但没有 unionid。"
            " "
            f"openid={identity['openid'] or '-'} "
            f"sessionid={identity['sessionid'] or '-'} "
            f"token={identity['loader_token'] or '-'}"
        )

    attempt_summary = "; ".join(
        f"{name}={_shorten(result)}"
        for name, result in attempts
    )
    if attempt_summary:
        return False, f"无法通过 wxid 获取 unionid 或业务 token | {attempt_summary}"
    return False, "无法通过 wxid 获取 unionid 或业务 token"

def business_headers(context: HarContext, unionid: str, include_token: bool = True) -> dict[str, str]:
    headers = {
        "appid": context.appid or WECHAT_APPID,
        "platformcode": context.platformcode or PLATFORM_CODE,
        "unionid": unionid.strip(),
        "User-Agent": context.user_agent or DEFAULT_USER_AGENT,
        "Referer": context.referer or DEFAULT_REFERER,
        "xweb_xhr": "1",
        "Content-Type": "application/json",
        "Accept": "*/*",
    }
    if include_token and context.token_header_name and context.token_header_value:
        headers[context.token_header_name] = context.token_header_value
    return headers

def should_retry_without_token(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("errno") in (401, "401"):
        return True
    message = str(
        result.get("info")
        or result.get("msg")
        or result.get("message")
        or result.get("Message")
        or ""
    )
    return "token无效" in message or "token invalid" in message.lower()

def liby_http_json(
    method: str,
    path: str,
    unionid: str,
    timeout: int,
    context: HarContext,
    payload: dict[str, Any] | None = None,
) -> tuple[int | None, Any]:
    url = path if path.startswith("http://") or path.startswith("https://") else f"{API_BASE}{path}"
    include_token = bool(context.token_header_name and context.token_header_value)
    status_code, result = http_json(
        method,
        url,
        timeout=timeout,
        headers=business_headers(context, unionid, include_token=include_token),
        payload=payload,
    )
    if include_token and should_retry_without_token(result):
        status_code, result = http_json(
            method,
            url,
            timeout=timeout,
            headers=business_headers(context, unionid, include_token=False),
            payload=payload,
        )
    return status_code, result

def liby_ok(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("code") in (200, "200"):
        return True
    if result.get("success") is True:
        return True
    if result.get("errno") in (0, "0"):
        return True
    return False

def get_user_data(unionid: str, timeout: int, context: HarContext) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "GET",
        USER_DATA_PATH,
        unionid=unionid,
        timeout=timeout,
        context=context,
    )
    if status_code != 200:
        return False, f"查询用户信息失败 | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict) or not liby_ok(result):
        return False, f"查询用户信息失败 | resp={_shorten(result)}"
    return True, result

def get_task_list(
    unionid: str,
    timeout: int,
    context: HarContext,
    marketing_code: str = "",
) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "POST",
        TASK_LIST_PATH,
        unionid=unionid,
        timeout=timeout,
        context=context,
        payload={"marketingCode": marketing_code},
    )
    if status_code != 200:
        return False, f"查询任务列表失败 | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict) or not liby_ok(result):
        return False, f"查询任务列表失败 | resp={_shorten(result)}"
    return True, result

def execute_task(unionid: str, task_id: int, timeout: int, context: HarContext) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "GET",
        f"{TASK_EXECUTE_PATH}?{urlencode({'taskId': task_id})}",
        unionid=unionid,
        timeout=timeout,
        context=context,
    )
    if status_code != 200:
        return False, f"执行任务失败 | taskId={task_id} | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict) or not liby_ok(result):
        return False, f"执行任务失败 | taskId={task_id} | resp={_shorten(result)}"
    return True, result

def add_coins(
    unionid: str,
    micro_union: str,
    timeout: int,
    context: HarContext,
) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "POST",
        ADD_COINS_PATH,
        unionid=unionid,
        timeout=timeout,
        context=context,
        payload={
            "myUnionId": unionid.strip(),
            "parentUnionId": "",
            "microUnion": micro_union,
            "isNewMember": 0,
        },
    )
    if status_code != 200:
        return False, f"补积分失败 | microUnion={micro_union} | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict) or not liby_ok(result):
        return False, f"补积分失败 | microUnion={micro_union} | resp={_shorten(result)}"
    return True, result

def get_micro_page_info(
    unionid: str,
    micro_union: str,
    timeout: int,
    context: HarContext,
) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "GET",
        f"{MICRO_PAGE_INFO_PATH}?{urlencode({'appTab': '', 'id': micro_union})}",
        unionid=unionid,
        timeout=timeout,
        context=context,
    )
    if status_code != 200:
        return False, f"查询微页面失败 | microUnion={micro_union} | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict):
        return False, f"查询微页面失败 | microUnion={micro_union} | resp={_shorten(result)}"
    return True, result

def extract_lottery_context(micro_page_result: dict[str, Any]) -> dict[str, Any] | None:
    data = micro_page_result.get("data", {})
    if not isinstance(data, dict):
        return None

    components = data.get("componts", [])
    if not isinstance(components, list):
        return None

    micro_page_info_id = str(data.get("microPageInfoId") or "").strip()
    micro_page_title = str(data.get("title", "")).strip()
    invitation_type = _extract_int(data.get("invitationType"), 0)

    for component in components:
        if not isinstance(component, dict):
            continue
        if str(component.get("unit", "")).strip() != LOTTERY_COMPONENT_UNIT:
            continue

        lottery_data = component.get("lotteryData", {})
        if not isinstance(lottery_data, dict):
            lottery_data = {}

        lottery_id = _extract_int(
            lottery_data.get("id")
            or lottery_data.get("lotteryId")
            or component.get("id")
            or component.get("lotteryId"),
            0,
        )
        component_micro_page_info_id = str(
            lottery_data.get("microPageInfoId")
            or component.get("microPageInfoId")
            or micro_page_info_id
            or ""
        ).strip()
        lottery_title = str(
            lottery_data.get("lotteryName")
            or lottery_data.get("name")
            or component.get("lotteryName")
            or component.get("name")
            or micro_page_title
        ).strip()

        if component_micro_page_info_id and lottery_id > 0:
            return {
                "microPageInfoId": component_micro_page_info_id,
                "microPageTitle": micro_page_title,
                "lotteryId": lottery_id,
                "lotteryTitle": lottery_title,
                "isPreview": str(
                    component.get("isPreview")
                    or lottery_data.get("isPreview")
                    or ""
                ).strip(),
                "coin": _extract_int(lottery_data.get("coin") or component.get("coin"), 0),
                "deduct": _extract_int(lottery_data.get("deduct") or component.get("deduct"), 0),
                "invitationType": invitation_type,
            }
    return None

def get_lottery_coin(
    unionid: str,
    lottery_id: int,
    micro_page_info_id: str,
    timeout: int,
    context: HarContext,
) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "GET",
        f"{LOTTERY_COIN_PATH}?{urlencode({'lotteryId': lottery_id, 'microPageInfoId': micro_page_info_id})}",
        unionid=unionid,
        timeout=timeout,
        context=context,
    )
    if status_code != 200:
        return (
            False,
            f"查询抽奖次数失败 | lotteryId={lottery_id} | microPageInfoId={micro_page_info_id} | "
            f"HTTP={status_code} | resp={_shorten(result)}",
        )
    if not isinstance(result, dict) or not liby_ok(result):
        return (
            False,
            f"查询抽奖次数失败 | lotteryId={lottery_id} | microPageInfoId={micro_page_info_id} | "
            f"resp={_shorten(result)}",
        )
    return True, result

def lottery_action(
    unionid: str,
    lottery_id: int,
    micro_page_info_id: str,
    is_preview: str,
    timeout: int,
    context: HarContext,
) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "GET",
        (
            f"{LOTTERY_ACTION_PATH}?"
            f"{urlencode({'wechatUnionId': unionid, 'lotteryId': lottery_id, 'microPageInfoId': micro_page_info_id, 'isPreview': is_preview})}"
        ),
        unionid=unionid,
        timeout=timeout,
        context=context,
    )
    if status_code != 200:
        return (
            False,
            f"执行抽奖失败 | lotteryId={lottery_id} | microPageInfoId={micro_page_info_id} | "
            f"HTTP={status_code} | resp={_shorten(result)}",
        )
    if not isinstance(result, dict):
        return (
            False,
            f"执行抽奖失败 | lotteryId={lottery_id} | microPageInfoId={micro_page_info_id} | "
            f"resp={_shorten(result)}",
        )
    return True, result

def claim_task_reward(
    unionid: str,
    task: dict[str, Any],
    timeout: int,
    context: HarContext,
) -> tuple[bool, dict[str, Any] | str]:
    status_code, result = liby_http_json(
        "POST",
        TASK_REWARD_PATH,
        unionid=unionid,
        timeout=timeout,
        context=context,
        payload=task,
    )
    if status_code != 200:
        return False, f"领取任务奖励失败 | taskId={task.get('id')} | HTTP={status_code} | resp={_shorten(result)}"
    if not isinstance(result, dict) or not liby_ok(result):
        return False, f"领取任务奖励失败 | taskId={task.get('id')} | resp={_shorten(result)}"
    return True, result

def task_status(task: dict[str, Any]) -> int:
    return _extract_int(task.get("isComplete"), 0)

def task_status_label(task: dict[str, Any]) -> str:
    return TASK_STATUS_LABELS.get(task_status(task), str(task.get("isComplete")))

def task_reward_text(task: dict[str, Any]) -> str:
    integral = task.get("integral")
    if integral not in (None, "", "null"):
        return f"{integral}积分"
    reward_type = task.get("rewardType")
    return f"奖励类型={reward_type}"

def parse_micro_union(task: dict[str, Any]) -> str:
    for key in ("appletsUrl", "appletsUrlExtend", "url"):
        raw = str(task.get(key, "")).strip()
        if not raw:
            continue
        parsed = urlsplit(raw)
        query = parse_qs(parsed.query)
        values = query.get("microUnion") or query.get("microunion")
        if values and values[0]:
            return values[0]
    return ""

def is_auto_supported_task(task: dict[str, Any]) -> bool:
    if _extract_int(task.get("taskType"), -1) != 0:
        return False
    return True

def is_sign_task(task: dict[str, Any]) -> bool:
    text = " ".join(
        str(task.get(key, "")).strip().lower()
        for key in ("title", "describes", "explains")
    )
    return any(keyword.lower() in text for keyword in SIGN_KEYWORDS)

def format_task_summary(task: dict[str, Any]) -> str:
    return (
        f"[{task.get('id')}] {task.get('title', '')} | "
        f"状态={task_status_label(task)} | 奖励={task_reward_text(task)} | "
        f"任务类型={task.get('taskType')}"
    )

def find_task_by_id(tasks: list[dict[str, Any]], task_id: int) -> dict[str, Any] | None:
    for task in tasks:
        if _extract_int(task.get("id"), -1) == task_id:
            return task
    return None

def poll_task_refresh(
    unionid: str,
    task_id: int,
    timeout: int,
    context: HarContext,
    retries: int = 4,
    wait_seconds: int = 1,
) -> tuple[bool, dict[str, Any] | None, str]:
    last_error = "刷新后未找到任务"
    for attempt in range(1, retries + 1):
        ok, result = get_task_list(unionid, timeout, context)
        if not ok:
            last_error = str(result)
        else:
            assert isinstance(result, dict)
            tasks = result.get("data", [])
            if isinstance(tasks, list):
                task = find_task_by_id(tasks, task_id)
                if task is not None:
                    return True, task, ""
                last_error = "任务已从任务列表消失"
        if attempt < retries:
            time.sleep(wait_seconds)
    return False, None, last_error

def select_tasks(tasks: list[dict[str, Any]], mode: str) -> list[dict[str, Any]]:
    auto_tasks = [task for task in tasks if is_auto_supported_task(task)]
    if mode == "sign":
        return [task for task in auto_tasks if is_sign_task(task)]
    if mode == "tasks":
        return [task for task in auto_tasks if not is_sign_task(task)]
    return auto_tasks

def collect_micro_unions(tasks: list[dict[str, Any]]) -> list[str]:
    micro_unions: list[str] = []
    seen: set[str] = set()
    for task in tasks:
        micro_union = parse_micro_union(task)
        if not micro_union or micro_union in seen:
            continue
        seen.add(micro_union)
        micro_unions.append(micro_union)
    return micro_unions

def run_micro_union_lottery(
    unionid: str,
    micro_union: str,
    timeout: int,
    context: HarContext,
    verbose: bool,
) -> tuple[bool, list[str]]:
    lines: list[str] = [f"抽奖页尝试 | microUnion={micro_union}"]

    ok, micro_page_result = get_micro_page_info(unionid, micro_union, timeout, context)
    if not ok:
        lines.append(str(micro_page_result))
        return False, lines

    assert isinstance(micro_page_result, dict)
    page_code = micro_page_result.get("code")
    if page_code not in (200, "200"):
        message = micro_page_result.get("msg") or micro_page_result.get("message") or micro_page_result
        if page_code in (501, "501"):
            lines.append(f"抽奖跳过：当前账号不符合活动条件 | {message}")
            return True, lines
        lines.append(f"抽奖失败：微页面返回异常 | resp={_shorten(message)}")
        return False, lines

    lottery_context = extract_lottery_context(micro_page_result)
    if not lottery_context:
        lines.append("抽奖跳过：当前微页面没有抽奖组件")
        return True, lines

    micro_page_title = str(lottery_context.get("microPageTitle", "") or "").strip() or micro_union
    lottery_title = str(lottery_context.get("lotteryTitle", "") or "").strip() or micro_page_title
    micro_page_info_id = str(lottery_context.get("microPageInfoId", "") or "").strip()
    lottery_id = _extract_int(lottery_context.get("lotteryId"), 0)
    invitation_type = _extract_int(lottery_context.get("invitationType"), 0)

    lines.append(
        f"抽奖信息 | 页面={micro_page_title} | 抽奖={lottery_title} | "
        f"microPageInfoId={micro_page_info_id} | lotteryId={lottery_id}"
    )

    if not micro_page_info_id or lottery_id <= 0:
        lines.append("抽奖跳过：抽奖参数不完整")
        return True, lines

    ok, coin_result = get_lottery_coin(unionid, lottery_id, micro_page_info_id, timeout, context)
    if not ok:
        lines.append(str(coin_result))
        return False, lines

    assert isinstance(coin_result, dict)
    coin_data = coin_result.get("data", {})
    if not isinstance(coin_data, dict):
        coin_data = {}

    coin = _extract_int(coin_data.get("coin"), _extract_int(lottery_context.get("coin"), 0))
    surplus_coin = _extract_int(coin_data.get("surplusCoin"), 0)
    deduct = _extract_int(coin_data.get("deduct"), _extract_int(lottery_context.get("deduct"), 0))
    free_count = 0 if coin <= 0 else surplus_coin // coin

    lines.append(
        f"抽奖次数 | 免费={free_count}次 | 剩余抽奖币={surplus_coin} | "
        f"每次需要抽奖币={coin} | 需积分={deduct}"
    )

    should_draw = free_count > 0 or (coin == 0 and deduct == 0)
    if not should_draw:
        if deduct > 0:
            lines.append(f"抽奖跳过：当前没有免费次数，自动模式不消耗{deduct}积分")
        elif invitation_type == 3:
            lines.append("抽奖跳过：免费抽奖次数已用完，可继续邀请好友获取机会")
        else:
            lines.append("抽奖跳过：当前没有可用抽奖次数")
        return True, lines

    ok, action_result = lottery_action(
        unionid,
        lottery_id,
        micro_page_info_id,
        str(lottery_context.get("isPreview", "") or ""),
        timeout,
        context,
    )
    if not ok:
        lines.append(str(action_result))
        return False, lines

    assert isinstance(action_result, dict)
    action_data = action_result.get("data", {})
    if isinstance(action_data, dict) and action_data.get("authUrl"):
        lines.append(f"抽奖跳过：需要先授权 | authUrl={action_data.get('authUrl')}")
        return True, lines

    action_code = action_result.get("code")
    if action_code in (200, "200"):
        if isinstance(action_data, dict) and action_data.get("goodsId"):
            prize_name = (
                action_data.get("lotteryName")
                or action_data.get("goodsName")
                or lottery_title
            )
            prize_type = action_data.get("goodsType") or "未知"
            lines.append(f"抽奖结果：中奖 | 奖品={prize_name} | 类型={prize_type}")
        else:
            lines.append("抽奖结果：未中奖")
    elif action_code in (-501, "-501", -502, "-502"):
        lines.append("抽奖结果：积分不足")
        return True, lines
    else:
        message = action_result.get("msg") or action_result.get("message") or action_result
        lines.append(f"抽奖失败 | resp={_shorten(message)}")
        return False, lines

    refresh_ok, refresh_coin_result = get_lottery_coin(unionid, lottery_id, micro_page_info_id, timeout, context)
    if refresh_ok and isinstance(refresh_coin_result, dict):
        refresh_coin_data = refresh_coin_result.get("data", {})
        if not isinstance(refresh_coin_data, dict):
            refresh_coin_data = {}
        refresh_coin = _extract_int(refresh_coin_data.get("coin"), coin)
        refresh_surplus_coin = _extract_int(refresh_coin_data.get("surplusCoin"), 0)
        refresh_free_count = 0 if refresh_coin <= 0 else refresh_surplus_coin // refresh_coin
        lines.append(
            f"抽奖后次数 | 免费={refresh_free_count}次 | 剩余抽奖币={refresh_surplus_coin}"
        )
    elif verbose:
        lines.append(f"抽奖后刷新警告：{_shorten(refresh_coin_result)}")

    return True, lines

def run_single_task(
    unionid: str,
    task: dict[str, Any],
    timeout: int,
    context: HarContext,
    verbose: bool,
) -> tuple[bool, list[str]]:
    lines: list[str] = [format_task_summary(task)]
    status = task_status(task)
    task_id = _extract_int(task.get("id"), -1)
    title = str(task.get("title", ""))

    if task_id < 0:
        lines.append("跳过：任务 ID 无效")
        return False, lines

    if not is_auto_supported_task(task):
        lines.append("跳过：暂不支持的任务类型")
        return True, lines

    if status >= 2:
        lines.append("已领奖")
        return True, lines

    current_task = dict(task)

    if status == 0:
        ok, result = execute_task(unionid, task_id, timeout, context)
        if not ok:
            lines.append(str(result))
            return False, lines
        lines.append(f"执行成功 | taskId={task_id}")

        micro_union = parse_micro_union(task)
        if micro_union:
            ok, add_result = add_coins(unionid, micro_union, timeout, context)
            if ok:
                lines.append(f"补积分成功 | microUnion={micro_union}")
            else:
                lines.append(str(add_result))

        ok, refreshed_task, refresh_error = poll_task_refresh(unionid, task_id, timeout, context)
        if ok and refreshed_task is not None:
            current_task = refreshed_task
            status = task_status(current_task)
            lines.append(f"刷新后状态={task_status_label(current_task)}")
        else:
            lines.append(f"刷新警告：{refresh_error}")

    if status == 1:
        ok, reward_result = claim_task_reward(unionid, current_task, timeout, context)
        if not ok:
            lines.append(str(reward_result))
            return False, lines
        lines.append(f"领奖成功 | taskId={task_id} | 标题={title}")

        ok, refreshed_task, refresh_error = poll_task_refresh(unionid, task_id, timeout, context)
        if ok and refreshed_task is not None:
            lines.append(f"最终状态={task_status_label(refreshed_task)}")
        elif verbose:
            lines.append(f"最终刷新警告：{refresh_error}")
        return True, lines

    if status == 0:
        lines.append("执行后仍未达到领奖状态")
        return False, lines

    if status >= 2:
        lines.append("刷新后已领奖")
        return True, lines

    lines.append(f"未知任务状态={status}")
    return False, lines

def load_accounts_from_env() -> list[dict[str, str]]:
    raw = ""
    for key in ACCOUNT_ENV_KEYS:
        raw = os.getenv(key, "").strip()
        if raw:
            break

    if not raw:
        bridge_accounts = fetch_accounts()
        if bridge_accounts:
            return bridge_accounts
        return []

    accounts: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        parts = [part.strip() for part in line.split("#")]
        remark = ""
        wxid = ""
        unionid = ""

        if len(parts) >= 3:
            remark, wxid, unionid = parts[0], parts[1], parts[2]
        elif len(parts) == 2:
            remark, wxid = parts
        else:
            remark = parts[0]
            wxid = parts[0]

        remark = remark or wxid or unionid
        key = (wxid, unionid)
        if key in seen:
            continue
        seen.add(key)
        accounts.append({"remark": remark, "wxid": wxid, "unionid": unionid})
    return accounts

def print_task_status(tasks: list[dict[str, Any]]) -> None:
    for task in tasks:
        print(format_task_summary(task))

def run_unionid_mode(
    remark: str,
    unionid: str,
    timeout: int,
    context: HarContext,
    mode: str,
    status_only: bool,
    verbose: bool,
) -> int:
    print(f"账号: {remark}")
    print(f"unionid: {unionid}")

    ok, user_result = get_user_data(unionid, timeout, context)
    if not ok:
        print(f"查询用户信息失败: {user_result}")
        print("-" * 60)
        return 1

    assert isinstance(user_result, dict)
    user_data = user_result.get("data", {})
    integral_before = _extract_int(user_data.get("integral"), -1)
    nickname = user_data.get("nickName", "-")
    mobile = user_data.get("mobile", "-")
    print(f"用户={nickname} | 手机={mobile} | 积分={integral_before}")

    ok, task_result = get_task_list(unionid, timeout, context)
    if not ok:
        print(f"查询任务列表失败: {task_result}")
        print("-" * 60)
        return 1

    assert isinstance(task_result, dict)
    tasks = task_result.get("data", [])
    if not isinstance(tasks, list):
        print(f"任务列表返回异常: {_shorten(task_result)}")
        print("-" * 60)
        return 1

    selected_tasks = select_tasks(tasks, mode)
    if verbose:
        print(f"任务总数={len(tasks)} | 选中任务={len(selected_tasks)} | 模式={mode}")

    if not selected_tasks:
        if mode == "sign":
            print("任务列表中没有找到签到类任务，当前 HAR 未包含独立签到接口。")
        else:
            print("没有找到可自动执行的任务。")
        print("-" * 60)
        return 0

    if status_only:
        print_task_status(selected_tasks)
        print("-" * 60)
        return 0

    overall_ok = True
    for task in selected_tasks:
        ok, lines = run_single_task(unionid, task, timeout, context, verbose)
        overall_ok = overall_ok and ok
        for line in lines:
            print(line)
        print("-" * 40)

    lottery_micro_unions = collect_micro_unions(selected_tasks)
    for micro_union in lottery_micro_unions:
        ok, lines = run_micro_union_lottery(unionid, micro_union, timeout, context, verbose)
        overall_ok = overall_ok and ok
        for line in lines:
            print(line)
        print("-" * 40)

    verify_ok, verify_user = get_user_data(unionid, timeout, context)
    if verify_ok and isinstance(verify_user, dict):
        integral_after = _extract_int(verify_user.get("data", {}).get("integral"), -1)
        delta = integral_after - integral_before if integral_before >= 0 and integral_after >= 0 else "?"
        print(f"执行后积分={integral_after} | 增加={delta}")
    elif verbose:
        print(f"校验用户信息失败: {_shorten(verify_user)}")

    verify_ok, verify_tasks = get_task_list(unionid, timeout, context)
    if verify_ok and isinstance(verify_tasks, dict):
        final_tasks = select_tasks(verify_tasks.get("data", []), mode)
        if final_tasks:
            print("最终任务状态:")
            print_task_status(final_tasks)
    elif verbose:
        print(f"校验任务列表失败: {_shorten(verify_tasks)}")

    print("-" * 60)
    return 0 if overall_ok else 1

def run_wxid_mode(
    accounts: list[dict[str, str]],
    timeout: int,
    base_context: HarContext,
    mode: str,
    status_only: bool,
    verbose: bool,
) -> int:
    success_count = 0

    for index, account in enumerate(accounts, 1):
        remark = account.get("remark", "") or account.get("wxid", "") or account.get("unionid", "")
        wxid = account.get("wxid", "").strip()
        unionid = account.get("unionid", "").strip()
        print(f"[{index}/{len(accounts)}] {remark}")

        runtime_context = HarContext(
            unionid=base_context.unionid,
            openid=base_context.openid,
            appid=base_context.appid,
            platformcode=base_context.platformcode,
            referer=base_context.referer,
            user_agent=base_context.user_agent,
            token_header_name=base_context.token_header_name,
            token_header_value=base_context.token_header_value,
            har_path=base_context.har_path,
        )

        if wxid:
            ok, identity = resolve_unionid_from_wxid(wxid, timeout, verbose, runtime_context)
            if ok:
                assert isinstance(identity, dict)
                if identity.get("unionid"):
                    unionid = str(identity["unionid"]).strip()
                if identity.get("openid"):
                    runtime_context.openid = str(identity["openid"]).strip()
                fresh_token = str(identity.get("token") or "").strip()
                if fresh_token:
                    runtime_context.token_header_name = build_business_token_header_name(runtime_context.appid)
                    runtime_context.token_header_value = fresh_token
                if verbose:
                    print(
                        f"微信登录成功 | 来源={identity.get('source', '-')} | "
                        f"unionid={identity.get('unionid', '-') or '-'} | "
                        f"openid={identity.get('openid', '-') or '-'} | "
                        f"登录类型={identity.get('login_type', '-') or '-'} | "
                        f"sessionid={identity.get('sessionid', '-') or '-'} | "
                        f"token={identity.get('token', '-') or '-'} | "
                        f"加载器token={identity.get('loader_token', '-') or '-'} | "
                        f"app_code={identity.get('app_code', '-') or '-'}"
                    )
                    if not fresh_token and not runtime_context.token_header_value:
                        print("调试: 未从 wxid 登录刷新到业务 token")
                    for line in identity.get("debug", []):
                        print(f"调试: {line}")
            else:
                print(f"wxid 登录警告 | wxid={wxid} | {identity}")

        if not unionid:
            print("跳过：没有 wxid，也没有 unionid")
            print("-" * 60)
            continue

        exit_code = run_unionid_mode(remark, unionid, timeout, runtime_context, mode, status_only, verbose)
        if exit_code == 0:
            success_count += 1

    return 0 if success_count else 1

def run_single_unionid(
    unionid: str,
    timeout: int,
    context: HarContext,
    mode: str,
    status_only: bool,
    verbose: bool,
) -> int:
    return run_unionid_mode("single", unionid, timeout, context, mode, status_only, verbose)

def main() -> int:
    args = parse_args()
    print(f"作者: {SCRIPT_AUTHOR} | {SCRIPT_NAME}")
    print(f"小程序: {MINI_PROGRAM_HINT}")

    accounts: list[dict[str, str]] = []
    if args.wxid.strip():
        accounts = [{
            "remark": args.wxid.strip(),
            "wxid": args.wxid.strip(),
            "unionid": args.unionid.strip(),
        }]
    else:
        accounts = load_accounts_from_env()

    har_context = HarContext()
    har_error: str | None = None
    har_path = pick_har_file(args.har)
    har_context, har_error = try_extract_har_context(har_path)

    if args.verbose:
        print(f"微信服务: {YYB_BASE_URL}")
        print(f"HAR: {har_context.har_path or '未使用'}")
        if har_error:
            print(f"HAR 警告: {har_error}")
        print(
            f"HAR 上下文 unionid={har_context.unionid or '-'} "
            f"openid={har_context.openid or '-'} "
            f"appid={har_context.appid or '-'} "
            f"platformcode={har_context.platformcode or '-'}"
        )

    if accounts:
        return run_wxid_mode(
            accounts,
            args.timeout,
            har_context if har_context.har_path else HarContext(),
            args.mode,
            args.status_only,
            args.verbose,
        )

    unionid = args.unionid.strip() or har_context.unionid.strip()
    if unionid:
        return run_single_unionid(
            unionid,
            args.timeout,
            har_context,
            args.mode,
            args.status_only,
            args.verbose,
        )

    if har_error:
        print(f"HAR 警告: {har_error}", file=sys.stderr)

    print("未提供 wxid 或 unionid。", file=sys.stderr)

    print("用法2: 设置环境变量 `liby`，每行一个账号，格式为 remark#wxid", file=sys.stderr)
    print("用法3: 传入 --unionid，或把立白 HAR 文件放到脚本同目录", file=sys.stderr)
    return 2

if __name__ == "__main__":
    raise SystemExit(main())
