#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# ==========================================================
# 功能说明：code 换 token（含缓存与自动刷新）
# 机制：YYB GO 获取微信 code → wxMiniSilentLogin 换取 token → 缓存到本地 JSON；
#       下次运行先读取缓存 token，并调用积分接口验证是否仍有效；
#       有效则直接复用（无需再获取 code）；失效或过期则重新获取 code 自动刷新。
# ==========================================================


"""
君品荟小程序动态 code 版（YYB GO）

功能：
  1. YYB GO /wxapp/getCode 获取微信 code
  2. /api/v2/login/wxMiniSilentLogin 使用 code 换 token
  3. 每日签到
  4. 查询积分
  5. PushPlus 推送
  6. 品赞代理，业务请求优先代理，失败直连兜底

环境变量：
  YYB_URL            YYB 根地址，如 http://yyb-go:8000
  YYB_USER / YYB_PASS  YYB Basic 认证（可与网页账号相同；增强版协议接口常不校验，但仍须非空）
  YYB_REF            单个账号 ref（控制台 ID 或 OpenID）
  JPH_YYB_REFS / YYB_REFS  多账号，换行或逗号分隔（优先于 YYB_REF）
  JPH_APP_VERSION    小程序版本号，默认 1.7
  JPH_CHANNEL_CODE   签到渠道码，默认 xj_mall_wx_applet
  PLUSPLUS_TOKEN     PushPlus token，可选
  PROXY_API          品赞代理提取 API，可选
  PROXY_TYPE         http / socks5，默认 http
  OCR_SERVER         滑块缺口 OCR 服务，默认 http://ocr.fj.us.ci

依赖：
  pip install requests pycryptodome
  socks5 代理需：
  pip install requests[socks]
"""

import base64
import json
import os
import random
import sys
import time
import traceback
from datetime import datetime
from typing import Any, Dict, List, Tuple
from urllib.parse import quote

import requests

# 滑块验证码 pointJson 使用 AES-ECB 加密
try:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad as _aes_pad
    _HAS_CRYPTO = True
except Exception:
    _HAS_CRYPTO = False

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


APP_NAME = "君品荟小程序"
APPID = "wx8d41cdc44c8aeaab"

YYB_URL = os.getenv("YYB_URL", "").strip().rstrip("/")
YYB_USER = os.getenv("YYB_USER", "").strip()
YYB_PASS = os.getenv("YYB_PASS", "")


def parse_yyb_refs() -> List[str]:
    # YYB_AUTO_ACCOUNTS=1：自动从 YYB Go /accounts 拉取所有 alive 微信
    if os.getenv("YYB_AUTO_ACCOUNTS", "0") == "1":
        refs: List[str] = []
        try:
            resp = requests.get(f"{YYB_URL}/accounts", timeout=15)
            data = resp.json()
            accounts = data.get("data") or data.get("accounts") or []
            if isinstance(accounts, dict):
                accounts = accounts.get("list", [])
            for acc in accounts:
                if isinstance(acc, dict) and acc.get("status") == "alive":
                    ref = acc.get("openid") or acc.get("id")
                    if ref:
                        refs.append(str(ref))
            print(f"[自动账号] 获取到 {len(refs)} 个 alive 账号")
        except Exception as exc:
            print(f"[自动账号] 获取失败: {exc}")
        return refs
    raw = (
        os.getenv("JPH_YYB_REFS")
        or os.getenv("YYB_REFS")
        or os.getenv("YYB_REF")
        or ""
    ).strip()
    refs: List[str] = []
    for part in raw.replace(",", "\n").splitlines():
        item = part.strip()
        if item and not item.startswith("#"):
            refs.append(item)
    return refs


ACCOUNTS = parse_yyb_refs()

APP_VERSION = os.getenv("JPH_APP_VERSION", "1.7")
CHANNEL_CODE = os.getenv("JPH_CHANNEL_CODE", "xj_mall_wx_applet")
LOGIN_AUTH = os.getenv("JPH_LOGIN_AUTH", "Basic d2VjaGF0OndlY2hhdF9zZWNyZXQ=")

