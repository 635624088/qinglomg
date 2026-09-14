#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
芙蓉王一物一码 · 青龙面板专用脚本 v3（全自动验证版）
================ 青龙环境变量（面板 → 环境变量）================
  FRW_TASKS       【链接+验证码清单】每行一条，格式：  链接|验证码
                  例：https://y2wm.cn/99.1000.1/AC1019...|670808
  FRW_CIPHER      survey 活动页地址栏 CipherParam= 后面那一长串（可长期复用）
  FRW_JWT         选填：已知 Bearer token
  FRW_ACTIVITY_ID 选填：默认 2096773585352835073
  FRW_CX_SEED     【全自动验证·必需】抓包里 cx.nise.cn 请求头 Seed 的值
  FRW_CX_TOKEN    【全自动验证·必需】抓包里 cx.nise.cn 请求头 Scanapi-Authorization 的值
                  （两者来自一次抓包即可，TokenExpire=0 长期有效，直到下次登录小程序被顶掉）
  PUSHPLUS_TOKEN  选填：填了才推送
  FRW_RESET       填 1 清空「已派发」记录（换一批码时用）
  FRW_CHECK_LINK  默认 1：验证前先用 y2wm 接口校验链接是否有效
  FRW_LAT/LNG     选填：校验用的经纬度
  FRW_CX_OFF      填 1 关闭全自动验证，退回「推送链接+验证码手动输入」模式
================ 工作流程 ==========================================
  1. 自动抽奖（有次数就抽完）
  2. 全自动验证：取清单第一条未消费的 链接|验证码
     → batch.search 查码（服务端返回 NeedVcode/ProductId/VerifyCount）
     → vcode.verify 提交 6 位验证码 → 次数计入你自己的微信账号
  3. 验证成功后重新查询统计，若凑满新抽奖机会立即再抽
  4. PushPlus 推送结果
  规则：每累计 6 次有效验证 = 1 次抽奖机会。
================ 实现说明 ==========================================
  cx.nise.cn 协议已逆向破解（AES-128-ECB + RSA-PKCS1v1.5，密钥均在客户端），
  本脚本内置零依赖纯 Python 实现（青龙容器无需 pip 装任何包）。
  协议细节见 协议破解报告.md / cx_client.py。
