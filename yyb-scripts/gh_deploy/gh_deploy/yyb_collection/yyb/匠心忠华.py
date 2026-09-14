# -*- coding: utf-8 -*-
"""
匠心忠华 微信小程序自动化脚本 (加密版)
环境变量: WXID=wxid1&wxid2&...  依赖: YYB_BASE_URL + cryptography
"""
import os, re, json, time, hashlib, urllib.parse, base64, random, requests
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

# ================== 配置 ==================
EnvName       = "WXID"                # 与第一段保持一致
WX_APPID      = "wxddaa0832e6acc5f1"
YYB_BASE_URL  = os.getenv("YYB_BASE_URL", "").strip()
BASE_URL      = "https://api.quwayouxuan.com"
TOKEN_FILE    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jxzh_token_cache.json")
BRIDGE_TIMEOUT = 20
REQ_TIMEOUT    = 15
_SIGN_SECRET  = base64.b64decode("c3VwZXJqaW5n").decode()

# ================== 通知 ==================
def load_send():
    p = os.path.dirname(os.path.abspath(__file__)) + "/notify.py"
    if os.path.exists(p):
        try:
            from notify import send
            return send
        except Exception:
            return None
    return None
send = load_send()

# ================== 缓存 ==================
def load_cache():
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}
def save_cache(data):
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"  缓存写入失败: {e}")
TOKEN_CACHE = load_cache()

# ================== 从 YYB 协议获取账号 ==================
def fetch_accounts_from_yyb():
    """从 YYB 协议获取账号列表，返回 [(nickname, wxid), ...]"""
    if not YYB_BASE_URL:
        return []
    try:
        url = f"{YYB_BASE_URL}/accounts"
        resp = requests.get(url, timeout=15)
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            accounts = []
            for acc in data["data"]:
                wxid = acc.get("openid", "")
                nickname = acc.get("nickname", "") or acc.get("alias", "") or wxid
                if wxid:
                    accounts.append({"wxid": wxid, "remark": nickname})
            return accounts
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []

# ================== 账号解析 ==================
def get_accounts():
    # 优先从 YYB 协议获取
    yyb_accounts = fetch_accounts_from_yyb()
    if yyb_accounts:
        print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
        return yyb_accounts

    # 回退：从环境变量获取
    raw = os.getenv(EnvName, "").strip()
    if not raw:
        print(f"未配置环境变量 {EnvName}")
        return []
    accounts = []
    for x in re.split(r"[&\n]+", raw):
        x = x.strip()
        if not x: continue
        if "#" in x:
            a, b = x.split("#", 1)
            a, b = a.strip(), b.strip()
            if a.lower().startswith("wxid"):
                accounts.append({"wxid": a, "remark": b or a})
            else:
                accounts.append({"wxid": b, "remark": a or b})
        else:
            accounts.append({"wxid": x, "remark": x})
    print(f"共加载 {len(accounts)} 个账号")
    return accounts

# ================== 签名 ==================
def make_key(params):
    sorted_keys = sorted(params.keys())
    raw = "".join([f"{k}={params[k]}" for k in sorted_keys])
    raw = (raw + _SIGN_SECRET).replace(" ", "")
    encoded = urllib.parse.quote(raw, safe='')
    encoded = re.sub(r"[!|'|\(|\)|\~|\*]", lambda m: "%" + "{:02X}".format(ord(m.group(0))), encoded)
    return hashlib.sha1(encoded.encode('utf-8')).hexdigest().lower()

# ================== 获取微信 code (YYB协议) ==================
def get_wx_code(wxid):
    if not YYB_BASE_URL:
        raise Exception("未配置 YYB_BASE_URL")
    url = f"{YYB_BASE_URL}/wxapp/getCode"
    payload = {"ref": wxid, "app_id": WX_APPID}
    for _ in range(3):
        try:
            resp = requests.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=BRIDGE_TIMEOUT)
            data = resp.json()
            if data.get("code") == 0:
                result = data.get("data", {}).get("result") if isinstance(data.get("data"), dict) else data.get("data")
                if isinstance(result, dict):
                    code = result.get("code")
                else:
                    code = data.get("data", {}).get("code") or data.get("data", {}).get("result")
                if code:
                    return str(code)
            time.sleep(2)
        except Exception:
            time.sleep(2)
    raise Exception("获取 code 失败")

