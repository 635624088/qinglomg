#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
无忧计划青龙每日任务

环境变量：WYJH
格式：手机号#密码#device_id
多账号：使用换行、& 或 | 分隔，例如：
    13800138000#password#device-a&13900139000#password#device-b

device_id 为可选：只填 手机号#密码 时自动生成随机 device_id 用于 attest 签名，
登录请求不携带 device_id 字段，可绕过设备绑定上限（适用于已绑定设备的账号）。
示例：13800138000#password

多账号并发运行，默认并发 5，可通过环境变量 WY_MAX_WORKERS 调整。

任务顺序：
1. 每日签到
2. 看广告赚金币（单次运行最多成功20次；服务端无广告、无奖励或达到个人上限时立即结束）
3. 领取“今日挑战”中所有可领取的每日任务和每周任务奖励

青龙定时示例：15 8 * * *
无忧计划注册链接：https://dgccvi.com/#/register?ref=IPFLKEH
邀请码：IPFLKEH            必须填写邀请码注册
只支持安卓下载

接口、attest 和请求签名均按 APK 1.0.8 当前源码实现。
"""

import hashlib
import hmac
import json
import math
import os
import random
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


API_BASE = "https://api.dgccvi.com/api/app"
ADS_BASE = "https://ads.dgccvi.com/api/app"
ATTEST_KEY = "aac0ab40d0612c8549f88e87e476751a348f910156e9e73590ddaece2a4288d5"
APP_VERSION = "1.0.8"
PACKAGE_NAME = "com.dgccvi.app"
MAX_AD_REWARDS = 20
HTTP_TIMEOUT = 25
SESSION_REFRESH_SECONDS = 1740
MOBILE_PATTERN = re.compile(r"^1[3-9]\d{9}$")
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
    "Chrome/120.0 Mobile Safari/537.36"
)

def log(message: str, account: str = "") -> None:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    prefix = f"[{account}] " if account else ""
    print(f"[{now}] {prefix}{message}", flush=True)


def compact_json(value: Any) -> str:
    # 对应前端 JSON.stringify；请求签名依赖完全相同的正文。
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hmac_hex(key: str, value: str) -> str:
    return hmac.new(key.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def mask_phone(phone: str) -> str:
    return phone[:3] + "****" + phone[7:] if len(phone) == 11 else phone


def nested_value(data: Any, *keys: str) -> Any:
    if not isinstance(data, dict):
        return None
    for key in keys:
        value = data.get(key)
        if value is not None:
            return value
    child = data.get("data")
    if isinstance(child, dict):
        return nested_value(child, *keys)
    return None


class NetworkError(RuntimeError):
    pass


class ApiError(RuntimeError):
    def __init__(self, status: int, data: Any, fallback: str = "请求失败"):
        self.status = status
        self.data = data if isinstance(data, dict) else {}
        self.code = str(self.data.get("code") or "")
        self.message = str(
            self.data.get("error")
            or self.data.get("message")
            or self.data.get("msg")
            or f"{fallback} (HTTP {status})"
        )
        super().__init__(self.message)


def raw_http(
    method: str,
    url: str,
    headers: Optional[Dict[str, str]] = None,
    body: Optional[bytes] = None,
    timeout: int = HTTP_TIMEOUT,
) -> Tuple[int, Any]:
    request = urllib.request.Request(
        url=url,
        data=body,
        headers=headers or {},
        method=method.upper(),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise NetworkError(f"网络请求失败 {method.upper()} {url}: {reason}") from exc

    if not raw.strip():
        return status, {}
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, {"error": f"服务器返回非JSON内容: {raw[:160]}"}


@dataclass(frozen=True)
class Account:
    phone: str
    password: str
    device_id: str
    explicit_device_id: bool = True

    @property
    def label(self) -> str:
        return mask_phone(self.phone)


def parse_accounts(raw: str) -> List[Account]:
    accounts: List[Account] = []
    seen = set()
    for segment in re.split(r"[\r\n&|]+", raw or ""):
        segment = segment.strip()
        if not segment:
            continue
        parts = segment.split("#", 2)
        phone = parts[0].strip()
        password = parts[1].strip() if len(parts) > 1 else ""
        device_id = parts[2].strip() if len(parts) > 2 else ""
        if not phone or not password:
            raise ValueError(f"变量片段格式错误：{segment[:24]}...，正确格式为 手机号#密码 或 手机号#密码#device_id")
        if not MOBILE_PATTERN.fullmatch(phone):
            raise ValueError(f"手机号格式错误：{mask_phone(phone)}")
        # device_id 可选：留空时自动生成随机值（仅用于 attest 签名，登录不传 device_id）
        explicit = bool(device_id)
        if not device_id:
            device_id = "device-" + secrets.token_hex(12)
        identity = (phone, device_id)
        if identity in seen:
            continue
        seen.add(identity)
        accounts.append(Account(phone, password, device_id, explicit_device_id=explicit))
    return accounts


class WuyouClient:
    def __init__(self, account: Account):
        self.account = account
        self.token = ""
        # 当前服务端的主API和广告API分别保存attest会话，不能混用session_id。
        self.sessions: Dict[str, Dict[str, Any]] = {}

    @staticmethod
    def session_scope(url: str) -> str:
        target = urllib.parse.urlsplit(url)
        ads = urllib.parse.urlsplit(ADS_BASE)
        if target.netloc.lower() == ads.netloc.lower():
            return ADS_BASE
        return API_BASE

    def attest(self, base_url: str = API_BASE) -> None:
        scope = self.session_scope(base_url)
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        proof_text = f"attest\n{timestamp}\n{nonce}\n{self.account.device_id}"
        payload = {
            "integrity_token": "",
            "device_id": self.account.device_id,
            "ts": timestamp,
            "nonce": nonce,
            "native_proof": hmac_hex(ATTEST_KEY, proof_text),
        }
        status, data = raw_http(
            "POST",
            scope + "/attest",
            headers={"Content-Type": "application/json"},
            body=compact_json(payload).encode("utf-8"),
        )
        if status != 200 or not isinstance(data, dict) or not data.get("ok"):
            raise ApiError(status, data, "attest失败")
        session_id = str(data.get("session_id") or "")
        session_secret = str(data.get("session_secret") or "")
        if not session_id or not session_secret:
            raise RuntimeError("attest响应缺少session_id或session_secret")
        self.sessions[scope] = {
            "session_id": session_id,
            "session_secret": session_secret,
            "created_at": time.time(),
        }

    def ensure_session(self, url: str) -> Dict[str, Any]:
        scope = self.session_scope(url)
        session = self.sessions.get(scope) or {}
        if (
            not session.get("session_id")
            or not session.get("session_secret")
            or time.time() - float(session.get("created_at") or 0) >= SESSION_REFRESH_SECONDS
        ):
            self.attest(scope)
            session = self.sessions[scope]
        return session

    def signed_headers(self, method: str, url: str, body_text: str, auth: bool) -> Dict[str, str]:
        session = self.ensure_session(url)
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        # 源码只把URL pathname写入签名，不包含query string。
        path = urllib.parse.urlsplit(url).path or "/"
        message = (
            f"{method.upper()}\n{path}\n{timestamp}\n{nonce}\n{sha256_hex(body_text)}"
        )
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Origin": "https://localhost",
            "Referer": "https://localhost/",
            "X-Requested-With": PACKAGE_NAME,
            "X-App-Session": str(session["session_id"]),
            "X-App-Ts": timestamp,
            "X-App-Nonce": nonce,
            "X-App-Sign": hmac_hex(str(session["session_secret"]), message),
        }
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _request_url(
        self,
        method: str,
        url: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
        auth: bool = True,
        attest_retry: bool = True,
    ) -> Any:
        if query:
            url += "?" + urllib.parse.urlencode(query)
        body_text = "" if body is None else compact_json(body)
        headers = self.signed_headers(method, url, body_text, auth)
        status, data = raw_http(
            method,
            url,
            headers=headers,
            body=body_text.encode("utf-8") if body_text else None,
        )
        if 200 <= status < 300:
            return data
        if (
            status == 403
            and isinstance(data, dict)
            and data.get("code") == "app_required"
            and attest_retry
        ):
            self.attest(self.session_scope(url))
            return self._request_url(method, url.split("?", 1)[0], query, body, auth, False)
        raise ApiError(status, data)

    def api(
        self,
        method: str,
        endpoint: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
        auth: bool = True,
    ) -> Any:
        return self._request_url(method, API_BASE + endpoint, query, body, auth)

    def ads(
        self,
        method: str,
        endpoint: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        try:
            return self._request_url(method, ADS_BASE + endpoint, query, body, True)
        except NetworkError as exc:
            # 当前前端源码仅在广告独立域名网络不可达时回退到主API域名。
            log(f"广告域名不可达，按源码回退主API：{exc}", self.account.label)
            return self._request_url(method, API_BASE + endpoint, query, body, True)

    def login(self) -> Dict[str, Any]:
        login_body: Dict[str, Any] = {
            "account": self.account.phone,
            "password": self.account.password,
            "platform": "android",
            "app_version": APP_VERSION,
        }
        # 仅当用户显式提供了 device_id 时才传给登录接口。
        # 自动生成的 device_id 只用于 attest 签名，登录不传可绕过设备绑定上限。
        if self.account.explicit_device_id:
            login_body["device_id"] = self.account.device_id
        response = self.api(
            "POST",
            "/auth/login",
            body=login_body,
            auth=False,
        )
        token = nested_value(response, "token", "access_token")
        if not token:
            raise RuntimeError("登录响应中未找到token")
        self.token = str(token)
        return response if isinstance(response, dict) else {}


def fetch_current_user(client: WuyouClient) -> Dict[str, Any]:
    query: Dict[str, Any] = {
        "platform": "android",
        "app_version": APP_VERSION,
    }
    if client.account.explicit_device_id:
        query["device_id"] = client.account.device_id
    response = client.api("GET", "/me", query=query)
    return response if isinstance(response, dict) else {}


def authenticate(client: WuyouClient) -> Tuple[Dict[str, Any], str]:
    login_data = client.login()
    return login_data, "密码登录"


def do_checkin(client: WuyouClient) -> Tuple[str, int]:
    account = client.account.label
    status = client.api("GET", "/checkin/status")
    if isinstance(status, dict) and status.get("checked_today"):
        log("签到：今日已签到", account)
        return "今日已签到", 0
    try:
        result = client.api("POST", "/checkin")
    except ApiError as exc:
        if "已签到" in exc.message:
            log("签到：今日已签到", account)
            return "今日已签到", 0
        raise
    coins = int(nested_value(result, "coins_awarded", "gold_coins", "coins") or 0)
    log(f"签到成功，获得 {coins} 金币", account)
    return "签到成功", coins


def number_value(data: Any, *keys: str, default: float = 0) -> float:
    value = nested_value(data, *keys)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def choose_request_interval(data: Any) -> int:
    direct = number_value(data, "next_request_available_in", "request_interval_seconds")
    if direct > 0:
        return max(0, math.ceil(direct))
    minimum = max(0, math.ceil(number_value(data, "request_interval_min_seconds")))
    maximum = max(minimum, math.ceil(number_value(data, "request_interval_max_seconds")))
    return random.randint(minimum, maximum) if maximum > 0 else 0


def sleep_countdown(seconds: int, reason: str, account: str) -> None:
    seconds = max(0, int(seconds))
    if seconds <= 0:
        return
    log(f"{reason}，等待 {seconds} 秒", account)
    time.sleep(seconds)


EXHAUSTED_CODES = {
    "daily_limit",
    "daily_limit_reached",
    "limit_reached",
    "no_ad",
    "no_ads",
    "no_fill",
    "ad_exhausted",
    "exhausted",
    "need_app",
}


def is_exhausted_error(exc: ApiError) -> bool:
    message = exc.message.lower()
    return exc.code.lower() in EXHAUSTED_CODES or any(
        text in message
        for text in ("上限", "暂无", "没有广告", "无广告", "no ad", "no fill", "exhaust", "请下载", "下载 app")
    )


def list_ads(client: WuyouClient) -> Dict[str, Any]:
    response = client.ads(
        "GET", "/alliance-ads", query={"device_id": client.account.device_id}
    )
    return response if isinstance(response, dict) else {}


def abort_ad(client: WuyouClient, play_token: str) -> None:
    if not play_token:
        return
    try:
        client.ads("POST", "/alliance-ads/session/abort", body={"play_token": play_token})
    except Exception:
        pass


def heartbeat(client: WuyouClient, play_token: str, progress: float) -> None:
    client.ads(
        "POST",
        "/alliance-ads/session/heartbeat",
        body={"play_token": play_token, "progress_seconds": round(progress, 2)},
    )


def watch_and_complete(client: WuyouClient, session: Dict[str, Any]) -> Dict[str, Any]:
    account = client.account.label
    play_token = str(session.get("play_token") or "")
    if not play_token:
        raise RuntimeError("广告session缺少play_token")
    duration = max(1.0, float(session.get("duration_seconds") or 1))
    heartbeat_interval = float(session.get("heartbeat_interval") or 15)
    # 前端源码把心跳间隔限制在5~30秒。
    heartbeat_interval = max(5.0, min(30.0, heartbeat_interval))
    reward_preview = int(session.get("reward_coins") or 0)
    log(
        f"开始观看广告：时长 {duration:g} 秒，预计奖励 {reward_preview} 金币",
        account,
    )

    started = time.monotonic()
    try:
        # timeupdate在视频开始后会尽早产生第一次进度上报。
        try:
            heartbeat(client, play_token, 0.02)
        except Exception as exc:
            log(f"首次心跳失败，继续播放：{exc}", account)

        target_elapsed = duration + 0.8
        while True:
            elapsed = time.monotonic() - started
            remaining = target_elapsed - elapsed
            if remaining <= 0:
                break
            time.sleep(min(heartbeat_interval, remaining))
            elapsed = time.monotonic() - started
            progress = min(duration, elapsed)
            try:
                heartbeat(client, play_token, progress)
                log(f"广告心跳：{progress:.1f}/{duration:g} 秒", account)
            except Exception as exc:
                # App源码同样忽略单次heartbeat失败，最终仍会complete。
                log(f"广告心跳失败，继续播放：{exc}", account)

        try:
            heartbeat(client, play_token, duration)
        except Exception as exc:
            log(f"结束心跳失败，继续结算：{exc}", account)
        result = client.ads(
            "POST",
            "/alliance-ads/session/complete",
            body={"play_token": play_token, "progress_seconds": round(duration, 2)},
        )
        return result if isinstance(result, dict) else {}
    except Exception:
        abort_ad(client, play_token)
        raise


def ad_limit_from_state(state: Dict[str, Any]) -> int:
    server_limit = int(
        number_value(state, "max_views_per_device_per_day", "max_views_per_day", default=0)
    )
    if server_limit > 0:
        return min(MAX_AD_REWARDS, server_limit)
    return MAX_AD_REWARDS


def remaining_from_state(state: Dict[str, Any]) -> Optional[int]:
    value = nested_value(
        state,
        "remaining_views",
        "remaining_views_today",
        "remaining_today",
        "remaining_count",
    )
    if value is None:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def do_ads(client: WuyouClient) -> Tuple[int, int, str]:
    account = client.account.label
    try:
        state = list_ads(client)
    except ApiError as exc:
        if is_exhausted_error(exc):
            log(f"广告结束：{exc.message}", account)
            return 0, 0, exc.message
        raise

    if not state.get("enabled", False):
        log("广告结束：功能未开放", account)
        return 0, 0, "功能未开放"
    items = state.get("items")
    if not isinstance(items, list) or not items:
        log("广告结束：暂无可看广告", account)
        return 0, 0, "暂无可看广告"

    limit = ad_limit_from_state(state)
    remaining = remaining_from_state(state)
    if remaining is not None:
        limit = min(limit, remaining)
    if limit <= 0:
        log("广告结束：今日个人次数已用完", account)
        return 0, 0, "今日个人次数已用完"

    log(f"广告任务启动，本次最多领取 {limit} 次，服务端无奖励会提前结束", account)
    success_count = 0
    total_coins = 0
    end_reason = "达到本次7次安全上限"

    while success_count < limit:
        items = state.get("items")
        if not isinstance(items, list) or not items:
            end_reason = "暂无可看广告"
            break
        sleep_countdown(choose_request_interval(state), "广告请求冷却", account)

        start_result: Optional[Dict[str, Any]] = None
        interval_retries = 0
        while start_result is None:
            try:
                response = client.ads(
                    "POST",
                    "/alliance-ads/session/start",
                    body={"device_id": client.account.device_id, "client": "app"},
                )
                start_result = response if isinstance(response, dict) else {}
            except ApiError as exc:
                if exc.code == "request_interval":
                    interval_retries += 1
                    if interval_retries > 5:
                        end_reason = "广告请求间隔连续受限"
                        log(f"广告结束：{end_reason}", account)
                        return success_count, total_coins, end_reason
                    retry_after = max(1, int(number_value(exc.data, "retry_after", default=1)))
                    sleep_countdown(retry_after, "服务端要求延迟请求", account)
                    continue
                if is_exhausted_error(exc):
                    end_reason = exc.message
                    log(f"广告结束：{end_reason}", account)
                    return success_count, total_coins, end_reason
                raise

        session = start_result.get("session")
        if not isinstance(session, dict):
            end_reason = "开启广告未返回session"
            log(f"广告结束：{end_reason}", account)
            break
        try:
            complete = watch_and_complete(client, session)
        except ApiError as exc:
            if is_exhausted_error(exc):
                end_reason = exc.message
                log(f"广告结束：{end_reason}", account)
                break
            raise

        reward = int(number_value(complete, "gold_coins", "reward_coins", "coins", default=0))
        if reward <= 0:
            end_reason = str(
                nested_value(complete, "message", "error") or "本条广告没有奖励"
            )
            log(f"广告结束：{end_reason}", account)
            break
        success_count += 1
        total_coins += reward
        log(f"第 {success_count} 次广告结算成功，获得 {reward} 金币", account)

        if success_count >= limit:
            end_reason = f"已完成个人可用次数（本次 {success_count} 次）"
            break
        next_interval = choose_request_interval(complete)
        if next_interval <= 0:
            next_interval = choose_request_interval(start_result)
        sleep_countdown(next_interval, "下一条广告冷却", account)
        try:
            state = list_ads(client)
        except ApiError as exc:
            if is_exhausted_error(exc):
                end_reason = exc.message
                break
            raise
        if not state.get("enabled", False):
            end_reason = "广告功能已关闭"
            break

    log(f"广告任务完成：成功 {success_count} 次，共 {total_coins} 金币；{end_reason}", account)
    return success_count, total_coins, end_reason


def task_list(client: WuyouClient) -> List[Dict[str, Any]]:
    response = client.api("GET", "/daily-tasks")
    tasks = nested_value(response, "tasks")
    return [task for task in tasks if isinstance(task, dict)] if isinstance(tasks, list) else []


def do_challenge_rewards(client: WuyouClient) -> Tuple[int, int, int]:
    account = client.account.label
    claimed_keys = set()
    failed_keys = set()
    daily_count = 0
    weekly_count = 0
    total_coins = 0

    # 领取后重新拉取，兼容领取一个任务后服务端又解锁另一个奖励。
    for _ in range(3):
        tasks = task_list(client)
        claimable = [
            task
            for task in tasks
            if task.get("can_claim")
            and not task.get("is_claimed")
            and str(task.get("task_key") or "") not in claimed_keys | failed_keys
        ]
        if not claimable:
            break
        claimed_this_round = 0
        for task in claimable:
            task_key = str(task.get("task_key") or "")
            if not task_key:
                continue
            title = str(task.get("title") or task_key)
            period = str(task.get("period_type") or "daily").lower()
            endpoint_key = urllib.parse.quote(task_key, safe="")
            try:
                result = client.api("POST", f"/daily-tasks/{endpoint_key}/claim")
                coins = int(number_value(result, "coins", "gold_coins", "reward_coins", default=0))
                claimed_keys.add(task_key)
                claimed_this_round += 1
                total_coins += coins
                if period == "weekly":
                    weekly_count += 1
                    period_name = "每周任务"
                else:
                    daily_count += 1
                    period_name = "每日任务"
                log(f"领取{period_name}“{title}”成功，获得 {coins} 金币", account)
            except ApiError as exc:
                failed_keys.add(task_key)
                log(f"领取任务“{title}”失败：{exc.message}", account)
        if claimed_this_round == 0:
            break

    if daily_count == 0 and weekly_count == 0:
        log("今日挑战：没有可领取的每日/每周任务奖励", account)
    else:
        log(
            f"今日挑战领取完成：每日 {daily_count} 个，每周 {weekly_count} 个，共 {total_coins} 金币",
            account,
        )
    return daily_count, weekly_count, total_coins


def coin_balance(client: WuyouClient) -> Optional[int]:
    try:
        query: Dict[str, Any] = {
            "platform": "android",
            "app_version": APP_VERSION,
        }
        if client.account.explicit_device_id:
            query["device_id"] = client.account.device_id
        me = client.api("GET", "/me", query=query)
    except Exception:
        return None
    user = me.get("user") if isinstance(me, dict) else None
    if not isinstance(user, dict):
        user = me if isinstance(me, dict) else {}
    wallet = user.get("wallet") if isinstance(user.get("wallet"), dict) else {}
    value = wallet.get("gold_coins")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def run_account(account: Account) -> Tuple[bool, str]:
    client = WuyouClient(account)
    log("开始执行", account.label)
    try:
        login_data, login_mode = authenticate(client)
        user = nested_value(login_data, "user")
        if not isinstance(user, dict) and isinstance(login_data, dict):
            user = login_data
        user_id = user.get("id") if isinstance(user, dict) else None
        log(
            f"认证成功（{login_mode}）{f'，账号ID {user_id}' if user_id else ''}",
            account.label,
        )

        errors: List[str] = []
        checkin_status, checkin_coins = "执行失败", 0
        ad_count, ad_coins, ad_reason = 0, 0, "执行失败"
        daily_count, weekly_count, task_coins = 0, 0, 0
        try:
            checkin_status, checkin_coins = do_checkin(client)
        except Exception as exc:
            errors.append(f"签到失败：{exc}")
            log(errors[-1], account.label)
        try:
            ad_count, ad_coins, ad_reason = do_ads(client)
        except Exception as exc:
            ad_reason = f"执行失败：{exc}"
            errors.append(f"广告失败：{exc}")
            log(errors[-1], account.label)
        try:
            daily_count, weekly_count, task_coins = do_challenge_rewards(client)
        except Exception as exc:
            errors.append(f"今日挑战失败：{exc}")
            log(errors[-1], account.label)
        balance = coin_balance(client)
        earned = checkin_coins + ad_coins + task_coins
        summary = (
            f"账号：{account.label}\n"
            f"签到：{checkin_status}（+{checkin_coins}金币）\n"
            f"广告：{ad_count}次（+{ad_coins}金币，{ad_reason}）\n"
            f"今日挑战：每日{daily_count}个 / 每周{weekly_count}个（+{task_coins}金币）\n"
            f"本轮合计：+{earned}金币"
        )
        if balance is not None:
            summary += f"\n当前金币：{balance}"
        if errors:
            summary += "\n异常：" + "；".join(errors)
        log("执行完成", account.label)
        return not errors, summary
    except ApiError as exc:
        message = f"账号：{account.label}\n执行失败：{exc.message}（HTTP {exc.status}{f' / {exc.code}' if exc.code else ''}）"
        log(message.replace("\n", "；"), account.label)
        return False, message
    except Exception as exc:
        message = f"账号：{account.label}\n执行失败：{exc}"
        log(message.replace("\n", "；"), account.label)
        return False, message


def send_notification(content: str) -> None:
    if not content.strip():
        return
    try:
        # 青龙的 notify.py 通常位于 /ql/data/scripts；仓库子目录运行时该目录
        # 不一定在 sys.path 中，因此同时兼容脚本同目录和青龙公共脚本目录。
        notify_dirs = [
            os.path.dirname(os.path.abspath(__file__)),
            "/ql/data/scripts",
            "/ql/scripts",
        ]
        for notify_dir in notify_dirs:
            if os.path.isfile(os.path.join(notify_dir, "notify.py")) and notify_dir not in sys.path:
                sys.path.insert(0, notify_dir)

        from notify import send  # type: ignore

        send("无忧计划每日任务", content)
        log("青龙通知调用完成")
    except Exception as exc:
        log(f"通知模块不可用，跳过推送：{exc}")


MAX_WORKERS = int(os.getenv("WY_MAX_WORKERS") or "5")


def run_account_worker(index: int, total: int, account: Account) -> Tuple[int, bool, str]:
    log(f"===== 账号 {index}/{total} =====")
    success, summary = run_account(account)
    return index, success, summary


def main() -> int:
    raw = os.getenv("WYJH") or ""
    if not raw.strip():
        message = "未配置环境变量 WYJH，格式：手机号#密码 或 手机号#密码#device_id"
        log(message)
        send_notification(f"任务未执行：{message}")
        return 1
    try:
        accounts = parse_accounts(raw)
    except ValueError as exc:
        log(str(exc))
        send_notification(f"任务未执行：{exc}")
        return 1
    if not accounts:
        message = "WYJH 中没有有效账号"
        log(message)
        send_notification(f"任务未执行：{message}")
        return 1

    total = len(accounts)
    log(f"共读取 {total} 个账号，并发数 {MAX_WORKERS}")

    results: List[Optional[str]] = [None] * total
    success_count = 0
    workers = min(MAX_WORKERS, total)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(run_account_worker, i + 1, total, acc): i
            for i, acc in enumerate(accounts)
        }
        for future in as_completed(futures):
            index, success, summary = future.result()
            results[index - 1] = summary
            success_count += int(success)

    content = "\n\n--------------------\n\n".join(r for r in results if r)
    send_notification(content)
    log(f"全部完成：成功 {success_count}/{total}")
    return 0 if success_count == total else 2


if __name__ == "__main__":
    sys.exit(main())
