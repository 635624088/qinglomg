#!/usr/env python3
from __future__ import annotations

import fcntl
import json
import os
import secrets
import string
import sys
import time
from typing import Any

import requests
import urllib3

urllib3.disable_warnings()

# ── 调试开关（硬编码） ──
DEBUG = False  # 改为 True 可输出详细日志

# ── 配置项 ──
APPID = "wxdb3c0e388702f785"
# YYB 代理地址（青龙容器内访问 pure 用 172.17.0.1:18080；外部/本机可用 http://YOUR_QL_HOST:18080）
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_AUTH = ("yyb", "yyb")  # YYB Basic auth
# 可选手动账号覆盖： 用 & 分隔的 openid 列表；留空则自动从 YYB 拉取 alive 账号
WXID_OVERRIDE = os.environ.get("WXID", "")
# 本地缓存文件路径
CACHE_FILE = os.path.join(os.path.dirname(__file__), ".wx_session_cache.json")
# 目标券ID（如不指定则自动领取第一个未领取的）
TARGET_COUPON_ID: int | None = None

# 接口超时
API_TIMEOUT = 15
CODE_API_TIMEOUT = 30

# ── 请求常量 ──
DOMAIN = "https://discount.wxpapp.wechatpay.cn"
PAGE = "pages/gift/index"
MODULE_NAME = "mmpaytxbbsmp"
PAGE_FRAME_VERSION = "180"
SESSION_SCENE = "daily_reward"
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; Mobile) "
    "AppleWebKit/537. 36 (KHTML, like Gecko) Version/4.0 "
    "Chrome/132.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.50 NetType/WIFI Language/zh_CN "
    "ABI/arm64 MiniProgramEnv/android"
)

# ── 推送模块 ──
try:
    from notify import send  # type: ignore
except ImportError:
    def send(title: str, content: str) -> None:
        print(f"[notify-fallback] {title}\n{content}")


class ClaimError(RuntimeError):
    pass


# ── 本地文件缓存工具（带文件锁） ──
def _read_cache() -> dict:
    """读取缓存文件，若文件不存在或损坏则返回空字典"""
    if not os.path.exists(CACHE_FILE):
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            except (IOError, OSError, AttributeError):
                pass
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, IOError):
        return {}

def _write_cache(data: dict) -> None:
    """写入缓存文件，使用独占锁"""
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (IOError, OSError, AttributeError):
            pass
        json.dump(data, f, indent=2, ensure_ascii=False)

def cache_get(key: str) -> str | None:
    """从本地缓存获取值，若不存在或出错返回 None"""
    data = _read_cache()
    return data.get(key)

def cache_set(key: str, value: str) -> bool:
    """写入本地缓存，成功返回 True"""
    data = _read_cache()
    data[key] = value
    _write_cache(data)
    return True

def cache_delete(key: str) -> bool:
    """从本地缓存删除键"""
    data = _read_cache()
    if key in data:
        del data[key]
        _write_cache(data)
    return True


# ── 账号来源： 从 YYB 拉取 alive 账号 ──
def fetch_accounts() -> list[str]:
    """从 YYB 代理拉取 alive 账号的 openid 列表（作为提现用的身份）"""
    try:
        resp = requests.get(
            f"{YYB_BASE_URL}/accounts", auth=YYB_AUTH, timeout=API_TIMEOUT, verify=False
        )
    except requests.RequestException as err:
        raise ClaimError(f"拉取 YYB 账号失败：{err}") from err
    if resp.status_code != 200:
        raise ClaimError(f"拉取 YYB 账号返回 HTTP {resp.status_code}：{resp.text}")
    try:
        payload = resp.json()
    except Exception as err:
        raise ClaimError(f"解析 YYB 账号响应失败：{err}，响应：{resp.text}")
    arr = payload.get("data") or []
    ids = [
        a["openid"]
        for a in arr
        if isinstance(a, dict) and a.get("status") == "alive" and a.get("openid")
    ]
    return ids