# ================== code 换 token ==================
def wx_login(code):
    params = {
        "os": "miniProgram", "deviceabout": "miniProgram", "version": "1.3.01",
        "miniprogram_os": "Android", "current_time": str(int(time.time() * 1000)), "code": code
    }
    params["key"] = make_key(params)
    headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 MicroMessenger/8.0.65 MiniProgramEnv/android",
        "xweb_xhr": "1", "Content-Type": "application/x-www-form-urlencoded", "Accept": "*/*",
        "Referer": f"https://servicewechat.com/{WX_APPID}/128/page-frame.html",
    }
    resp = requests.post(f"{BASE_URL}/mini_program/get_openid.do", data=params, headers=headers, timeout=REQ_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 1 or not data.get("data", {}).get("token"):
        raise Exception(f"登录失败: {data.get('message', data)}")
    return data["data"]["token"], data["data"]

# ================== 验证 token ==================
def check_token(token):
    params = {
        "os": "miniProgram", "deviceabout": "miniProgram", "version": "1.3.01",
        "miniprogram_os": "Android", "current_time": str(int(time.time() * 1000)),
        "token": token, "source": "4"
    }
    params["key"] = make_key(params)
    headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 MicroMessenger/8.0.65 MiniProgramEnv/android",
        "xweb_xhr": "1", "Content-Type": "application/x-www-form-urlencoded", "Accept": "*/*",
        "Referer": f"https://servicewechat.com/{WX_APPID}/128/page-frame.html",
    }
    try:
        resp = requests.post(f"{BASE_URL}/task/task/taskList.do", data=params, headers=headers, timeout=REQ_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 1 or not data.get("data", {}).get("userinfo"):
            return None
        return data["data"]["userinfo"]
    except Exception:
        return None

# ================== 获取/刷新 Token ==================
def get_token(wxid):
    cache = TOKEN_CACHE.get(wxid, {})
    token = cache.get("token")
    if token:
        user_info = check_token(token)
        if user_info:
            TOKEN_CACHE[wxid]["userinfo"] = user_info
            save_cache(TOKEN_CACHE)
            print(f"  使用缓存 Token | 昵称: {user_info.get('username', '-')} | 积分: {user_info.get('points', 0)}")
            return token, user_info
    code = get_wx_code(wxid)
    token, user_info = wx_login(code)
    TOKEN_CACHE[wxid] = {"token": token, "userinfo": user_info}
    save_cache(TOKEN_CACHE)
    print(f"  ✅ 登录成功 | 昵称: {user_info.get('username', '-')} | 积分: {user_info.get('points', 0)}")
    return token, user_info

# ================== 加密机器人 ==================
class QuWaRobot:
    def __init__(self):
        self.base_url = BASE_URL
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 MicroMessenger/8.0.65 MiniProgramEnv/android",
            "xweb_xhr": "1", "Content-Type": "application/x-www-form-urlencoded", "Accept": "*/*",
            "Referer": f"https://servicewechat.com/{WX_APPID}/123/page-frame.html"
        }
        self.global_request_data = {
            "os": "miniProgram",
            "deviceabout": "miniProgram",
            "version": "1.3.00",
            "miniprogram_os": "Android"
        }
        self.session_key = None
        self.openid = "o_" + "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=26))

    def _make_key(self, params):
        return make_key(params)   # 复用上面的签名

    def generate_random_string(self, length=32):
        chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        return "".join(random.choices(chars, k=length))

    def perform_ecdh_key_exchange(self, token):
        try:
            private_key = ec.generate_private_key(ec.SECP256R1())
            public_key = private_key.public_key()
            client_pub_bytes = public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
            client_pub_base64 = base64.b64encode(client_pub_bytes).decode()
            salt_bytes = os.urandom(32)
            salt_base64 = base64.b64encode(salt_bytes).decode()

            exchange_data = {
                **self.global_request_data,
                "clientPublicKey": urllib.parse.quote(client_pub_base64),
                "timestamp": str(int(time.time())),
                "salt": salt_base64,
                "device": self.openid,
                "token": token
            }
            exchange_data["key"] = self._make_key(exchange_data)

            url = f"{self.base_url}/dynamic_key/getServerPublicKey.do"
            res = requests.post(url, data=exchange_data, headers=self.headers, timeout=10).json()
            if res.get("code") != 1:
                print(f"  [-] ❌ 协商失败: {res.get('message')}")
                return False

            server_pub_base64 = res.get("data", {}).get("publicKey")
            if not server_pub_base64:
                print("  [-] ❌ 服务器未返回公钥")
                return False

            server_pub_bytes = base64.b64decode(server_pub_base64)
            server_public_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), server_pub_bytes)
            shared_secret = private_key.exchange(ec.ECDH(), server_public_key)

            info_str = f'{{"device":"{self.openid}","token":"{token}"}}'
            hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt_bytes, info=info_str.encode())
            self.session_key = hkdf.derive(shared_secret)
            print("  [+] 🔑 密钥协商成功！")
            return True
        except Exception as e:
            print(f"  [-] ❌ 密钥协商异常: {str(e)}")
            return False

    def encrypt_payload(self, payload_dict):
        iv = os.urandom(12)
        plaintext = json.dumps(payload_dict, separators=(',', ':'), ensure_ascii=False)
        aesgcm = AESGCM(self.session_key)
        ciphertext_with_tag = aesgcm.encrypt(iv, plaintext.encode('utf-8'), b"")
        return base64.b64encode(iv + ciphertext_with_tag).decode()

    def decrypt_payload(self, encrypted_base64):
        try:
            combined = base64.b64decode(encrypted_base64)
            iv = combined[:12]
            ciphertext_with_tag = combined[12:]
            aesgcm = AESGCM(self.session_key)
            return aesgcm.decrypt(iv, ciphertext_with_tag, b"").decode()
        except Exception as e:
            print(f"  [-] 解密失败: {str(e)}")
            return None

    def post_request(self, url_path, biz_data, token):
        url = f"{self.base_url}{url_path}"
        full_biz_data = {**self.global_request_data, "token": token, **biz_data}
        full_biz_data["key"] = self._make_key(full_biz_data)

        headers = self.headers.copy()
        headers["X-Request-Id"] = self.generate_random_string(32)
        headers["X-Device-Id"] = self.openid
        headers["X-Token"] = token

        if self.session_key:
            try:
                headers["X-Param"] = self.encrypt_payload(full_biz_data)
                res_obj = requests.post(url, data={}, headers=headers, timeout=10).json()
                if res_obj.get("code") == 4096:
                    self.session_key = None
                    if self.perform_ecdh_key_exchange(token):
                        return self.post_request(url_path, biz_data, token)
                    return {"code": -1, "message": "重新协商失败"}
                if "data" in res_obj and res_obj.get("code") == 1 and isinstance(res_obj["data"], str):
                    decrypted = self.decrypt_payload(res_obj["data"])
                    if decrypted:
                        res_obj["data"] = json.loads(decrypted)
                return res_obj
            except Exception:
                self.session_key = None

        # 降级明文
        return requests.post(url, data=full_biz_data, headers=headers, timeout=10).json()

