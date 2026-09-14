#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=============================================
宝妈上班（张团小程序22）自动赚取贡献值脚本  [支持自动续期]
=============================================
功能:
  1. 自动调用 wolf-order/createContribution 赚取积分 (250积分/次)
  2. 每天运行前自动检测 uniIdToken(JWT) 有效期
  3. 即将过期/已过期时, 通过 YYB_GO 取码服务自动续期:
       YYB_GO /wxapp/getCode -> 微信登录 code
       -> uni-id-co loginByWeixin -> 新 uniIdToken
  4. 续期后的新 token 写入本地缓存, 并可写回青龙环境变量

平台: 青龙面板 (Python3)
原理: 基于 UniCloud (DCloud) API 逆向, HMAC-MD5 签名 (已验证通过)

------------------------------------------------------------
环境变量 (青龙面板添加):
  必需:
    YYB_GO                - YYB_GO 取码服务 (格式 地址@微信账号标识, 可多行=多账号; 每个微信独立取码并自动续期 token)
  可选:
    WOLF_UID              - 你自己的用户ID [多账号可留空! 脚本登录后会自动从响应提取每个账号的 uid]
    WOLF_UNI_ID_TOKEN     - uniIdToken(JWT)  [首次运行填一个即可; 之后脚本自动续期, 可留空]
    WOLF_YYB_GO_ENTRY    - 指定只跑 YYB_GO 中某一行账号 (填完整行, 如 172.17.0.4:8000@xxx); 不填则自动遍历所有行 (多账号)
    WOLF_MAX_RUNS         - 每次运行最大调用次数 (默认 20)
    WOLF_QYWX_KEY         - 企业微信Webhook Key (运行结果通知, 可选)
    WOLF_APPID            - 目标小程序appid (默认 wxe6cb23a7f02277ed = 宝妈上班, 不变)
    WOLF_RENEW_HOURS      - 续期阈值(小时), token剩余低于此值即自动续期 (默认 12)
    QL_URL                - 青龙地址 (默认 http://127.0.0.1:5700, 脚本在青龙内运行可用)
    QL_CLIENT_ID          - 青龙应用ID (可选, 用于把新token写回青龙环境变量)
    QL_CLIENT_SECRET      - 青龙应用密钥 (可选)
  注意: SPACE_ID / CLIENT_SECRET / WX_APPID / UNI_APPID 是"宝妈上班"小程序专属,
        只要目标小程序不变就无需修改。
------------------------------------------------------------
说明:
  * accessToken(x-basement-token) 每次运行自动获取, 无需手动填写
  * clientSecret 已内置, 无需填写
  * 续期条件: token 剩余有效期 < WOLF_RENEW_HOURS (默认 12) 小时, 或 token 缺失/解析失败
  * 续期成功后写入脚本同目录 wolf_token_cache_{账号ref}.json (按账号隔离); 下次运行优先使用各账号缓存中最新且有效的 token
"""

import re

# === YYB_GO 统一通知注入 begin ===
import os as __os, sys as __sys, io as __io, atexit as __atexit, re as __re
_yyb_logs = []
class __LogHook(__io.TextIOBase):
    def __init__(self, s): self._s = s
    def write(self, s):
        if s and s != '\n': _yyb_logs.append(s.rstrip('\n'))
        self._s.write(s); return len(s)
    def flush(self): self._s.flush()
if not isinstance(__sys.stdout, __LogHook): __sys.stdout = __LogHook(__sys.stdout)
if not isinstance(__sys.stderr, __LogHook): __sys.stderr = __LogHook(__sys.stderr)

__pushed = False
def __push():
    global __pushed
    if __pushed: return
    try:
        body = '\n'.join(_yyb_logs[-40:])
        title = __os.path.basename(__sys.argv[0]) if __sys.argv else 'YYB_GO'
        sn = None
        try:
            from sendNotify import sendNotify as _sn
            sn = _sn
        except Exception:
            sn = None
        if sn and callable(sn):
            try: sn(title, body); return
            except Exception: pass
        key = __resolve_key()
        if key:
            import json as __json, urllib.request as __ur
            data = __json.dumps({'msgtype':'text','text':{'content':f'【{title}】\n{body}'}}).encode('utf-8')
            req = __ur.Request(f'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}', data=data, headers={'Content-Type':'application/json'})
            __ur.urlopen(req, timeout=15)
    except Exception:
        pass
    __pushed = True

def __resolve_key():
    k = __os.environ.get('WOLF_QYWX_KEY') or __os.environ.get('QYWX_KEY') or __os.environ.get('QYWX') or __os.environ.get('WEWORK_KEY')
    if k: return k
    for cand in ('sendNotify.js', '/ql/data/scripts/sendNotify.js'):
        try:
            t = open(cand, encoding='utf-8').read()
            m = __re.search(r"QYWX_KEY\s*=\s*'([^']+)'", t)
            if not m:
                m = __re.search(r'QYWX_KEY\s*=\s*"([^"]+)"', t)
            if m: return m.group(1)
        except Exception:
            pass
    return None

__orig_os_exit = __os._exit
def __patched_os_exit(code=0):
    global __pushed
    if __pushed:
        return __orig_os_exit(code)
    __pushed = True
    try: __push()
    except Exception: pass
    return __orig_os_exit(code)
try: __os._exit = __patched_os_exit
except Exception: pass

__atexit.register(__push)
# === YYB_GO 统一通知注入 end ===

import hmac
import hashlib
import json
import time
import random
import os
import sys
import base64
import requests

# ============ 常量配置 (已从wxapkg提取 / 已逆向验证) ============
SPACE_ID = "mp-50d375d9-5c5e-4271-8517-b09cb093334b"
CLIENT_SECRET = "Gf/DmFLzvUNIqaty2aIXEQ=="  # 从wxapkg提取, HMAC-MD5签名密钥
API_URL = "https://api.next.bspapp.com/client"
WX_APPID = "wxe6cb23a7f02277ed"
UNI_APPID = "__UNI__AE9315F"
APP_NAME = "张团--小程序22"

# ============ 从环境变量读取 ============
# 注意: 以下专属于使用者自己的配置, 不写默认值, 避免误用他人服务/账号
UID = os.environ.get("WOLF_UID", "")
UNI_ID_TOKEN = os.environ.get("WOLF_UNI_ID_TOKEN", "")
MAX_RUNS = int(os.environ.get("WOLF_MAX_RUNS", "20"))
RENEW_HOURS = float(os.environ.get("WOLF_RENEW_HOURS", "12"))

TARGET_APPID = os.environ.get("WOLF_APPID", "wxe6cb23a7f02277ed")

# 青龙写回 (可选)
QL_URL = os.environ.get("QL_URL", "http://127.0.0.1:5700")
QL_CLIENT_ID = os.environ.get("QL_CLIENT_ID", "")
QL_CLIENT_SECRET = os.environ.get("QL_CLIENT_SECRET", "")

# accessToken (运行时自动获取, 有效期10分钟)
_access_token = ""
_token_expire_time = 0

# token 缓存文件 (集中存放在脚本同目录下的专用文件夹, 不与脚本混放)
TOKEN_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wolf_token_caches")
CACHE_PATH = os.path.join(TOKEN_CACHE_DIR, "wolf_token_cache.json")


# ============ YYB_GO 取码服务 (地址@微信账号标识 多行) ============
YYB_GO_RAW = os.environ.get("YYB_GO", "")

def parse_yyb_go_entry(raw):
    value = (raw or "").strip()
    if not value:
        return None, None
    at = value.find("@")
    if at == -1:
        print(f"  [YYB_GO] 格式应为 地址@微信账号标识, 当前值: {value}")
        return None, None
    server = value[:at].strip()
    ref = value[at + 1:].strip()
    if server.startswith("http://"):
        server = server[7:]
    elif server.startswith("https://"):
        server = server[8:]
    server = server.rstrip("/")
    if not server or not ref:
        return None, None
    return server, ref

def get_yyb_go_code(entry):
    """通过 YYB_GO 服务获取指定账号的微信登录 code (entry 格式: 地址@微信账号标识)"""
    if not entry:
        return None
    server, ref = parse_yyb_go_entry(entry)
    if not server or not ref:
        print(f"  [YYB_GO] 无效 entry: {entry}")
        return None
    try:
        url = f"http://{server}/wxapp/getCode"
        r = requests.post(url, json={"ref": ref, "app_id": TARGET_APPID}, timeout=20).json()
        code = r.get("data", {}).get("result", {}).get("code")
        if r.get("code") != 0 or not code:
            print(f"  [YYB_GO] 取码失败 ({ref}): {json.dumps(r, ensure_ascii=False)[:200]}")
            return None
        print(f"  [YYB_GO] 取码成功 ({server})")
        return code
    except Exception as e:
        print(f"  [YYB_GO] 取码异常: {e}")
        return None


# ============ 签名算法 (HMAC-MD5, 已验证通过) ============
def generate_sign(body_data):
    sorted_keys = sorted(body_data.keys())
    parts = []
    for k in sorted_keys:
        v = str(body_data[k])
        if v:  # 跳过空值
            parts.append(f"{k}={v}")
    sign_string = "&".join(parts)
    return hmac.new(
        CLIENT_SECRET.encode("utf-8"),
        sign_string.encode("utf-8"),
        digestmod=hashlib.md5,
    ).hexdigest()


def _headers(extra=None):
    h = {
        "Content-Type": "application/json",
        "charset": "utf-8",
        "User-Agent": (
            "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro Build/SKQ1.211006.001; wv) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 "
            "Mobile Safari/537.36 MicroMessenger/8.0.71"
        ),
        "Referer": f"https://servicewechat.com/{WX_APPID}/3/page-frame.html",
    }
    if extra:
        h.update(extra)
    return h


def get_access_token():
    """调用 anonymousAuthorize 获取 accessToken (有效期600秒, 每次运行自动获取)"""
    global _access_token, _token_expire_time
    if _access_token and time.time() < _token_expire_time - 30:
        return _access_token
    timestamp = int(time.time() * 1000)
    body = {
        "method": "serverless.auth.user.anonymousAuthorize",
        "params": "{}",
        "spaceId": SPACE_ID,
        "timestamp": timestamp,
    }
    h = _headers({"x-serverless-sign": generate_sign(body)})
    try:
        resp = requests.post(API_URL, json=body, headers=h, timeout=30).json()
        if resp.get("success"):
            data = resp.get("data", {})
            _access_token = data.get("accessToken", "")
            _token_expire_time = time.time() + data.get("expiresInSecond", 600)
            return _access_token
        print(f"  [accessToken] 获取失败: {json.dumps(resp, ensure_ascii=False)[:200]}")
        return None
    except Exception as e:
        print(f"  [accessToken] 异常: {e}")
        return None


def build_client_info():
    return {
        "PLATFORM": "mp-weixin", "OS": "android", "APPID": UNI_APPID,
        "DEVICEID": str(random.randint(10**18, 10**19 - 1)), "scene": 1011,
        "appId": UNI_APPID, "appName": APP_NAME, "appVersion": "1.0.0",
        "appVersionCode": "100", "appLanguage": "zh-Hans", "hostVersion": "8.0.71",
        "hostName": "WeChat", "uniPlatform": "mp-weixin", "uniCompilerVersion": "5.07",
        "uniRuntimeVersion": "5.07", "deviceType": "phone", "deviceBrand": "redmi",
        "deviceModel": "Redmi K30 Pro", "osName": "android", "osVersion": "12",
        "locale": "zh-Hans", "LOCALE": "zh-Hans",
    }


def call_api(function_target, function_args, retry_on_token_expired=True):
    """调用 UniCloud 云函数 (自动注入 clientInfo/uniIdToken/accessToken/签名)"""
    token = get_access_token()
    if not token:
        return None
    args = json.loads(json.dumps(function_args))
    if "clientInfo" not in args:
        args["clientInfo"] = build_client_info()
    if "uniIdToken" not in args:
        args["uniIdToken"] = UNI_ID_TOKEN
    ts = int(time.time() * 1000)
    body = {
        "method": "serverless.function.runtime.invoke",
        "params": json.dumps({"functionTarget": function_target, "functionArgs": args},
                             ensure_ascii=False, separators=(",", ":")),
        "spaceId": SPACE_ID, "timestamp": ts, "token": token,
    }
    h = _headers({"x-basement-token": token, "x-serverless-sign": generate_sign(body)})
    try:
        resp = requests.post(API_URL, json=body, headers=h, timeout=30).json()
        if retry_on_token_expired and not resp.get("success"):
            err = resp.get("error", {})
            if err.get("code") == "GATEWAY_INVALID_TOKEN":
                print("  [call_api] accessToken 过期, 刷新重试...")
                global _access_token, _token_expire_time
                _access_token = ""; _token_expire_time = 0
                return call_api(function_target, function_args, retry_on_token_expired=False)
        return resp
    except Exception as e:
        print(f"  [call_api] 异常: {e}")
        return None


# ============ token 续期 ============
def jwt_remaining_hours(token):
    """返回 JWT 剩余有效小时数; 无法解析返回 None"""
    try:
        p = token.split(".")[1]
        p += "=" * (4 - len(p) % 4)
        payload = json.loads(base64.urlsafe_b64decode(p))
        exp = payload.get("exp", 0)
        return (exp - int(time.time())) / 3600
    except Exception:
        return None


def cache_path_for(entry):
    """按账号隔离 token 缓存: 用 entry 的 ref 部分生成独立缓存文件"""
    _, ref = parse_yyb_go_entry(entry)
    if not ref:
        ref = "default"
    safe = re.sub(r'[^A-Za-z0-9]', '_', ref)[:48]
    os.makedirs(TOKEN_CACHE_DIR, exist_ok=True)
    return os.path.join(TOKEN_CACHE_DIR, f"wolf_token_cache_{safe}.json")


def load_cache(path=None):
    try:
        p = path or CACHE_PATH
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return None


def save_cache(token, path=None):
    try:
        p = path or CACHE_PATH
        os.makedirs(os.path.dirname(p), exist_ok=True)
        rem = jwt_remaining_hours(token)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"token": token, "saved_at": int(time.time()),
                       "expired": int(time.time()) + (rem * 3600 if rem else 0)}, f, ensure_ascii=False, indent=2)
        print(f"  [cache] 已写入本地缓存, 有效期剩余约 {rem:.1f}h")
    except Exception as e:
        print(f"  [cache] 写入失败: {e}")


def fetch_wx_code(entry):
    """获取微信登录 code (仅通过 YYB_GO 取码服务)"""
    return get_yyb_go_code(entry)


def renew_token(entry):
    """完整续期: YYB_GO取码 -> uni-id-co loginByWeixin -> 新 uniIdToken"""
    if not entry:
        print("  [续期] 缺少 YYB_GO 账号配置 (entry 为空)")
        return None
    print("  [续期] 步骤1: 从 YYB_GO 获取微信登录 code ...")
    code = fetch_wx_code(entry)
    if not code:
        return None
    print(f"  [续期] 拿到 code: {code[:12]}...")

    print("  [续期] 步骤2: 匿名授权获取 accessToken ...")
    at = get_access_token()
    if not at:
        return None

    print("  [续期] 步骤3: loginByWeixin 换取新 uniIdToken ...")
    fa = {"method": "loginByWeixin", "params": [{"code": code}], "clientInfo": build_client_info()}
    ts = int(time.time() * 1000)
    body = {
        "method": "serverless.function.runtime.invoke",
        "params": json.dumps({"functionTarget": "uni-id-co", "functionArgs": fa},
                             ensure_ascii=False, separators=(",", ":")),
        "spaceId": SPACE_ID, "timestamp": ts, "token": at,
    }
    h = _headers({"x-basement-token": at, "x-serverless-sign": generate_sign(body)})
    try:
        resp = requests.post(API_URL, json=body, headers=h, timeout=30).json()
    except Exception as e:
        print(f"  [续期] loginByWeixin 异常: {e}")
        return None
    if not resp.get("success"):
        print(f"  [续期] loginByWeixin 失败: {json.dumps(resp, ensure_ascii=False)[:200]}")
        return None
    data = resp.get("data", {})
    new_token = data.get("newToken", {}).get("token") or data.get("token") or data.get("uniIdToken")
    if not new_token:
        print(f"  [续期] 响应中未找到 token: {json.dumps(resp, ensure_ascii=False)[:200]}")
        return None
    print("  [续期] 成功获取新 uniIdToken ✅")
    return new_token


def resolve_token(entry, allow_env=True):
    """
    解析指定账号应使用的 token (按账号隔离缓存):
      优先取 (env, 仅单账号) / 该账号缓存中剩余有效期最长且仍有效的一个。
      若最佳 token 剩余 < RENEW_HOURS 或不存在, 则触发续期。
    多账号模式必须 allow_env=False: 否则 WOLF_UNI_ID_TOKEN(某一个账号的身份)
    会被其它账号复用, 导致所有账号操作同一个 uid。
    返回 (token, source)
    """
    candidates = []
    env_tok = UNI_ID_TOKEN.strip()
    if allow_env and env_tok:
        candidates.append(("env", env_tok))
    cache = load_cache(cache_path_for(entry))
    if cache and cache.get("token"):
        candidates.append(("cache", cache["token"]))

    best, best_src, best_rem = None, None, -1
    for src, tok in candidates:
        rem = jwt_remaining_hours(tok)
        if rem is not None and rem > 0 and rem > best_rem:
            best, best_src, best_rem = tok, src, rem

    # 需要续期的情况
    if best is None or best_rem < RENEW_HOURS:
        reason = "无有效token" if best is None else f"剩余 {best_rem:.1f}h < {RENEW_HOURS}h"
        print(f"[token] 需要续期 ({reason})")
        new_tok = renew_token(entry)
        if new_tok:
            save_cache(new_tok, cache_path_for(entry))
            return new_tok, "renewed"
        # 续期失败, 退回已有最佳 token (若仍有用)
        if best:
            print(f"[token] 续期失败, 退回 {best_src} token (剩余 {best_rem:.1f}h)")
            return best, best_src
        return None, None

    print(f"[token] 使用 {best_src} token, 剩余约 {best_rem:.1f}h")
    return best, best_src


# ============ 青龙环境变量写回 (可选) ============
def update_qinglong_env(name, value):
    if not QL_CLIENT_ID or not QL_CLIENT_SECRET:
        return False
    try:
        # 1) 获取青龙 openapi token
        r = requests.get(f"{QL_URL}/open/auth/token",
                         params={"client_id": QL_CLIENT_ID, "client_secret": QL_CLIENT_SECRET},
                         timeout=15).json()
        if r.get("code") != 200:
            print(f"  [青龙] 获取token失败: {r.get('message')}")
            return False
        ql_token = r["data"]["token"]
        # 2) 查找环境变量
        r = requests.get(f"{QL_URL}/api/env",
                         params={"searchValue": name, "token": ql_token}, timeout=15).json()
        env_id = None
        if r.get("code") == 200:
            for item in r.get("data", {}).get("content", []):
                if item.get("name") == name:
                    env_id = item["id"]
                    break
        # 3) 更新或创建
        if env_id:
            body = [{"id": env_id, "name": name, "value": value, "remarks": "auto-renewed by wolf_bmbsh"}]
            r = requests.put(f"{QL_URL}/api/env", json=body,
                             params={"token": ql_token}, timeout=15).json()
        else:
            body = [{"name": name, "value": value, "remarks": "auto-renewed by wolf_bmbsh"}]
            r = requests.post(f"{QL_URL}/api/env", json=body,
                              params={"token": ql_token}, timeout=15).json()
        if r.get("code") == 200:
            print(f"  [青龙] 已更新环境变量 {name}")
            return True
        print(f"  [青龙] 更新环境变量失败: {r.get('message')}")
        return False
    except Exception as e:
        print(f"  [青龙] 写回异常: {e}")
        return False


# ============ 业务逻辑 ============
def create_contribution():
    return call_api("wolf-order", {"method": "createContribution", "params": [{"uid": UID}]})


def get_daily_count():
    now_ts = int(time.time() * 1000)
    beijing = (int(time.time()) + 8 * 3600) % 86400
    today_start_ms = (int(time.time()) - beijing) * 1000
    return call_api("DCloud-clientDB", {"command": {"$db": [
        {"$method": "collection", "$param": ["wolf-contribution"]},
        {"$method": "where", "$param": [f'uid=="{UID}" && create_time>{today_start_ms} && type==0']},
        {"$method": "count", "$param": []},
    ]}})


def get_user_info():
    return call_api("DCloud-clientDB", {"command": {"$db": [
        {"$method": "collection", "$param": ["uni-id-users"]},
        {"$method": "where", "$param": ["'_id' == $cloudEnv_uid"]},
        {"$method": "field", "$param": ["uid,_id,mobile,nickname,my_invite_code,money,score,level"]},
        {"$method": "get", "$param": []},
    ]}})


def extract_uid():
    """从当前登录账号的 uni-id-users 记录中提取该账号的 uid (用于区分多账号)"""
    ui = get_user_info()
    if ui and ui.get("success"):
        u = ui.get("data", {}).get("data", [])
        if u:
            u = u[0]
            uid = u.get("uid") or u.get("_id")
            if uid:
                return str(uid)
    return None


# 注: 通知已统一由文件顶部「YYB_GO 统一通知注入」块在退出时收集完整日志并推送,
#     任何退出路径 (成功/失败/零成功/异常) 都会发送, 无需此处单独 send_notify。


# ============ 主流程 ============
def run_account(entry, allow_env=True):
    """为单个 YYB_GO 账号执行完整流程, 返回汇总 dict"""
    server, ref = parse_yyb_go_entry(entry)
    if not server or not ref:
        print(f"\n  [账号] 跳过无效 entry: {entry}")
        return {"entry": entry, "ok": False, "reason": "无效 entry", "earned": 0, "success": 0}
    print(f"\n{'#'*60}\n# 账号: {server} @ {ref}\n{'#'*60}")

    # 1) token (按账号隔离; 多账号模式禁用 env 共享)
    print("\n[1/4] 解析并校验 uniIdToken ...")
    token, src = resolve_token(entry, allow_env=allow_env)
    if not token:
        print("  无法获取有效 token, 跳过该账号")
        return {"entry": entry, "ok": False, "reason": "no token", "earned": 0, "success": 0}
    global UNI_ID_TOKEN, UID
    UNI_ID_TOKEN = token  # 后续业务调用使用续期后的 token

    # 2) 提取本账号 uid
    print("\n[2/4] 获取本账号 uid ...")
    acc_uid = extract_uid()
    if not acc_uid:
        print("  无法获取该账号 uid, 跳过")
        return {"entry": entry, "ok": False, "reason": "no uid", "earned": 0, "success": 0}
    UID = acc_uid
    print(f"  本账号 uid: {acc_uid}")

    # 3) 查询今日状态
    print("\n[3/4] 查询今日状态 ...")
    dc = get_daily_count()
    if dc and dc.get("success"):
        print(f"  今日已领取次数: {dc.get('data', {}).get('total', '?')}")
    else:
        print(f"  查询失败: {json.dumps(dc, ensure_ascii=False)[:150] if dc else 'None'}")
    ui = get_user_info()
    if ui and ui.get("success"):
        u = ui.get("data", {}).get("data", [])
        if u:
            u = u[0]
            print(f"  昵称: {u.get('nickname')} | 积分: {u.get('score')} | 余额: {u.get('money')}")

    # 4) 自动赚取
    print(f"\n[4/4] 开始自动赚取 (最多 {MAX_RUNS} 次) ...")
    total_earned, success_count, consecutive_fail = 0, 0, 0
    for i in range(MAX_RUNS):
        print(f"\n  [{i+1}/{MAX_RUNS}] createContribution ...")
        res = create_contribution()
        if not res:
            consecutive_fail += 1
            print("  网络异常")
            if consecutive_fail >= 3:
                print("  连续3次失败, 终止"); break
            time.sleep(random.randint(10, 20)); continue
        if not res.get("success"):
            consecutive_fail += 1
            print(f"  API失败: {json.dumps(res, ensure_ascii=False)[:150]}")
            if consecutive_fail >= 3:
                print("  连续3次失败, 终止"); break
            time.sleep(random.randint(10, 20)); continue
        d = res.get("data", {})
        if d.get("errCode") == 0:
            inner = d.get("data", {})
            total_earned += inner.get("cons", 0)
            success_count += 1
            consecutive_fail = 0
            print(f"  发放成功! 贡献值: {inner.get('cons')}, 今日总次数: {inner.get('count')}")
        else:
            msg = d.get("errMsg", "未知")
            print(f"  失败 (errCode={d.get('errCode')}): {msg}")
            if any(kw in msg for kw in ["上限", "超过", "限制", "已达", "满了", "次数"]):
                print("  已达上限, 终止"); break
            consecutive_fail += 1
            if consecutive_fail >= 3:
                print("  连续3次业务失败, 终止"); break
        if i < MAX_RUNS - 1:
            delay = random.randint(30, 60)
            print(f"  等待 {delay}s ...")
            time.sleep(delay)

    print(f"\n  本账号完成: 成功 {success_count} 次, 贡献值 {total_earned}")
    return {"entry": entry, "ok": True, "src": src, "earned": total_earned, "success": success_count, "uid": acc_uid}


def main():
    print("=" * 50)
    print("  宝妈上班 自动赚取贡献值 (多账号版, 含自动续期)")
    print("=" * 50)

    if not YYB_GO_RAW:
        print("  缺少 YYB_GO 配置, 退出")
        sys.exit(1)

    entries = [e for e in YYB_GO_RAW.splitlines() if e.strip()]
    if not entries:
        print("  YYB_GO 为空, 退出")
        sys.exit(1)

    # 兼容: 指定 WOLF_YYB_GO_ENTRY 则只跑该行 (便于单独调试某个账号)
    sel = os.environ.get("WOLF_YYB_GO_ENTRY", "").strip()
    if sel:
        entries = [sel]
        print(f"  (已指定 WOLF_YYB_GO_ENTRY, 仅运行: {sel})")
    print(f"  共 {len(entries)} 个账号待运行\n")

    # 多账号模式必须禁用 env token 共享: 否则第2/3...个账号会复用 WOLF_UNI_ID_TOKEN
    # (第一个账号的身份), 导致所有账号都在操作同一个 uid。多账号下每个账号只用自己
    # 通过 YYB_GO 取码续期得到的隔离缓存 token。
    allow_env = (len(entries) == 1)
    if not allow_env and UNI_ID_TOKEN.strip():
        print("  [多账号] 已禁用 WOLF_UNI_ID_TOKEN 共享, 每个账号将各自通过 YYB_GO 取码续期\n")

    results = []
    for idx, entry in enumerate(entries, 1):
        print(f"\n\n========== 账号 {idx}/{len(entries)} ==========")
        results.append(run_account(entry, allow_env=allow_env))

    # 汇总
    print("\n\n" + "=" * 50)
    print("  全部账号运行完毕 - 汇总")
    print("=" * 50)
    tot_earned = sum(r.get("earned", 0) for r in results)
    tot_success = sum(r.get("success", 0) for r in results)
    for r in results:
        if r.get("ok"):
            print(f"  [OK] {r['entry']}  uid={r.get('uid')}  成功 {r['success']} 次, 贡献值 {r['earned']}")
        else:
            print(f"  [跳过] {r['entry']}  ({r.get('reason')})")
    print(f"\n  总计: 成功 {tot_success} 次, 贡献值 {tot_earned} (1积分=1元)")

    # 串号自检: 多账号却出现重复 uid, 说明仍有账号复用了同一 token
    uids = [r.get("uid") for r in results if r.get("uid")]
    if len(entries) > 1 and len(uids) != len(set(uids)):
        dup = [u for u in set(uids) if uids.count(u) > 1]
        print(f"\n  ⚠️ 检测到重复 uid {dup}: 仍有账号在共用同一身份 token, 请检查对应微信是否已在 YYB_GO 登录授权!")

    # 单账号模式下, 若续期成功则写回青龙环境变量 (多账号不写回, 避免覆盖)
    if len(results) == 1 and results[0].get("src") == "renewed":
        update_qinglong_env("WOLF_UNI_ID_TOKEN", UNI_ID_TOKEN)
    # 通知由顶部「YYB_GO 统一通知注入」块在退出时统一推送


if __name__ == "__main__":
    main()
