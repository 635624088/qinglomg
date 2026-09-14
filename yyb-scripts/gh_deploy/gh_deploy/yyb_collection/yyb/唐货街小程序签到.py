#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 依赖:
#  #小程序://唐货街/pua6eRzvwHTJQAp


import base64
import json
import os
import random
import re
import string
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
import urllib3

try:
    from Crypto.Cipher import AES
except Exception:
    AES = None

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
PAGE_API_URL = f"{YYB_BASE_URL}/api/document/page_api.json"
APP_CODE_URL = f"{YYB_BASE_URL}/wxapp/getCode"
SESSION_ID_URL = f"{YYB_BASE_URL}/wxapp/getCode"
THJ_APPID = os.getenv("THJ_APPID", "wx7fc1c39c9cf402fd").strip()
THJ_HOST = os.getenv("THJ_HOST", "https://shop-api.erunli.com").strip()
THJ_API_ROOT = os.getenv("THJ_API_ROOT", "/gw-shop/app/v1/").strip()
THJ_ENTERPRISE_HASH = os.getenv("THJ_ENTERPRISE_HASH", "62adc7465f8b867192210cf7ac42779a").strip()

LOGIN_PATH = os.getenv("LOGIN_PATH", "user/login")
SIGN_PATH = os.getenv("SIGN_PATH", "points-paradise/sign")
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "15"))
DEBUG = os.getenv("A8_DEBUG", "0").strip().lower() in ("1", "true", "yes", "y")
VERIFY_SSL = os.getenv("VERIFY_SSL", "0").strip().lower() in ("1", "true", "yes", "y")

if not VERIFY_SSL:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

AES_KEY_B64 = "dGhqMTAyOEtFWTU4ODg4OA=="

# 获取账号昵称映射
def get_nickname_map():
    """从YYB协议获取openid到nickname的映射"""
    try:
        url = f"{YYB_BASE_URL}/accounts"
        resp = requests.get(url, timeout=10)
        data = resp.json()
        if data.get('code') == 0:
            accounts = data.get('data', [])
            return {acc.get('openid'): acc.get('nickname', acc.get('alias', '')) for acc in accounts}
    except Exception as e:
        print(f"获取账号映射失败: {e}")
    return {}

nickname_map = get_nickname_map()

def fetch_yyb_accounts() -> List[Dict[str, str]]:
    """直接从 YYB 协议获取所有账号"""
    try:
        url = f"{YYB_BASE_URL}/accounts"
        resp = requests.get(url, timeout=10)
        data = resp.json()
        if data.get('code') != 0:
            print(f"获取 YYB 账号列表失败: {data.get('msg', '未知错误')}")
            return []
        
        accounts = data.get('data', [])
        result = []
        for acc in accounts:
            openid = acc.get('openid', '')
            nickname = acc.get('nickname', '') or acc.get('alias', '')
            if openid:
                result.append({
                    "openid": openid,
                    "nickname": nickname or openid[:8],
                })
        return result
    except Exception as e:
        print(f"获取 YYB 账号列表异常: {e}")
        return []

def debug(msg: str) -> None:
    if DEBUG:
        print(f"[DEBUG] {msg}")

def shorten(v: Any, limit: int = 300) -> str:
    s = str(v)
    return s if len(s) <= limit else s[:limit] + "..."

def safe_json_loads(text: str) -> Any:
    if not isinstance(text, str):
        return text
    try:
        return json.loads(text)
    except Exception:
        pass
    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last != -1 and last > first:
        try:
            return json.loads(text[first : last + 1])
        except Exception:
            pass
    return text

def extract_first(payload: Any, keys: Tuple[str, ...]) -> Optional[Any]:
    if isinstance(payload, dict):
        for k in keys:
            val = payload.get(k)
            if val not in (None, "", 0, "0", [], {}):
                return val
        for val in payload.values():
            got = extract_first(val, keys)
            if got not in (None, "", 0, "0", [], {}):
                return got
    elif isinstance(payload, list):
        for item in payload:
            got = extract_first(item, keys)
            if got not in (None, "", 0, "0", [], {}):
                return got
    return None

