 

'''
#小程序://逢三得利吧/MuzyBFBe8ripASo


'''
from datetime import datetime, timedelta
import os, random, hashlib, json
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from urllib.error import URLError, HTTPError
from fake_useragent import UserAgent
import time

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

import requests

# 禁用 SSL 警告
requests.packages.urllib3.disable_warnings()

# ====================== 核心业务逻辑 ======================
#import os
#os.environ["http_proxy"] = "h...5:5700"
#os.environ["https_proxy"] = "ht..00"

# ====================== 全局配置 ======================
bl_ql_sz = 'fsdlb'  # 环境变量名称，储存账号信息
jbxmmz, ywmz, jbxmbb = "逢三得利吧", "fsdlb","1.0"  # 脚本名称 & 版本
blgs = f'\n#小程序://逢三得利吧/MuzyBFBe8ripASo\n抓 hzguanqi.com/api/login\n请求头 Authorization  \n格式 备注#Authorization  \n '  # 环境变量格式说明

jbzzxx, jbbbsj = "1", "2026年1月8日10:29:10"  # 更新信息
log_log = []  # 全局日志收集器

URLS = "https://xiaodian.miyatech.com"#三得利接口
SIGN_IN_URL = f"{URLS}/api/coupon/auth/signIn"#签到接口
LOGIN_URL = f"{URLS}/api/user/login/wx-jc"  # 登录接口
ENV_NAME = "fsdlb"                 # 环境变量名：账号列表  备注#wxid
TXT_FILE = "三得利ck.txt"       # 输出文件名：备注#Authorization
MINIPROGRAM_APPID = "wxb33ed03c6c715482"
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "")  # YYB 协议地址

# 备注 -> wxid 映射，用于"参数过期时自动重新登录并刷新 ck"
REMARK_WXID_MAP = {}

# 示例账号（可注释掉，改用你自己的环境变量）
os.environ['fsdlb1'] = '''
4150杰#wxid_gcmdmojm1g0t722
'''

def sc_ua():
    user_agent = UserAgent()
    return user_agent.random

def hs(ck): 
    """生成三得利签到API的请求头"""
    # 如果token已经包含"bearer "前缀，则直接使用，否则添加前缀
    if ck:
        auth_header = ck if ck.lower().startswith("bearer ") else f"bearer {ck}"
    else:
        auth_header = ""
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090c39)XWEB/14315",
        "X-VERSION": "2.3.0",
        "Authorization": auth_header, 
        "HH-VERSION": "0.4.14",
        "MARKETING-PLAN-NO": "",
        "ONE-ID": "",
        "HH-FROM": "20230130307725",
        "componentSend": "1",
        "HH-APP": "wxb33ed03c6c715482",
        "USER-ENTRANCE-CHANNEL": "",
        "appPublishType": "1",
        "USER-ENTRANCE-CHANNEL-KEY": "",
        "groupPosId": "",
        "Content-Type": "application/json;charset=UTF-8",
        "charset": "utf-8",
        "xweb_xhr": "1",
        "store": ",:,",
        "HH-CI": "saas-wechat-app",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": "https://servicewechat.com/wxb33ed03c6c715482/62/page-frame.html",
        "Accept-Language": "zh-CN,zh;q=0.9"
    }

def fetch_js_code(remark, wxid):
    """从 YYB 协议获取小程序 login code"""
    if not YYB_BASE_URL:
        print(f"❌ {remark}：YYB_BASE_URL 未设置")
        return None
    try:
        url = f"{YYB_BASE_URL}/wxapp/getCode"
        payload = {"app_id": MINIPROGRAM_APPID, "ref": wxid}
        headers = {"Content-Type": "application/json"}
        for _ in range(3):
            resp = requests.post(url, json=payload, headers=headers, timeout=60)
            data = resp.json()
            if data.get("code") == 0:
                result = data.get("data", {}).get("result") if isinstance(data.get("data"), dict) else data.get("data")
                if isinstance(result, dict):
                    code = result.get("code")
                else:
                    code = data.get("data", {}).get("code") or data.get("data", {}).get("result")
                if code:
                    return code
            time.sleep(2)
        print(f"❌ {remark}：获取code失败")
    except Exception as e:
        print(f"❌ {remark}：获取code异常：{e}")
    return None