# ── Code 获取（YYB /wxapp/getCode，替代 WMPF） ──
def get_single_code(openid: str) -> str:
    """通过 YYB 代理的 /wxapp/getCode 获取登录 code（不再依赖 WMPF）"""
    url = f"{YYB_BASE_URL}/wxapp/getCode"
    payload = {"app_id": APPID, "ref": openid}
    try:
        resp = requests.post(
            url, json=payload, auth=YYB_AUTH, timeout=CODE_API_TIMEOUT, verify=False
        )
    except requests.RequestException as err:
        raise ClaimError(f"获取 code 请求失败：{err}") from err

    if resp.status_code != 200:
        raise ClaimError(f"获取 code 返回 HTTP {resp.status_code}：{resp.text}")

    try:
        data = resp.json()
    except Exception as err:
        raise ClaimError(f"解析 code 响应失败：{err}，响应内容：{resp.text}")

    if data.get("code") != 0:
        raise ClaimError(f"获取 code 返回错误：{data}")

    result = (data.get("data") or {}).get("result") or {}
    code = result.get("code")
    if not code:
        raise ClaimError(f"接口未返回 code：{data}")
    return code


# ── 获取 session_token（带缓存） ──
def get_session_token(session: requests.Session, openid: str, track_id: str) -> str:
    """获取 session_token，优先从本地缓存读取，失效则重新登录并缓存"""
    cache_key = f"wxid_{openid}_session_token"
    cached_token = cache_get(cache_key)

    if cached_token is not None:
        if DEBUG:
            print(f"[DEBUG] 使用缓存的 session_token 进行验证...")
        try:
            _ = query_coupons(session, cached_token, track_id)
            return cached_token
        except ClaimError as e:
            if DEBUG:
                print(f"[DEBUG] 缓存 session_token 失效：{e}，清除缓存并重新登录")
            cache_delete(cache_key)

    # 正常登录流程： 通过 YYB 获取 code -> 登录
    code = get_single_code(openid)
    data = api_get(
        session,
        "/txbbs-user/user/login",
        headers=make_headers(track_id, jscode=code),
    )
    token = data.get("session_token")
    if not isinstance(token, str) or not token:
        raise ClaimError(f"登录返回缺少 session_token：{data}")

    cache_set(cache_key, token)
    if DEBUG:
        print(f"[DEBUG] 已缓存新的 session_token")

    return token


# ── 业务函数 ──
def run_account(openid: str) -> dict[str, Any]:
    track_id = make_track_id()
    session = requests.Session()
    session.verify = False

    session_token = get_session_token(session, openid, track_id)
    coupons = query_coupons(session, session_token, track_id)

    # 选择可领取的优惠券
    coupon = select_coupon(coupons)

    if coupon is None:
        claimed_coupon = next((item for item in coupons if item.get("is_claimed")), None)
        return {
            "status": "already_claimed" if claimed_coupon else "no_daily",
            "coupon": claimed_coupon,
        }

    if coupon.get("is_claimed"):
        status = "already_claimed"
    else:
        claim_coupon(session, session_token, track_id, coupon)
        status = "claimed"

    return {
        "status": status,
        "coupon": coupon,
    }


def query_coupons(session: requests.Session, session_token: str, track_id: str) -> list[dict[str, Any]]:
    data = api_get(
        session,
        "/txbbs-mall/coupon/querydailygiftcoupons",
        headers=make_headers(track_id, session_token=session_token),
    )
    items = data.get("coupon_items")
    if not isinstance(items, list):
        raise ClaimError(f"查询返回缺少 coupon_items：{data}")
    return [item for item in items if isinstance(item, dict)]


def select_coupon(coupons: list[dict[str, Any]]) -> dict[str, Any] | None:
    if TARGET_COUPON_ID is not None:
        return next((item for item in coupons if coupon_id(item) == TARGET_COUPON_ID), None)
    # 领取第一个未领取的
    return next((item for item in coupons if not item.get("is_claimed") and coupon_id(item)), None)