"""
import os
import sys
import json
import ssl
import time
import base64
import hashlib
import random
import socket
import re
import urllib.request
import urllib.parse
import urllib.error
# 青龙容器内 IPv6 解析失败会导致 getaddrinfo 整体报错，强制 IPv4。
_orig_getaddrinfo = socket.getaddrinfo
def _getaddrinfo_ipv4(host, port, family=0, *args):
    if family == 0:
        family = socket.AF_INET
    return _orig_getaddrinfo(host, port, family, *args)
socket.getaddrinfo = _getaddrinfo_ipv4
# ------------------------------------------------------------------ 配置
QL_DB = "/ql/data/db/database.sqlite"
def env_or_db(name, default=""):
    """环境变量优先；拿不到再直读青龙 Envs 表。"""
    v = os.environ.get(name, "").strip()
    if v:
        return v
    try:
        import sqlite3
        if os.path.exists(QL_DB):
            c = sqlite3.connect(QL_DB, timeout=10)
            row = c.execute("select value from Envs where name=?", (name,)).fetchone()
            c.close()
            if row and row[0]:
                return str(row[0]).strip()
    except Exception:
        pass
    return default
SURVEY_BASE    = os.environ.get("FRW_BASE", "https://survey.nise.cn")
ACTIVITY_ID    = os.environ.get("FRW_ACTIVITY_ID", "2096773585352835073")
CIPHER         = env_or_db("FRW_CIPHER")
JWT_TOKEN      = env_or_db("FRW_JWT")
PUSHPLUS_TOKEN = env_or_db("PUSHPLUS_TOKEN")
def db_first(name, default=''):
    # multiline values MUST be read from DB: task launcher truncates os.environ multiline vars (2026-09-12, 100 lines -> 19)
    try:
        import sqlite3 as _sq
        if os.path.exists(QL_DB):
            _c = _sq.connect(QL_DB, timeout=10)
            _row = _c.execute('select value from Envs where name=?', (name,)).fetchone()
            _c.close()
            if _row and _row[0] and str(_row[0]).strip():
                return str(_row[0])
    except Exception:
        pass
    return os.environ.get(name, default)

FRW_TASKS      = db_first("FRW_TASKS")
FRW_RESET      = os.environ.get("FRW_RESET", "").strip() == "1"
CHECK_LINK     = env_or_db("FRW_CHECK_LINK", "1").strip() != "0"
CX_DISABLED    = os.environ.get("FRW_CX_OFF", "").strip() == "1"
LAT            = os.environ.get("FRW_LAT", "31.3878").strip()
LNG            = os.environ.get("FRW_LNG", "118.3702").strip()
CX_SEED        = env_or_db("FRW_CX_SEED")
CX_TOKEN       = env_or_db("FRW_CX_TOKEN")

# ---- v5: 拆分模式 all|verify|draw ----
#   verify = 主验证（只验证码，不抽奖）  draw = 主抽奖（只把剩余机会抽完）
#   由 furongwang_verify.py / furongwang_lottery.py 入口脚本设置；直接跑本脚本默认 all
FRW_MODE = os.environ.get("FRW_MODE", "all").strip().lower() or "all"
# ---- v4: YYB 协议集成 + 多账号 ----
YYB_URL   = os.environ.get("FRW_YYB_URL", "http://YOUR_QL_HOST:18080").strip().rstrip("/")
YYB_USER  = env_or_db("FRW_YYB_USER") or "admin"
YYB_PASS  = env_or_db("FRW_YYB_PASS") or "YOUR_QL_PASSWORD"
CX_APPID  = os.environ.get("FRW_CX_APPID", "wx249c69bf104cd98f").strip()
# 多账号：昵称|YYB账号(ref/openid/序号)|手机号##昵称|ref|手机号...
CX_ACCOUNTS_RAW = env_or_db("FRW_CX_ACCOUNTS")
# 短信登录码：ref:6位码 或 6位码（单账号时）
SMS_CODE  = env_or_db("FRW_SMS_CODE")
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__)) or os.getcwd()
TOKEN_CACHE = os.path.join(SCRIPT_DIR, "furongwang_token.json")
STATE_FILE  = os.path.join(SCRIPT_DIR, "furongwang_state.json")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.78(0x18004e26) NetType/WIFI Language/zh_CN")
def log(m):
    print(m, flush=True)
# ================================================================== cx.nise.cn 零依赖加密
CX_BASE      = "https://cx.nise.cn/api/"
CX_SALT      = ".b9efa1acae9786016042c0c56934914226f29db6dadb8bbd8cd3802eba664ef7"
CX_VERSION   = "v2.8.16"
CX_KEY_TV    = "06b23e6ec5b2635b"     # Transfer-Voucher 静态密钥
CX_KEY_QR    = "cdfb525105705c75"     # Body Voucher (qrVoucher) 静态密钥
CX_RSA_N = int(
    "a4352fc17cf9abb59f117e98cf8301bc64f13379cfcb7c0261d63b035f95027f8"
    "1e899a45e002a33c76c37d508cd36104c332385a2738247093bdd274d9649e94e"
    "f9115498ffafc92b9d6ce952a287c4996cf9029a6dd192c7f9b5109c235357edb"
    "b9387028406af32b68e2187d9546fa8e74da43bd5a6f4b7c43ee586af89a7", 16)
CX_RSA_E = 65537
_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
def cx_rs(n):
    return ''.join(random.choice(_ALPHABET) for _ in range(n))
def cx_rk(n):
    return ''.join(random.choice("0123456789") for _ in range(n))
# ---- AES-128（纯 Python，S 盒运行时生成）----
def _gmul(a, b):
    r = 0
    for _ in range(8):
        if b & 1:
            r ^= a
        a = ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else (a << 1)
        b >>= 1
    return r
def _rotl8(x, n):
    return ((x << n) | (x >> (8 - n))) & 0xFF
_SBOX = None
def _sbox():
    global _SBOX
    if _SBOX is None:
        t = []
        for x in range(256):
            inv = 0
            if x:
                for y in range(1, 256):
                    if _gmul(x, y) == 1:
                        inv = y
                        break
            t.append(inv ^ _rotl8(inv, 1) ^ _rotl8(inv, 2)
                     ^ _rotl8(inv, 3) ^ _rotl8(inv, 4) ^ 0x63)
        _SBOX = t
    return _SBOX
_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]
def _expand_key(key16):
    s = _sbox()
    w = [list(key16[i*4:(i+1)*4]) for i in range(4)]
    for i in range(4, 44):
        t = list(w[i-1])
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [s[b] for b in t]
            t[0] ^= _RCON[i//4 - 1]
        w.append([w[i-4][j] ^ t[j] for j in range(4)])
    return w
def _add_rk(st, w, rnd):
    for c in range(4):
        for r in range(4):
            st[r][c] ^= w[rnd*4 + c][r]
def _sub(st):
    s = _sbox()
    for r in range(4):
        for c in range(4):
            st[r][c] = s[st[r][c]]
def _shift(st):
    for r in range(1, 4):
        st[r] = st[r][r:] + st[r][:r]
def _mix(st):
    for c in range(4):
        a = [st[r][c] for r in range(4)]
        st[0][c] = _gmul(a[0], 2) ^ _gmul(a[1], 3) ^ a[2] ^ a[3]
        st[1][c] = a[0] ^ _gmul(a[1], 2) ^ _gmul(a[2], 3) ^ a[3]
        st[2][c] = a[0] ^ a[1] ^ _gmul(a[2], 2) ^ _gmul(a[3], 3)
        st[3][c] = _gmul(a[0], 3) ^ a[1] ^ a[2] ^ _gmul(a[3], 2)
def aes_ecb_encrypt(key16, data):
    if len(key16) != 16 or len(data) % 16:
        raise ValueError("bad aes input")
    w = _expand_key(key16)
    out = bytearray()
    for off in range(0, len(data), 16):
        blk = data[off:off+16]
        st = [[blk[r + 4*c] for c in range(4)] for r in range(4)]
        _add_rk(st, w, 0)
        for rnd in range(1, 11):
            _sub(st)
            _shift(st)
            if rnd != 10:
                _mix(st)
            _add_rk(st, w, rnd)
        for c in range(4):
            for r in range(4):
                out.append(st[r][c])
    return bytes(out)
def pkcs7_pad(data):
    n = 16 - len(data) % 16
    return data + bytes([n]) * n
def rsa_pkcs1_encrypt(msg):
    ps_len = 128 - 3 - len(msg)
    if ps_len < 8:
        raise ValueError("rsa msg too long")
    ps = bytes(random.randrange(1, 256) for _ in range(ps_len))
    em = b"\x00\x02" + ps + b"\x00" + msg
    return pow(int.from_bytes(em, "big"), CX_RSA_E, CX_RSA_N).to_bytes(128, "big")
def cx_b64url(b):
    """gBase64.encodeURI() 实测 = 双重 base64：b64(b64(密文))"""
    inner = base64.b64encode(b).decode()
    return base64.b64encode(inner.encode()).decode()
def cx_voucher(key, sid):
    body = {"exp": int(time.time()*1000) + 120000, "uid": cx_rs(32),
            "ver": CX_VERSION, "sid": sid}
    plain = pkcs7_pad(json.dumps(body, separators=(',', ':')).encode())
    return cx_b64url(aes_ecb_encrypt(key.encode(), plain))
def cx_encrypt_payload(payload):
    key = cx_rk(16)
    body = dict(payload)
    for k in ("Data", "Signature", "Voucher"):
        body.pop(k, None)
    body["Ct"] = int(time.time() * 1000)
    plain = pkcs7_pad(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode())
    cipher = aes_ecb_encrypt(key.encode(), plain)
    rsa_json = json.dumps({"key": key, "iv": key}, separators=(',', ':')).encode()
    sig = rsa_pkcs1_encrypt(rsa_json)
    return cx_b64url(cipher), base64.b64encode(sig).decode()
def cx_post(path, payload, sid, token, timeout=30):
    ts = int(time.time() * 1000)
    nonce = cx_rs(12)
    h = {
        "Content-Type": "application/json",
        "App-Key": "VerifyMpClient",
        "Version": CX_VERSION,
        "Accept-Version": CX_VERSION,
        "Trace-Id": hashlib.md5(("%s-%s-%s-%s" % (sid, cx_rk(16), ts, cx_rk(16))).encode()).hexdigest(),
        "Sign": hashlib.md5(("vf?appId=cxverifyclient&nonce=%s&timestamp=%s%s"
                             % (nonce, ts, CX_SALT)).encode()).hexdigest(),
        "Nonce": nonce,
        "Timestamp": str(ts),
        "Seed": sid,
        "Scanapi-Authorization": token,
        "Transfer-Voucher": cx_voucher(CX_KEY_TV, sid),
        "User-Agent": UA,
    }
    dc, sig = cx_encrypt_payload(payload)
    body = {"Data": dc, "Signature": sig, "Voucher": cx_voucher(CX_KEY_QR, sid)}
    req = urllib.request.Request(CX_BASE + path, data=json.dumps(body).encode(),
                                 headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
def cx_scan_params(url):
    p = {"Host": "", "Code": "", "OriginCode": urllib.parse.unquote(url)}
    r = urllib.parse.unquote(url)
    m = re.match(r'(\w+)://([^/:]+)(:\d*)?', r)
    if m:
        p["Domain"] = m.group(0)
        p["Protocol"] = m.group(1)
        p["Host"] = m.group(2)
    m = re.match(r'(\w+)://([^/:]+)(:\d*)?/([a-zA-Z0-9.]+)?([^# ]*)', r)
    if m:
        p["ProductId"] = m.group(4) or ""
    m = re.match(r'(\w+)://([^/:]+)(:\d*)?/([a-zA-Z0-9.]+)?/([a-zA-Z0-9\_\-\$\!]+)?([^# ]*)', r)
    if m:
        p["Code"] = m.group(5) or ""
    return p
def cx_scan_payload(url, scan_type="99", vcode=""):
    sp = cx_scan_params(url)
    return {
        "ScanType": scan_type,
        "OriginCode": sp.get("OriginCode", url),
        "Code": sp.get("Code", ""),
        "ProductId": sp.get("ProductId", ""),
        "Latitude": "31.385586480035", "Longitude": "118.433150",
        "AreaCode": "340207", "CityCode": "340200", "ProvinceCode": "340000",
        "ProvinceName": "安徽省", "CityName": "芜湖市", "AreaName": "三山区",
        "Host": sp.get("Host", ""),
        "Domain": sp.get("Domain", ""),
        "Protocol": sp.get("Protocol", ""),
        "Vcode": vcode,
        # 2026-09-12 实测：vcode.verify 缺该字段会返回 Status=20「参数缺失请重试」
        # （小程序请求层 encryptRetain:!0 会把 EncryptRetain 塞进加密 payload）
        "EncryptRetain": True,
    }
def cx_verify_search(url, sid, token):
    """batch.search：查码。返回 dict（Data 有 NeedVcode/ProductId/VerifyCount/IsTrue）"""
    return cx_post("qrv2/verify/batch.search", cx_scan_payload(url), sid, token)
def cx_verify_vcode(url, code6, product_id, sid, token):
    """vcode.verify：提交 6 位验证码（会消耗一次验证！）"""
    payload = cx_scan_payload(url, vcode=code6)
    payload["ProductId"] = product_id
    return cx_post("qrv2/verify/vcode.verify", payload, sid, token)
# ------------------------------------------------------------------ YYB 协议（多账号 Seed/短信登录）
_YYB_COOKIE = {"v": ""}
def yyb_req(path, data=None, retry=True):
    """调用 YYB 控制台 API（自动登录；管理类接口需 cookie，wxapp 接口匿名可通）"""
    h = {"Content-Type": "application/json"}
    if _YYB_COOKIE["v"]:
        h["Cookie"] = _YYB_COOKIE["v"]
    req = urllib.request.Request(YYB_URL + path,
                                 data=json.dumps(data).encode() if data is not None else None,
                                 headers=h, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            sc = r.headers.get("Set-Cookie")
            if sc:
                _YYB_COOKIE["v"] = sc.split(";")[0]
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode("utf-8", "replace")
        if e.code in (401, 403) and retry:
            lr = urllib.request.Request(YYB_URL + "/login",
                data=json.dumps({"username": YYB_USER, "password": YYB_PASS}).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(lr, timeout=15) as r2:
                _YYB_COOKIE["v"] = (r2.headers.get("Set-Cookie") or "").split(";")[0]
            return yyb_req(path, data, retry=False)
        raise RuntimeError("YYB %s -> %s %s" % (path, e.code, body))
def yyb_get_code(ref):
    o = yyb_req("/wxapp/getCode", {"ref": str(ref), "app_id": CX_APPID})
    if o.get("code") != 0:
        raise RuntimeError("YYB getCode 失败: %s" % o.get("msg"))
    res = (o.get("data") or {}).get("result") or {}
    if res.get("errMsg") != "login:ok" or not res.get("code"):
        raise RuntimeError("YYB getCode 异常: %s" % res)
    return res["code"]
def cx_fetch_sess(code):
    """wx.login code -> (SessKey, NeedVerify)。SessKey 即 Seed 头，按微信账号固定"""
    o = cx_post("v3/third/wechat/fetch.sess.key", {"Code": code}, "", "")
    d = o.get("Data") or {}
    if o.get("Status") != 1 or not d.get("SessKey"):
        raise RuntimeError("fetch.sess.key 失败: %s %s" % (o.get("Status"), o.get("Msg")))
    return d["SessKey"], int(d.get("NeedVerify") or 0)
def yyb_seed(ref):
    """实时获取指定 YYB 账号的 Seed（稳定值，随取随用）"""
    return cx_fetch_sess(yyb_get_code(ref))[0]
def cx_send_sms(mobile, sid):
    """发送登录短信 -> Voucher（60s 内不可重发）"""
    return cx_post("v3/u/send.login.sms",
                   {"Mobile": mobile, "Event": "smsLogin", "SessKey": sid,
                    "Business": ""}, sid, "")
def cx_sms_login(mobile, smscode, voucher, sid):
    """短信验证码登录 -> Token（Voucher 来自 send.login.sms）"""
    payload = {"Duration": 0, "NeedVerify": 0, "Voucher": voucher or "",
               "Mobile": mobile, "SmsCode": smscode, "SessKey": sid,
               "ForceUpd": 0, "Event": "smsLogin", "CurrClauseVer": "v2.3.5",
               "AcceptClause": True}
    return cx_post("v3/u/sms.login", payload, sid, "")
def parse_accounts(raw):
    """昵称|ref|手机号[|CipherParam]##... -> [{name,ref,mobile,cipher}]"""
    out = []
    for part in re.split(r"##|\n", raw or ""):
        part = part.strip()
        if not part:
            continue
        cols = [c.strip() for c in part.split("|")]
        if len(cols) >= 3:
            out.append({"name": cols[0], "ref": cols[1],
                        "mobile": cols[2], "cipher": cols[3] if len(cols) > 3 else ""})
    return out
