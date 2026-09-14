'''
备注#wid
 小程序:绿蜜蜂回收
 YYB_BASE_URL YYB 协议地址
 优先从 YYB 协议获取账号
 没有邀请吧
 #小程序://旧衣回收/Ltn5FWgUEBmXxvD 

1.2  更新提现功能
'''
from datetime import datetime, timedelta
import os, requests, random, hashlib, json
from fake_useragent import UserAgent
import time

# ====================== 全局配置 ======================
bl_ql_sz = 'lmf_jie'  # 环境变量名称，储存账号信息
jbxmmz, ywmz, jbxmbb = "绿蜜蜂回收", "lmf_jie","1.2"  # 脚本名称 & 版本

jbzzxx = jbbbsj = "2026年2月18日11:06:28"
log_log = []  # 全局日志收集器
txgn = 0  # 提现功能开关：0=打开提现，1=关闭提现
REQUEST_TIMEOUT = 20  # 延长超时时间到20秒
REQUEST_RETRIES = 3   # 请求重试次数

# 小程序appid
appid = "wx6fcde446296d9588"

# ====================== 环境变量配置 ======================
# 修复：去掉环境变量名中的多余数字，确保和后续调用一致
os.environ['YYB_BASE_URL'] = os.environ.get('YYB_BASE_URL', 'http://172.17.0.1:18080')
os.environ['lmf_jie'] = '''

'''

# ====================== 核心工具函数 ======================
def sc_ua():#生成UA
    user_agent = UserAgent()
    return user_agent.random

def log(msg: str): print(msg); log_log.append(msg)  # 打印并收集日志

def pd(): print(f'--- {jbxmmz} {jbbbsj} v{jbxmbb} ---\n--- {jbzzxx} ---\n--- 广告区 ---')  # 打印脚本信息

# 通用请求工具（带重试）
def urly(u, h, m="GET", d=None, retries=REQUEST_RETRIES, retry_delay=2):
    mu = (m or "GET").upper()
    req = {"GET": requests.get, "POST": requests.post, "POST_DA": requests.post, "PUT": requests.put}.get(mu)
    if not req: raise ValueError("仅支持 GET/POST/POST_DA/PUT 请求")
    for i in range(retries + 1):
        try:
            kw = {"headers": h, "timeout": REQUEST_TIMEOUT}
            if mu == "POST": kw["json"] = d
            elif mu == "POST_DA": kw["data"] = d
            elif mu == "PUT": kw["json"] = d
            r = req(u, **kw); r.raise_for_status(); return r.json()
        except requests.exceptions.RequestException as e:
            if i < retries: 
                time.sleep(retry_delay)
                print(f"请求重试 {i+1}/{retries}：{str(e)}")
            else: 
                print(f"多次重试后请求失败：{str(e)}")
                return None

# 账号加载函数
def acc(v):
    def parse(s): return [x.strip() for x in (s.replace("&", "\n").split("\n") if isinstance(s, str) else s) if x.strip()]
    jf, tf = f"{v}.json", f"{v}.txt"
    if os.path.exists(jf): return [f"{'#'.join([val[k] for k in val if k.lower().startswith('ck') and val[k]])}#{key}" for key, val in json.load(open(jf, "r", encoding="utf-8")).items()]
    if os.path.exists(tf): return parse(open(tf, "r", encoding="utf-8").read().strip().split("\n"))
    ev = os.getenv(v); 
    if ev: print(f"🌍 从环境变量 {v} 加载账号"); return parse(ev)
    print(f"⚠️ 环境变量 {v} 未设置  {blgs}"); return []

def fetch_accounts_from_yyb(yyb_base_url: str) -> list:
    """从 YYB 协议获取账号列表"""
    try:
        url = f"{yyb_base_url}/accounts"
        r = requests.get(url, timeout=15)
        data = r.json()
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

# 通知函数（增加容错）
def jie_tz():
    msg="\n\n".join(log_log)
    if os.getenv("jie_tz","False").lower()=="true":
        try:
            QLAPI.notify(jbxmmz,msg); print("📢 通知已发送")
        except NameError:
            print("⚠️ QLAPI未定义，跳过通知发送")
    else:
        print("🔕 已关闭通知")