def post_json(url: str, payload: Dict[str, Any]) -> Tuple[Optional[int], Any]:
    try:
        r = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
        try:
            data = r.json()
        except Exception:
            data = r.text
        return r.status_code, data
    except Exception as exc:
        return None, f"request failed: {exc}"

def pick_target_app_dir(base_dir: Path) -> Tuple[Optional[str], Optional[Path]]:
    candidates = []
    for p in base_dir.iterdir():
        if not p.is_dir() or not p.name.startswith("wx"):
            continue
        app_cfg = p / "app-config.json"
        if app_cfg.exists():
            candidates.append((p.name.split("_")[0], p, app_cfg))
    if not candidates:
        for p in base_dir.iterdir():
            if p.is_dir() and p.name.startswith("wx"):
                return p.name.split("_")[0], p
        return None, None
    appid, target, _ = sorted(candidates, key=lambda x: len(x[0]))[0]
    return appid, target

def load_business_config(app_dir: Path) -> Dict[str, str]:
    cfg = {
        "host": "",
        "apiRoot": "/",
        "enterpriseHash": "",
    }
    app_cfg = app_dir / "app-config.json"
    if app_cfg.exists():
        try:
            obj = json.loads(app_cfg.read_text(encoding="utf-8"))
            ext = obj.get("ext") or {}
            cfg["host"] = str(ext.get("host") or "")
            cfg["apiRoot"] = str(ext.get("apiRoot") or "/")
            cfg["enterpriseHash"] = str(ext.get("enterpriseHash") or "")
        except Exception:
            pass
    if not cfg["host"]:
        config_js = app_dir / "utils" / "noCommit" / "config.js"
        if config_js.exists():
            text = config_js.read_text(encoding="utf-8", errors="ignore")
            m_host = re.search(r'host:\s*"([^"]+)"', text)
            m_root = re.search(r'apiRoot:\s*"([^"]+)"', text)
            m_hash = re.search(r'enterpriseHash:\s*"([^"]+)"', text)
            if m_host:
                cfg["host"] = m_host.group(1)
            if m_root:
                cfg["apiRoot"] = m_root.group(1)
            if m_hash:
                cfg["enterpriseHash"] = m_hash.group(1)
    if not cfg["host"]:
        raise RuntimeError("未能从解包目录提取 host")
    if not cfg["apiRoot"].startswith("/"):
        cfg["apiRoot"] = "/" + cfg["apiRoot"]
    if not cfg["apiRoot"].endswith("/"):
        cfg["apiRoot"] += "/"

    # ??? app.js ???globalData.apiRoot = "/gw-shop" + apiRoot
    if not cfg["apiRoot"].startswith("/gw-shop/"):
        cfg["apiRoot"] = "/gw-shop" + cfg["apiRoot"]
    return cfg

def normalize_api_root(api_root: str) -> str:
    root = (api_root or "/gw-shop/app/v1/").strip()
    if not root.startswith("/"):
        root = "/" + root
    if not root.endswith("/"):
        root += "/"
    if not root.startswith("/gw-shop/"):
        root = "/gw-shop" + root
    return root

def resolve_app_and_business(base_dir: Path) -> Tuple[str, Dict[str, str], str]:
    appid, app_dir = pick_target_app_dir(base_dir)
    # 优先环境变量，兼容青龙纯脚本目录执行
    if THJ_HOST:
        cfg = {
            "host": THJ_HOST,
            "apiRoot": normalize_api_root(THJ_API_ROOT),
            "enterpriseHash": THJ_ENTERPRISE_HASH,
        }
        source = "env"
        return (THJ_APPID or appid or "wx7fc1c39c9cf402fd"), cfg, source

    # 次选解包目录
    if app_dir is not None and appid is not None:
        cfg = load_business_config(app_dir)
        return appid, cfg, f"dir:{app_dir.name}"

    # 最后兜底（尽量可运行）
    cfg = {
        "host": "https://shop-api.erunli.com",
        "apiRoot": "/gw-shop/app/v1/",
        "enterpriseHash": "62adc7465f8b867192210cf7ac42779a",
    }
    return (THJ_APPID or "wx7fc1c39c9cf402fd"), cfg, "fallback"

