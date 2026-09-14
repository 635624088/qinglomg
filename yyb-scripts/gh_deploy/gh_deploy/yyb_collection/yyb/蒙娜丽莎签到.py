"""
蒙娜丽莎只能code  签到
1.手动绑定门店
2.设置 YYB_BASE_URL 协议地址
3.变量名 MLLS 格式 备注#wxid  

更新 1.2 - YYB 协议适配
"""
import os, random, json, time
import requests
from notify import send

# ====================== 全局配置 ======================
bl_ql_sz = 'MLLS'  # 环境变量名称，储存账号信息 格式：备注#wxid
jbxmmz, ywmz, jbxmbb = "蒙娜丽莎", "MLLS", "1.2"  # 脚本名称 & 版本
blgs = f'\n#蒙娜丽莎  \n格式 备注#wxid  自动获取 code 登录获取ck后 保存到 蒙娜丽莎ck.txt \n格式：备注#WebChatID#CustomerID#tokenStr'
jbzzxx, jbbbsj = "yyb协议适配", "2026年7月14日"  # 更新信息
log_log = []  # 全局日志收集器
REMARK_WXID_MAP = {}  # 备注 -> wxid 映射，用于token过期时重新获取ck

# ====================== 核心配置 ======================

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
CALC_SERVICE_URL = os.getenv("CALC_SERVICE_URL", "http://192.168.22.214:7778/calculate")  # ddddocr 计算服务地址
# 代理配置（仅用于登录）
PROXY_URL = os.getenv("MLLS_PROXY", "http://172.17.0.1:18080")
PROXY_DICT = {"http": PROXY_URL, "https": PROXY_URL} if PROXY_URL else None
PROXY_URL2_API = os.getenv("MLLS_PROXY2", "").strip()

if PROXY_DICT and PROXY_URL2_API:
    print(f"🌐 已配置主代理：{PROXY_URL}，备用代理")
elif PROXY_DICT:
    print(f"🌐 已配置主代理：{PROXY_URL}")
elif PROXY_URL2_API:
    print("🌐 已配置备用代理")
else:
    print("⚠️ 未配置代理，登录可能被拉黑")

TARGET_DOMAIN = "https://mcs.monalisagroup.com.cn"
SIGN_URL = f"{TARGET_DOMAIN}/member/doAction"
MINIPROGRAM_APPID = "wxce6a8f654e81b7a4"
TXT_FILE = "蒙娜丽莎ck.txt"

requests.packages.urllib3.disable_warnings()

# ====================== 工具函数 ======================
def log(msg: str): 
    print(msg)
    log_log.append(msg)

def pd(): 
    print(f'--- {jbxmmz} {jbbbsj} v{jbxmbb} ---\n--- {jbzzxx} ---\n--- 广告区 ---')

def get_headers():
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090c39)XWEB/14315",
        "Content-Type": "application/x-www-form-urlencoded",
        "xweb_xhr": "1",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": "https://servicewechat.com/wxce6a8f654e81b7a4/471/page-frame.html",
        "Accept-Language": "zh-CN,zh;q=0.9"
    }

def fetch_accounts_from_yyb(yyb_base_url: str) -> list:
    """从 YYB 协议获取账号列表"""
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
                    accounts.append(f"{nickname}#{openid}")
            return accounts
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []

def fetch_code(remark, wxid):
    """从 YYB 协议获取小程序 login code"""
    try:
        resp = requests.post(
            f"{YYB_BASE_URL}/wxapp/getCode",
            json={"ref": wxid, "app_id": MINIPROGRAM_APPID},
            headers={"Content-Type": "application/json"},
            timeout=30
        )
        resp.raise_for_status()
        res = resp.json()
        if res.get("code") == 0:
            data = res.get("data", {})
            result = data.get("result") or data
            code = result.get("code", "")
            if code:
                return code
    except Exception as e:
        print(f"  获取code失败: {e}")
    return None

def fetch_code1(remark, wxid):
    """备用获取code方式（旧接口，仅兼容）"""
    try:
        url = f"{YYB_BASE_URL}/prod-api/wechat/api/getMiniProgramCode"
        headers = {"Authorization": os.getenv('yjc_AUTH_TOKEN')}
        resp = requests.post(url, json={"wxid": wxid, "appid": MINIPROGRAM_APPID}, headers=headers, timeout=30)
        resp.raise_for_status()
        res = resp.json()
        if res.get("code") == 200 and res.get("data", {}).get("code"):
            return res["data"]["code"]
    except Exception as e:
        print(f"  备用获取code失败: {e}")
    return None

