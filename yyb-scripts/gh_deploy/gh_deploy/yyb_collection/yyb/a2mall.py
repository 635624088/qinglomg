"""
cron: 0 8 * * *
new Env('a2官方商城签到');

配置：
YYB_BASE_URL - YYB 协议地址
"""
import requests
import json
import os
import time
import uuid

def fetch_accounts_from_yyb(yyb_base_url: str) -> list:
    """从 YYB 协议获取账号列表，返回 [(nickname, openid), ...]"""
    try:
        url = f"{yyb_base_url}/accounts"
        resp = requests.get(url, timeout=15)
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            accounts = []
            for acc in data["data"]:
                openid = acc.get("openid", "")
                nickname = acc.get("nickname", "") or acc.get("alias", "") or openid
                if openid:
                    accounts.append((nickname, openid))
            return accounts
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []

# ==================== 固定配置 ====================
APP_ID = "wx33cf9bf4dff9388d"
KDT_ID = "113745713"
CHECKIN_ID = "3800805"

BASE_URL = "https://h5.youzan.com"
LOGIN_URL = "https://uic.youzan.com/passport/general/auth.json"
CHECKIN_URL = f"{BASE_URL}/wscump/checkin/checkinV2.json"
ACTIVITY_URL = f"{BASE_URL}/wscump/checkin/get_activity_by_yzuid_v2.json"
USER_INFO_URL = f"{BASE_URL}/wscuser/membercenter/present.json"

# ==================== 读取环境变量 ====================
WXID_LIST_STR = os.getenv("V2_WXIDS", "")
TOKEN_LIST_STR = os.getenv("V2_ACCESS_TOKENS", "")
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")

# 解析多账号
WXID_LIST = [w.strip() for w in WXID_LIST_STR.replace("\n", "&").split("&") if w.strip()]
TOKEN_LIST = [t.strip() for t in TOKEN_LIST_STR.replace("\n", "&").split("&") if t.strip()]

# 全局请求超时
REQ_TIMEOUT = 20

