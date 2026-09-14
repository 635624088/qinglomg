"""
全心全意小天鹅 - 合并版
功能：签到 + 打工收蛋 + 养鹅 + 精灵任务，一次登录跑完全部任务
版本：2.0
更新日期：2026年6月18日

账号格式：备注#ucAccessToken（多条用 & 或换行分隔；兼容 @ 分隔符）
环境变量名：qxqyxte
通知：
 - 钉钉机器人：DD_BOT_TOKEN / DD_BOT_SECRET
 - 青龙通知：jie_tz=true 时调用 QLAPI.notify
"""

from datetime import datetime, timedelta
import os, random, hashlib, json, time, sys, hmac, base64, urllib.parse, gzip, zlib
try:
    import requests
except ImportError:
    requests = None
from urllib.request import urlopen, Request
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.error import URLError, HTTPError
from fake_useragent import UserAgent

# ====================== 全局配置 ======================
URLS = "https://littleswanmp.midea.com"
bl_ql_sz = 'qxqyxte'  # 环境变量名
jbxmmz = "全心全意小天鹅-合并版"
ywmz = "qxqyxte"
jbxmbb = "2.0"
jbzzxx = "脚本整理"
jbbbsj = "2026年6月18日"
blgs = '\n#小程序://全心全意小天鹅/ltoC6Q6N0i2escg 里面的\n抓 格式 备注#uc_access_token \n '

log_log = []  # 全局日志收集器

# 钉钉通知配置
DD_BOT_TOKEN = os.getenv('DD_BOT_TOKEN', '')
DD_BOT_SECRET = os.getenv('DD_BOT_SECRET', '')

# YYB 协议配置（用于显示账号昵称）
YYB_BASE_URL = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
REMARK_WXID_MAP = {}  # 备注 -> openid 映射


# ====================== 工具函数 ======================
def sc_ua():
    user_agent = UserAgent()
    return user_agent.random


def fetch_accounts_from_yyb(yyb_base_url):
    """从 YYB 协议获取账号列表"""
    if not yyb_base_url:
        return {}
    try:
        resp = requests.get(f"{yyb_base_url}/accounts", timeout=10)
        data = resp.json()
        if data.get("code") == 0:
            account_map = {}
            for item in data.get("data", []):
                openid = item.get("openid", "")
                nickname = item.get("nickname") or item.get("alias") or ""
                if openid and nickname:
                    account_map[nickname] = openid
            return account_map
    except Exception:
        pass
    return {}


def hs(uc_access_token, bearer_token):
    """构造通用请求头"""
    return {
        "User-Agent": sc_ua(),
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': 'https://servicewechat.com/wx33856a6b31431c6e/148/page-frame.html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Content-Type': 'application/json',
        'xweb_xhr': '1',
        'ucAccessToken': uc_access_token,
        'authorization': f'Bearer {bearer_token}',
    }


def log(msg: str):
    """打印并收集日志"""
    print(msg)
    log_log.append(msg)


def pd():
    """打印脚本信息"""
    print(f'--- {jbxmmz} {jbbbsj} v{jbxmbb} ---\n--- {jbzzxx} ---\n--- 广告区 ---')


def urly(u, h, m="GET", d=None, retries=3, retry_delay=3):
    """通用请求函数（支持 gzip/br/deflate）"""
    for i in range(retries + 1):
        try:
            mu = m.upper()
            data = None
            if mu in ("POST", "POST_DA") and d is not None:
                if mu == "POST":
                    data = json.dumps(d).encode('utf-8') if isinstance(d, dict) else (d.encode('utf-8') if isinstance(d, str) else d)
                else:
                    data = urlencode(d).encode('utf-8') if isinstance(d, dict) else (d.encode('utf-8') if isinstance(d, str) else d)
            req = Request(u, data=data, headers=(h or {}).copy())
            with urlopen(req, timeout=15) as response:
                raw = response.read()
                enc = (response.headers.get('Content-Encoding') or '').lower()
                if 'gzip' in enc:
                    raw = gzip.decompress(raw)
                elif 'br' in enc:
                    try:
                        import brotli
                        raw = brotli.decompress(raw)
                    except Exception:
                        pass
                elif 'deflate' in enc:
                    try:
                        raw = zlib.decompress(raw, -zlib.MAX_WBITS)
                    except Exception:
                        raw = zlib.decompress(raw)
                return json.loads(raw.decode('utf-8'))
        except (URLError, HTTPError, json.JSONDecodeError, Exception) as e:
            if i < retries:
                print(f"❌ 请求失败: {e} | 重试 {i+1}/{retries}，{retry_delay}s 后重试")
                time.sleep(retry_delay)
            else:
                print(f"❌ 请求失败: {e} | 已达最大重试次数")
                return None