# ====================== wxid取code（带重试）======================
def fetch_code(wxid):
    url = f"{os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080')}/wxapp/getCode"
    payload = {"ref": wxid, "app_id": appid}
    
    # 增加重试机制
    for retry in range(REQUEST_RETRIES):
        try:
            r = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
            if r.ok:
                resp_data = r.json()
                # 兼容 YYB 协议格式：code=0, data.result.code
                if resp_data.get("Code") == 0 or resp_data.get("code") in {0, "0"}:
                    data = resp_data.get("Data") or resp_data.get("data") or {}
                    nested = data.get("result") or data.get("Result") or data
                    return nested.get("code") or nested.get("Code") or data.get("code") or data.get("Code")
                else:
                    print(f"获取jsCode失败，接口返回错误码：{resp_data.get('Code', resp_data.get('code', '未知'))}，重试第{retry+1}次")
            else:
                print(f"获取jsCode失败，HTTP状态码：{r.status_code}，重试第{retry+1}次")
        except requests.exceptions.Timeout:
            print(f"连接超时（{REQUEST_TIMEOUT}秒），重试第{retry+1}次")
        except requests.exceptions.ConnectionError:
            print(f"连接被拒绝，目标服务可能未启动，重试第{retry+1}次")
        except Exception as e:
            print(f"获取jsCode异常：{str(e)}，重试第{retry+1}次")
        
        if retry < REQUEST_RETRIES - 1:
            time.sleep(2)  # 重试间隔2秒
    
    # 所有重试失败
    print(f"多次重试后仍无法获取{wxid}的jsCode，请检查网络或服务地址")
    return None

# 养鸡场code获取（增加默认值容错）
def fetch_code1(wxid):
    url = f"{os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080')}/prod-api/wechat/api/getMiniProgramCode"
    headers = {"Authorization": os.getenv('yjc_AUTH_TOKEN', '')}  # 增加默认值避免KeyError
    r = requests.post(url, json={"wxid": wxid, "appid": appid}, headers=headers, timeout=REQUEST_TIMEOUT)
    print(r.json().get("data", {}).get("code"))
    return r.json().get("data", {}).get("code") if r.ok and r.json().get("code") == 200 else None

# ====================== 绿蜜蜂核心业务逻辑 ======================
# 全局 Session 复用连接
SES = requests.Session()

# MD5加密函数
def md5_hex(text: str) -> str:
    return hashlib.md5(text.encode('utf-8')).hexdigest()

# 构建签名
def build_lmf_signature(device_id, timestamp):
    app_id = "75762944"
    app_secret = "ZNsLuCwAnnrDuQuyvTQcGpthsmASHSeG"
    rand_str = "lv_mi_feng_uni_app"
    raw = f"app_id={app_id}&app_secret={app_secret}&device_id={device_id}&rand_str={rand_str}&timestamp={timestamp}"
    sig = hashlib.md5(raw.encode("utf-8")).hexdigest()
    return raw, sig

# 获取access_token（增加容错）
def get_at(did=None, ts=None):
    try:
        did = did or str(int(time.time()*1000))
        ts = int(ts) if ts is not None else int(time.time())
        _, sig = build_lmf_signature(did, ts)
        r = SES.post(
            "https://lmf.lvmifo.com/api/5a60c77b79875?appType=WX_APP", 
            headers=hdr(), 
            data={'app_id':'75762944','device_id':did,'rand_str':'lv_mi_feng_uni_app','timestamp':str(ts),'signature':sig}, 
            timeout=REQUEST_TIMEOUT
        )
        if not r.ok: 
            print(f"获取 access_token 失败: HTTP {r.status_code}")
            return None
        j = r.json()
        tok = (j.get('data') or {}).get('access_token') if isinstance(j, dict) else None
        if not tok: 
            print(f"获取 access_token 失败: {j}")
        return tok
    except requests.exceptions.RequestException as e:
        print(f"获取access_token请求失败: {e}")
        return None

# 请求头构造
def hdr(at='', ut=''):
    return {
        'User-Agent': sc_ua(),
        'Content-Type':'application/x-www-form-urlencoded',
        'version':'v1.0.0',
        'user-token':ut or '',
        'access-token':at or '',
        'lat':'',
        'lng':'',
        'this-shop-id':'0',
        'charset':'utf-8',
        'Referer':f'https://servicewechat.com/{appid}/295/page-frame.html'
    }

# 登录获取用户信息
def dl(bz, wxid):
    tok = get_at()
    jd = fetch_code(wxid)
    if not tok or not jd: 
        print(f"{bz} - 缺少 token 或 js_code，登录失败")
        return None, None, None
    try:
        r = SES.post(
            'https://lmf.lvmifo.com/api/5e05692405c63', 
            headers=hdr(at=tok), 
            data={'code': jd}, 
            timeout=REQUEST_TIMEOUT
        )
        if not r.ok: 
            print(f"{bz} - 登录失败: HTTP {r.status_code}")
            return None, None, None
        j = r.json()
        data = j.get('data') if isinstance(j, dict) else None
        if isinstance(data, dict):
            zh = data.get('phone')
            ut = data.get('utoken')
            return zh, ut, tok
        return None, None, None
    except requests.exceptions.RequestException as e:
        print(f"{bz} - 登录请求失败: {e}")
        return None, None, None