class V2MallWxid:
    def __init__(self, nickname=None, wxid=None, access_token=None):
        self.nickname = nickname or wxid
        self.wxid = wxid
        self.access_token = access_token
        self.session_id = None
        self.session = requests.Session()
        # 基础请求头
        self.base_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B)',
            'Content-Type': 'application/json',
            'Referer': f'https://servicewechat.com/{APP_ID}/33/page-frame.html'
        }
        self.session.headers.update(self.base_headers)

    def wxid_login(self):
        """wxid登录：注释唤醒步骤，保留获取Code+登录"""
        if not self.wxid:
            print("❌ wxid 为空，跳过登录")
            return False

        print(f"🔹 开始登录 {self.nickname}")

        # ===================== 【已注释：微信唤醒步骤】=====================
        # try:
        #     awake_url = f"{WECHAT_LOADER_URL}/api/v1/wx/login/awake"
        #     resp = requests.post(awake_url, json={"wxid": self.wxid}, timeout=REQ_TIMEOUT)
        #     if resp.status_code != 200:
        #         print(f"❌ 微信唤醒请求异常，状态码: {resp.status_code}")
        #         return False
        #     res = resp.json()
        #     if not res.get("status"):
        #         print(f"❌ 唤醒失败: {res.get('message', '未知错误')}")
        #         return False
        # except requests.exceptions.RequestException as e:
        #     print(f"❌ 唤醒微信网络异常: {str(e)}")
        #     return False
        # =================================================================

        time.sleep(1)

        # 2. 获取小程序 code（保留此流程）
        try:
            code_url = f"{YYB_BASE_URL}/wxapp/getCode"
            payload = {"ref": self.wxid, "app_id": APP_ID}
            resp = requests.post(code_url, json=payload, timeout=REQ_TIMEOUT)
            if resp.status_code != 200:
                print(f"❌ 获取code请求异常，状态码: {resp.status_code}")
                return False
            res = resp.json()
            code = None
            if isinstance(res, dict):
                if res.get("code") == 0:
                    data = res.get("data") or {}
                    result = data.get("result") if isinstance(data, dict) else None
                    if isinstance(result, dict):
                        code = result.get("code")
                    elif not data:
                        pass
                    else:
                        code = data.get("code") or data.get("result")
                elif res.get("status"):
                    data = res.get("Data") or {}
                    code = data.get("code")
            if not code:
                print(f"❌ 获取code失败: {res}")
                return False
            print("✅ 获取小程序 code 成功")
        except requests.exceptions.RequestException as e:
            print(f"❌ 获取code网络异常: {str(e)}")
            return False

        time.sleep(1)

        # 3. 使用code登录换取 access_token（保留此流程）
        login_payload = {
            "appId": APP_ID,
            "code": code,
            "platformName": "weapp",
            "signature": "windows",
            "clientId": "4d65249d377b2c3ed8",
            "grantType": "yz_union",
            "inWsc": True,
            "kdtId": KDT_ID
        }
        login_url_full = f"{LOGIN_URL}?kdt_id={KDT_ID}&app_id={APP_ID}"

        try:
            resp = self.session.post(login_url_full, json=login_payload, timeout=REQ_TIMEOUT)
            if resp.status_code != 200:
                print(f"❌ 登录接口异常，状态码: {resp.status_code}")
                return False
            res = resp.json()
            if res.get("code") != 0:
                print(f"❌ 登录失败: {res.get('msg', '未知')}")
                return False

            data = res.get("data", {})
            self.access_token = data.get("accessToken")
            self.session_id = data.get("sessionId")

            if not self.access_token:
                print("❌ 未获取到 access_token")
                return False
            print("✅ 账号登录成功")
            return True
        except requests.exceptions.RequestException as e:
            print(f"❌ 登录请求异常: {str(e)}")
            return False

    def build_url(self, url):
        """拼接通用参数"""
        params = f"app_id={APP_ID}&kdt_id={KDT_ID}&access_token={self.access_token}"
        return f"{url}?{params}"

    def get_user_info(self):
        """获取用户昵称/等级，兼容data为非字典的情况"""
        if not self.access_token:
            return False
        try:
            url = self.build_url(USER_INFO_URL)
            resp = self.session.get(url, timeout=REQ_TIMEOUT)
            res = resp.json()
            if res.get("code") == 0:
                data = res.get("data")
                # 修复：判断data是否为字典，非字典则跳过解析
                if isinstance(data, dict):
                    nick = data.get("nickname", "匿名用户")
                    level = data.get("levelName", "")
                    print(f"👤 账号信息: {nick} {level}")
                else:
                    print("👤 用户信息接口返回数据异常，跳过解析")
                return True
        except Exception as e:
            print(f"⚠️ 获取用户信息异常: {str(e)}")
        return False

    def get_checkin_status(self):
        """查询今日是否已签到、连续签到天数"""
        if not self.access_token:
            return None, 0
        try:
            url = self.build_url(ACTIVITY_URL) + f"&checkinId={CHECKIN_ID}"
            resp = self.session.get(url, timeout=REQ_TIMEOUT)
            res = resp.json()
            if res.get("code") == 0:
                data = res.get("data", {})
                return data.get("isCheckin", False), data.get("continuesDay", 0)
        except Exception as e:
            print(f"⚠️ 查询签到状态异常: {str(e)}")
        return None, 0

    def checkin(self):
        """执行签到"""
        if not self.access_token:
            print("❌ 缺少 access_token，无法签到")
            return False

        try:
            url = self.build_url(CHECKIN_URL) + f"&checkinId={CHECKIN_ID}"
            headers = self.base_headers.copy()
            if self.session_id:
                extra_data = {
                    "is_weapp": 1,
                    "sid": self.session_id,
                    "version": "2.197.11.201",
                    "client": "weapp",
                    "bizEnv": "wsc",
                    "uuid": str(uuid.uuid4()),
                    "ftime": int(time.time() * 1000)
                }
                headers["extra-data"] = json.dumps(extra_data)

            resp = self.session.get(url, headers=headers, timeout=REQ_TIMEOUT)
            res = resp.json()

            if res.get("code") != 0:
                msg = res.get("msg", "未知错误")
                if "已达到上限" in msg or "已签到" in msg:
                    print("ℹ️ 今日已完成签到")
                else:
                    print(f"❌ 签到失败: {msg}")
                return False

            data = res.get("data", {})
            if data.get('success'):
                reward_list = data.get('list', [])
                rewards = []
                for r in reward_list:
                    if r.get('isSuccess'):
                        title = r.get('infos', {}).get('title', '')
                        rewards.append(title)
                reward_str = ', '.join(rewards) if rewards else '未知'
                times = data.get('times', 1)
                print(f"✅ 签到成功! 获得: {reward_str}, 累计{times}次")
                return True
            else:
                print("❌ 签到失败")
                return False
        except Exception as e:
            print(f"⚠️ 签到异常: {str(e)}")
        return False

    def run(self):
        if self.wxid:
            if not self.wxid_login():
                return
        elif not self.access_token:
            print(f"❌ {self.nickname} 未配置wxid或token")
            return

        time.sleep(1)
        self.get_user_info()

        time.sleep(1)
        is_checkin, continues_day = self.get_checkin_status()
        if is_checkin is not None:
            if is_checkin:
                print(f"ℹ️ 今日已签到, 连续{continues_day}天")
                return
            else:
                print(f"📊 当前连续{continues_day}天")

        time.sleep(1)
        self.checkin()

def main():
    print("=" * 50)
    print("a2官方商城签到")
    print("=" * 50)

    clients = []

    # 优先从 YYB 协议获取账号
    YYB_ACCOUNTS = []
    if YYB_BASE_URL:
        YYB_ACCOUNTS = fetch_accounts_from_yyb(YYB_BASE_URL)

    if YYB_ACCOUNTS:
        print(f"\nwxid登录模式 (共{len(YYB_ACCOUNTS)}个账号)")
        print(f"YYB: {YYB_BASE_URL}\n")
        clients = [V2MallWxid(nickname=n, wxid=w) for n, w in YYB_ACCOUNTS]

    elif TOKEN_LIST:
        print(f"\ntoken登录模式 (共{len(TOKEN_LIST)}个账号)\n")
        clients = [V2MallWxid(nickname=f"Token账号{i+1}", access_token=token) for i, token in enumerate(TOKEN_LIST)]

    else:
        print("\n请配置 V2_WXIDS 或 V2_ACCESS_TOKENS")
        return

    print(f"开始执行 [{time.strftime('%Y-%m-%d %H:%M:%S')}]\n")

    for i, client in enumerate(clients, 1):
        print(f"{'='*20} {client.nickname} {'='*20}")
        client.run()
        print()
        if i < len(clients):
            time.sleep(2)

    print(f"{'='*50}")
    print(f"完成 [{time.strftime('%Y-%m-%d %H:%M:%S')}]")
    print(f"{'='*50}")

if __name__ == "__main__":
    main()