def get_proxy_from_api(api_url):
    """从代理池API获取代理IP地址"""
    try:
        resp = requests.get(api_url, timeout=10, verify=False)
        resp.raise_for_status()
        proxy_text = resp.text.strip()
        if proxy_text:
            proxy_line = proxy_text.split('\n')[0].split('\r')[0].strip()
            if ':' in proxy_line:
                proxy_url = proxy_line if (proxy_line.startswith('http://') or proxy_line.startswith('https://')) else f"http://{proxy_line}"
                return {"http": proxy_url, "https": proxy_url}
    except Exception as e:
        print(f"从代理池获取IP失败: {e}")
    return None

def login_and_get_token(remark, code):
    try:
        session = requests.Session()
        session.verify = False
        login_data = {"brand": "MON", "webChatName": "微信用户", "telephone": "", "code": code, "remarks": "", "operationType": "", "action": "addCustomer", "customerName": "微信用户", "storeID": "", "address": "-", "Province": "", "City": "", "Region": ""}
        resp = session.post(SIGN_URL, data=login_data, headers=get_headers(), proxies={"http": None, "https": None}, timeout=30)
        resp.raise_for_status()
        res = resp.json()
        status = res.get("status")

        if status == -100:
            if PROXY_DICT:
                try:
                    print(f"  检测到风控，使用主代理重试")
                    resp = session.post(SIGN_URL, data=login_data, headers=get_headers(), proxies=PROXY_DICT, timeout=30)
                    resp.raise_for_status()
                    res = resp.json()
                    status = res.get("status")
                except Exception as e:
                    print(f"  主代理异常: {e}")

            if status != 2 and PROXY_URL2_API:
                max_retry = 3
                is_proxy_api = any(kw in PROXY_URL2_API for kw in ['/tools/', '/getapi', '/XApi', '/api/', 'api2.', 'api.'])
                for i in range(1, max_retry + 1):
                    if status == 2: break
                    try:
                        proxy_dict2 = None
                        if is_proxy_api:
                            proxy_dict2 = get_proxy_from_api(PROXY_URL2_API)
                            if not proxy_dict2:
                                if i < max_retry: time.sleep(1)
                                continue
                        elif PROXY_URL2_API.startswith('http://') or PROXY_URL2_API.startswith('https://'):
                            proxy_dict2 = {"http": PROXY_URL2_API, "https": PROXY_URL2_API}
                        else:
                            break
                        if proxy_dict2:
                            resp = session.post(SIGN_URL, data=login_data, headers=get_headers(), proxies=proxy_dict2, timeout=30)
                            resp.raise_for_status()
                            res = resp.json()
                            status = res.get("status")
                            if status == 2: break
                            if i < max_retry: time.sleep(1)
                    except Exception as e:
                        if i < max_retry: time.sleep(1)

        if status == 2 and isinstance(res.get("resultInfo"), list) and res["resultInfo"]:
            user_info = res["resultInfo"][0]
            cid, webchatid, token_str = str(user_info.get("CustomerID", "")).strip(), user_info.get("WebChatID", ""), res.get("tokenStr", "")
            store_name = user_info.get("StoreName", "").strip()
            if not store_name:
                print(f"  没有绑定门店")
                return "NO_STORE"
            if cid and webchatid and token_str:
                return {"cid": cid, "webchatid": webchatid, "token_str": token_str}
            else:
                print(f"  登录响应缺少字段")
        else:
            print(f"  登录失败 status={status}")
    except Exception as e:
        print(f"  登录异常: {e}")
    return None

def save_to_txt(remark, webchatid, cid, token_str):
    try:
        existing_lines = []
        if os.path.exists(TXT_FILE):
            with open(TXT_FILE, "r", encoding="utf-8") as f:
                existing_lines = [line.strip() for line in f if line.strip()]
        new_line = f"{remark}#{webchatid}#{cid}#{token_str}"
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
    except Exception as e:
        print(f"  保存失败: {e}")