def parse_sms_codes(raw):
    """"ref:code##ref:code" 或单账号直接 6 位码"""
    out = {}
    for part in re.split(r"##|\n|;", raw or ""):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip()] = v.strip()
        else:
            out.setdefault("*", part)
    return out
def acct_token_ok(token):
    """用 member.counts 探测 token 是否有效（不消耗任何次数）"""
    try:
        o = cx_post("v3/u/fetch.member.counts", {}, "", token)
        return o.get("Status") == 1, o
    except Exception as e:
        return False, {"Msg": str(e)}
def ensure_acct_token(acct, st_acct, push_later):
    """确保账号 token 有效；失效时走短信登录（需 FRW_SMS_CODE）或发起发码。
    返回 (token 或 None, note)"""
    tok = st_acct.get("token") or ""
    if tok:
        ok, resp = acct_token_ok(tok)
        if ok:
            return tok, ""
        log("[账号 %s] token 失效，尝试短信续登" % acct["name"])
    # 回退：使用抓包更新的 FRW_CX_TOKEN（重新抓包后填该变量即可恢复全自动，无需短信）
    fb = env_or_db("FRW_CX_TOKEN")
    if fb and fb != tok:
        ok2, _ = acct_token_ok(fb)
        if ok2:
            st_acct["token"] = fb
            log("[账号 %s] 使用 FRW_CX_TOKEN 抓包 token（探测有效）" % acct["name"])
            return fb, ""
    if not acct.get("mobile"):
        return None, "❌ 未配置手机号，无法短信登录"
    # Seed 实时取
    try:
        sid = yyb_seed(acct["ref"])
        st_acct["seed"] = sid
    except Exception as e:
        return None, "❌ YYB 获取 Seed 失败：%s" % e
    # 有短信码？直接登录
    codes = parse_sms_codes(SMS_CODE)
    code6 = codes.get(acct["ref"]) or codes.get(acct["name"]) or codes.get("*") or ""
    voucher = st_acct.get("voucher") or ""
    if code6 and voucher:
        o = cx_sms_login(acct["mobile"], code6, voucher, sid)
        d = o.get("Data") or {}
        if o.get("Status") == 1 and d.get("Token"):
            st_acct["token"] = d["Token"]
            st_acct.pop("voucher", None)
            log("[账号 %s] 短信登录成功" % acct["name"])
            return d["Token"], "✅ 短信登录成功"
        return None, "❌ 短信登录失败（Status %s）：%s" % (o.get("Status"), o.get("Msg"))
    # 发送短信验证码（60s 冷却由服务端控制）
    last = int(st_acct.get("sms_ts", 0) or 0)
    if time.time() - last < 65:
        return None, "⏳ 验证码短信冷却中，稍后重试"
    o = cx_send_sms(acct["mobile"], sid)
    d = o.get("Data") or {}
    if o.get("Status") == 1 and d.get("Voucher"):
        st_acct["voucher"] = d["Voucher"]
        st_acct["sms_ts"] = int(time.time())
        note = ("📱 已向 %s 发送登录短信。请把 6 位短信码填入环境变量 FRW_SMS_CODE"
                "（格式 %s:验证码），再运行一次即自动登录。" % (acct["mobile"], acct["ref"]))
        log("[账号 %s] %s" % (acct["name"], note))
        push_later.append(note)
        return None, note
    return None, "❌ 发送短信失败（Status %s）：%s" % (o.get("Status"), o.get("Msg"))