def rand_str(n: int) -> str:
    pool = string.ascii_letters + string.digits
    return "".join(random.choice(pool) for _ in range(n))

def aes_encrypt_headers(token: str = "") -> Dict[str, str]:
    if AES is None:
        raise RuntimeError("缺少 pycryptodome，请先安装: pip install pycryptodome")

    random5 = rand_str(5)
    random15 = rand_str(15)
    random16 = rand_str(16)
    ts10 = list(str(int(__import__("time").time())))
    b64_random16 = base64.b64encode(random16.encode()).decode()
    random16_result = random15 + b64_random16 + random5
    insert_pos = [2, 6, 9, 11, 14, 16, 19, 23, 27, 29]
    for i, pos in enumerate(insert_pos):
        random16_result = random16_result[:pos] + ts10[i] + random16_result[pos:]

    payload = json.dumps({
        "request_encrypt_data": "REQUEST_encrypt_DATA_1028_888888",
        "token": token or "",
    }, ensure_ascii=False)

    key = base64.b64decode(AES_KEY_B64)
    iv = base64.b64decode(base64.b64encode(random16.encode()))
    pad = 16 - (len(payload.encode("utf-8")) % 16)
    raw = payload.encode("utf-8") + bytes([pad] * pad)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    encrypted = base64.b64encode(cipher.encrypt(raw)).decode()

    return {
        "bl-input-random-string": random16_result,
        "bl-input-string": encrypted,
    }

def aes_decrypt_response(info_b64: str, random16_result: str) -> Any:
    if AES is None:
        raise RuntimeError("缺少 pycryptodome，请先安装: pip install pycryptodome")
    n = random16_result[15:]
    d = n[: len(n) - 5]
    s = base64.b64decode(d).decode("utf-8")
    iv = base64.b64decode(base64.b64encode(s.encode()))
    key = base64.b64decode(AES_KEY_B64)

    data = base64.b64decode(info_b64)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    dec = cipher.decrypt(data)
    pad = dec[-1]
    if 0 < pad <= 16:
        dec = dec[:-pad]
    plain = dec.decode("utf-8", errors="ignore").strip()
    return safe_json_loads(plain)

def parse_accounts() -> List[Dict[str, str]]:
    raw = os.getenv("thjwxid", "") or os.getenv("jyxe", "")
    out: List[Dict[str, str]] = []
    seen = set()
    for item in re.split(r"[&\r\n]+", raw):
        text = item.strip()
        if not text:
            continue
        if "#" in text:
            remark, wxid = text.split("#", 1)
            remark, wxid = remark.strip() or wxid.strip(), wxid.strip()
        else:
            remark, wxid = text, text
        if not wxid or wxid in seen:
            continue
        seen.add(wxid)
        out.append({"remark": remark, "wxid": wxid})
    return out

def fetch_code(wxid: str, appid: str) -> Tuple[bool, str]:
    """从YYB协议获取wxcode"""
    status, ret = post_json(APP_CODE_URL, {"ref": wxid, "app_id": appid})

    if status != 200:
        return False, f"get code failed: {status} | {shorten(ret)}"
    # YYB 响应结构: {"code": 0, "data": {"result": {"code": "xxx"}}}
    # 优先从 data.result.code 取，避免被顶层 code:0 干扰
    code = None
    if isinstance(ret, dict):
        data = ret.get('data', {})
        if isinstance(data, dict):
            result = data.get('result', {})
            if isinstance(result, dict):
                code = result.get('code')
    if not code:
        code = extract_first(ret, ("code", "Code", "result"))
    if not code:
        return False, f"get code empty: {shorten(ret)}"

    return True, str(code)

def fetch_sessionid(wxid: str, appid: str) -> Tuple[bool, str]:
    status, ret = post_json(SESSION_ID_URL, {"wxid": wxid, "appid": appid})
    if status != 200:
        return False, f"get sessionid failed: {status} | {shorten(ret)}"
    sid = extract_first(ret, ("sessionid", "sessionId", "token", "Token", "Sessionid", "SessionID"))
    if not sid:
        return False, f"get sessionid empty: {shorten(ret)}"
    return True, str(sid)