# ================== 单账号执行 ==================
def run_account(wxid, remark):
    print(f"\n{'='*46}\n  【{remark}】\n{'='*46}")
    try:
        token, user_info = get_token(wxid)
        real_name = user_info.get("username", remark)
        initial_pts = user_info.get("points", "0")
        print(f"  账户: {real_name} | 跑前积分: {initial_pts}")

        bot = QuWaRobot()
        negotiated = bot.perform_ecdh_key_exchange(token)
        if not negotiated:
            pass

        # 签到
        c_res = bot.post_request("/task/task/taskSuccrss.do", {"taskid": "1", "subtask_id": "0", "current_time": str(int(time.time() * 1000))}, token)
        c_m = c_res.get('message', '完成')
        print(f"  签到结果: {c_m}")
        c_s = "✅ 签到成功" if c_res.get('code') == 1 or any(k in c_m for k in ["已", "完成"]) else f"❌ {c_m}"

        # 视频任务
        a_c, gained_pts = 0, 0
        max_attempts = 30
        for i in range(max_attempts):
            a_res = bot.post_request("/task/task/taskSuccrss.do", {"taskid": "40", "subtask_id": "0", "current_time": str(int(time.time() * 1000))}, token)
            code = a_res.get("code")
            msg = a_res.get("message", "未知错误")
            if code == 1:
                a_c += 1
                pts = a_res.get("data", {}).get("points", 60)
                gained_pts += int(pts) if str(pts).isdigit() else 60
                wait_time = random.randint(160, 200)
                print(f"      └─ 第{a_c}次: ✅ +{pts}积分 | 累计: {gained_pts}")
                time.sleep(wait_time)
            elif any(kw in msg for kw in ["上限", "已达", "超出"]):
                print(f"      └─ 今日共成功 {a_c} 次")
                break
            elif any(kw in msg for kw in ["不能重复", "已完成", "已领取"]):
                break
            else:
                break

        v_s = f"🎬 执行({a_c}次) | 收益: +{gained_pts}分"
        print(f"  [√] 账号 [{real_name}] 处理完毕")
        return f"👤 昵称：{real_name}\n   ├ 原有：{initial_pts} 分\n   ├ 签到：{c_s}\n   └ 视频：{v_s}"
    except Exception as e:
        TOKEN_CACHE.pop(wxid, None)
        save_cache(TOKEN_CACHE)
        print(f"  [x] 异常: {str(e)}")
        return f"⚠️ {remark}: 运行异常 - {str(e)}"

def main():
    _h = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n┃  匠 心 忠 华 助 手 (加密版) ┃\n┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"
    print(_h)
    accounts = get_accounts()
    if not accounts:
        return
    reports = [run_account(acc["wxid"], acc["remark"]) for acc in accounts]
    summary = "\n" + "="*46 + "\n🎯 任务汇总报告：\n\n" + "\n\n".join(reports)
    print(summary)
    if send:
        send("匠心忠华任务报告(加密版)", _h + "\n\n" + "\n\n".join(reports))

if __name__ == "__main__":
    main()