PLUSPLUS_TOKEN = os.getenv("PLUSPLUS_TOKEN", "")
PROXY_API = os.getenv("PROXY_API", "")
PROXY_TYPE = os.getenv("PROXY_TYPE", "http").lower()

PROXY_RETRY_TIMES = 3
PROXY_VALIDATE_URL = "http://httpbin.org/ip"
PROXY_FETCH_INTERVAL = 3
ENABLE_DIRECT_FALLBACK = True
REQUEST_TIMEOUT = 30

CODE_RETRY_TIMES = 10
CODE_RETRY_INTERVAL = 3

BASE_URL = "https://fm.exijiu.com"
LOGIN_URL = f"{BASE_URL}/api/v2/login/wxMiniSilentLogin"
SIGN_CHECK_URL = f"{BASE_URL}/api/customer/daily/checkTodaySignIn"
SIGN_URL = f"{BASE_URL}/api/customer/daily/fillSignIn"
POINTS_URL = f"{BASE_URL}/api/customer/accoutInter/token"
CAPTCHA_GET_URL = f"{BASE_URL}/api/captcha/get"
CAPTCHA_CHECK_URL = f"{BASE_URL}/api/captcha/check"

OCR_SERVER = (os.environ.get("OCR_SERVER") or "http://ocr.fj.us.ci").rstrip("/")

COOKIE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jph_cookie.json")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf2541923) XWEB/19823"
)


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def sleep(seconds: float) -> None:
    time.sleep(seconds)


def mask(value: Any) -> str:
    value = str(value or "")
    if len(value) <= 12:
        return value
    return f"{value[:6]}...{value[-6:]}"


def json_preview(data: Any, limit: int = 800) -> str:
    try:
        return json.dumps(data, ensure_ascii=False)[:limit]
    except Exception:
        return str(data)[:limit]


def safe_data(resp: Dict[str, Any]) -> Dict[str, Any]:
    """Safely extract 'data' from an API response, handling null/missing."""
    return resp.get("data") or {}


def log_title() -> None:
    print()
    print("╔" + "═" * 50 + "╗")
    print("║ 🍶 君品荟小程序动态 code 版                        ║")
    print(f"║ 🕒 启动时间: {now_text():<32}║")
    print(f"║ 🔢 账号数量: {len(ACCOUNTS):<34}║")
    print("╚" + "═" * 50 + "╝")


def log_account_header(index: int, total: int, ref: str) -> None:
    print()
    print("┌" + "─" * 50 + "┐")
    print(f"│ 🧩 账号 {index} / {total:<37}│")
    print(f"│ 🌍 YYB_REF {mask(ref):<37}│")
    print("└" + "─" * 50 + "┘")


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
        raise RuntimeError("缺少环境变量：" + ", ".join(missing))
    if not ACCOUNTS:
        raise RuntimeError("缺少 YYB_REF / YYB_REFS / JPH_YYB_REFS（填 YYB 控制台账号 ID 或 OpenID）")


def direct_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    return session


def parse_proxy_response(text: Any) -> Dict[str, Any] | None:
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)

    text = text.strip()
    if not text:
        return None

    try:
        data = json.loads(text)
        proxy_obj = None

        if isinstance(data.get("data"), list) and data["data"]:
            proxy_obj = data["data"][0]
        elif isinstance(data.get("data"), dict):
            proxy_obj = data["data"]
        elif data.get("ip") and data.get("port"):
            proxy_obj = data
        elif isinstance(data.get("result"), dict):
            proxy_obj = data["result"]

        if proxy_obj:
            host = proxy_obj.get("ip") or proxy_obj.get("host")
            port = proxy_obj.get("port")
            if host and port:
                return {
                    "host": str(host),
                    "port": int(port),
                    "username": proxy_obj.get("user") or proxy_obj.get("username") or "",
                    "password": proxy_obj.get("pass") or proxy_obj.get("password") or "",
                }
    except Exception:
        pass

    if ":" in text:
        parts = text.split(":")
        if len(parts) >= 2:
            return {
                "host": parts[0],
                "port": int(parts[1]),
                "username": parts[2] if len(parts) > 2 else "",
                "password": parts[3] if len(parts) > 3 else "",
            }

    return None


