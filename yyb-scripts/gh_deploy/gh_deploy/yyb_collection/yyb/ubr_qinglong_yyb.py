#!/usr/bin/env python3
"""北京环球度假区 2026 活动每日签到（YYB 多账号版）。

启动后直接执行：缓存 token 验证 -> 失效时 YYB 取 code 登录 ->
只读状态预检 -> 未签到才调用 completeQuest -> 再次只读确认。

依赖：requests
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
from email.utils import formatdate
from pathlib import Path
from typing import Any, Callable

import requests


APP_ID = os.getenv("UBR_APP_ID", "wx21f6790118783b83").strip()
BASE_URL = "https://bmp.app.universalbeijingresort.com"
LOGIN_PATH = "/2026_ubr_yunyingqiu/ubr/user/login"
DETAIL_PATH = "/2026_ubr_yunyingqiu/business/activityRecord/detail"
SIGN_PATH = "/2026_ubr_yunyingqiu/business/activityRecord/completeQuest"

ACTIVITY_CODE = os.getenv("UBR_ACTIVITY_CODE", "2026_UBR_YUNYINGQIU").strip()
HMAC_USER = "ubr-bmp"
HMAC_SECRET = "aK@AtX5#Ck5x"
REQUEST_TIMEOUT = float(os.getenv("UBR_TIMEOUT", "30"))

YYB_URL = os.getenv("YYB_URL", "").strip().rstrip("/")
YYB_USER = os.getenv("YYB_USER", "").strip()
YYB_PASS = os.getenv("YYB_PASS", "")
YYB_REF = os.getenv("YYB_REF", "").strip()
YYB_CLOUD_ENABLED = os.getenv("YYB_CLOUD_ENABLED", "").strip().lower() in (
    "1",
    "true",
    "yes",
)
TOKEN_CACHE_FILE = Path(
    os.getenv(
        "YYB_TOKEN_CACHE",
        str(Path(__file__).with_name(f"{Path(__file__).stem}_token_cache.json")),
    )
)

YYB_SESSION = requests.Session()
YYB_SESSION.trust_env = False  # YYB 固定不走环境代理。
BUSINESS_SESSION = requests.Session()
BUSINESS_SESSION.trust_env = False


def send_notification(title: str, content: str) -> None:
    """兼容青龙常见 notify.py；本地没有通知模块时静默跳过。"""
    try:
        from notify import send  # type: ignore

        send(title, content)
    except Exception:
        return


def require_yyb_config() -> None:
    missing = [
        name
        for name, value in (
            ("YYB_URL", YYB_URL),
            ("YYB_USER", YYB_USER),
            ("YYB_PASS", YYB_PASS),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(f"缺少青龙变量：{', '.join(missing)}")


def yyb_request(method: str, path: str, payload: dict[str, Any] | None = None) -> dict:
    require_yyb_config()
    try:
        response = YYB_SESSION.request(
            method,
            f"{YYB_URL}{path}",
            auth=(YYB_USER, YYB_PASS),
            headers={"Accept": "application/json"},
            json=payload,
            timeout=120,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"YYB 请求失败：{type(exc).__name__}") from None
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"YYB 请求失败：HTTP {response.status_code}")
    try:
        body = response.json()
    except ValueError:
        raise RuntimeError("YYB 返回了非 JSON 数据") from None
    if not isinstance(body, dict):
        raise RuntimeError("YYB 返回格式不正确")
    return body


def get_yyb_accounts() -> list[dict[str, Any]]:
    body = yyb_request("GET", "/accounts")
    if body.get("code") not in (0, 200):
        raise RuntimeError(f"YYB 获取账号失败：{body.get('msg') or '未知错误'}")
    accounts = body.get("data")
    if isinstance(accounts, dict):
        accounts = accounts.get("accounts") or accounts.get("list")
    if not isinstance(accounts, list):
        raise RuntimeError("YYB /accounts 返回格式不正确")
    result = [
        item
        for item in accounts
        if isinstance(item, dict) and item.get("id") is not None
    ]
    if YYB_REF:
        keys = ("id", "uin", "openid", "openId")
        result = [
            item
            for item in result
            if any(str(item.get(key, "")) == YYB_REF for key in keys)
        ]
        if not result:
            raise RuntimeError("YYB_REF 未匹配到任何账号")
    if not result:
        raise RuntimeError("YYB 中没有可用账号")
    return result


def get_yyb_code(account_id: Any, app_id: str) -> str:
    body = yyb_request(
        "POST", "/wxapp/getCode", {"app_id": app_id, "ref": str(account_id)}
    )
    if body.get("code") not in (0, 200):
        raise RuntimeError(f"YYB 获取 Code 失败：{body.get('msg') or '未知错误'}")
    code = ((body.get("data") or {}).get("result") or {}).get("code")
    if not code:
        raise RuntimeError("YYB 响应中没有微信 Code")
    return str(code)  # 一次性使用，不打印、不缓存。


def mask_identifier(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= 7:
        return f"{text[:1]}***{text[-1:]}"
    return f"{text[:3]}***{text[-4:]}"


def get_account_label(account: dict[str, Any]) -> str:
    name = str(
        account.get("alias")
        or account.get("nickname")
        or account.get("nickName")
        or ""
    )
    name = " ".join(name.replace("[", " ").replace("]", " ").split())[:24]
    stable_id = f"#{account['id']}"
    if name:
        return f"{name}·{stable_id}"
    masked = mask_identifier(
        account.get("uin") or account.get("openid") or account.get("openId")
    )
    return f"{masked or 'YYB账号'}·{stable_id}"


def read_token_cache() -> dict[str, Any]:
    try:
        body = json.loads(TOKEN_CACHE_FILE.read_text(encoding="utf-8"))
        return body if isinstance(body, dict) else {}
    except (OSError, ValueError):
        return {}


def write_token_cache(cache: dict[str, Any]) -> None:
    try:
        TOKEN_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_file = TOKEN_CACHE_FILE.with_suffix(TOKEN_CACHE_FILE.suffix + ".tmp")
        temp_file.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(temp_file, TOKEN_CACHE_FILE)
        try:
            os.chmod(TOKEN_CACHE_FILE, 0o600)
        except OSError:
            pass
    except OSError as exc:
        raise RuntimeError(f"写入 token 缓存失败：{exc}") from None


def get_cached_token(account_id: Any) -> dict[str, Any] | None:
    value = read_token_cache().get(str(account_id))
    return value if isinstance(value, dict) else None


def save_cached_token(account_id: Any, token_data: dict[str, Any]) -> None:
    cache = read_token_cache()
    cache[str(account_id)] = token_data
    write_token_cache(cache)


def remove_cached_token(account_id: Any) -> None:
    cache = read_token_cache()
    if cache.pop(str(account_id), None) is not None:
        write_token_cache(cache)


def ensure_token(
    account_id: Any,
    app_id: str,
    is_token_valid: Callable[[dict[str, Any]], bool],
    login_with_code: Callable[[str], dict[str, Any]],
) -> dict[str, Any]:
    cached = get_cached_token(account_id)
    if cached and is_token_valid(cached):
        return cached
    remove_cached_token(account_id)
    code = get_yyb_code(account_id, app_id)
    token_data = login_with_code(code)
    if not token_data:
        raise RuntimeError("登录失败，未获得 token")
    save_cached_token(account_id, token_data)
    return token_data


def operate_wx_data(account_id: Any, app_id: str, payload: dict[str, Any]) -> dict:
    """云函数能力预留；本项目签到不需要，默认关闭。"""
    if not YYB_CLOUD_ENABLED:
        raise RuntimeError("云函数能力未启用（YYB_CLOUD_ENABLED）")
    return yyb_request(
        "POST",
        "/wxapp/operateWxData",
        {"ref": str(account_id), "app_id": app_id, "payload": payload},
    )


def compact_json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def build_hmac_headers(body_text: str) -> dict[str, str]:
    x_date = formatdate(usegmt=True)
    digest = "SHA-256=" + base64.b64encode(
        hashlib.sha256(body_text.encode("utf-8")).digest()
    ).decode("ascii")
    signing_text = f"x-date: {x_date}\ndigest: {digest}"
    signature = base64.b64encode(
        hmac.new(
            HMAC_SECRET.encode("utf-8"),
            signing_text.encode("utf-8"),
            hashlib.sha1,
        ).digest()
    ).decode("ascii")
    authorization = (
        f'hmac username="{HMAC_USER}", algorithm="hmac-sha1", '
        f'headers="x-date digest", signature="{signature}"'
    )
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-date": x_date,
        "Authorization": authorization,
        "Digest": digest,
    }


def business_post(
    path: str,
    data: dict[str, Any],
    session_data: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    body_text = compact_json(data)
    headers = build_hmac_headers(body_text)
    if session_data:
        headers["ArrowAuthorization"] = str(session_data.get("token") or "")
        headers["userId"] = str(session_data.get("user_id") or "")
    try:
        response = BUSINESS_SESSION.post(
            BASE_URL + path,
            data=body_text.encode("utf-8"),
            headers=headers,
            timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"业务请求失败：{type(exc).__name__}") from None
    try:
        payload = response.json()
    except ValueError:
        raise RuntimeError("业务接口返回了非 JSON 数据") from None
    if not isinstance(payload, dict):
        raise RuntimeError("业务接口返回格式不正确")
    return response.status_code, payload


def detail_body(user_id: Any) -> dict[str, Any]:
    return {
        "userId": str(user_id),
        "activityCode": ACTIVITY_CODE,
        "prePrizeIds": [],
    }


def is_explicit_auth_failure(http_status: int, payload: dict[str, Any]) -> bool:
    return http_status in (401, 403) or payload.get("status") in (401, 403) or payload.get(
        "code"
    ) in (401, 403)


def validate_cached_token(cached: dict[str, Any]) -> bool:
    token = cached.get("token")
    user_id = cached.get("user_id")
    if not token or not user_id:
        return False
    http_status, payload = business_post(DETAIL_PATH, detail_body(user_id), cached)
    if is_explicit_auth_failure(http_status, payload):
        return False
    if http_status == 200 and payload.get("code") == 200:
        return True
    raise RuntimeError(
        f"token 验证接口异常：HTTP {http_status}, code={payload.get('code')}"
    )


def login_with_code(code: str) -> dict[str, Any]:
    http_status, payload = business_post(
        LOGIN_PATH,
        {"code": code, "registerSource": "", "activityCode": ACTIVITY_CODE},
    )
    if http_status != 200 or payload.get("code") != 200:
        raise RuntimeError(
            f"小程序登录失败：HTTP {http_status}, code={payload.get('code')}, "
            f"message={payload.get('message') or '未知错误'}"
        )
    entity = ((payload.get("data") or {}).get("entity") or {})
    token = entity.get("token")
    user_id = entity.get("id")
    if not token or not user_id:
        raise RuntimeError("小程序登录成功响应中缺少 token 或 userId")
    if str(user_id) == "-1" or not entity.get("uid"):
        raise RuntimeError("该微信账号尚未初始化活动，请先在微信中打开活动并完成必要授权")
    return {
        "token": str(token),
        "user_id": str(user_id),
        "uid": str(entity.get("uid") or ""),
        "identity": str(entity.get("identity") or ""),
    }


def get_sign_quest(payload: dict[str, Any]) -> dict[str, Any] | None:
    entity = ((payload.get("data") or {}).get("entity") or {})
    quests = entity.get("questList") or []
    if not isinstance(quests, list):
        return None
    return next(
        (
            item
            for item in quests
            if isinstance(item, dict)
            and (
                item.get("questCode") == "SIGN_IN"
                or item.get("templateCode") == "SIGN_IN"
            )
        ),
        None,
    )


def quest_finished(quest: dict[str, Any]) -> bool:
    completed = int(quest.get("completedCount") or 0)
    target = int(quest.get("targetCount") or 1)
    return bool(quest.get("isFinished")) or completed >= target


def fetch_detail(session_data: dict[str, Any]) -> dict[str, Any]:
    user_id = session_data["user_id"]
    http_status, payload = business_post(
        DETAIL_PATH, detail_body(user_id), session_data
    )
    if is_explicit_auth_failure(http_status, payload):
        raise RuntimeError("业务 token 已失效，请在下次运行时重新登录")
    if http_status != 200 or payload.get("code") != 200:
        raise RuntimeError(
            f"任务详情失败：HTTP {http_status}, code={payload.get('code')}"
        )
    return payload


def run_account(account: dict[str, Any]) -> str:
    label = get_account_label(account)
    token_data = ensure_token(
        account["id"], APP_ID, validate_cached_token, login_with_code
    )
    detail = fetch_detail(token_data)
    quest = get_sign_quest(detail)
    if not quest:
        raise RuntimeError("任务详情中没有 SIGN_IN")
    if quest_finished(quest):
        return f"{label}: 今日已签到"

    template_id = quest.get("templateId")
    if template_id is None:
        raise RuntimeError("SIGN_IN 任务缺少 templateId")
    user_id = token_data["user_id"]
    http_status, payload = business_post(
        SIGN_PATH,
        {
            "userId": str(user_id),
            "activityCode": ACTIVITY_CODE,
            "questTemplateId": str(template_id),
        },
        token_data,
    )
    if is_explicit_auth_failure(http_status, payload):
        remove_cached_token(account["id"])
        raise RuntimeError("签到时 token 失效；已清缓存，下次运行将重新取 code")
    if http_status != 200 or payload.get("code") != 200:
        raise RuntimeError(
            f"签到失败：HTTP {http_status}, code={payload.get('code')}, "
            f"message={payload.get('message') or '未知错误'}"
        )

    confirmed = get_sign_quest(fetch_detail(token_data))
    if not confirmed or not quest_finished(confirmed):
        raise RuntimeError("签到接口返回成功，但状态复查未确认完成")
    return f"{label}: 签到成功"


def main() -> int:
    try:
        require_yyb_config()
        accounts = get_yyb_accounts()
    except RuntimeError as exc:
        message = str(exc)
        print(message, file=sys.stderr)
        send_notification("环球影城签到配置错误", message)
        return 1

    print("模式: EXECUTE")
    print(f"小程序: {APP_ID}，YYB账号数: {len(accounts)}")
    results: list[str] = []
    failed = False
    for account in accounts:
        label = get_account_label(account)
        try:
            result = run_account(account)
        except Exception as exc:
            failed = True
            result = f"{label}: 失败 - {exc}"
        print(result)
        results.append(result)

    send_notification("环球影城签到", "\n".join(results))
    return 2 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