# ------------------------------------------------------------------ HTTP（survey 侧）
def http(method, url, token=None, data=None, headers_extra=None, timeout=20):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if headers_extra:
        headers.update(headers_extra)
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            b = e.read().decode("utf-8", "replace")
        except Exception:
            b = ""
        return e.code, b, dict(e.headers)
    except Exception as e:
        return -1, str(e), {}
def jget(url, token):
    st, body, _ = http("GET", url, token)
    if st != 200:
        return None, "HTTP %s" % st
    try:
        return json.loads(body), None
    except Exception:
        return None, "非JSON: %s" % body[:120]
# ------------------------------------------------------------------ 缓存/状态
def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default
def save_json(path, obj):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log("[warn] 写 %s 失败: %s" % (path, e))
def token_is_valid(tok):
    if not tok:
        return False, None
    j, err = jget("%s/prod-api/wolf/userProductScanStat/queryDetailByUser?activityId=%s"
                  % (SURVEY_BASE, ACTIVITY_ID), tok)
    if err:
        return False, err
    if j.get("code") == 200:
        return True, j.get("data", {})
    return False, j.get("msg", "未知错误")
def token_from_cipher(cipher):
    url = ("%s/prod-api/api/wolf/wolfwx/getXcxToken?CipherParam=%s"
           % (SURVEY_BASE, urllib.parse.quote(cipher)))
    st, body, _ = http("GET", url)
    if st != 200:
        return None, None, "getXcxToken HTTP %s" % st
    try:
        j = json.loads(body)
    except Exception:
        return None, None, "getXcxToken 非JSON: %s" % body[:120]
    if j.get("code") != 200 or not (j.get("data") or {}).get("token"):
        return None, None, "getXcxToken 失败: %s" % (j.get("msg") or body[:150])
    return j["data"]["token"], j["data"], None