def build_proxy_dict(proxy_info: Dict[str, Any] | None) -> Dict[str, str] | None:
    if not proxy_info:
        return None

    host = proxy_info["host"]
    port = proxy_info["port"]
    username = proxy_info.get("username", "")
    password = proxy_info.get("password", "")

    auth = ""
    if username and password:
        auth = f"{quote(username)}:{quote(password)}@"

    scheme = "socks5" if PROXY_TYPE == "socks5" else "http"
    proxy_url = f"{scheme}://{auth}{host}:{port}"

    print(f"🛠️ [代理] 生成 {scheme.upper()} 代理 {host}:{port}")

    return {
        "http": proxy_url,
        "https": proxy_url,
    }


def validate_proxy(proxies: Dict[str, str] | None) -> Tuple[bool, str]:
    if not proxies:
        return False, ""

    try:
        response = requests.get(PROXY_VALIDATE_URL, proxies=proxies, timeout=15)
        if response.status_code == 200:
            try:
                ip = response.json().get("origin", "未知")
            except Exception:
                ip = "未知"
            print(f"✅ [代理] 验证通过，出口 IP: {ip}")
            return True, ip
    except Exception as exc:
        print(f"⚠️ [代理] 验证失败: {exc}")

    return False, ""


def get_valid_proxy(account_name: str) -> Tuple[Dict[str, str] | None, str]:
    if not PROXY_API:
        print(f"⚠️ [代理] {account_name} 未配置 PROXY_API，使用直连")
        return None, ""

    print(f"🌐 [代理] {account_name} 正在获取品赞代理...")

    for index in range(1, PROXY_RETRY_TIMES + 1):
        try:
            response = direct_session().get(PROXY_API, timeout=15)
            proxy_info = parse_proxy_response(response.text)

            if not proxy_info:
                print(f"⚠️ [代理] 第 {index} 次代理解析失败")
                continue

            print(f"✅ [代理] 提取到 {proxy_info['host']}:{proxy_info['port']}")
            proxies = build_proxy_dict(proxy_info)

            ok, ip = validate_proxy(proxies)
            if ok:
                return proxies, ip

            print(f"⚠️ [代理] 第 {index} 次代理不可用")
        except Exception as exc:
            print(f"⚠️ [代理] 第 {index} 次获取代理异常: {exc}")

        if index < PROXY_RETRY_TIMES:
            sleep(2)

    print("⚠️ [代理] 获取失败，使用直连")
    return None, ""


def request_with_proxy(
    method: str,
    url: str,
    *,
    proxies: Dict[str, str] | None = None,
    server: str = "",
    **kwargs,
) -> requests.Response:
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)

    if proxies:
        try:
            return requests.request(method, url, proxies=proxies, **kwargs)
        except Exception as exc:
            print(f"⚠️ [代理] {server} 代理请求失败: {exc}")
            if not ENABLE_DIRECT_FALLBACK:
                raise
            print("🔁 [兜底] 切换直连重试")

    session = direct_session()
    return session.request(method, url, **kwargs)


def send_pushplus(title: str, content: str) -> None:
    if not PLUSPLUS_TOKEN:
        print("⚠️ [PushPlus] 未配置 PLUSPLUS_TOKEN，跳过推送")
        return

    try:
        requests.post(
            "https://www.pushplus.plus/send",
            json={
                "token": PLUSPLUS_TOKEN,
                "title": title,
                "content": content,
                "template": "txt",
            },
            timeout=10,
        )
        print("✅ [PushPlus] 推送成功")
    except Exception as exc:
        print(f"❌ [PushPlus] 推送失败: {exc}")