def claim_coupon(
    session: requests.Session,
    session_token: str,
    track_id: str,
    coupon: dict[str, Any],
) -> None:
    cid = coupon_id(coupon)
    gift_type = coupon.get("daily_gift_type")
    amount = coupon_face_value(coupon)

    if not isinstance(cid, int):
        raise ClaimError(f"券缺少 coupon_id：{coupon}")
    if not isinstance(gift_type, str) or not gift_type:
        raise ClaimError(f"券缺少 daily_gift_type：{coupon}")
    if not isinstance(amount, int):
        raise ClaimError(f"券缺少 face_value：{coupon}")

    api_post(
        session,
        "/txbbs-mall/coupon/claimdailygiftcoupon",
        headers=make_headers(
            track_id,
            session_token=session_token,
            session_id=make_session_id(),
        ),
        json={
            "daily_gift_type": gift_type,
            "coupon_id": cid,
            "expected_send_amount": amount,
        },
    )


# ── HTTP 请求封装 ──
def api_get(session: requests.Session, path: str, *, headers: dict[str, str]) -> dict[str, Any]:
    response = session.get(f"{DOMAIN}{path}", headers=headers, timeout=API_TIMEOUT)
    return unwrap_response(response, path)


def api_post(
    session: requests.Session,
    path: str,
    *,
    headers: dict[str, str],
    json: dict[str, Any],
) -> dict[str, Any]:
    response = session.post(f"{DOMAIN}{path}", headers=headers, json=json, timeout=API_TIMEOUT)
    return unwrap_response(response, path)


def unwrap_response(response: requests.Response, action: str) -> dict[str, Any]:
    try:
        response.raise_for_status()
        payload = response.json()
    except Exception as err:
        raise ClaimError(f"{action} 请求失败：{err}，响应：{response.text}") from err

    if not isinstance(payload, dict):
        raise ClaimError(f"{action} 返回格式异常：{payload!r}")
    if payload.get("errcode") != 0:
        raise ClaimError(f"{action} 返回失败：errcode={payload.get('errcode')}，{payload}")

    data = payload.get("data")
    return data if isinstance(data, dict) else {}


# ── 辅助函数 ──
def make_headers(
    track_id: str,
    *,
    jscode: str | None = None,
    session_token: str | None = None,
    session_id: str | None = None,
) -> dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "X-Page": PAGE,
        "X-Track-Id": track_id,
        "xweb_xhr": "1",
        "X-Module-Name": MODULE_NAME,
        "X-Appid": APPID,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": f"https://servicewechat.com/{APPID}/{PAGE_FRAME_VERSION}/page-frame.html",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if jscode:
        headers["jscode"] = jscode
    if session_token:
        headers["session-token"]  = session_token
    if session_id:
        headers["session-id"] = session_id
    return headers


def make_track_id() -> str:
    return "T" + "".join(secrets.choice("0123456789ABCDEF") for _ in range(31))


def make_session_id() -> str:
    alphabet = string.ascii_lowercase + string.digits
    random_part = "".join(secrets.choice(alphabet) for _ in range(10))
    return f"{SESSION_SCENE}-{int(time.time() * 1000)}-{random_part}"


def coupon_info(coupon: dict[str, Any]) -> dict[str, Any]:
    value = coupon.get("coupon_info")
    return value if isinstance(value, dict) else {}


def coupon_id(coupon: dict[str, Any]) -> int | None:
    value = coupon_info(coupon).get("coupon_id")
    return value if isinstance(value, int) else None


def coupon_face_value(coupon: dict[str, Any]) -> int | None:
    value = coupon_info(coupon).get("face_value")
    return value if isinstance(value, int) else None


def coupon_name(coupon: dict[str, Any]) -> str:
    name = coupon_info(coupon).get("name")
    if isinstance(name, str) and name:
        return name
    return f"coupon_id={coupon_id(coupon)}"


def coupon_amount(coupon: dict[str, Any]) -> str:
    amount = coupon_face_value(coupon)
    if not isinstance(amount, int):
        return "未知额度"
    return f"{amount // 100}元" if amount % 100 == 0 else f"{amount / 100:.2f}元"