def query_status(token):
    """查询 survey 统计，返回 (done, need, remain) 或 None"""
    j, err = jget("%s/prod-api/wolf/userProductScanStat/queryDetailByUser?activityId=%s"
                  % (SURVEY_BASE, ACTIVITY_ID), token)
    if err:
        return None
    q = j.get("data", {})
    return (int(q.get("completedScanCnt", 0) or 0),
            int(q.get("requiredScanCnt", 6) or 6),
            int(q.get("remainLotterySize", 0) or 0))
def do_lottery(token):
    """把剩余抽奖机会抽完，返回中奖列表"""
    won = []
    while True:
        j2, e2 = jget("%s/prod-api/wolf/userProductScanStat/lottery?activityId=%s"
                      % (SURVEY_BASE, ACTIVITY_ID), token)
        if e2:
            log("[抽奖] 失败：%s" % e2)
            break
        if j2.get("code") == 200 and j2.get("data"):
            won.append(j2["data"])
            log("[抽奖] 中奖：%s" % j2["data"])
            time.sleep(1.2)
            continue
        if j2.get("msg"):
            log("[抽奖] %s" % j2.get("msg"))
        break
    return won
def do_lottery_retry(token):
    """draw 模式专用：繁忙/网络失败自动重试；单日抽奖机会用完立即结束，不死循环"""
    gap = int(env_or_db("FRW_LOTTERY_RETRY_GAP", "10") or 10)      # 每次失败后等待秒数
    max_r = int(env_or_db("FRW_LOTTERY_MAX_RETRY", "30") or 0)     # 连续失败上限，0=无限
    won = []
    n = 0
    fail_n = 0
    # 服务端提示"机会/次数已用完"类消息的关键字，命中即停止重试
    usedup_keys = ("用完", "上限", "不足", "暂无", "没有", "次数", "机会",
                   "再来", "明日", "明天", "已领", "已达", "超过")
    while True:
        n += 1
        j2, e2 = jget("%s/prod-api/wolf/userProductScanStat/lottery?activityId=%s"
                      % (SURVEY_BASE, ACTIVITY_ID), token)
        if e2:
            fail_n += 1
            if max_r and fail_n > max_r:
                log("[抽奖] 连续 %d 次失败，本次停止（剩余机会下次任务继续抽）" % max_r)
                break
            log("[抽奖] 网络失败（第 %d 次）：%s，%d 秒后重试" % (n, e2, gap))
            time.sleep(gap)
            continue
        if j2.get("code") == 200 and j2.get("data"):
            won.append(j2["data"])
            log("[抽奖] 中奖：%s" % j2["data"])
            fail_n = 0
            time.sleep(1.2)
            continue
        msg = j2.get("msg") or str(j2)[:120]
        # code==200 但无 data：服务端明确表示没有可抽机会
        if j2.get("code") == 200:
            log("[抽奖] 服务端返回无可抽机会（%s），单日抽奖结束，共尝试 %d 次" % (msg, n))
            break
        # token/登录失效：重试无意义，停止并提示
        if ("登录" in msg) or ("token" in msg.lower()) or ("授权" in msg):
            log("[抽奖] %s —— token 失效，停止重试，请更新凭据" % msg)
            break
        # 用完/次数上限类提示：今日抽奖结束，立即停止，不再重试
        if any(k in msg for k in usedup_keys):
            log("[抽奖] %s —— 单日抽奖机会已用完，结束（本次共尝试 %d 次，抽中 %d 次）"
                % (msg, n, len(won)))
            break
        # 其余视为繁忙/临时失败：有限重试
        fail_n += 1
        if max_r and fail_n > max_r:
            log("[抽奖] 连续 %d 次失败未成功（最后提示：%s），本次停止" % (max_r, msg))
            break
        log("[抽奖] 失败（第 %d 次）：%s，%d 秒后重试" % (n, msg, gap))
        time.sleep(gap)
    return won
# ------------------------------------------------------------------ 队列
def parse_tasks(raw):
    """链接|验证码[|账号昵称] -> [(link, code, acct_name_or_"")]"""
    out = []
    if not raw:
        return out
    for part in raw.replace("##", "\n").replace("，", ",").splitlines():
        p = part.strip()
        if not p:
            continue
        cols = p.split("|")
        link = cols[0].strip() if cols else ""
        code = cols[1].strip() if len(cols) > 1 else ""
        acct = cols[2].strip() if len(cols) > 2 else ""
        out.append((link, code, acct))
    return out
def check_link(link):
    """用 y2wm 明文接口校验链接，返回 (ok, 说明)"""
    if not link:
        return None, "无链接"
    st, body, _ = http("POST", "https://y2wm.cn/CigaretteQrcodeQuery/CodeQuery/scanCode/v1",
                       data={"qrcode": link, "clientInfo": UA.lower(),
                             "latitude": LAT, "longitude": LNG, "ip": ""},
                       headers_extra={"Content-Type": "application/json;charset=utf-8"},
                       timeout=15)
    if st != 200:
        return None, "校验失败 HTTP %s" % st
    try:
        j = json.loads(body)
    except Exception:
        return None, "校验返回非JSON"
    d = j.get("data") or {}
    msg = d.get("message") or d.get("errorMessage") or ""
    if not d.get("codeCheck"):
        return False, "链接无效：%s" % (msg or "未知")
    meta = (d.get("codeData") or {}).get("meta") or {}
    name = meta.get("spuName") or ""
    return True, "有效 · %s" % name if name else "有效"