def get_code(ref: str) -> str | None:
    require_yyb_config()
    url = f"{YYB_URL}/wxapp/getCode"
    auth = base64.b64encode(f"{YYB_USER}:{YYB_PASS}".encode("utf-8")).decode("ascii")
    headers = {
        "Authorization": "Basic " + auth,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    payload = {"app_id": APPID, "ref": str(ref)}

    for attempt in range(1, CODE_RETRY_TIMES + 1):
        print(f"🔐 [授权] YYB getCode ref={mask(ref)}（第 {attempt}/{CODE_RETRY_TIMES} 次）")
        try:
            response = direct_session().post(
                url,
                headers=headers,
                json=payload,
                timeout=30,
            )
            raw = response.text or ""
            if "/login" in raw or raw.lstrip().lower().startswith("<"):
                print("❌ [授权] YYB 返回登录页；请确认 YYB_URL 指向协议服务且账号在线")
                return None

            data = response.json()
            code = None
            if isinstance(data, dict):
                if data.get("code") == 0:
                    code = ((data.get("data") or {}).get("result") or {}).get("code")
                if not code:
                    code = data.get("code") if isinstance(data.get("code"), str) else None
                result = data.get("result")
                if not code and isinstance(result, dict):
                    code = result.get("code")

            if isinstance(code, str) and code and code != "null":
                print("✅ [授权] code 获取成功")
                return code

            print(f"⚠️ [授权] code 无效: {json_preview(data, 200)}")
        except Exception as exc:
            print(f"❌ [授权] code 获取异常: {exc}")

        if attempt < CODE_RETRY_TIMES:
            sleep(CODE_RETRY_INTERVAL)

    print(f"❌ [授权] ref={mask(ref)} 多次获取 code 失败")
    return None


def login_headers() -> Dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "AppID": APPID,
        "Authorization": LOGIN_AUTH,
        "App-Version": APP_VERSION,
        "X-Access-Token": "",
        "Referer": f"https://servicewechat.com/{APPID}/",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    return headers


def common_headers(token: str | None = None) -> Dict[str, str]:
    headers = {
        "AppID": APPID,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Referer": f"https://servicewechat.com/{APPID}/",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if token:
        headers["X-Access-Token"] = token
    return headers


def extract_token(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None

    inner = data.get("data")
    candidates = [
        data.get("token"),
        data.get("accessToken"),
        data.get("access_token"),
        data.get("jwt"),
    ]

    if isinstance(inner, dict):
        candidates.extend([
            inner.get("token"),
            inner.get("accessToken"),
            inner.get("access_token"),
            inner.get("jwt"),
        ])

        user = inner.get("user")
        if isinstance(user, dict):
            candidates.extend([
                user.get("token"),
                user.get("accessToken"),
                user.get("access_token"),
                user.get("jwt"),
            ])

    for item in candidates:
        if item and item != "null":
            return str(item)

    return None


def login_by_code(
    server: str,
    code: str,
    proxies: Dict[str, str] | None,
) -> Tuple[str | None, Dict[str, Any] | None]:
    try:
        print("🔐 [登录] 使用 code 换 token")
        response = request_with_proxy(
            "POST",
            LOGIN_URL,
            headers=login_headers(),
            json={"code": code},
            proxies=proxies,
            server=server,
        )

        try:
            data = response.json()
        except Exception:
            data = {"raw": response.text[:800]}

        token = extract_token(data)
        if token:
            inner = data.get("data") or {}
            phone = inner.get("phone", "")
            openid = inner.get("openId", "")
            print(f"✅ [登录] token 获取成功: {mask(token)}")
            if phone:
                print(f"👤 [登录] 手机号: {phone}")
            if openid:
                print(f"🔑 [登录] openId: {mask(openid)}")
            return token, data

        print(f"❌ [登录] 未识别 token 字段: {json_preview(data)}")
        return None, data
    except Exception as exc:
        print(f"❌ [登录] 请求异常: {exc}")
        return None, None


def api_get(server: str, url: str, token: str, proxies: Dict[str, str] | None) -> Dict[str, Any]:
    response = request_with_proxy(
        "GET",
        url,
        headers=common_headers(token),
        proxies=proxies,
        server=server,
    )
    try:
        return response.json()
    except Exception:
        return {
            "code": -1,
            "msg": f"JSON解析失败: {response.text[:300]}",
        }


def api_post(server: str, url: str, token: str, proxies: Dict[str, str] | None, payload: Dict[str, Any]) -> Dict[str, Any]:
    response = request_with_proxy(
        "POST",
        url,
        headers=common_headers(token),
        json=payload,
        proxies=proxies,
        server=server,
    )
    try:
        return response.json()
    except Exception:
        return {
            "code": -1,
            "msg": f"JSON解析失败: {response.text[:300]}",
        }


def is_success(resp: Dict[str, Any]) -> bool:
    if not isinstance(resp, dict):
        return False
    if resp.get("success") is True:
        return True
    return str(resp.get("code", "")) in ("10000", "0", "200")


def query_points(server: str, token: str, proxies: Dict[str, str] | None) -> Dict[str, Any]:
    try:
        resp = api_post(server, POINTS_URL, token, proxies, {"checkLevelExist": True})
        if is_success(resp):
            data = safe_data(resp)
            return {
                "success": True,
                "points": data.get("points", "0"),
                "nickname": data.get("nickName", ""),
                "memberNo": data.get("memberNo", ""),
            }
        return {
            "success": False,
            "message": resp.get("message") or resp.get("msg") or json_preview(resp, 200),
        }
    except Exception as exc:
        return {"success": False, "message": f"网络错误: {exc}"}


def aes_ecb_encrypt(data: str, key: str) -> str:
    """AES-ECB-PKCS7 加密，返回 base64，用于滑块 pointJson。"""
    if not _HAS_CRYPTO:
        raise RuntimeError("未安装 pycryptodome，无法加密滑块 pointJson")
    cipher = AES.new(key.encode("utf-8"), AES.MODE_ECB)
    padded = _aes_pad(data.encode("utf-8"), AES.block_size)
    return base64.b64encode(cipher.encrypt(padded)).decode("utf-8")


def get_captcha(server: str, token: str, proxies: Dict[str, str] | None) -> Dict[str, Any]:
    """获取滑块验证码数据，失败返回空 dict。"""
    resp = api_post(server, CAPTCHA_GET_URL, token, proxies, {"captchaType": "blockPuzzle"})
    rep = (resp.get("data") or {}).get("repData") or {}
    if not (rep.get("token") and rep.get("secretKey") and rep.get("originalImageBase64") and rep.get("jigsawImageBase64")):
        return {}
    return rep


def ocr_slider_x(slider_b64: str, back_b64: str) -> int | None:
    """调用 OCR 服务识别滑块缺口 x 坐标。"""
    if not OCR_SERVER:
        return None
    try:
        resp = requests.post(
            f"{OCR_SERVER}/capcode",
            json={"slidingImage": slider_b64, "backImage": back_b64},
            headers={"Content-Type": "application/json"},
            timeout=25,
        )
        data = resp.json()
        x = data.get("result")
        return int(x) if x is not None else None
    except Exception:
        return None


def check_captcha(
    server: str,
    token: str,
    proxies: Dict[str, str] | None,
    captcha_data: Dict[str, Any],
    x: int,
) -> Tuple[bool, Dict[str, Any]]:
    """提交滑块坐标，返回是否通过。"""
    try:
        point_str = json.dumps({"x": x, "y": 5}, separators=(",", ":"))
        encrypted_point = aes_ecb_encrypt(point_str, captcha_data["secretKey"])
        resp = api_post(
            server,
            CAPTCHA_CHECK_URL,
            token,
            proxies,
            {
                "captchaType": "blockPuzzle",
                "token": captcha_data["token"],
                "pointJson": encrypted_point,
            },
        )
        rep = (resp.get("data") or {}).get("repData") or {}
        passed = bool(rep.get("result")) or bool((resp.get("data") or {}).get("success"))
        return passed, resp
    except Exception as exc:
        return False, {"message": str(exc)}


# ====================== Token缓存管理 ======================
def load_token_cache() -> Dict[str, Any]:
    try:
        if os.path.exists(COOKIE_FILE):
            with open(COOKIE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as exc:
        print(f"⚠️ [缓存] 读取失败: {exc}")
    return {}


def save_token_cache(cache: Dict[str, Any]) -> None:
    try:
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
        print("✅ [缓存] Token保存成功")
    except Exception as exc:
        print(f"❌ [缓存] 保存失败: {exc}")


def get_cached_token(server: str) -> str | None:
    cache = load_token_cache()
    data = cache.get(server)
    if data and data.get("token") and data.get("expireTime"):
        try:
            expire = datetime.fromisoformat(data["expireTime"]).timestamp() * 1000
            if time.time() * 1000 < expire - 3600 * 1000:
                print(f"✅ [缓存] 使用 {server} token")
                return data["token"]
        except Exception as exc:
            print(f"⚠️ [缓存] 过期时间解析异常: {exc}")
    return None


def set_cached_token(server: str, token: str, expire_time: str) -> None:
    cache = load_token_cache()
    cache[server] = {
        "token": token,
        "expireTime": expire_time,
        "updateTime": datetime.now().isoformat(),
    }
    save_token_cache(cache)


def login_with_cache(
    server: str,
    proxies: Dict[str, str] | None,
) -> Tuple[str | None, Dict[str, Any] | None, str | None]:
    """优先使用缓存 token（积分接口验证），失效自动 code 刷新"""
    cache_token = get_cached_token(server)
    if cache_token:
        print("🔍 [缓存] 验证 token")
        try:
            points = query_points(server, cache_token, proxies)
            if points.get("success"):
                print("✅ [缓存] token 有效")
                return cache_token, None, None
        except Exception as exc:
            print(f"⚠️ [缓存] 验证异常: {exc}")
        print("⚠️ [缓存] token 已失效，重新登录")

    code = get_code(server)
    if not code:
        return None, None, None

    token, raw_login = login_by_code(server, code, proxies)
    if not token:
        return None, raw_login, code

    expire_time = None
    if raw_login and isinstance(raw_login, dict):
        inner = raw_login.get("data")
        if isinstance(inner, dict):
            expire_time = inner.get("expireTime") or inner.get("expire_time")
            expires_in = inner.get("expiresIn")
            if not expire_time and isinstance(expires_in, (int, float)) and expires_in > 0:
                expire_time = datetime.fromtimestamp(time.time() + expires_in).isoformat()
    if not expire_time:
        expire_time = datetime.fromtimestamp(time.time() + 24 * 3600).isoformat()
    elif not isinstance(expire_time, str):
        expire_time = datetime.fromtimestamp(expire_time / 1000).isoformat()
    set_cached_token(server, token, expire_time)
    return token, raw_login, code


# ====================== 君品荟业务 ======================
def check_signed(server: str, token: str, proxies: Dict[str, str] | None) -> Tuple[bool | None, Dict[str, Any]]:
    resp = api_post(server, SIGN_CHECK_URL, token, proxies, {})
    if not is_success(resp):
        return None, resp
    return resp.get("data") is True, resp


def parse_sign_response(resp: Dict[str, Any]) -> Tuple[str, bool]:
    if not is_success(resp):
        msg = resp.get("message") or resp.get("msg") or json_preview(resp, 200)
        return f"签到失败: {msg}", False

    data = safe_data(resp)
    extra_map = data.get("extraMap") or {}
    result_type = data.get("resultType")
    cont_days = extra_map.get("continuousSignDays")
    point_value = data.get("pointValue")

    if result_type == 4:
        return "今日已签到（重复操作）", True

    msg = "签到成功"
    if cont_days is not None:
        msg += f"，连续签到 {cont_days} 天"
    if point_value is not None:
        msg += f"，获得 {point_value} 积分"
    return msg, True


def do_sign(
    server: str,
    token: str,
    proxies: Dict[str, str] | None,
    login_code: str | None,
) -> Tuple[str, bool]:
    sign_date = datetime.now().strftime("%Y-%m-%d")
    payload_base = {
        "channelCode": CHANNEL_CODE,
        "signInDate": sign_date,
    }

    candidates: List[Tuple[str, str]] = []
    new_code = get_code(server)
    if new_code:
        candidates.append(("新 code", new_code))
    if login_code and login_code != new_code:
        candidates.append(("登录 code", login_code))

    if not candidates:
        return "签到失败: 未获取到 code", False

    last_msg = "签到失败: 未知错误"
    captcha_data: Dict[str, Any] = {}
    for label, code in candidates:
        print(f"🔐 [签到] 使用{label}提交签到")
        payload = dict(payload_base)
        payload["code"] = code
        resp = api_post(server, SIGN_URL, token, proxies, payload)
        msg, ok = parse_sign_response(resp)
        last_msg = msg
        if ok:
            print(f"✅ [签到] {msg}")
            return msg, True

        print(f"⚠️ [签到] {msg}")
        if "验证码" not in msg and "校验" not in msg:
            if "code" not in msg.lower() and "用户信息不存在" not in msg:
                return msg, False
            continue

        print("🔐 [验证码] 获取滑块验证码")
        captcha_data = get_captcha(server, token, proxies)
        if not captcha_data:
            return "签到失败: 获取滑块验证码失败", False

        x = ocr_slider_x(
            captcha_data.get("jigsawImageBase64", ""),
            captcha_data.get("originalImageBase64", ""),
        )
        if x is None:
            return "签到失败: 滑块缺口识别失败", False
        print(f"🧩 [验证码] OCR缺口坐标 x={x}")

        passed, _ = check_captcha(server, token, proxies, captcha_data, x)
        if not passed:
            return "签到失败: 滑块验证未通过", False
        print("✅ [验证码] 滑块验证通过")

        retry_code = get_code(server) or code
        payload = dict(payload_base)
        payload["code"] = retry_code
        payload["captchaVerification"] = captcha_data["token"]
        payload["pointJson"] = aes_ecb_encrypt(
            json.dumps({"x": x, "y": 5}, separators=(",", ":")),
            captcha_data["secretKey"],
        )
        resp = api_post(server, SIGN_URL, token, proxies, payload)
        msg, ok = parse_sign_response(resp)
        if ok:
            print(f"✅ [签到] {msg}")
            return msg, True
        print(f"⚠️ [签到] {msg}")
        return msg, False

    return last_msg, False


def run_account(index: int, total: int, server: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "server": server,
        "success": False,
        "proxyStatus": "未使用代理",
        "proxyIp": "-",
        "token": "-",
        "user": "-",
        "points": "-",
        "signMsg": "-",
        "error": "",
    }

    log_account_header(index, total, server)

    proxies, proxy_ip = get_valid_proxy(server)
    result["proxyStatus"] = "使用专属代理" if proxies else "使用直连"
    result["proxyIp"] = proxy_ip or "-"

    sleep(PROXY_FETCH_INTERVAL)

    delay = random.randint(2, 6)
    print(f"⏳ [延迟] 启动延迟 {delay}s")
    sleep(delay)

    token, raw_login, login_code = login_with_cache(server, proxies)
    if not token:
        result["error"] = f"登录失败: {json_preview(raw_login)}"
        return result

    result["token"] = mask(token)

    try:
        before = query_points(server, token, proxies)
        before_points = before.get("points", "0") if before.get("success") else "0"
        if before.get("success"):
            nickname = before.get("nickname", "")
            if nickname:
                result["user"] = nickname
                print(f"👤 [用户] {nickname}")
            result["points"] = before_points
            print(f"💰 [积分] 签到前: {before_points}")
        else:
            print(f"⚠️ [积分] 查询失败: {before.get('message')}")

        signed, status_resp = check_signed(server, token, proxies)
        if signed is None:
            result["signMsg"] = (
                status_resp.get("message")
                or status_resp.get("msg")
                or json_preview(status_resp, 300)
            )
            print(f"⚠️ [签到] 状态查询失败: {result['signMsg']}")
            return result

        if signed:
            result["signMsg"] = "今日已签到"
            print(f"✅ [签到] {result['signMsg']}")
            result["success"] = True
        else:
            result["signMsg"], sign_ok = do_sign(server, token, proxies, login_code)
            if sign_ok:
                result["success"] = True

        after = query_points(server, token, proxies)
        if after.get("success"):
            after_points = after.get("points", "0")
            result["points"] = after_points
            try:
                diff = int(after_points) - int(before_points)
                diff_str = f"+{diff}" if diff > 0 else str(diff)
            except (TypeError, ValueError):
                diff_str = "-"
            print(f"💰 [积分] 签到后: {after_points} ({diff_str})")
        else:
            print(f"⚠️ [积分] 签到后查询失败: {after.get('message')}")

        return result
    except Exception as exc:
        result["error"] = traceback.format_exc().strip()
        print(f"❌ [账号] 执行失败: {exc}")
        return result


def build_notify(results: List[Dict[str, Any]]) -> str:
    success_count = sum(1 for item in results if item["success"])
    fail_count = len(results) - success_count

    content = f"""🍶 君品荟小程序动态 code 任务结果

━━━━━━━━━━━━━━━━━━━━
🏁 总结：{success_count} 成功 / {fail_count} 失败
🕒 时间：{now_text()}
━━━━━━━━━━━━━━━━━━━━
"""

    for idx, res in enumerate(results, 1):
        icon = "✅" if res["success"] else "❌"

        content += f"""
🧩 账号 {idx}
🌍 来源：{res["server"]}
🌐 代理：{res["proxyStatus"]}
📡 出口IP：{res["proxyIp"]}
🔐 Token：{res["token"]}
👤 用户：{res["user"]}
💰 积分：{res["points"]}
📝 签到：{res["signMsg"]}
{icon} 结果：{"成功" if res["success"] else "失败"}
"""

        if not res["success"]:
            content += f"❌ 原因：{res['error']}\n"

        content += "━━━━━━━━━━━━━━━━━━━━\n"

    return content


def main() -> None:
    try:
        require_yyb_config()
    except RuntimeError as exc:
        print(f"❌ [配置] {exc}")
        return

    log_title()
    print(f"🔗 [YYB] {YYB_URL}")

    results: List[Dict[str, Any]] = []

    for index, ref in enumerate(ACCOUNTS, 1):
        try:
            result = run_account(index, len(ACCOUNTS), ref)
            results.append(result)
        except Exception as exc:
            print(f"❌ [主程序] {mask(ref)} 执行异常: {exc}")
            results.append({
                "server": ref,
                "success": False,
                "proxyStatus": "-",
                "proxyIp": "-",
                "token": "-",
                "user": "-",
                "points": "-",
                "signMsg": "-",
                "error": traceback.format_exc().strip(),
            })

        if index < len(ACCOUNTS):
            print("⏳ [间隔] 等待 2s 后处理下一个账号")
            sleep(2)

    success_count = sum(1 for item in results if item["success"])
    fail_count = len(results) - success_count

    print()
    print("╔" + "═" * 50 + "╗")
    print("║ 🏁 君品荟任务执行完成                          ║")
    print(f"║ ✅ 成功: {success_count:<39}║")
    print(f"║ ❌ 失败: {fail_count:<39}║")
    print(f"║ 🕒 结束时间: {now_text():<32}║")
    print("╚" + "═" * 50 + "╝")

    send_pushplus("🍶 君品荟小程序动态 code 任务完成", build_notify(results))


if __name__ == "__main__":
    main()