def fetch_js_code1(remark, wxid):
    """从本地中转服务获取小程序 login code（需要Authorization）- 供手动修改使用
    如需使用此函数，请在main()中将fetch_js_code改为fetch_js_code1
    需要设置环境变量：yjc_AUTH_TOKEN=authorization令牌
    别人  手动改fetch_js_code1  修fetch_js_code
    """
    if not YYB_BASE_URL:
        print(f"❌ {remark}：YYB_BASE_URL 未设置")
        return None
    try:
        url = f"{YYB_BASE_URL}/wxapp/getCode"
        headers = {"Authorization": os.getenv('yjc_AUTH_TOKEN')}
        resp = requests.post(
            url,
            json={"wxid": wxid, "appid": MINIPROGRAM_APPID},
            headers=headers,
            proxies={"http": None, "https": None},  # 明确不使用系统代理
            timeout=30,
            verify=False
        )
        resp.raise_for_status()
        res = resp.json()
        if res.get("code") == 200 and res.get("data", {}).get("code"):
            return res["data"]["code"]
    except Exception as e:
        print(f"❌ {remark}：获取code异常：{e}")
        return None

def login_and_get_token(remark, js_code):
    """调用三得利登录接口，获取 access_token"""
    try:
        login_data = {
            "jsCode": js_code,
            "clientId": "saas-wechat-app",
            "myUnionId": "",
            "appPublishType": 1
        }
        
        res = urly(LOGIN_URL, hs(""), m="POST", d=login_data)
        
        if res and res.get("code") == "200" and res.get("success") == True:
            data = res.get("data", {})
            token_info = data.get("tokenInfo", {})
            access_token = token_info.get("access_token", "")
            
            if access_token:
                
                return access_token
            else:
                print(f"⚠️ {remark}：登录响应缺少access_token字段")
        else:
            print(f"⚠️ {remark}：登录失败，code={res.get('code') if res else 'None'}")
    except Exception as e:
        print(f"❌ {remark}：登录异常：{e}")
    
    return None

def save_to_txt(remark, authorization):
    """保存 / 更新到 三得利ck.txt，格式：备注#Authorization"""
    try:
        existing_lines = []
        if os.path.exists(TXT_FILE):
            with open(TXT_FILE, "r", encoding="utf-8") as f:
                existing_lines = [line.strip() for line in f if line.strip()]

        new_line = f"{remark}#{authorization}"

        updated_lines = []
        found = False
        for line in existing_lines:
            if line.split("#", 1)[0] == remark:
                updated_lines.append(new_line)
                found = True
            else:
                updated_lines.append(line)

        if not found:
            updated_lines.append(new_line)

        with open(TXT_FILE, "w", encoding="utf-8") as f:
            for line in updated_lines:
                f.write(line + "\n")

        print(f"💾 {remark}：已写入 {TXT_FILE}")
    except Exception as e:
        print(f"⚠️ {remark}：保存失败：{e}")

def check_ck_valid(bz, ck):
    """检查ck是否过期：通过调用签到首页接口判断"""
    try:
        url = f"{URLS}/api/coupon/auth/signIn/homePage?miniappId=159"
        res = urly(url, hs(ck), m="GET")
        
        # 如果返回None，说明请求失败
        if res is None:
            return False
        
        if isinstance(res, dict):
            # 检查是否有401错误
            if res.get("status") == 401 or res.get("error") == "Unauthorized" or res.get("code") == "401":
                return False
            # 检查code是否为200
            if res.get("code") == "200":
                return True
        return False
    except Exception as e:
        print(f"⚠️ {bz}：检查ck有效性异常：{e}")
        return False