def mask_openid(openid: str) -> str:
    return openid if len(openid) <= 12 else f"{openid[:6]}...{openid[-4:]}"


# ── 主函数 ──
def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    start_time = time.strftime('%Y-%m-%d %H:%M:%S')
    if DEBUG:
        print(f"[DEBUG] 开始执行... {start_time}")

    # 解析账号列表： 优先手动覆盖，否则自动从 YYB 拉 alive 账号
    if WXID_OVERRIDE:
        openids = [item.strip() for item in WXID_OVERRIDE.split("&") if item.strip()]
        print(f"[账号] 使用手动覆盖的 {len(openids)} 个账号")
    else:
        try:
            openids = fetch_accounts()
            print(f"[账号] 从 YYB 自动拉取，共 {len(openids)} 个 alive 账号")
        except ClaimError as e:
            msg = f"错误：拉取 YYB 账号失败：{e}"
            print(msg)
            send("领券失败", msg)
            return 1

    if not openids:
        msg = "错误：未获取到任何 alive 账号（YYB 返回空或全为非 alive）"
        print(msg)
        send("领券失败", msg)
        return 1

    results: list[dict[str, Any]] = []
    for idx, openid in enumerate(openids, start=1):
        prefix = f"🌸 账号[{idx}]"
        try:
            result = run_account(openid)
            print_success(prefix, openid, result)
            results.append({"openid": openid, "success": True, **result})
        except Exception as err:
            err_msg = str(err)
            print(f"{prefix} ❌ 处理失败（{mask_openid(openid)}）")
            print(f"{prefix} 错误：{err_msg}")
            results.append({"openid": openid, "success": False, "error": err_msg})

    end_time = time.strftime('%Y-%m-%d %H:%M:%S')
    cost = int(time.time() - time.mktime(time.strptime(start_time, "%Y-%m-%d %H:%M:%S")))
    if DEBUG:
        print(f"[DEBUG] 执行结束... {end_time} 耗时 {cost} 秒")

    # 汇总推送
    total = len(openids)
    ok = sum(1 for r in results if r.get("success"))
    lines = [
        f"执行时间：{start_time} ～ {end_time}（耗时 {cost} 秒）",
        f"账号总数：{total}，成功：{ok}，失败：{total - ok}",
        "=" * 30,
    ]
    for r in results:
        if r.get("success"):
            coupon = r.get("coupon")
            status = r.get("status")
            if status == "claimed":
                lines.append(f"✅ {mask_openid(r['openid'])}：领取成功（{coupon_name(coupon)} {coupon_amount(coupon)}）")
            elif status == "already_claimed":
                lines.append(f"ℹ️ {mask_openid(r['openid'])}：今日已领取（{coupon_name(coupon)} {coupon_amount(coupon)}）")
            else:
                lines.append(f"ℹ️ {mask_openid(r['openid'])}：无可用优惠券")
        else:
            lines.append(f"❌ {mask_openid(r['openid'])}：失败（{r.get('error', '未知错误')}）")

    content = "\n".join(lines)
    send("微信支付优惠券领取汇总", content)

    return 0 if ok == total else 1


def print_success(prefix: str, openid: str, result: dict[str, Any]) -> None:
    print(f"{prefix} ✅ 登录成功（{mask_openid(openid)}）")
    coupon = result.get("coupon")
    if not isinstance(coupon, dict):
        print(f"{prefix} 未查询到每日额度")
        return

    name = coupon_name(coupon)
    amount = coupon_amount(coupon)
    status = result.get("status")

    if status == "claimed":
        print(f"{prefix} ✅ 领取成功：{name}")
        print(f"{prefix} 到账额度：{amount}")
    elif status == "already_claimed":
        print(f"{prefix} 今日已领取：{name}")
        print(f"{prefix} 当前额度：{amount}")
    else:
        print(f"{prefix} 未查询到每日额度")


if __name__ == "__main__":
    raise SystemExit(main())