# ------------------------------------------------------------------ 推送
def pushplus(title, content):
    if not PUSHPLUS_TOKEN:
        return
    try:
        body = json.dumps({"token": PUSHPLUS_TOKEN, "title": title,
                           "content": content, "template": "html"}).encode("utf-8")
        req = urllib.request.Request("http://www.pushplus.plus/send", data=body,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            log("[PushPlus] %s" % r.status)
    except Exception as e:
        log("[PushPlus] 推送失败: %s" % e)
# ------------------------------------------------------------------ 全自动验证
def _token_expired(resp):
    m = str(resp.get("Msg") or "")
    return "40001" in m or "令牌已过期" in m or "授权登录" in m
def auto_verify(acct, seed, cxtoken, survey_token, done, need, remain, won, state):
    """对指定账号执行一条未消费任务的自动验证。
    返回 (note, consumed_code, done, remain, won, expired)"""
    tasks = parse_tasks(FRW_TASKS)
    accounts = state.setdefault("accounts", {})
    st_acct = accounts.setdefault(acct["ref"], {})
    consumed = set(st_acct.get("consumed", []))
    pending = st_acct.get("pending") or {}
    aname = acct["name"]
    # 频控退避：上次尝试后冷却期内不再发起查码
    cooldown = int(env_or_db("FRW_CX_COOLDOWN", "30") or 30) * 60
    last_ts = int(st_acct.get("last_cx_ts", 0) or 0)
    if last_ts and time.time() - last_ts < cooldown:
        wait = int((cooldown - (time.time() - last_ts)) / 60) + 1
        note = "⏳ [%s] 上次尝试太近，冷却中（还需约 %s 分钟）" % (aname, wait)
        log("[验证] " + note)
        return note, None, done, remain, won, False
    # 上次验证是否生效（次数上涨）
    if pending.get("code") and done > int(pending.get("done", done)):
        consumed.add(pending["code"])
        log("[验证] [%s] 上次验证码 %s 已生效（次数 %s→%s）"
            % (aname, pending["code"], pending.get("done"), done))
        pending = {}
    target = None
    task_owner = state.setdefault("task_owner", {})
    fail_run = st_acct.setdefault("fail_run", {})
    skip_after = int(env_or_db("FRW_SKIP_AFTER", "5") or 5)
    for link, code, t_acct in tasks:
        if not (link and code) or code in consumed:
            continue
        if fail_run.get(code, 0) >= skip_after:
            continue
        if t_acct and t_acct != aname:
            continue          # 任务指定了其他账号
        owner = task_owner.get(code)
        if owner and owner != acct["ref"]:
            continue          # 已被其他账号占用
        target = (link, code)
        break
    note = ""
    if not target:
        st_acct["consumed"] = sorted(consumed)
        st_acct["pending"] = {}
        note = "⚠️ [%s] 可用的 链接|验证码 已全部用完" % aname if tasks else "未配置 FRW_TASKS"
        log("[验证] " + note)
        return note, None, done, remain, won, False
    link, code = target
    task_owner[code] = acct["ref"]
    link_info = ""
    if CHECK_LINK:
        ok3, info3 = check_link(link)
        link_info = info3
        log("[链接] %s" % info3)
        if ok3 is False:
            st_acct["consumed"] = sorted(consumed)
            st_acct["pending"] = {}
            note = "❌ [%s] 链接无效，不消费稍后重试：%s" % (aname, info3)
            log("[验证] " + note)
            return note, None, done, remain, won, False
    st_acct["last_cx_ts"] = int(time.time())
    retry_max = int(env_or_db("FRW_QUERY_RETRY", "60") or 60)
    retry_gap = max(int(env_or_db("FRW_QUERY_RETRY_GAP", "10") or 10), 2)
    r = None
    st_ = None
    d = {}
    for attempt in range(1, retry_max + 1):
        try:
            r = cx_verify_search(link, seed, cxtoken)
        except Exception as e:
            log("[验证] ❌ [%s] 码查询异常：%s（%ss 后重试）" % (aname, e, retry_gap))
            time.sleep(retry_gap)
            continue
        st_ = r.get("Status")
        d = r.get("Data") or {}
        if _token_expired(r):
            break
        msg_s = str(r.get("Msg") or "")
        transient = (st_ == 0) or ("鉴真服务异常" in msg_s) or (st_ == 1 and (not d or "NeedVcode" not in d))
        if not transient:
            break
        log("[验证] ⏳ [%s] 码 %s 第 %s/%s 次查询繁忙（%s），%s 秒后重试同一码"
            % (aname, code, attempt, retry_max, (msg_s or "空数据")[:40], retry_gap))
        time.sleep(retry_gap)
    if st_ != 1:
        if _token_expired(r):
            note = "🔒 [%s] 会话令牌已过期（40001）" % aname
        else:
            note = "❌ [%s] 码查询失败（Status %s）：%s" % (aname, st_, r.get("Msg") or str(d)[:120])
        fail_run[code] = fail_run.get(code, 0) + retry_max
        log("[验证] " + note)
        return note, None, done, remain, won, _token_expired(r)
    if not d or "NeedVcode" not in d:
        # 服务端偶发软限流：Status=1 但 Data 为空。按临时失败处理，绝不消费验证码。
        note = "⏳ [%s] 码查询返回空数据（可能是频控），下次运行重试" % aname
        fail_run[code] = fail_run.get(code, 0) + retry_max
        log("[验证] " + note)
        return note, None, done, remain, won, False
    prod_name = (d.get("ProductDetail") or {}).get("ProductName") or ""
    log("[查码] [%s] %s | NeedVcode=%s | 该码已验 %s 次 | %s"
        % (aname, prod_name, d.get("NeedVcode"), d.get("VerifyCount"), d.get("ProductId")))
    if not d.get("NeedVcode"):
        consumed.add(code)
        st_acct["consumed"] = sorted(consumed)
        st_acct["pending"] = {}
        note = "ℹ️ [%s] 该链接无需验证码（已验证过），已跳过" % aname
        log("[验证] " + note)
        return note, code, done, remain, won, False
    product_id = d.get("ProductId") or ""
    r2 = None
    st2 = None
    d2 = {}
    for attempt2 in range(1, retry_max + 1):
        try:
            r2 = cx_verify_vcode(link, code, product_id, seed, cxtoken)
        except Exception as e:
            log("[验证] ❌ [%s] 验证提交异常：%s（%s 秒后重试）" % (aname, e, retry_gap))
            time.sleep(retry_gap)
            continue
        st2 = r2.get("Status")
        d2 = r2.get("Data") or {}
        if _token_expired(r2):
            break
        msg2 = str(r2.get("Msg") or "")
        transient2 = (st2 == 0) or ("鉴真服务异常" in msg2) or (st2 == 1 and not d2)
        if not transient2:
            break
        log("[验证] ⏳ [%s] 码 %s 第 %s/%s 次提交繁忙（%s），%s 秒后重试同一码"
            % (aname, code, attempt2, retry_max, (msg2 or "空数据")[:40], retry_gap))
        time.sleep(retry_gap)
    if _token_expired(r2):
        note = "🔒 [%s] 会话令牌已过期（40001）" % aname
        log("[验证] " + note)
        return note, None, done, remain, won, True
    if st2 == 1 and d2.get("IsTrue") is not False:
        consumed.add(code)
        pending = {"code": code, "done": done, "link": link}
        note = "✅ [%s] 全自动验证成功：验证码 %s（该码累计 %s 次）" % (
            aname, code, d2.get("VerifyCount") or (done + 1))
        log("[验证] " + note)
        if survey_token:
            time.sleep(2)
            s2 = query_status(survey_token)
            if s2:
                done, need, remain = s2
                log("[状态] 验证后：已验证 %s 次，剩余抽奖 %s" % (done, remain))
                if remain > 0 and FRW_MODE in ("all", "draw"):
                    won += do_lottery(survey_token)
                    s3 = query_status(survey_token)
                    if s3:
                        done, need, remain = s3
    elif st2 in (30, 401, 101, 102):
        note = "⚠️ [%s] 会话需要重新登录/绑定手机（Status %s）：%s" % (aname, st2, r2.get("Msg") or "")
        log("[验证] " + note)
    else:
        note = "❌ [%s] 自动验证失败（Status %s）：%s %s" % (
            aname, st2, r2.get("Msg") or "", str(d2)[:120])
        fail_run[code] = fail_run.get(code, 0) + retry_max
        log("[验证] " + note)
    st_acct["consumed"] = sorted(consumed)
    st_acct["pending"] = pending
    return note, code, done, remain, won, False
# ------------------------------------------------------------------ 主流程
def main():
    log("=" * 58)
    log("芙蓉王一物一码 · 开始 (v3 全自动验证)")
    # ---------- 1. token ----------
    cache = load_json(TOKEN_CACHE, {})
    user_info = cache.get("userInfo") or {}
    token = None
    ok, _ = token_is_valid(JWT_TOKEN)
    if ok:
        token = JWT_TOKEN
        log("[token] 使用环境变量 FRW_JWT")
    else:
        ok2, _ = token_is_valid(cache.get("token", ""))
        if ok2:
            token = cache["token"]
            log("[token] 使用缓存 token（用户 %s）"
                % (user_info.get("realName") or "?"))
        else:
            tok, info, err = token_from_cipher(CIPHER) if CIPHER else (None, None, "未配置 FRW_CIPHER")
            if tok:
                token = tok
                user_info = (info or {}).get("userInfo") or {}
                if (info or {}).get("cbk"):
                    globals()["ACTIVITY_ID"] = info["cbk"]
                save_json(TOKEN_CACHE, {"token": tok, "userInfo": user_info,
                                        "ts": int(time.time())})
                log("[token] CipherParam 换新 token：%s" % (user_info.get("realName") or "?"))
            else:
                log("[token] 获取失败：%s" % err)
    if not token:
        msg = ("芙蓉王任务失败：无法获取有效 token。\n请更新青龙环境变量 FRW_CIPHER"
               "（survey 活动页地址栏 CipherParam= 那段）。")
        log(msg)
        pushplus("【芙蓉王】失败 - 需更新 CipherParam", msg.replace("\n", "<br>"))
        return 2
    real_name = user_info.get("realName") or "-"
    phone = user_info.get("phone") or user_info.get("mobile") or ""
    # ---------- 2. 状态 ----------
    s = query_status(token)
    if not s:
        log("[状态] 查询失败")
        pushplus("【芙蓉王】查询失败", "queryDetailByUser 失败")
        return 3
    done, need, remain = s
    log("[状态] 用户=%s 已验证 %s 次，每 %s 次得 1 次抽奖，剩余抽奖 %s"
        % (real_name, done, need, remain))
    # ---------- 3. 抽奖 ----------
    won = []
    if FRW_MODE == "verify":
        log("[抽奖] 验证模式，跳过抽奖（由主抽奖任务执行）")
    elif remain > 0:
        if FRW_MODE == "draw":
            # v8: 主抽奖模式一直重试，直到把机会抽完
            won = do_lottery_retry(token)
        else:
            won = do_lottery(token)
        s = query_status(token)
        if s:
            done, need, remain = s
    else:
        log("[抽奖] 暂无抽奖机会，跳过")
    # ---------- 4. 全自动验证（v4 多账号，YYB 提供 Seed） ----------
    state = {} if FRW_RESET else load_json(STATE_FILE, {})
    push_later = []
    auto_notes = []
    verified_code = None
    expired_any = False
    cx_ready = False
    if FRW_MODE == "draw":
        log("[验证] 抽奖模式，跳过全自动验证")
    elif CX_DISABLED:
        log("[验证] FRW_CX_OFF=1，全自动验证关闭")
    else:
        acct_list = parse_accounts(CX_ACCOUNTS_RAW)
        if not acct_list and CX_SEED and CX_TOKEN:
            acct_list = [{"name": "主号", "ref": "manual", "mobile": "", "cipher": ""}]
        if not acct_list:
            log("[验证] 未配置 FRW_CX_ACCOUNTS（或 FRW_CX_SEED/FRW_CX_TOKEN），退回手动模式")
        for _ref, _a in state.get("accounts", {}).items():
            _a.pop("fail_run", None)
        for acct in acct_list:
            aname = acct["name"]
            st_acct = state.setdefault("accounts", {}).setdefault(acct["ref"], {})
            st_acct["name"] = aname
            try:
                if acct["ref"] == "manual":
                    seed, cxtoken = CX_SEED, CX_TOKEN
                else:
                    # v6: 优先复用 state 里已验证可用的 seed/token 对（YYB getCode 经常抽风返回空 code）
                    seed = st_acct.get("seed") or ""
                    cxtoken, note = ensure_acct_token(acct, st_acct, push_later)
                    if not cxtoken:
                        auto_notes.append(note)
                        continue
                    if not seed:
                        seed = yyb_seed(acct["ref"])
                        st_acct["seed"] = seed
            except Exception as e:
                auto_notes.append("❌ [%s] 初始化失败：%s" % (aname, e))
                continue
            cx_ready = True
            verify_interval = int(env_or_db("FRW_VERIFY_INTERVAL", "15") or 15)
            ok_cnt = 0
            while True:
                note, vcode, done, remain, won, expired = auto_verify(
                    acct, seed, cxtoken, token, done, need, remain, won, state)
                if vcode:
                    ok_cnt += 1
                    auto_notes.append(note)
                    if verified_code is None:
                        verified_code = vcode
                    if expired:
                        expired_any = True
                        st_acct.pop("token", None)   # 清失效 token，下轮短信重登
                        break
                    time.sleep(max(verify_interval, 1))  # 每验证一个间隔 N 秒再验证下一个
                    continue
                auto_notes.append(note)
                if expired:
                    expired_any = True
                    st_acct.pop("token", None)
                    break
                if ("已全部用完" in note) or ("未配置" in note) or ("冷却中" in note):
                    break
                continue
            if ok_cnt:
                auto_notes.insert(len(auto_notes) - ok_cnt,
                                  "✅ [%s] 本轮连续自动验证 %s 个（间隔 %ss）"
                                  % (aname, ok_cnt, verify_interval))
            _fails = sorted((st_acct.get("fail_run") or {}).keys())
            if _fails:
                state["failed_codes"] = _fails
                try:
                    open("/ql/data/scripts/furongwang_failed.txt", "w").write("\n".join(_fails) + "\n")
                except Exception:
                    pass
                auto_notes.append("❌ [%s] 本次验证失败 %s 个（已跳过，稍后自动重试）：%s"
                                  % (aname, len(_fails), " ".join(_fails)))
        state["ts"] = int(time.time())
        save_json(STATE_FILE, state)
    # ---------- 5. 手动模式：派发下一个待验证码 ----------
    pending = {}
    if FRW_MODE != "draw" and (not cx_ready or expired_any):
        tasks = parse_tasks(FRW_TASKS)
        consumed = set(state.get("consumed", []))
        pending = state.get("pending") or {}
        note = ""
        if pending.get("code"):
            if done > int(pending.get("done", done)):
                consumed.add(pending["code"])
                note = "✅ 上一次的验证码 %s 已验证成功（次数 %s→%s）" % (
                    pending["code"], pending.get("done"), done)
                log("[队列] " + note)
                pending = {}
            else:
                note = "⏳ 验证码 %s 上次已派发，尚未验证（次数仍为 %s）" % (
                    pending["code"], done)
                log("[队列] " + note)
        if not pending and tasks:
            for link, code, _a in tasks:
                if code and code not in consumed:
                    pending = {"code": code, "link": link, "done": done}
                    log("[队列] 派发新验证码：%s" % code)
                    break
            if not pending:
                log("[队列] 清单里的验证码已全部用完")
        state["consumed"] = sorted(consumed)
        state["pending"] = pending
        save_json(STATE_FILE, state)
    # ---------- 6. 汇总 + 推送 ----------
    left_need = need - (done % need)
    lines = ["<b>用户：%s</b>%s" % (real_name, (" (%s)" % phone) if phone else ""),
             "已验证：%s 次（每 %s 次换 1 次抽奖）" % (done, need),
             "本次抽中：%s 次" % len(won)]
    if won:
        lines.append("奖品：" + "、".join(str(w) for w in won))
    lines.append("再验证 <b>%s</b> 次可获得新的抽奖机会" % left_need)
    if auto_notes:
        lines += ["", "===== 全自动验证 ====="] + auto_notes
    if verified_code:
        lines.append("下次运行将继续验证清单中的下一条。")
    if FRW_MODE != "draw" and (not cx_ready or expired_any):
        if pending:
            lines += ["", "===== 本次待验证（手动） =====",
                      "验证码：<b style='font-size:20px'>%s</b>" % pending["code"]]
            if pending.get("link"):
                lines.append('链接：<a href="%s">点击在微信打开（自动跳小程序）</a>'
                             % pending["link"])
            lines.append("操作：点链接 → 橙杏服务小程序 → 粘贴上面 6 位验证码")
            lines.append("⚠️ 必须用「%s」这个微信号验证，换号不计入" % real_name)
        elif parse_tasks(FRW_TASKS):
            lines += ["", "⚠️ FRW_TASKS 里的验证码已全部验证完，请补充新的。"]
    if expired_any:
        lines += ["", "🔒 部分账号 token 已失效，已清除缓存。按推送里的短信指引"
                  "（填 FRW_SMS_CODE）即可重新登录，无需抓包。"]
    for extra in push_later:
        lines += ["", extra]
    summary = "\n".join(lines)
    import re as _re
    plain = _re.sub(r"<[^>]+>", "", summary.replace("<br>", "\n"))
    log("-" * 58)
    log(plain)
    log("-" * 58)
    title = "【芙蓉王】%s · 抽%s次" % (real_name, len(won))
    if verified_code:
        title += " · 已自动验证"
    elif cx_ready:
        title += " · 自动验证失败"
    elif pending:
        title += " · 待验 %s" % pending["code"]
    pushplus(title, summary.replace("\n", "<br>"))
    log("任务结束")
    return 0
if __name__ == "__main__":
    sys.exit(main())