#签到
def do_sign_in(bz, ck):

    url = f"{SIGN_IN_URL}"
    # 发送 JSON 数据 {"miniappId":159}
    res = urly(url, hs(ck), m="POST", d={"miniappId": 159})
    
    if not res:
        print(f"{bz} ❌ 签到请求失败")
        return False
    
    code = res.get("code")
    msg = res.get("msg", "")
    
    # 处理成功响应 (code: "200")
    if code == "200" and res.get("success") == True:
        data = res.get("data", {})
        integral_text = data.get("integralToastText", "未知")
       # print(f"{bz} ✅ 签到成功 | {integral_text}")
        log(f"{bz} ✅ 签到成功 | {integral_text}")
        return True
    # 处理已签到响应 (code: "999")
    elif code == "999":
        print(f"{bz} ℹ️ {msg}")
        return True  # 已签到也算成功
    else:
        print(f"{bz} ❌ 签到失败: {msg}")
        return False

def check_sign_in_status(bz, ck, wait_time):
    """
    检查签到状态，如果未签到则等待后执行签到
    wait_time: 等待时间（秒），如果为0则不等待
    """
    url = f"{URLS}/api/coupon/auth/signIn/homePage?miniappId=159"
    res = urly(url, hs(ck), m="GET")
    
    # 检查 ck 是否过期（401 Unauthorized）
    if res is None:
        print(f"{bz} ❌ 检查签到状态失败: 请求返回None")
        return False
    
    # 检查是否是401错误（通过HTTPError返回的错误数据）
    if isinstance(res, dict):
        if res.get("status") == 401 or res.get("error") == "Unauthorized" or res.get("code") == "401":
            log(f"{bz} ❌ ck过期，请更新ck")
            return False
    
    if res.get("code") != "200":
        print(f"{bz} ❌ 检查签到状态失败: {res}")
        return False
    
    data = res.get("data", {})
    has_sign_in = data.get("hasSignIn", False)
    keep_sign_in_days = data.get("keepSignInDays", 0)
    total_integral = data.get("totalIntegral", 0)
    
    if has_sign_in:
        log(f"{bz} ✅ 签到 | 天数: {keep_sign_in_days} | 总积分: {total_integral}")
        return True
    else:
        print(f"{bz} ⏳ 今日未签到 | 连续签到天数: {keep_sign_in_days} | 总积分: {total_integral}")
        
        # 如果未签到，等待指定时间后执行签到
        if wait_time > 0:
            print(f"{bz} ⏳ 等待 {wait_time} 秒后执行签到...")
            time.sleep(wait_time)
        
        # 执行签到
        return do_sign_in(bz, ck)