def load_ck_from_txt():
    ck_map = {}
    if os.path.exists(TXT_FILE):
        with open(TXT_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and line.count("#") == 3:
                    parts = line.split("#", 3)
                    ck_map[parts[0]] = parts
    return ck_map

def acc(v):
    def parse(s): 
        return [x.strip() for x in (s.replace("&", "\n").split("\n") if isinstance(s, str) else s) if x.strip()]
    
    ck_map = load_ck_from_txt()
    result = []
    remark_set = set()
    
    if ck_map:
        for parts in ck_map.values():
            result.append(parts)
            remark_set.add(parts[0])
    
    # 优先从 YYB 协议获取账号
    if YYB_BASE_URL:
        yyb_accounts = fetch_accounts_from_yyb(YYB_BASE_URL)
        if yyb_accounts:
            print(f"📦 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
            for entry in yyb_accounts:
                if '#' in entry:
                    remark, wxid = entry.split('#', 1)
                    REMARK_WXID_MAP[remark] = wxid
                    if remark not in remark_set:
                        result.append((remark, wxid))
                        remark_set.add(remark)
            if result:
                return result
    
    ev = os.getenv(v)
    if ev:
        for line in parse(ev):
            if '#' in line:
                parts = line.split('#', 1)
                if len(parts) == 2:
                    remark, wxid = parts[0].strip(), parts[1].strip()
                    if remark and wxid:
                        REMARK_WXID_MAP[remark] = wxid
                        if remark not in remark_set:
                            result.append((remark, wxid))
                            remark_set.add(remark)
    
    if not result:
        print(f"⚠️ 未加载到账号")
    return result


def check_attendance_status(remark, cid):
    try:
        data = {"brand": "MON", "action": "continuousAttendance", "CustomerID": cid}
        resp = requests.post(SIGN_URL, data=data, headers=get_headers(), proxies={"http": None, "https": None}, timeout=30, verify=False)
        resp.raise_for_status()
        res = resp.json()
        status = res.get("status")
        info = res.get("resultInfo") or {}
        todays = info.get("todays", 0)
        continuity_day = info.get("continuityDay", 0)
        total_days = continuity_day + todays
        if status == 0 and todays == 0:
            return ("not_signed", total_days)
        elif status == 0:
            return ("signed", total_days)
        else:
            return ("error", 0)
    except Exception as e:
        return ("error", 0)

def generate_captcha_b64(token_str):
    try:
        data = {"brand": "MON", "action": "generateCaptcha", "tokenStr": token_str}
        resp = requests.post(SIGN_URL, data=data, headers=get_headers(), proxies={"http": None, "https": None}, timeout=30, verify=False)
        resp.raise_for_status()
        res = resp.json()
        status = res.get("status")
        if status == -200: return "TOKEN_EXPIRED"
        if status != 0 or not res.get("resultInfo"): return None
        return res["resultInfo"]
    except Exception as e:
        return None

def calc_captcha_with_ddddocr(token_str):
    img_b64 = generate_captcha_b64(token_str)
    if img_b64 == "TOKEN_EXPIRED": return "TOKEN_EXPIRED"
    if not img_b64: return None
    try:
        payload = {"image": img_b64}
        resp = requests.post(CALC_SERVICE_URL, json=payload, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        expression = None
        if isinstance(data, dict):
            for expr_key in ["expression", "formula", "calc", "expr", "question"]:
                if expr_key in data:
                    expression = str(data[expr_key])
                    break
            for key in ["result", "res", "answer", "data", "code"]:
                if key in data:
                    try:
                        val = int(str(data[key]).strip())
                        return val
                    except Exception: continue
        try:
            val = int(str(data).strip())
            return val
        except Exception: pass
        return None
    except Exception as e:
        return None

def get_customer_integral(remark, cid, webchatid):
    try:
        data = {"action": "getCustomer", "webChatID": webchatid, "brand": "MON", "CustomerID": cid}
        resp = requests.post(SIGN_URL, data=data, headers=get_headers(), proxies={"http": None, "https": None}, timeout=30, verify=False)
        resp.raise_for_status()
        res = resp.json()
        status = res.get("status")
        info = res.get("resultInfo") or []
        if status == 0 and isinstance(info, list) and info:
            return info[0].get("Integral", 0)
        return None
    except Exception as e:
        return None

def sign_with_captcha(remark, cid, token_str, webchatid=None):
    answer = calc_captcha_with_ddddocr(token_str)
    if answer == "TOKEN_EXPIRED": return "TOKEN_EXPIRED"
    if answer is None: return f" 验证码识别失败"
    try:
        data = {"action": "sign", "CustomerID": cid, "CustomerName": "微信用户", "StoreID": "0", "OrganizationID": "0", "Brand": "MON", "tokenStr": token_str, "correctAnswer": answer}
        resp = requests.post(SIGN_URL, data=data, headers=get_headers(), proxies={"http": None, "https": None}, timeout=30, verify=False)
        resp.raise_for_status()
        res = resp.json()
        status = res.get("status")
        if status == 0:
            gain = res.get("resultInfo", 0)
            msg = f"  签到成功，获得金币 {gain}"
            if webchatid:
                integral = get_customer_integral(remark, cid, webchatid)
                if integral is not None: msg += f"，总金币 {integral}"
            return msg
        elif status == 7: return f"  今日已签到"
        elif status == -666: return f"  验证码错误"
        elif status == -667: return f"  未绑定门店"
        else: return f"  签到失败 status={status}"
    except Exception as e:
        return f"  签到异常: {e}"

def jie_tz():
    msg="\n\n".join(log_log)
    if os.getenv("jie_tz","False").lower()=="true": QLAPI.notify(jbxmmz,msg); print("📢 通知已发送")
    else: print("🔕 已关闭通知")

def main():
    pd()
    accounts = acc(bl_ql_sz)
    if not accounts:
        log("⚠️ 未加载到任何账号")
        return
    
    print(f"📋 共 {len(accounts)} 个账号")
    success, fail = 0, 0
    
    for i, account in enumerate(accounts, 1):
        if i > 1:
            delay = random.uniform(2, 4)
            time.sleep(delay)
        
        if len(account) == 4:
            remark, webchatid, cid, token_str = account
            print(f"\n[{i}/{len(accounts)}] {remark}")
            status, total_days = check_attendance_status(remark, cid)
            if status == "signed":
                integral = get_customer_integral(remark, cid, webchatid)
                if integral is not None:
                    log(f"  已签到 {total_days} 天 金币 {integral}")
                else:
                    log(f"  已签到 {total_days} 天")
            elif status == "not_signed":
                result = sign_with_captcha(remark, cid, token_str, webchatid)
                if result == "TOKEN_EXPIRED":
                    wxid = REMARK_WXID_MAP.get(remark)
                    if not wxid:
                        fail += 1; continue
                    code = fetch_code(remark, wxid)
                    if not code:
                        fail += 1; continue
                    new_info = login_and_get_token(remark, code)
                    if not new_info or new_info == "NO_STORE":
                        fail += 1; continue
                    save_to_txt(remark, new_info["webchatid"], new_info["cid"], new_info["token_str"])
                    cid = new_info["cid"]; token_str = new_info["token_str"]; webchatid = new_info["webchatid"]
                    result = sign_with_captcha(remark, cid, token_str, webchatid)
                    log(result)
                else:
                    log(result)
            success += 1
            continue
        
        if len(account) == 2:
            remark, wxid = account
            print(f"\n[{i}/{len(accounts)}] {remark}")
            code = fetch_code(remark, wxid)
            if not code:
                fail += 1; continue
            info = login_and_get_token(remark, code)
            if not info or info == "NO_STORE":
                fail += 1; continue
            save_to_txt(remark, info["webchatid"], info["cid"], info["token_str"])
            status, total_days = check_attendance_status(remark, info["cid"])
            if status == "not_signed":
                result = sign_with_captcha(remark, info["cid"], info["token_str"], info["webchatid"])
                if result == "TOKEN_EXPIRED":
                    fail += 1
                else:
                    log(result)
            elif status == "signed":
                integral = get_customer_integral(remark, info["cid"], info["webchatid"])
                if integral is not None:
                    log(f"  已签到 {total_days} 天 金币 {integral}")
                else:
                    log(f"  已签到 {total_days} 天")
            success += 1
    
    stat = f"📊 完成：共 {len(accounts)} 个，成功 {success}，失败 {fail}"
    log(f"\n{stat}")
    jie_tz()

if __name__ == "__main__":
    main()