# 签到功能
def sign(access_token, user_token):
    base_url = 'https://lmf.lvmifo.com/api/5dca57afa379e'
    params = {'m': 'toSign'}
    h = hdr(at=access_token, ut=user_token)
    
    try:
        r = SES.get(base_url, headers=h, params=params, timeout=REQUEST_TIMEOUT)
        if not r.ok:
            print(f"签到失败: HTTP {r.status_code}")
            return None
        j = r.json()
        code = j.get('code') if isinstance(j, dict) else None
        if code == -1:
            print('今日已签到')
        elif code == 1:
            print('签到成功', j.get('data'))
        else:
            print('签到失败', j)
        return j
    except requests.exceptions.RequestException as e:
        print(f"签到请求失败: {e}")
        return None

# 查询用户信息（余额）
def info(access_token, user_token):
    base_url = 'https://lmf.lvmifo.com/api/5dca57afa379e'
    params = {'m': 'getUserInfo'}
    h = hdr(at=access_token, ut=user_token)
    try:
        r = SES.get(base_url, headers=h, params=params, timeout=REQUEST_TIMEOUT)
        if not r.ok:
            print(f"查询用户信息失败: HTTP {r.status_code}")
            return None, None, None
        j = r.json()
        if isinstance(j, dict) and j.get('code') == 1 and isinstance(j.get('data'), dict):
            d = j.get('data')
            return d.get('phone'), d.get('amount'), j
        return None, None, j
    except requests.exceptions.RequestException as e:
        print(f"查询用户信息请求失败: {e}")
        return None, None, None

# 提现功能（优化金额处理）
def cash_apply(access_token, user_token, amount):
    """
    提现功能
    amount: 提现金额（处理小数，保留两位）
    """
    try:
        # 处理金额格式，避免int截断小数
        cash_amount = round(float(amount), 2)
        base_url = 'https://lmf.lvmifo.com/api/5e12a7e1848ba'
        params = {'m': 'cashApply', 'amount': cash_amount}
        h = hdr(at=access_token, ut=user_token)
        
        r = SES.get(base_url, headers=h, params=params, timeout=REQUEST_TIMEOUT)
        if not r.ok:
            print(f"提现失败: HTTP {r.status_code}")
            return None
        j = r.json()
        code = j.get('code') if isinstance(j, dict) else None
        msg = j.get('msg', '')
        if code == 1:
            print(f'✅ 提现成功: {msg}, 金额: {cash_amount}元')
        else:
            print(f'❌ 提现失败: {msg}', j)
        return j
    except (ValueError, TypeError) as e:
        print(f"💰 金额格式错误，提现失败: {e}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"💰 提现请求失败: {e}")
        return None

# ====================== 主函数 ======================
def main():
    pd()
    ts = []
    # 优先从 YYB 协议获取账号
    yyb_url = os.environ.get('YYB_BASE_URL', '').strip()
    if yyb_url:
        ts = fetch_accounts_from_yyb(yyb_url)
    # 回退到环境变量
    if not ts:
        ts = acc(bl_ql_sz)
    if not ts:
        print("⚠️ 未加载到任何wxid账号，脚本结束")
        return
    print(f"📌 共加载到 {len(ts)} 个账号，开始处理...")
    
    for i, t in enumerate(ts, 1):
        p = [x.strip() for x in t.split('#') if x.strip()]
        if len(p) < 2: 
            print(f"⚠️ 第{i}个账号数据格式错误，跳过")
            continue
        bz, wxid = p[0], p[1]
        print(f"\n-- {i}/{len(ts)} 🎐 {bz} --")
        
        phone, ut, tok = dl(bz, wxid)
        if ut and tok:
            # 执行签到
            sign(tok, ut)
            # 查询用户信息和余额
            p, amt, _ = info(tok, ut)
            if p is not None:
                # 隐藏手机号中间4位
                phone_hide = p[:3] + "****" + p[7:] if isinstance(p, str) and len(p) >= 11 else p
                print(f'当前余额: {amt}元，手机号: {phone_hide}')
                
                # 提现功能：余额大于3元且提现开关打开
                if txgn == 0 and amt is not None:
                    try:
                        amt_float = float(amt)
                        if amt_float > 3:
                            cash_apply(tok, ut, amt_float)
                        else:
                            print(f"💡 余额 {amt_float}元 < 3元，暂不提现")
                    except (ValueError, TypeError):
                        print(f"⚠️ 余额格式错误（{amt}），跳过提现")
        else:
            print(f"{bz} - 未获取到用户token，跳过签到和提现")
    
    jie_tz()

# ====================== 启动 ======================
if __name__ == "__main__":
    main()