def user_login(host: str, api_root: str, enterprise_hash: str, code: str) -> Tuple[bool, Any, str]:
    url = f"{host}{api_root}{LOGIN_PATH}"
    ext_headers = aes_encrypt_headers("")
    headers = {
        "content-type": "application/json",
        "Accept": "application/json",
        "Enterprise-Hash": enterprise_hash,
        "App-Version": "V9.2.1",
        "Api-Version": "v1.0",
        "Trace-Id": "",
        "Trace-State": "0",
        "Token": "",
        **ext_headers,
    }
    try:
        r = requests.post(url, json={"code": code}, headers=headers, timeout=REQUEST_TIMEOUT, verify=VERIFY_SSL)
    except Exception as exc:
        return False, {"request_error": str(exc), "url": url}, ""
    payload = safe_json_loads(r.text) if r.text else {}

    if r.status_code != 200:
        return False, {"status": r.status_code, "body": payload}, ""
    if isinstance(payload, dict) and "info" in payload and "bl_input_random_string" in payload:
        try:
            payload = aes_decrypt_response(payload["info"], payload["bl_input_random_string"])
        except Exception as exc:
            return False, {"status": r.status_code, "decrypt_error": str(exc), "body": payload}, ""
    token = extract_first(payload, ("token", "Token")) or ""
    return bool(token), payload, str(token)

def sign_task(host: str, api_root: str, enterprise_hash: str, token: str) -> Tuple[bool, Any]:
    url = f"{host}{api_root}{SIGN_PATH}"
    ext_headers = aes_encrypt_headers(token)
    headers = {
        "content-type": "application/json",
        "Accept": "application/json",
        "Enterprise-Hash": enterprise_hash,
        "App-Version": "V9.2.1",
        "Api-Version": "v1.0",
        "Trace-Id": "",
        "Trace-State": "0",
        "Token": token.strip(),
        **ext_headers,
    }
    try:
        r = requests.post(url, json={}, headers=headers, timeout=REQUEST_TIMEOUT, verify=VERIFY_SSL)
    except Exception as exc:
        return False, {"request_error": str(exc), "url": url}
    payload = safe_json_loads(r.text) if r.text else {}
    if isinstance(payload, dict) and "info" in payload and "bl_input_random_string" in payload:
        try:
            payload = aes_decrypt_response(payload["info"], payload["bl_input_random_string"])
        except Exception as exc:
            return False, {"status": r.status_code, "decrypt_error": str(exc), "body": payload}
    code = int(payload.get("code", -1)) if isinstance(payload, dict) else -1
    ok = r.status_code == 200 and isinstance(payload, dict) and code in (200, 510102, 10002)
    return ok, payload

def main() -> None:
    base = Path(__file__).resolve().parent
    appid, cfg, cfg_source = resolve_app_and_business(base)

    accounts = fetch_yyb_accounts()
    if not accounts:
        print("获取 YYB 账号列表失败，请检查 YYB_BASE_URL 配置")
        raise SystemExit(1)

    print(f"唐货街签到 | 账号: {len(accounts)} | APPID: {appid} | 来源: YYB")

    ok_count = 0
    for idx, acc in enumerate(accounts, 1):
        openid = acc["openid"]
        nickname = acc["nickname"]
        tag = f"[{idx}/{len(accounts)}] {nickname}"

        sid_ok, sid_ret = fetch_sessionid(openid, appid)
        code_ok, code_ret = fetch_code(openid, appid)
        if not code_ok:
            print(f"{tag} | 失败 | code: {shorten(code_ret, 80)}")
            continue

        login_ok, login_payload, token = user_login(cfg["host"], cfg["apiRoot"], cfg["enterpriseHash"], code_ret)
        if not login_ok:
            print(f"{tag} | 失败 | login: {shorten(login_payload, 80)}")
            continue

        sign_ok, sign_payload = sign_task(cfg["host"], cfg["apiRoot"], cfg["enterpriseHash"], token)
        if sign_ok:
            ok_count += 1
            print(f"{tag} | 成功")
        else:
            print(f"{tag} | 失败 | sign: {shorten(sign_payload, 80)}")

    print(f"汇总: {ok_count}/{len(accounts)}")

if __name__ == "__main__":
    main()