# ====================== 核心业务逻辑 ======================
def main():
    pd()
    
    # 优先从 YYB 协议获取账号
    yyb_accounts = []
    if YYB_BASE_URL:
        yyb_accounts = fetch_accounts_from_yyb(YYB_BASE_URL)
    
    if yyb_accounts:
        print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
        # 填充 REMARK_WXID_MAP，方便 ck 过期时自动刷新
        for remark, wxid in yyb_accounts:
            REMARK_WXID_MAP[remark] = wxid
        # 转换为 (remark, wxid) 格式，直接处理
        ts = [(remark, wxid) for remark, wxid in yyb_accounts]
    else:
        ts = acc(bl_ql_sz)
    
    success, fail = 0, 0
    
    for i, account in enumerate(ts, 1):
        if i > 1:
            delay = random.uniform(1, 3)
            time.sleep(delay)
        
        # 缓存账号：备注#Authorization
        if len(account) == 2 and isinstance(account, (list, tuple)):
            remark, ck = account[0], account[1]
            print(f"\n-- {i}/{len(ts)} 🎐 {remark} --")
            
            # 0. 先检查ck是否过期
            if not check_ck_valid(remark, ck):
                print(f"⛔ {remark}：ck已过期，尝试自动重新登录并刷新 ck...")
                wxid = REMARK_WXID_MAP.get(remark)
                if not wxid:
                    print(f"⚠️ {remark}：未在环境变量中找到对应 wxid，无法自动刷新，只能手动处理。")
                    fail += 1
                    continue
                
                # 通过 wxid 重新获取 jsCode 并登录，拿到新的 access_token
                js_code = fetch_js_code(remark, wxid)
                if not js_code:
                    print(f"❌ {remark}：重新获取 jsCode 失败，无法刷新参数")
                    fail += 1
                    continue
                
                new_token = login_and_get_token(remark, js_code)
                if not new_token:
                    print(f"❌ {remark}：重新登录失败，无法刷新参数")
                    fail += 1
                    continue
                
                # 覆盖写入新的 ck 记录
                save_to_txt(remark, new_token)
                print(f"♻️ {remark}：已自动刷新 ck（Authorization 已更新）")
                
                # 更新当前循环中使用的 ck，后面继续走签到逻辑
                ck = new_token
            else:
                print(f"✅ {remark}：ck有效")
            
            # 1. 执行签到任务：检查签到状态，如果未签到则等待后执行签到
            wait_time = random.randint(3, 8)  # 随机等待3-8秒
            if check_sign_in_status(remark, ck, wait_time):
                success += 1
            else:
                fail += 1
            continue
        
        # 环境变量账号：备注#wxid -> 获取jsCode + 登录 + 保存
        if len(account) == 2 and isinstance(account, tuple):
            remark, wxid = account
            print(f"\n-- {i}/{len(ts)} 🎐 {remark} --")
            
            js_code = fetch_js_code(remark, wxid)
            if not js_code:
                print(f"❌ {remark}：获取jsCode失败")
                fail += 1
                continue
            
            token = login_and_get_token(remark, js_code)
            if not token:
                print(f"❌ {remark}：登录失败，无法获取参数")
                fail += 1
                continue
            
            save_to_txt(remark, token)
            # 新账号获取到参数后，也顺便执行签到
            wait_time = random.randint(3, 8)
            if check_sign_in_status(remark, token, wait_time):
                success += 1
            else:
                fail += 1
            continue
        
        # 兼容旧格式：备注#ck
        if isinstance(account, str):
            p = [x.strip() for x in account.split('#') if x.strip()]
            if len(p) >= 2:
                bz, ck = p[0], p[1]
                print(f"\n-- {i}/{len(ts)} 🎐 {bz} --")
                wait_time = random.randint(3, 8)
                if check_sign_in_status(bz, ck, wait_time):
                    success += 1
                else:
                    fail += 1
                continue
        
        print(f"⚠️ 数据错误 跳过{i}")
        fail += 1
    
    print(f"\n📊 处理完成：成功 {success} 个，失败 {fail} 个")
    jie_tz()

# ====================== 工具3.0函数 ======================精简写法（简洁封装）让代码更短更清晰strftime 

def log(msg: str): print(msg); log_log.append(msg)  # 打印并收集日志

def pd(): print(f'--- {jbxmmz} {jbbbsj} v{jbxmbb} ---\n--- {jbzzxx} ---\n--- 广告区 ---')  # 打印脚本信息
def urly(u, h, m="GET", d=None, retries=3, retry_delay=3):
    for i in range(retries + 1):
        try:
            mu = m.upper()
            
            # 准备请求数据
            data = None
            if mu in ("POST", "POST_DA") and d:
                if mu == "POST" and isinstance(d, dict):
                    # JSON数据
                    data = json.dumps(d).encode('utf-8')
                    h = h.copy()
                  #  h['Content-Type'] = 'application/json'
                elif mu == "POST_DA":
                    # 表单数据
                    if isinstance(d, dict):
                        data = urlencode(d).encode('utf-8')
                    else:
                        data = d.encode('utf-8') if isinstance(d, str) else d
                    h = h.copy()
                   # h['Content-Type'] = 'application/x-www-form-urlencoded'
            
            # 创建请求对象
            req = Request(u, data=data, headers=h)
            
            # 发送请求
            with urlopen(req, timeout=15) as response:
                response_data = response.read().decode('utf-8')
                return json.loads(response_data)
                
        except HTTPError as e:
            # 对于 HTTP 错误，尝试读取响应体
            try:
                error_response = e.read().decode('utf-8')
                error_data = json.loads(error_response)
                # 401 错误不重试，直接返回错误信息
                if e.code == 401:
                    return error_data
            except:
                pass
            # 其他 HTTP 错误继续重试逻辑
            if i < retries: 
                print(f"❌ 请求失败: {e} | 重试 {i+1}/{retries}，{retry_delay}s 后重试")
                time.sleep(retry_delay)
            else: 
                print(f"❌ 请求失败: {e} | 已达最大重试次数")
                return None
        except (URLError, json.JSONDecodeError) as e:
            if i < retries: 
                print(f"❌ 请求失败: {e} | 重试 {i+1}/{retries}，{retry_delay}s 后重试")
                time.sleep(retry_delay)
            else: 
                print(f"❌ 请求失败: {e} | 已达最大重试次数")
                return None
        except Exception as e:
            if i < retries: 
                print(f"❌ 请求失败: {e} | 重试 {i+1}/{retries}，{retry_delay}s 后重试")
                time.sleep(retry_delay)
            else: 
                print(f"❌ 请求失败: {e} | 已达最大重试次数")
                return None