def acc(v):
    """解析账号：支持 json 文件、txt 文件、环境变量；兼容 # 和 @ 分隔符"""
    def parse(s):
        return [x.strip() for x in (s.replace("&", "\n").split("\n") if isinstance(s, str) else s) if x.strip()]

    def parse_line(line):
        line = line.strip()
        if not line or line.startswith('//') or line.startswith('#'):
            return None
        if '#' in line:
            parts = line.split('#')
        elif '@' in line:
            parts = line.split('@')
        else:
            print(f"⚠️ 账号格式错误，跳过: {line}")
            return None
        if len(parts) >= 2:
            bz = parts[0].strip()
            token = parts[1].strip()
            if token and len(token) > 10:
                return f"{bz}#{token}"
            else:
                print(f"⚠️ token格式错误，跳过: {bz}")
        else:
            print(f"⚠️ 账号格式错误，跳过: {line}")
        return None

    jf, tf = f"{v}.json", f"{v}.txt"
    if os.path.exists(jf):
        return [f"{'#'.join([val[k] for k in val if k.lower().startswith('ck') and val[k]])}#{key}"
                for key, val in json.load(open(jf, "r", encoding="utf-8")).items()]
    if os.path.exists(tf):
        lines = parse(open(tf, "r", encoding="utf-8").read())
        return [x for x in (parse_line(line) for line in lines) if x]
    ev = os.getenv(v)
    if ev:
        print(f"🌍加载账号ing")
        lines = parse(ev)
        results = [x for x in (parse_line(line) for line in lines) if x]
        
        # 用 YYB 协议补充昵称
        yyb_map = fetch_accounts_from_yyb(YYB_BASE_URL) if YYB_BASE_URL else {}
        if yyb_map:
            enriched = []
            for item in results:
                if '#' in item:
                    remark = item.split('#')[0]
                    openid = yyb_map.get(remark, '')
                    if openid:
                        REMARK_WXID_MAP[remark] = openid
                enriched.append(item)
            print(f"  📦 YYB 协议辅助: 获取到 {len(yyb_map)} 个账号 nicknames")
        return results
    print(f"⚠️ 环境变量 {v} 未设置 {blgs}")
    return []


def jie_tz():
    """青龙通知"""
    msg = "\n\n".join(log_log)
    if os.getenv("jie_tz", "False").lower() == "true":
        try:
            QLAPI.notify(jbxmmz, msg)
            print("📢 通知已发送")
        except Exception:
            print("📢 通知发送失败（QLAPI可能未定义）")
    else:
        print("🔕 已关闭青龙通知")


def dingtalk_send_notify(title, content):
    """发送钉钉机器人通知"""
    if not DD_BOT_TOKEN:
        return False
    try:
        message = {
            "msgtype": "markdown",
            "markdown": {
                "title": title,
                "text": f"## {title}\n\n{content}\n\n> 📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            }
        }
        timestamp = str(round(time.time() * 1000))
        if DD_BOT_SECRET:
            secret_enc = DD_BOT_SECRET.encode('utf-8')
            string_to_sign = f'{timestamp}\n{DD_BOT_SECRET}'
            string_to_sign_enc = string_to_sign.encode('utf-8')
            hmac_code = hmac.new(secret_enc, string_to_sign_enc, digestmod=hashlib.sha256).digest()
            sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
            url = f'https://oapi.dingtalk.com/robot/send?access_token={DD_BOT_TOKEN}&timestamp={timestamp}&sign={sign}'
        else:
            url = f'https://oapi.dingtalk.com/robot/send?access_token={DD_BOT_TOKEN}'
        headers = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}
        req = Request(url, data=json.dumps(message).encode('utf-8'), headers=headers)
        with urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode('utf-8'))
            if result.get('errcode') == 0:
                print(f"📢 钉钉通知发送成功")
                return True
            else:
                print(f"⚠️ 钉钉通知发送失败: {result.get('errmsg', '未知错误')}")
                return False
    except Exception as e:
        print(f"⚠️ 钉钉通知异常: {e}")
        return False


def generate_notification(success_accounts, failed_accounts, total_increase=0):
    """生成优化后的通知内容"""
    global log_log
    log_log = []

    total = len(success_accounts) + len(failed_accounts)
    success_count = len(success_accounts)
    failed_count = len(failed_accounts)

    title = f"🔔 {jbxmmz} 执行完成"
    content = []
    content.append(f"📊 账号总数: {total}")
    content.append(f"✅ 成功账号: {success_count}")
    content.append(f"❌ 失败账号: {failed_count}")

    if total_increase > 0:
        content.append(f"💰 贝壳增加: +{total_increase}")

    if failed_count > 0:
        content.append("\n📝 失败账号详情:")
        for i, account in enumerate(failed_accounts, 1):
            content.append(f"  {i}. {account}")

    notification = f"{title}\n{'-'*30}\n" + "\n".join(content)
    log_log.append(notification)
    print(f"\n{'='*50}")
    print(notification)
    print(f"{'='*50}")


