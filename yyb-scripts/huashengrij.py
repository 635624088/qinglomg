#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
花生日记 · 花生奖码(每日福利)青龙面板脚本(账号密码自动登录版)
================================================================
环境变量:
  HSRJ     必填,格式: 账号#密码 (手机号#登录密码)
           多账号用 & 或换行分隔,如: 13800000001#pwd1&13800000002#pwd2
           (兼容 @ / ; 分隔;若值里没有 # 则按 token 直接使用)
  HS_TASKS 可选,只跑部分任务,逗号分隔: claim,sign,video,mall (默认全部)
  HS_VIDEO_INTERVAL 可选,看福利视频两次上报间隔秒数(默认 8)
  HS_DEBUG 可选,=1 输出请求细节

自动完成的任务(每期=每天 21:25 开奖的一期):
  1. 登录        loginV3           自动获取 token(账号密码,无需抓包)
  2. 开心收下    claimNewUserReward 新用户领 5 奖码
  3. 签到        signIn            每日 1 奖码,连续签到有额外奖励
  4. 看福利视频  completeAdTask    每期最多 3 次,每次 1 奖码
  5. 浏览福利商城 finishWatchTask(taskType=22) 每期 1 次,1 奖码
仅打印状态不自动执行(需真人/下单): 开启通知、添加企业微信、下单享返佣、
邀请新用户、激活有效粉丝、邀请好友助力、浏览京东会场、上榜好物清单。

纯 Python 标准库实现(AES/RSA/MD5 均内置),青龙 2.x/3.x 开箱即用。
"""

import base64
import hashlib
import json
import os
import random
import re
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# ============ 常量(逆向自 App v60411) ============
APP_HOST = os.environ.get("HS_APP_HOST", "https://hsrj-api.huashengjia100.com")
H5_HOST = os.environ.get("HS_HOST", "https://hsrjh5.huashengjia100.com")
H5_BASE = H5_HOST + "/api/h5-rest/actEveryDay"
AES_IV = b"5698274814688181"          # AESUtils.ivParameter
SIGN_NONCE = "hsRj@01@0ZzO2"          # MyApplication.getSign 里的 n
RSA_PUB_B64 = (                       # MyApplication.getSign 内置 RSA 公钥(1024bit)
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDMCJwiuJ2rznDixvE/hodTAIj1fH71j9GOm4pT28of"
    "McHQO4vE0AEcvrGsWx0YFgdQlKwTS7GoYoDG2LQcD04GlTLE6OVgMa+eXQSYMkLcUQdv+0m912D4IL"
    "ubIy3Vm3awbqzofan6fjP/2qnqtr5/Yyje0MoSC0umdQUZrUgZfQIDAQAB")
UA = ("Mozilla/5.0 (Linux; Android 14; 2203121C Build/UKQ1.231003.002; wv) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 "
      "Mobile Safari/537.36 XWEB/1180054 MMWEBSDK/20240403 MMWEBID/3658 "
      "MicroMessenger/8.0.49.2560(0x2800313D) WeChat/arm64 Weixin NetType/WIFI "
      "Language/zh_CN ABI/arm64")
DEBUG = os.environ.get("HS_DEBUG") == "1"
VIDEO_INTERVAL = int(os.environ.get("HS_VIDEO_INTERVAL", "8"))

TASK_ALIAS = {
    "claim": "开心收下",
    "sign": "签到",
    "video": "看福利视频",
    "mall": "浏览福利商城",
}


def log(msg, level="INFO"):
    print(f"[{time.strftime('%H:%M:%S')}][{level}] {msg}", flush=True)


# ================================================================
# 纯 Python AES-128-CBC(已用 NIST 向量 + openssl 交叉验证)
# ================================================================
def _xtime(a):
    a <<= 1
    if a & 0x100:
        a ^= 0x11b
    return a & 0xff


def _gen_sbox():
    exp = [0] * 256
    log_t = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log_t[x] = i
        x ^= _xtime(x)                      # x *= 3 (生成元)

    def inv(a):
        return 0 if a == 0 else exp[(255 - log_t[a]) % 255]

    def rotl(b, n):
        return ((b << n) | (b >> (8 - n))) & 0xff

    sbox = [0] * 256
    for a in range(256):
        b = inv(a)
        sbox[a] = b ^ rotl(b, 1) ^ rotl(b, 2) ^ rotl(b, 3) ^ rotl(b, 4) ^ 0x63
    return sbox


SBOX = _gen_sbox()
INV_SBOX = [0] * 256
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i
RCON = [0x01]
for _ in range(10):
    RCON.append(_xtime(RCON[-1]))


def _expand_key(key):
    w = [list(key[i * 4:i * 4 + 4]) for i in range(4)]
    for i in range(4, 44):
        t = list(w[i - 1])
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [SBOX[b] for b in t]
            t[0] ^= RCON[i // 4 - 1]
        w.append([w[i - 4][j] ^ t[j] for j in range(4)])
    rk = []
    for r in range(11):
        kb = []
        for c in range(4):
            kb.extend(w[4 * r + c])
        rk.append(kb)
    return rk


def _xor(s, k):
    return [s[i] ^ k[i] for i in range(16)]


def _shift_rows(s):
    o = [0] * 16
    for c in range(4):
        for r in range(4):
            o[c * 4 + r] = s[((c + r) % 4) * 4 + r]
    return o


def _inv_shift_rows(s):
    o = [0] * 16
    for c in range(4):
        for r in range(4):
            o[c * 4 + r] = s[((c - r) % 4) * 4 + r]
    return o


def _mix_col(a):
    return [
        _xtime(a[0]) ^ (_xtime(a[1]) ^ a[1]) ^ a[2] ^ a[3],
        a[0] ^ _xtime(a[1]) ^ (_xtime(a[2]) ^ a[2]) ^ a[3],
        a[0] ^ a[1] ^ _xtime(a[2]) ^ (_xtime(a[3]) ^ a[3]),
        (_xtime(a[0]) ^ a[0]) ^ a[1] ^ a[2] ^ _xtime(a[3]),
    ]


def _gmul(a, b):
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        b >>= 1
        a = _xtime(a)
    return p


def _inv_mix_columns(s):
    o = [0] * 16
    for c in range(4):
        a = s[c * 4:c * 4 + 4]
        o[c * 4 + 0] = _gmul(a[0], 14) ^ _gmul(a[1], 11) ^ _gmul(a[2], 13) ^ _gmul(a[3], 9)
        o[c * 4 + 1] = _gmul(a[0], 9) ^ _gmul(a[1], 14) ^ _gmul(a[2], 11) ^ _gmul(a[3], 13)
        o[c * 4 + 2] = _gmul(a[0], 13) ^ _gmul(a[1], 9) ^ _gmul(a[2], 14) ^ _gmul(a[3], 11)
        o[c * 4 + 3] = _gmul(a[0], 11) ^ _gmul(a[1], 13) ^ _gmul(a[2], 9) ^ _gmul(a[3], 14)
    return o


def _aes_enc_block(block, rk):
    s = _xor(block, rk[0])
    for r in range(1, 10):
        s = [SBOX[b] for b in s]
        s = _shift_rows(s)
        for c in range(4):
            s[c * 4:c * 4 + 4] = _mix_col(s[c * 4:c * 4 + 4])
        s = _xor(s, rk[r])
    s = [SBOX[b] for b in s]
    s = _shift_rows(s)
    return _xor(s, rk[10])


def _aes_dec_block(block, rk):
    s = _xor(block, rk[10])
    for r in range(9, 0, -1):
        s = _inv_shift_rows(s)
        s = [INV_SBOX[b] for b in s]
        s = _xor(s, rk[r])
        s = _inv_mix_columns(s)
    s = _inv_shift_rows(s)
    s = [INV_SBOX[b] for b in s]
    return _xor(s, rk[0])


def _pkcs7_pad(data):
    n = 16 - len(data) % 16
    return data + bytes([n]) * n


def _pkcs7_unpad(data):
    if not data or len(data) % 16:
        return data
    n = data[-1]
    if 1 <= n <= 16 and data[-n:] == bytes([n]) * n:
        return data[:-n]
    return data


def aes_cbc_encrypt(data, key, iv):
    rk = _expand_key(key)
    data = _pkcs7_pad(data)
    out = b""
    prev = iv
    for i in range(0, len(data), 16):
        blk = _xor(list(data[i:i + 16]), list(prev))
        enc = _aes_enc_block(blk, rk)
        out += bytes(enc)
        prev = enc
    return out


def aes_cbc_decrypt(data, key, iv):
    rk = _expand_key(key)
    out = b""
    prev = iv
    for i in range(0, len(data), 16):
        blk = list(data[i:i + 16])
        dec = _aes_dec_block(blk, rk)
        out += bytes(_xor(dec, list(prev)))
        prev = bytes(blk)
    return _pkcs7_unpad(out)


# ================================================================
# RSA PKCS#1 v1.5 加密(sign 头)
# ================================================================
def _der_read(data, off):
    tag = data[off]
    off += 1
    ln = data[off]
    off += 1
    if ln & 0x80:
        n = ln & 0x7F
        ln = int.from_bytes(data[off:off + n], "big")
        off += n
    return tag, data[off:off + ln], off + ln


def _parse_rsa_pub(b64):
    der = base64.b64decode(b64)
    _, seq1, _ = _der_read(der, 0)           # SubjectPublicKeyInfo
    _, _, off = _der_read(seq1, 0)           # AlgorithmIdentifier
    _, bits, _ = _der_read(seq1, off)        # BIT STRING
    _, rsaseq, _ = _der_read(bits, 1)        # RSAPublicKey
    _, nbytes, off = _der_read(rsaseq, 0)    # modulus
    _, ebytes, _ = _der_read(rsaseq, off)    # exponent
    return int.from_bytes(nbytes, "big"), int.from_bytes(ebytes, "big")


RSA_N, RSA_E = _parse_rsa_pub(RSA_PUB_B64)


def rsa_encrypt_pkcs1v15(msg):
    k = (RSA_N.bit_length() + 7) // 8
    ps_len = k - 3 - len(msg)
    if ps_len < 8:
        raise ValueError("RSA message too long")
    ps = bytes(random.randint(1, 255) for _ in range(ps_len))
    em = b"\x00\x02" + ps + b"\x00" + msg
    return pow(int.from_bytes(em, "big"), RSA_E, RSA_N).to_bytes(k, "big")


def md5hex(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()


# ================================================================
# App 登录协议
# ================================================================
def get_date_key(date_key, public_key):
    """复刻 EncryptionManage.getDateKey: 用 dateKey/publicKey/随机数拼出 key"""
    r = random.randint(0, 19)                # (int)(Math.random()*20)
    md5rs = md5hex(str(r))
    md5pk = md5hex(public_key)
    i3 = int(date_key[23:]) % 9 + 1
    d1, d0 = date_key[i3:], date_key[:i3]
    i1 = r % 9 + 1
    p1, p0 = md5pk[i1:], md5pk[:i1]
    m1, m0 = md5rs[i1:], md5rs[:i1]
    return str(i1) + str(i3) + p1 + m1 + d1 + m0 + p0 + d0 + str(i1)


def app_headers(token=""):
    return {
        "clientPlatform": "android",
        "clientFramework": "native",
        "platforms": "android",
        "appInfo": "Peanut_60411",
        "appVersion": "60411",
        "deviceInfo": "DeviceName_Xiaomi_2203121C",
        "OSInfo": "android_14",
        "netType": "1",
        "deviceImei": uuid.uuid4().hex[:16],
        "deviceUUID": uuid.uuid4().hex[:16],
        "User-Agent": UA,
        "token": token,
        "regid": "",
        "oaid": "",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    }


def http_post(url, headers, body):
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")


def login(mobile, password):
    """账号密码登录,返回 token。失败抛 RuntimeError(带服务端 msg)。"""
    # 1. 取登录密钥
    st, txt = http_post(APP_HOST + "/user-rest/token/getLoginKey", app_headers(), b"")
    if DEBUG:
        log(f"getLoginKey <- {txt[:200]}", "DEBUG")
    try:
        lk = json.loads(txt).get("data") or {}
        date_key, public_key = lk["dateKey"], lk["publicKey"]
    except Exception:
        raise RuntimeError(f"获取登录密钥失败: {txt[:120]}")

    # 2. 组装加密登录报文
    aes_key = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(16))
    payload = {
        "areaCode": "+86",
        "mobile": mobile,
        "passWord": password,
        "verificationCode": "",
        "type": "1",                          # 1 = 账号密码登录
        "key": get_date_key(date_key, public_key),
        "key1": str(len(date_key)),
        "jiguangVerifyFlag": "0",
        "loginToken": "",
        "voiceFlag": "",
    }
    plain = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    params = base64.b64encode(
        aes_cbc_encrypt(plain.encode("utf-8"), aes_key.encode(), AES_IV)).decode()
    sign = base64.b64encode(rsa_encrypt_pkcs1v15(
        f"k={aes_key}&n={SIGN_NONCE}&t={int(time.time() * 1000)}".encode())).decode()

    h = app_headers()
    h["sign"] = sign
    h["eMode"] = "1"
    body = urllib.parse.urlencode({"params": params}).encode()

    # 3. 登录
    st, txt = http_post(APP_HOST + "/user-rest/token/loginV3", h, body)
    if DEBUG:
        log(f"loginV3 <- {txt[:300]}", "DEBUG")
    try:
        j = json.loads(txt)
    except Exception:
        raise RuntimeError(f"登录响应异常: {txt[:120]}")
    if j.get("status") != 200:
        raise RuntimeError(f"登录失败: {j.get('msg')}(status={j.get('status')})")
    data = j.get("data")
    if not isinstance(data, str) or not data:
        raise RuntimeError(f"登录响应缺少 data: {txt[:120]}")
    # 4. 解密拿到 token
    dec_in = urllib.parse.unquote(data)
    dec = aes_cbc_decrypt(base64.b64decode(dec_in), aes_key.encode(), AES_IV)
    try:
        tb = json.loads(dec.decode("utf-8", "ignore"))
    except Exception:
        raise RuntimeError(f"登录 data 解密失败: {dec[:120]!r}")
    token = tb.get("token") or ""
    if not token:
        raise RuntimeError(f"未取到 token: {dec.decode('utf-8', 'ignore')[:200]}")
    return token, tb


# ================================================================
# H5 活动接口(花生奖码)
# ================================================================
def build_multipart(fields, boundary):
    lines = []
    for k, v in fields.items():
        lines.append(f"--{boundary}".encode())
        lines.append(f'Content-Disposition: form-data; name="{k}"'.encode())
        lines.append(b"")
        lines.append(str(v).encode("utf-8"))
    lines.append(f"--{boundary}--".encode())
    return b"\r\n".join(lines) + b"\r\n"


def h5_api(action, fields, token):
    boundary = "----WebKitFormBoundary" + uuid.uuid4().hex[:16]
    body = build_multipart(fields, boundary)
    req = urllib.request.Request(f"{H5_BASE}/{action}", data=body, method="POST")
    req.add_header("Accept", "application/json, text/plain, */*")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("User-Agent", UA)
    req.add_header("token", token)
    req.add_header("Origin", H5_HOST)
    req.add_header("X-Requested-With", "com.jf.lkrj")
    if DEBUG:
        log(f"  -> POST {action} fields={json.dumps(fields, ensure_ascii=False)}", "DEBUG")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
    except Exception as e:
        return {"status": -1, "msg": f"网络异常 {e}", "data": None}
    try:
        j = json.loads(raw)
    except Exception:
        return {"status": -2, "msg": raw[:200], "data": None}
    if DEBUG:
        log(f"  <- {action} => {raw[:300]}", "DEBUG")
    return j


def collect_codes(rj, box):
    for x in ((rj.get("data") or {}).get("betNumbersList") or []):
        box.append(str(x))
    return box


class Account:
    def __init__(self, mobile, password, idx):
        self.mobile = mobile
        self.password = password
        self.idx = idx
        self.token = None
        self.issue_no = None
        self.codes = []
        self.done = set()

    def call(self, action, fields=None, need_issue=True):
        f = dict(fields or {})
        f["token"] = self.token
        if need_issue and self.issue_no and "issueNo" not in f:
            f["issueNo"] = self.issue_no
        rj = h5_api(action, f, self.token)
        if rj.get("status") == 401:
            raise PermissionError(rj.get("msg"))
        return rj

    # ---------- 0. 进入活动 ----------
    def enter_activity(self):
        rj = self.call("enter", need_issue=False)
        if rj.get("status") != 200:
            log(f"进入活动失败: {rj.get('msg')}", "WARN")
            return False
        d = rj.get("data") or {}
        self.issue_no = str(d.get("issueNo") or "")
        draw = ""
        ii = d.get("issueInfo")
        if isinstance(ii, dict):
            draw = ii.get("drawTime") or ""
        log(f"当前期次 issueNo={self.issue_no} 我的奖码数={d.get('myBetCount')} "
            f"奖池={d.get('issueInfo', {}).get('poolAmount') if isinstance(ii, dict) else ''} "
            f"开奖={draw}")
        return bool(self.issue_no)

    # ---------- 1. 开心收下 ----------
    def do_claim(self):
        rj = self.call("claimNewUserReward")
        if rj.get("status") == 200:
            collect_codes(rj, self.codes)
            n = len((rj.get("data") or {}).get("betNumbersList") or [])
            log(f"[开心收下] 成功,获得奖码 {n} 个")
        else:
            log(f"[开心收下] 跳过:{rj.get('msg')}(可能已领取/非新用户)")
        self.done.add("claim")

    # ---------- 2. 签到 ----------
    def do_sign(self):
        rj = self.call("task/list")
        sign_info = {}
        if rj.get("status") == 200:
            sign_info = (rj.get("data") or {}).get("signInInfo") or {}
        if sign_info.get("signedToday") or sign_info.get("isCompleted"):
            log(f"[签到] 今日已签到(连续 {sign_info.get('continuousDays')} 天)")
            self.done.add("sign")
            return
        rj2 = self.call("signIn")
        if rj2.get("status") == 200:
            collect_codes(rj2, self.codes)
            d = rj2.get("data") or {}
            extra = " 触发连续奖励!" if d.get("isExtraReward") else ""
            log(f"[签到] 成功,奖码 +{d.get('rewardCount')},连续 {d.get('continuousDays')} 天{extra}")
        else:
            log(f"[签到] 失败:{rj2.get('msg')}")
        self.done.add("sign")

    # ---------- 3. 看福利视频 ----------
    def do_video(self):
        rj = self.call("task/list")
        tl = (rj.get("data") or {}).get("taskList") or []
        v = next((t for t in tl if t.get("taskCode") == 6), None)
        if not v:
            log("[看福利视频] 本期无该任务")
            self.done.add("video")
            return
        limit = int(v.get("limitCount") or 3)
        done_cnt = int(v.get("completedCount") or 0)
        remain = max(0, limit - done_cnt)
        if remain <= 0:
            log("[看福利视频] 已完成本期次数")
            self.done.add("video")
            return
        log(f"[看福利视频] 还可完成 {remain}/{limit} 次,开始逐次上报…")
        ok = 0
        for i in range(remain):
            rc = self.call("completeAdTask")
            if rc.get("status") == 200:
                collect_codes(rc, self.codes)
                d = rc.get("data") or {}
                ok += 1
                log(f"[看福利视频] 第 {i + 1}/{remain} 次成功,奖码 +{d.get('rewardCount')}")
            else:
                log(f"[看福利视频] 第 {i + 1} 次失败:{rc.get('msg')} —— "
                    "若提示需先看广告,请当天在 App 内真实看完激励视频后再跑脚本", "WARN")
                break
            if i < remain - 1:
                time.sleep(VIDEO_INTERVAL)
        self.done.add("video")

    # ---------- 4. 浏览福利商城 ----------
    def do_mall(self):
        rj = self.call("getOtherTaskList", need_issue=False)
        task = None
        if rj.get("status") == 200:
            tl = (rj.get("data") or {}).get("taskList") or []
            task = next((t for t in tl if t.get("taskType") == 22), None)
        if not task:
            log("[浏览福利商城] 未找到该任务")
            self.done.add("mall")
            return
        if task.get("taskStatus") == 1 or int(task.get("finishCount") or 0) > 0:
            log("[浏览福利商城] 本期已完成")
            self.done.add("mall")
            return
        rc = self.call("finishWatchTask", {"taskType": 22}, need_issue=False)
        if rc.get("status") == 200:
            collect_codes(rc, self.codes)
            d = rc.get("data") or {}
            log(f"[浏览福利商城] 成功,奖码 +{d.get('rewardCount')}")
        else:
            log(f"[浏览福利商城] 失败:{rc.get('msg')}", "WARN")
        self.done.add("mall")

    # ---------- 5. 打印人工任务状态 ----------
    def show_manual_tasks(self):
        rj = self.call("task/list")
        if rj.get("status") != 200:
            return
        tl = (rj.get("data") or {}).get("taskList") or []
        manual = {2: "添加企业微信", 4: "开启通知", 5: "下单享返佣", 7: "浏览京东会场",
                  10: "邀请新用户", 11: "激活有效粉丝"}
        pending = []
        for t in tl:
            name = manual.get(t.get("taskCode"))
            if not name:
                continue
            if t.get("isCompleted") or t.get("isRewarded"):
                continue
            pending.append(f"{name}(+{t.get('rewardCount')}注)")
        if pending:
            log("以下任务需真人/下单,脚本不代做: " + "、".join(pending))

    def run(self):
        # --- 登录 ---
        masked = self.mobile[:3] + "****" + self.mobile[-4:] if len(self.mobile) >= 7 else self.mobile
        log(f"===== 账号[{self.idx}] {masked} =====")
        try:
            self.token, tb = login(self.mobile, self.password)
        except RuntimeError as e:
            log(f"账号[{self.idx}] {e}", "ERROR")
            return None
        log(f"登录成功 token={self.token[:12]}… 手机号={tb.get('phoneNumber') or masked}")
        if not self.enter_activity():
            log("获取期次失败,跳过该账号", "WARN")
            return None
        tasks = os.environ.get("HS_TASKS", "claim,sign,video,mall")
        for t in [x.strip() for x in tasks.split(",") if x.strip()]:
            fn = {"claim": self.do_claim, "sign": self.do_sign,
                  "video": self.do_video, "mall": self.do_mall}.get(t)
            if not fn:
                log(f"未知任务名 {t},可选: claim,sign,video,mall", "WARN")
                continue
            log(f"—— 执行「{TASK_ALIAS.get(t, t)}」 ——")
            try:
                fn()
            except PermissionError:
                raise
            except Exception as e:
                log(f"「{TASK_ALIAS.get(t, t)}」异常:{e}", "WARN")
            time.sleep(1)
        try:
            self.show_manual_tasks()
        except Exception:
            pass
        return {"codes": self.codes, "done": sorted(self.done), "issue": self.issue_no}


def parse_accounts():
    raw = (os.environ.get("HSRJ") or os.environ.get("HS_TOKEN") or "").strip()
    if not raw:
        log("未设置环境变量 HSRJ(格式: 账号#密码,多账号用 & 或换行分隔)。退出。", "ERROR")
        sys.exit(1)
    items = [x.strip() for x in re.split(r"[&\n;]", raw) if x.strip()]
    accounts = []
    for it in items:
        if "#" in it:
            acc, pwd = it.split("#", 1)
            accounts.append((acc.strip(), pwd.strip()))
        elif "@" in it:  # 兼容 账号@密码
            acc, pwd = it.split("@", 1)
            accounts.append((acc.strip(), pwd.strip()))
        else:
            log(f"跳过无效配置(缺少 # 分隔): {it[:6]}…", "WARN")
    if not accounts:
        log("HSRJ 中没有可用的账号#密码。退出。", "ERROR")
        sys.exit(1)
    return accounts


def main():
    accounts = parse_accounts()
    total_codes = []
    ok = 0
    summary_lines = []
    for i, (mobile, password) in enumerate(accounts, 1):
        acct = Account(mobile, password, i)
        try:
            s = acct.run()
            if s:
                ok += 1
                total_codes.extend(s["codes"])
                line = f"账号[{i}] {mobile[:3]}****{mobile[-4:]}: " \
                       f"新增奖码 {len(s['codes'])} 个"
                summary_lines.append(line)
                log(f"账号[{i}] 完成:{','.join(s['done'])} 新增奖码 {len(s['codes'])} 个: {s['codes']}")
        except PermissionError:
            log(f"账号[{i}] token 失效(登录异常)", "ERROR")
        except Exception as e:
            log(f"账号[{i}] 执行失败:{e}", "ERROR")
        if i < len(accounts):
            time.sleep(3)
    log("=" * 60)
    if ok:
        log(f"全部完成:成功账号 {ok}/{len(accounts)},共获得奖码 {len(total_codes)} 个")
        if total_codes:
            log("奖码列表: " + ",".join(total_codes))
    else:
        log("没有账号执行成功,请检查 HSRJ 账号密码", "ERROR")

    # 青龙通知(可选)
    if summary_lines and os.environ.get("HS_NOTIFY", "1") == "1":
        try:
            sys.path.append("/ql/scripts")
            sys.path.append("/ql/data/scripts")
            from notify import send  # noqa
            send("花生日记·花生奖码", "\n".join(summary_lines) +
                 f"\n\n共获得奖码 {len(total_codes)} 个(每天 21:25 开奖)")
        except Exception:
            pass
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