def acc(v):
    """解析账号：同时读取缓存和环境变量账号
    - TXT_FILE 中：行格式 备注#Authorization
    - 环境变量：行格式 备注#wxid
    """
    accounts = []
    cached_accounts_map = {}
    
    def parse(s): return [x.strip() for x in (s.replace("&", "\n").split("\n") if isinstance(s, str) else s) if x.strip()]
    
    # 1. 读取缓存账号（从三得利ck.txt）
    if os.path.exists(TXT_FILE):
        with open(TXT_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and '#' in line:
                    parts = line.split("#", 1)
                    if len(parts) == 2:
                        remark = parts[0]
                        cached_accounts_map[remark] = parts  # 完整两段：备注#Authorization
        
        if cached_accounts_map:
            print(f"📄 从{TXT_FILE}读取到{len(cached_accounts_map)}个预存账号")
            accounts.extend(cached_accounts_map.values())
    
    # 2. 读取环境变量账号
    jf, tf = f"{v}.json", f"{v}.txt"
    if os.path.exists(jf): 
        env_accounts = [f"{'#'.join([val[k] for k in val if k.lower().startswith('ck') and val[k]])}#{key}" for key, val in json.load(open(jf, "r", encoding="utf-8")).items()]
        for acc_line in env_accounts:
            if '#' in acc_line:
                parts = acc_line.split('#', 1)
                if len(parts) == 2:
                    remark, wxid = parts[0].strip(), parts[1].strip()
                    REMARK_WXID_MAP[remark] = wxid
                    if remark not in cached_accounts_map:
                        accounts.append((remark, wxid))
    elif os.path.exists(tf):
        env_accounts = parse(open(tf, "r", encoding="utf-8").read().strip().split("\n"))
        for acc_line in env_accounts:
            if '#' in acc_line:
                parts = acc_line.split('#', 1)
                if len(parts) == 2:
                    remark, wxid = parts[0].strip(), parts[1].strip()
                    REMARK_WXID_MAP[remark] = wxid
                    if remark not in cached_accounts_map:
                        accounts.append((remark, wxid))
    else:
        ev = os.getenv(v)
        if ev:
            print(f"🌍 从环境变量 {v} 加载账号")
            env_accounts = parse(ev)
            for acc_line in env_accounts:
                if '#' in acc_line:
                    parts = acc_line.split('#', 1)
                    if len(parts) == 2:
                        remark, wxid = parts[0].strip(), parts[1].strip()
                        REMARK_WXID_MAP[remark] = wxid
                        if remark not in cached_accounts_map:
                            accounts.append((remark, wxid))
        else:
            print(f"⚠️ 环境变量 {v} 未设置  {blgs}")
    
    print(f"📋 总计加载{len(accounts)}个账号")
    return accounts

def jie_tz():
    msg="\n\n".join(log_log)
    if os.getenv("jie_tz","False").lower()=="true": QLAPI.notify(jbxmmz,msg); print("📢 通知已发送")
    else: print("🔕 已关闭通知")

# ====================== 更新 更新 ======================

# ====================== 启动 ======================
if __name__ == "__main__":
    main()