# ====================== 通用登录 ======================
def swan_get_bearer_token(bz, uc_access_token):
    """小天鹅-获取bearer_token"""
    url = 'https://littleswanmp.midea.com/api/auth/login/uc_token'
    headers = {
        'User-Agent': sc_ua(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'ucAccessToken': uc_access_token,
        'charset': 'utf-8',
        'Referer': 'https://servicewechat.com/wx33856a6b31431c6e/148/page-frame.html'
    }
    body = {'uc_token': uc_access_token}

    res = urly(url, headers, m="POST_DA", d=body)
    if res is None:
        print(f"{bz} ❌ 获取bearer_token请求失败")
        return None

    code = res.get('code')
    if code == 200:
        access_token = res.get('content', {}).get('access_token')
        if access_token:
            print(f"{bz} ✅ 成功获取bearer_token")
            return access_token
        else:
            print(f"{bz} ❌ bearer_token响应中缺少access_token")
            return None
    else:
        print(f"{bz} ❌ 获取bearer_token失败: code={code} msg={res.get('chnDesc') or res.get('engDesc')}")
        return None


# ====================== 签到逻辑 ======================
def _parse_channel_id_from_long_url(long_url):
    try:
        pr = urlparse(long_url or '')
        frag = pr.fragment or ''
        qs_str = frag.split('?', 1)[1] if '?' in frag else pr.query
        params = parse_qs(qs_str, keep_blank_values=True)
        return params.get('channelId', [None])[0]
    except Exception:
        return None


def _parse_actv_id_from_long_url(long_url):
    try:
        pr = urlparse(long_url or '')
        frag = pr.fragment or ''
        qs_str = frag.split('?', 1)[1] if '?' in frag else pr.query
        params = parse_qs(qs_str, keep_blank_values=True)
        return params.get('actvId', [None])[0]
    except Exception:
        return None


def _is_signed_today_from_init_data(init_data):
    try:
        lst = init_data[0].get('rollSignList', [])
        item = next((x for x in lst if x.get('isToday') is True), None)
        if not item:
            today = datetime.now().strftime('%Y%m%d')
            item = next((x for x in lst if x.get('signDate') == today), None)
        return bool(item and str(item.get('signStatus')) == '3')
    except Exception:
        return False


def swan_signin2_step1(bz, uc_access_token):
    """签到2任务 - 步骤1：转换token获取用户信息"""
    url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/common/login/convertUcAccessToken'
    headers = {
        'User-Agent': sc_ua(),
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'appId': 'QLZZ9Fr7w2to',
        'apiKey': '3660663068894a0d9fea574c2673f3c0',
        'Origin': 'https://weixin.midea.com',
        'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    }
    body = {
        "headParams": {"language": "CN", "originSystem": "MCSP", "timeZone": "", "userCode": "", "tenantCode": "", "userKey": "TEST_", "transactionId": ""},
        "pagination": None,
        "restParams": {"ucAccessToken": uc_access_token, "rootCode": "XTE", "imUserId": "", "uid": "", "openId": "", "unionId": ""}
    }
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 步骤1请求失败")
        return None
    if res.get('code') == "000000":
        print(f"{bz} ✅ 步骤1成功: 获取用户信息")
        return res.get('data', {})
    else:
        print(f"{bz} ❌ 步骤1失败: {res.get('msg')}")
        return None


def swan_signin2_step2_1_get_c4a_token(bz, uc_access_token, user_data, bearer_jwt=None, mobile_override=None, openid_override=None):
    """步骤2.1：换取 C4aToken(jwtToken)"""
    url = 'https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/token/exchange/getC4aToken.do'
    headers = {
        'User-Agent': sc_ua(),
        'Content-Type': 'application/json',
        'ucAccessToken': uc_access_token,
        'charset': 'utf-8',
        'Referer': 'https://servicewechat.com/wx33856a6b31431c6e/148/page-frame.html',
    }
    if bearer_jwt:
        headers['authorization'] = f'Bearer {bearer_jwt}'
    mobile = mobile_override if mobile_override is not None else user_data.get('phone') or ''
    openid = openid_override if openid_override is not None else user_data.get('openId') or ''
    body = {"restParams": {"mobile": str(mobile), "appId": "10080", "openid": str(openid)}}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 步骤2.1请求失败")
        return None
    if res.get('code') == '000000':
        print(f"{bz} ✅ 步骤2.1成功: 获取jwtToken")
        return res.get('data')
    print(f"{bz} ❌ 步骤2.1失败: {res.get('msg')}")
    return None


def swan_signin2_step2_2_get_long_url(bz, uc_access_token, user_data, jwt_token, short_url='https://d.midea.com/d/L1AbJNjWiQw'):
    """步骤2.2：通过 jwtToken 获取长链接"""
    url = 'https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/im-svr/cmimp/user/login/enc/getLongUrlByToken'
    headers = {
        'User-Agent': sc_ua(),
        'Content-Type': 'application/json',
        'ucAccessToken': uc_access_token,
        'charset': 'utf-8',
        'Referer': 'https://servicewechat.com/wx33856a6b31431c6e/148/page-frame.html',
    }
    rest = {
        "brand": 2, "sourceSys": "LSWX",
        "unionId": user_data.get('unionId', ''),
        "openId": user_data.get('openId', ''),
        "uid": user_data.get('uid', ''),
        "rootCode": "XTE", "appCode": "XTE_SHG",
        "shortUrl": short_url,
        "jwtToken": jwt_token,
        "ucToken": uc_access_token,
    }
    body = {"pagination": {}, "restParams": rest, "openid": user_data.get('openId', '')}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 步骤2.2请求失败")
        return None, None, None
    if res.get('code') == '000000':
        long_url = res.get('data')
        channel_id = _parse_channel_id_from_long_url(long_url or '')
        actv_id = _parse_actv_id_from_long_url(long_url or '')
        return long_url, channel_id, actv_id
    print(f"{bz} ❌ 步骤2.2失败: {res.get('msg')}")
    return None, None, None


def swan_signin2_step2_3_get_actv_info(bz, actv_id, channel_id):
    """步骤2.3：获取活动信息"""
    url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/cmimp/activity/getActvInfo'
    headers = {
        'User-Agent': sc_ua(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Content-Type': 'application/json',
        'appId': 'QLZZ9Fr7w2to',
        'apiKey': '3660663068894a0d9fea574c2673f3c0',
        'Origin': 'https://weixin.midea.com',
        'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'X-Requested-With': 'com.tencent.mm',
    }
    body = {
        "headParams": {"language": "CN", "originSystem": "MCSP", "timeZone": "", "userCode": "", "tenantCode": "", "userKey": "TEST_", "transactionId": ""},
        "pagination": None,
        "restParams": {"actvId": str(actv_id), "rootCode": "XTE", "appCode": "XTE_SHG", "channelId": str(channel_id), "imUserId": "", "uid": "", "openId": "", "unionId": ""}
    }
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 步骤2.3请求失败")
        return None
    if res.get('code') == '000000':
        print(f"{bz} ✅ 步骤2.3成功: 活动信息已获取")
        return res.get('data')
    print(f"{bz} ❌ 步骤2.3失败: {res.get('msg')}")
    return None


def swan_signin2_step2_4_init_data(bz, uc_access_token, actv_id, channel_id, user_data, im_user_data):
    """步骤2.5：initData"""
    url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/cmimp/activity/initData'
    headers = {
        'User-Agent': sc_ua(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Content-Type': 'application/json',
        'appId': 'QLZZ9Fr7w2to',
        'apiKey': '3660663068894a0d9fea574c2673f3c0',
        'Origin': 'https://weixin.midea.com',
        'X-Requested-With': 'com.tencent.mm',
        'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    }
    body = {
        "headParams": {"language": "CN", "originSystem": "MCSP", "timeZone": "", "userCode": "", "tenantCode": "", "userKey": "TEST_", "transactionId": ""},
        "pagination": None,
        "restParams": {
            "actvId": str(actv_id), "rootCode": "XTE", "appCode": "XTE_SHG",
            "userType": 1, "openId": user_data.get('openId', ''),
            "templateId": "2", "channelId": str(channel_id), "wasLogin": True,
            "imUserId": im_user_data.get('imUserId', ''),
            "uid": user_data.get('uid', ''),
            "unionId": user_data.get('unionId', ''),
        }
    }
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 步骤2.5请求失败")
        return None
    if res.get('code') == '000000':
        return res.get('data')
    print(f"{bz} ❌ 步骤2.5失败: {res.get('msg')}")
    return None


def swan_signin2_step4(bz, user_data, actv_id):
    """步骤2.4：注册用户获取imUserId"""
    url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/common/login/register'
    headers = {
        'User-Agent': sc_ua(),
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'appId': 'QLZZ9Fr7w2to',
        'apiKey': '3660663068894a0d9fea574c2673f3c0',
        'Origin': 'https://weixin.midea.com',
        'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    }
    body = {
        "headParams": {"language": "CN", "originSystem": "MCSP", "timeZone": "", "userCode": "", "tenantCode": "", "userKey": "TEST_", "transactionId": ""},
        "pagination": None,
        "restParams": {
            "uid": user_data.get('uid', ''),
            "openId": user_data.get('openId', ''),
            "unionId": user_data.get('unionId', ''),
            "phone": "",
            "actvId": str(actv_id),
            "rootCode": "XTE",
            "appCode": "XTE_SHG",
            "imUserId": ""
        }
    }
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 步骤2.4请求失败")
        return None
    if res.get('code') == "000000":
        print(f"{bz} ✅ 步骤2.4成功: 注册用户获取imUserId")
        return res.get('data', {})
    else:
        print(f"{bz} ❌ 步骤2.4失败: {res.get('msg')}")
        return None


def swan_signin2_step3(bz, uc_access_token, user_data, im_user_data, actv_id):
    """步骤3：执行签到操作"""
    url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/im/game/page/sign'
    headers = {
        'User-Agent': sc_ua(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Content-Type': 'application/json',
        'appId': 'QLZZ9Fr7w2to',
        'sec-ch-ua-platform': '"Android"',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Android WebView";v="138"',
        'ucAccessToken': uc_access_token,
        'sec-ch-ua-mobile': '?1',
        'apiKey': '3660663068894a0d9fea574c2673f3c0',
        'Origin': 'https://weixin.midea.com',
        'X-Requested-With': 'com.tencent.mm',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    }
    body = {
        "headParams": {"language": "CN", "originSystem": "MCSP", "timeZone": "", "userCode": "", "tenantCode": "", "userKey": "TEST_", "transactionId": ""},
        "pagination": None,
        "restParams": {
            "gameId": 9,
            "actvId": str(actv_id),
            "rootCode": "XTE",
            "appCode": "XTE_SHG"
        }
    }
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 步骤3请求失败")
        return None
    if res.get('code') == "000000":
        data = res.get('data', {})
        if data.get('result', False):
            prize = data.get('prizeDto', {})
            prize_name = prize.get('name', '未知奖励')
            consecutive_days = data.get('consecutiveDays', '0')
            log(f"{bz} ✅奖励 {prize_name}, 签到{consecutive_days}天")
        else:
            log(f"{bz} ⚠️步骤3: 已签到")
        return data
    else:
        print(f"{bz} ❌ 步骤3失败: {res.get('msg')}")
        return None


def swan_signin2(bz, uc_access_token):
    """签到2任务 - 完整流程"""
    print(f"{bz} 🎯 开始签到2任务...")

    user_data = swan_signin2_step1(bz, uc_access_token)
    if user_data is None:
        return None

    actv_id = None
    channel_id = None
    for attempt in range(3):
        jwt_token = swan_signin2_step2_1_get_c4a_token(bz, uc_access_token, user_data)
        if not jwt_token:
            continue
        long_url, temp_channel_id, temp_actv_id = swan_signin2_step2_2_get_long_url(bz, uc_access_token, user_data, jwt_token)
        if not long_url or not temp_channel_id or not temp_actv_id:
            continue
        test_result = swan_signin2_step2_3_get_actv_info(bz, temp_actv_id, temp_channel_id)
        if test_result:
            actv_id = temp_actv_id
            channel_id = temp_channel_id
            print(f"{bz} ✅ 第{attempt + 1}次尝试成功: actvId={actv_id}, channelId={channel_id}")
            break
        else:
            print(f"{bz} ❌ 第{attempt + 1}次尝试: 活动信息验证失败")

    if not actv_id or not channel_id:
        actv_id = '401668349848950807'
        channel_id = '401668349999945746'
        print(f"{bz} ⚠️ 3次尝试均失败，使用兜底值: actvId={actv_id}, channelId={channel_id}")
        _ = swan_signin2_step2_3_get_actv_info(bz, actv_id, channel_id)

    im_user_data = swan_signin2_step4(bz, user_data, actv_id)
    if im_user_data is None:
        return None

    init_data = swan_signin2_step2_4_init_data(bz, uc_access_token, actv_id, channel_id, user_data, im_user_data)
    if init_data and _is_signed_today_from_init_data(init_data):
        log(f"{bz} ✅ 今日已签到")
        return {"skipped": True, "reason": "already_signed"}

    sign_result = swan_signin2_step3(bz, uc_access_token, user_data, im_user_data, actv_id)
    print(f"{bz} 🎯 签到2任务完成")
    return sign_result


# ====================== 打工收蛋逻辑 ======================
def get_user_info(bz, uc_access_token, bearer_token):
    """获取用户信息"""
    url = f"{URLS}/api/web/mobile/swan/getSwanByToken"
    headers = hs(uc_access_token, bearer_token)
    res = urly(url, headers, m="GET")
    if res is None:
        print(f"{bz} ❌ 获取用户信息失败")
        return None
    code = res.get('code')
    if code in (0, 200, '0', '200'):
        return res.get('content', {})
    else:
        print(f"{bz} ⚠️ 获取用户信息失败: {res.get('chnDesc') or res.get('engDesc') or f'错误代码: {code}'}")
        return None


def gain_work_prize(bz, uc_access_token, bearer_token):
    """领取打工奖励"""
    url = f"{URLS}/api/web/mobile/swan/userGainWorkPrize"
    headers = hs(uc_access_token, bearer_token)
    print(f"{bz} 🔄 正在领取打工奖励...")
    res = urly(url, headers, m="POST", d={})
    if res is None:
        print(f"{bz} ❌ 领取失败")
        return None
    code = res.get('code')
    if code == 200:
        print(f"{bz} ✅ 领取成功")
        return res.get('content', {})
    else:
        print(f"{bz} ⚠️ 领取失败: {res.get('chnDesc') or res.get('engDesc') or f'错误代码: {code}'}")
        return None


def process_work_prize(bz, uc_access_token, bearer_token):
    """处理单个账号打工收蛋，返回 (success, increase)"""
    old_user_info = get_user_info(bz, uc_access_token, bearer_token)
    if old_user_info is None:
        return False, 0

    old_shells = old_user_info.get('shellAmount', 0)
    swan_nick = old_user_info.get('swanNick', '未知')
    print(f"{bz} 👤 用户: {swan_nick}")
    print(f"{bz} 📊 当前贝壳: {old_shells}")

    prize_result = gain_work_prize(bz, uc_access_token, bearer_token)
    if prize_result is None:
        return False, 0

    time.sleep(2)
    new_user_info = get_user_info(bz, uc_access_token, bearer_token)
    if new_user_info:
        new_shells = new_user_info.get('shellAmount', 0)
        print(f"{bz} 📊 领取后贝壳: {new_shells}")
        if new_shells > old_shells:
            increase = new_shells - old_shells
            print(f"{bz} ✅ 贝壳增加: +{increase}")
            return True, increase
        else:
            print(f"{bz} ℹ️ 贝壳未变化")
            return True, 0
    return False, 0


# ====================== 养鹅逻辑 ======================
def grzx(bz, uc_access_token, bearer_token):
    """个人中心信息"""
    url = f"{URLS}/api/web/mobile/swan/getSwanByToken"
    headers = hs(uc_access_token, bearer_token)
    res = urly(url, headers, m="GET")
    if res is None:
        print(f"{bz} ❌ 个人中心请求失败")
        return None

    code = res.get('code') if isinstance(res, dict) else None
    if code in (0, 200, '0', '200'):
        content = res.get('content') if isinstance(res, dict) else None
        if isinstance(content, dict):
            swan_nick = content.get('swanNick')
            level_name = content.get('levelName')
            level = content.get('level')
            growth_stage_name = content.get('growthStageName')
            shell_amount = content.get('shellAmount')
            start_working_time = content.get('startWorkingTime')

            if start_working_time:
                try:
                    start_time = datetime.fromisoformat(start_working_time.replace('Z', '+00:00'))
                    current_time = datetime.now(start_time.tzinfo) if start_time.tzinfo else datetime.now()
                    time_diff = current_time - start_time
                    work_duration_hours = time_diff.total_seconds() / 3600
                    work_interval_hours = 9
                    if work_duration_hours < work_interval_hours:
                        remaining_hours = work_interval_hours - work_duration_hours
                        working_status = f"工作中 (还需{remaining_hours:.1f}h)"
                    else:
                        working_status = f"可重新工作 (已工作{work_duration_hours:.1f}h)"
                except Exception:
                    working_status = "工作中 (时间解析失败)"
            else:
                working_status = "未打工"
            log(f"{bz} 👤 {swan_nick} | {level_name}(Lv{level}) | {growth_stage_name} | 贝壳: {shell_amount} | 工作状态: {working_status}")
            return {
                'swanNick': swan_nick, 'levelName': level_name, 'level': level,
                'growthStageName': growth_stage_name, 'shellAmount': shell_amount,
                'startWorkingTime': start_working_time,
            }
        else:
            print(f"{bz} ⚠️ 个人中心无内容")
            return None
    else:
        print(f"{bz} ⚠️ 个人中心返回异常: code={code}")
        return res


def swan_start_working(bz, uc_access_token, bearer_token, growth_stage_name=None, start_working_time=None):
    """开始工作"""
    if growth_stage_name and growth_stage_name != "鹅仔期":
        print(f"{bz} ⚠️ 当前成长阶段为 {growth_stage_name}，只有鹅仔期才能开始工作")
        return None

    if start_working_time:
        try:
            start_time = datetime.fromisoformat(start_working_time.replace('Z', '+00:00'))
            current_time = datetime.now(start_time.tzinfo) if start_time.tzinfo else datetime.now()
            time_diff = current_time - start_time
            work_duration_hours = time_diff.total_seconds() / 3600
            work_interval_hours = 9
            if work_duration_hours < work_interval_hours:
                remaining_hours = work_interval_hours - work_duration_hours
                remaining_minutes = int(remaining_hours * 60)
                print(f"{bz} ⚠️ 天鹅正在工作中，开始时间: {start_working_time}")
                print(f"{bz} ⏰ 还需等待约 {remaining_hours:.1f} 小时 ({remaining_minutes} 分钟) 才能重新工作")
                return None
            else:
                print(f"{bz} ✅ 工作已完成，可以重新开始工作 (已工作 {work_duration_hours:.1f} 小时)")
        except Exception as e:
            print(f"{bz} ⚠️ 解析工作时间失败: {e}，开始时间: {start_working_time}")
            return None

    url = f'{URLS}/api/web/mobile/swan/swanStartWorking'
    headers = hs(uc_access_token, bearer_token)
    body = {}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 开始工作请求失败")
        return None

    code = res.get('code') if isinstance(res, dict) else None
    chn_desc = res.get('chnDesc') if isinstance(res, dict) else None
    eng_desc = res.get('engDesc') if isinstance(res, dict) else None
    if code == 200:
        log(f"{bz} ✅ 开始工作成功: {chn_desc}")
        return res
    elif code == 1004:
        log(f"{bz} ⚠️ 开始工作失败: {chn_desc}")
        return res
    else:
        print(f"{bz} ⚠️ 开始工作返回异常: code={code} msg={chn_desc or eng_desc}")
        return res


def swan_gain_prize_by_rule(bz, uc_access_token, bearer_token):
    """养鹅-按规则领取奖励"""
    url = f'{URLS}/api/web/mobile/swan/userGainPrizeByRule'
    headers = hs(uc_access_token, bearer_token)
    headers['Content-Length'] = '2'
    headers['Host'] = 'littleswanmp.midea.com'
    body = {}
    res = urly(url, headers, m="POST", d={}, retries=5, retry_delay=2)
    if res is None:
        print(f"{bz} ❌ userGainPrizeByRule 请求失败")
        return None

    code = res.get('code') if isinstance(res, dict) else None
    if code in (0, 200, '0', '200'):
        content = res.get('content') if isinstance(res, dict) else None
        if isinstance(content, list):
            print(f"{bz} 额外奖励条目: {len(content)}")
            for i, item in enumerate(content, 1):
                if not isinstance(item, dict):
                    continue
                rule_name = item.get('ruleName')
                prize_name = item.get('prizeName')
                delta = item.get('changeValue')
                success = '是' if item.get('success') else '否'
                print(f"{bz} [+{delta}] {rule_name} -> {prize_name} | 成功: {success}")
        else:
            print(f"{bz} 无额外奖励或已领取")
    else:
        print(f"{bz} ⚠️ userGainPrizeByRule 返回异常: code={code}")
    return res


def rwlb_swan(bz, uc_access_token, bearer_token):
    """养鹅-任务中心列表"""
    url = f'{URLS}/api/web/mobile/swanPrize/queryPrizeRuleUserComplete'
    headers = hs(uc_access_token, bearer_token)
    body = {"ruleType": "1", "ruleClass": "3"}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 请求失败")
        return None

    code = res.get('code') if isinstance(res, dict) else None
    msg = res.get('msg') if isinstance(res, dict) else None
    if code in (0, 200, '0', '200'):
        content = res.get('content') if isinstance(res, dict) else None
        if isinstance(content, list):
            print(f"{bz} 任务数: {len(content)}")
            uncompleted = []
            for i, item in enumerate(content, 1):
                if not isinstance(item, dict):
                    continue
                rule_name = item.get('ruleName')
                completed_flag = bool(item.get('isUserCompleted'))
                print(f"{bz} [{i}] {rule_name} | {'是' if completed_flag else '否'}")
                if not completed_flag:
                    uncompleted.append(item)

            if uncompleted:
                print(f"{bz} 🔄 发现 {len(uncompleted)} 个未完成任务，开始自动完成...")
                for idx, task in enumerate(uncompleted, 1):
                    rule_id = task['id']
                    rule_name = task['ruleName']
                    print(f"{bz} ▶️ 开始任务: {rule_name} ({rule_id})")
                    br = swan_begin_task(bz, uc_access_token, bearer_token, rule_id)
                    if br is None or (isinstance(br, dict) and br.get('code') not in (0, 200, '0', '200')):
                        print(f"{bz} ❌ 开始任务失败: {rule_name}")
                        continue
                    time.sleep(1)
                    cr = swan_complete_task(bz, uc_access_token, bearer_token, rule_id)
                    if cr is None or (isinstance(cr, dict) and cr.get('code') not in (0, 200, '0', '200')):
                        print(f"{bz} ❌ 完成任务失败: {rule_name}")
                    else:
                        print(f"{bz} 🎉 完成任务成功: {rule_name}")
            else:
                print(f"{bz} ✅ 所有任务已完成")
        else:
            print(f"{bz} ⚠️ 返回异常: code={code} msg={msg}")
    return res


def swan_begin_task(bz, uc_access_token, bearer_token, rule_id):
    """养鹅-开始任务"""
    url = f'{URLS}/api/web/mobile/swanPrize/beginTask'
    headers = hs(uc_access_token, bearer_token)
    body = {"ruleId": str(rule_id)}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ beginTask 请求失败 ruleId={rule_id}")
    return res


def swan_complete_task(bz, uc_access_token, bearer_token, rule_id):
    """养鹅-完成任务"""
    url = f'{URLS}/api/web/mobile/swanPrize/completeTask'
    headers = hs(uc_access_token, bearer_token)
    body = {"ruleId": str(rule_id)}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ completeTask 请求失败 ruleId={rule_id}")
    return res


def swan_feed_grass(bz, uc_access_token, bearer_token):
    """喂草，循环直到青草不足"""
    url = f'{URLS}/api/web/mobile/swan/feedGrass'
    headers = hs(uc_access_token, bearer_token)
    body = {}
    feed_count = 0

    while True:
        res = urly(url, headers, m="POST", d=body)
        if res is None:
            print(f"{bz} ❌ 喂草请求失败")
            break

        code = res.get('code') if isinstance(res, dict) else None
        chn_desc = res.get('chnDesc') if isinstance(res, dict) else None
        eng_desc = res.get('engDesc') if isinstance(res, dict) else None

        if code == 200:
            feed_count += 1
            print(f"{bz} ✅ 第{feed_count}次喂草成功: {chn_desc}")
            content = res.get('content')
            if isinstance(content, dict):
                swan_nick = content.get('swanNick', '未知')
                growth_stage_name = content.get('growthStageName', '未知')
                grass_amount = content.get('grassAmount', 0)
                print(f"{bz} 🦢 天鹅昵称: {swan_nick} {growth_stage_name}")
                print(f"{bz} 🌱 青草数量: {grass_amount}")
                sleep_time = random.randint(5, 10)
                print(f"{bz} 😴 休眠{sleep_time}秒后继续喂草...")
                time.sleep(sleep_time)
        elif code == 400:
            print(f"{bz} ⚠️ 喂草失败: {chn_desc}")
            if feed_count > 0:
                print(f"{bz} 📊 总共成功喂草{feed_count}次")
            break
        else:
            print(f"{bz} ⚠️ 喂草返回异常: code={code} msg={chn_desc or eng_desc}")
            break
    return res


# ====================== 精灵任务逻辑 ======================
def rwlb(bz, uc_access_token, bearer_token):
    """精灵-任务中心列表"""
    url = f"{URLS}/api/web/mobile/avatarRule/queryPrizeRuleUserComplete"
    headers = hs(uc_access_token, bearer_token)
    body = {"ruleTypeId": "1", "ruleClassId": "2", "seq": 0}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ 请求失败")
        return None

    code = res.get('code') if isinstance(res, dict) else None
    chn_desc = res.get('chnDesc') if isinstance(res, dict) else None
    if code in (0, 200, '0', '200'):
        content = res.get('content') if isinstance(res, dict) else None
        if isinstance(content, list):
            print(f"{bz} 任务数: {len(content)}")
            uncompleted = []
            for i, item in enumerate(content, 1):
                if not isinstance(item, dict):
                    continue
                rule_name = item.get('ruleName')
                completed_flag = bool(item.get('isUserCompleted'))
                print(f"{bz} [{i}] {rule_name} | {'是' if completed_flag else '否'}")
                if not completed_flag:
                    uncompleted.append(item)

            if uncompleted:
                print(f"{bz} 🔄 发现 {len(uncompleted)} 个未完成任务，开始自动完成…")
                for idx, task in enumerate(uncompleted, 1):
                    rid = str(task.get('id'))
                    rname = task.get('ruleName', '')
                    ti = int(task.get('timeInterval', 0) or 0)
                    wait_base = max(1, ti)
                    jitter = random.randint(1, 3)
                    actual_wait = wait_base + jitter

                    print(f"\n{bz}▶️ 开始任务: {rname} ({rid})")
                    br = ksrw_tj1(bz, uc_access_token, bearer_token, rid)
                    if br is None or (isinstance(br, dict) and br.get('code') not in (0, 200, '0', '200')):
                        print(f"{bz} ❌ 开始任务失败: {rname}")
                        continue

                    if actual_wait > 0:
                        print(f"{bz} ⏳ 等待 {actual_wait}s 冷却…")
                        time.sleep(actual_wait)
                    cr = ksrw_dd2(bz, uc_access_token, bearer_token, rid)

                    if cr is None or (isinstance(cr, dict) and cr.get('code') not in (0, 200, '0', '200')):
                        print(f"{bz} ❌ 完成任务失败: {rname}")
                    else:
                        log(f"{bz} ✅ 任务完成: {rname}")
            else:
                log(f"{bz} ✅ 所有任务已完成")
        else:
            print(f"{bz} 无任务数据")
    else:
        print(f"{bz} ⚠️ 返回异常: code={code} msg={chn_desc}")
    return res


def ksrw_tj1(bz, uc_access_token, bearer_token, rule_id):
    """精灵-开始任务第一步"""
    url = f"{URLS}/api/web/mobile/avatarRule/beginTask"
    headers = hs(uc_access_token, bearer_token)
    body = {"ruleId": str(rule_id)}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ beginTask 请求失败 ruleId={rule_id}")
    else:
        code = res.get('code') if isinstance(res, dict) else None
        if code in (0, 200, '0', '200'):
            print("")
        else:
            print(f"{bz} ⚠️ beginTask 返回异常: code={code}")
    return res


def ksrw_dd2(bz, uc_access_token, bearer_token, rule_id):
    """精灵-完成任务"""
    url = f"{URLS}/api/web/mobile/avatarRule/completeTask"
    headers = hs(uc_access_token, bearer_token)
    body = {"ruleId": str(rule_id)}
    res = urly(url, headers, m="POST", d=body)
    if res is None:
        print(f"{bz} ❌ completeTask 请求失败 ruleId={rule_id}")
        return None

    code = res.get('code') if isinstance(res, dict) else None
    if code in (0, 200, '0', '200'):
        print(f"{bz} 🎉 领取成功")
    else:
        chn_desc = res.get('chnDesc') if isinstance(res, dict) else None
        print(f"{bz} ⚠️ completeTask 返回异常: code={code} msg={chn_desc}")
    return res


def avatar_gain_prize_by_rule(bz, uc_access_token, bearer_token):
    """精灵-奖励汇总/补发"""
    url = f"{URLS}/api/web/mobile/avatarRule/userGainPrizeByRule"
    headers = hs(uc_access_token, bearer_token)
    res = urly(url, headers, m="POST", d={}, retries=5, retry_delay=2)
    if res is None:
        print(f"{bz} ❌ userGainPrizeByRule 请求失败")
        return None

    code = res.get('code') if isinstance(res, dict) else None
    if code in (0, 200, '0', '200'):
        content = res.get('content') if isinstance(res, dict) else None
        if isinstance(content, list):
            if len(content) > 0:
                print(f"{bz} 有 {len(content)} 个额外奖励")
            else:
                print(f"{bz} 无额外奖励")
        else:
            print(f"{bz} 无额外奖励或已领取")
    else:
        print(f"{bz} ⚠️ userGainPrizeByRule 返回异常: code={code}")
    return res


# ====================== 主程序 ======================
def main():
    pd()
    ts = acc(bl_ql_sz)

    success_accounts = []
    failed_accounts = []
    total_increase = 0

    for i, t in enumerate(ts, 1):
        p = [x.strip() for x in t.split('#') if x.strip()]
        if len(p) < 2:
            print(f"⚠️ 数据错误 跳过{i}")
            failed_accounts.append(f"账号{i}: 格式错误")
            continue

        bz, uc_access_token = p[0], p[1]
        print(f"\n{'='*50}")
        print(f"📝 进度: {i}/{len(ts)} | 账号: {bz}")
        print(f"{'='*50}")

        account_success = True
        account_error = None

        # 1. 登录
        bearer_token = swan_get_bearer_token(bz, uc_access_token)
        if bearer_token is None:
            failed_accounts.append(f"{bz}: 无法获取bearer_token")
            continue

        # 2. 个人中心（为养鹅/收蛋提供基础信息）
        user_info = grzx(bz, uc_access_token, bearer_token)
        if user_info is None:
            failed_accounts.append(f"{bz}: 获取个人中心信息失败")
            continue

        growth_stage_name = user_info.get('growthStageName')
        start_working_time = user_info.get('startWorkingTime')

        # 3. 签到
        sign_result = swan_signin2(bz, uc_access_token)
        if sign_result is None:
            account_success = False
            account_error = "签到失败"

        # 4. 打工收蛋
        work_ok, increase = process_work_prize(bz, uc_access_token, bearer_token)
        total_increase += increase
        if not work_ok:
            account_success = False
            account_error = account_error or "打工收蛋失败"

        # 5. 开始工作
        swan_start_working(bz, uc_access_token, bearer_token, growth_stage_name, start_working_time)

        # 6. 养鹅额外奖励
        if swan_gain_prize_by_rule(bz, uc_access_token, bearer_token) is None:
            account_success = False
            account_error = account_error or "养鹅额外奖励失败"

        # 7. 精灵任务
        if rwlb(bz, uc_access_token, bearer_token) is None:
            account_success = False
            account_error = account_error or "精灵任务失败"

        # 8. 精灵额外奖励
        if avatar_gain_prize_by_rule(bz, uc_access_token, bearer_token) is None:
            account_success = False
            account_error = account_error or "精灵额外奖励失败"

        # 9. 养鹅任务列表
        if rwlb_swan(bz, uc_access_token, bearer_token) is None:
            account_success = False
            account_error = account_error or "养鹅任务失败"

        # 10. 喂草
        if swan_feed_grass(bz, uc_access_token, bearer_token) is None:
            account_success = False
            account_error = account_error or "喂草失败"

        if account_success:
            success_accounts.append(bz)
        else:
            failed_accounts.append(f"{bz}: {account_error}")

        # 账号间隔
        if i < len(ts):
            wait_time = random.randint(3, 5)
            print(f"\n⏳ 等待{wait_time}秒后处理下一个账号...")
            time.sleep(wait_time)

    # 生成通知
    generate_notification(success_accounts, failed_accounts, total_increase)

    # 发送钉钉通知
    if DD_BOT_TOKEN:
        notify_title = "小天鹅合并任务结果"
        notify_content = "\n".join(log_log)
        dingtalk_send_notify(notify_title, notify_content)

    # 青龙通知
    jie_tz()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n⚠️ 用户中断执行")
    except Exception as e:
        print(f"\n❌ 脚本执行异常: {e}")
