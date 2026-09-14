import requests
import json
import random
import time
import os
from datetime import datetime

# ====================== 配置 ======================
ENV_NAME = 'rqsp'
SCRIPT_NAME = "日清食品"
SCRIPT_VERSION = "2.1"

BASE_URL = "https://foodhall-prod-api.nissinfoodium.com.cn"
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
WXID_API_URL = f"{YYB_BASE_URL}/wxapp/getCode"
APPID = "wx21b71db59d93bd6d"

log_list = []

def log(msg: str):
    print(msg)
    log_list.append(msg)

def fetch_accounts_from_yyb(yyb_base_url):
    """从 YYB 协议获取账号列表"""
    try:
        resp = requests.get(f"{yyb_base_url}/accounts", timeout=10)
        data = resp.json()
        if data.get('code') == 0:
            accounts = []
            for item in data.get('data', []):
                wxid = item.get('openid') or item.get('wxid') or ''
                if wxid:
                    remark = item.get('nickname') or item.get('remark') or f"账号{len(accounts)+1}"
                    accounts.append((remark, wxid))
            if accounts:
                log(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                return accounts
    except Exception as e:
        log(f"❌ 从 YYB 获取账号失败: {e}")
    return []


def parse_env_accounts():
    accounts = []
    env_value = os.getenv(ENV_NAME, '')
    
    if env_value:
        lines = env_value.strip().split('\n')
        for line in lines:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '#' in line:
                remark, wxid = line.split('#', 1)
                accounts.append((remark.strip(), wxid.strip()))
                log(f"✅ 读取账号: {remark}")
    else:
        log("⚠️ 未设置环境变量，使用默认测试账号")
        accounts = [("测试账号", "test_wxid")]
    
    return accounts

def get_wx_code(wxid, yyb_base_url):
    """从 YYB 协议获取微信 code"""
    try:
        resp = requests.post(
            f"{yyb_base_url}/wxapp/getCode",
            json={"app_id": APPID, "ref": wxid},
            timeout=15
        )
        if resp.status_code == 200:
            data = resp.json()
            # YYB 格式: {"code": 0, "data": {"result": {"code": "xxx"}}}
            if data.get('code') == 0:
                result = data.get('data', {}).get('result') or {}
                return result.get('code') or result.get('Code')
            # 兼容其他格式
            if data.get('Success'):
                return data.get('Data', {}).get('code')
    except Exception as e:
        log(f"获取code失败: {e}")
    return None

def get_openid(code):
    url = f"{BASE_URL}/miniapp/auth/getOpenId"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254186b) XWEB/19481',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
    payload = {"code": code, "invitorMemberId": 0}
    
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                return result.get('data', {}).get('openId')
    except Exception as e:
        log(f"获取openId失败: {e}")
    return None

def login_with_openid(openid):
    url = f"{BASE_URL}/miniapp/auth/login"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254186b) XWEB/19481',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
    payload = {"openId": openid}
    
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                data = result.get('data', {})
                return data.get('accessToken'), data.get('userId')
    except Exception as e:
        log(f"登录失败: {e}")
    return None, None

def login_with_wxid(remark, wxid, yyb_base_url):
    code = get_wx_code(wxid, yyb_base_url)
    if not code:
        log(f"{remark} ❌ 获取code失败")
        return None, None
    
    openid = get_openid(code)
    if not openid:
        log(f"{remark} ❌ 获取openId失败")
        return None, None
    
    token, user_id = login_with_openid(openid)
    if token and user_id:
        log(f"{remark} ✅ 登录成功")
        return user_id, token
    else:
        log(f"{remark} ❌ 登录失败")
        return None, None

def create_headers(token):
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254186b) XWEB/19481',
        'authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }

def get_user_info(remark, token):
    url = f"{BASE_URL}/miniapp/member/info"
    headers = create_headers(token)
    
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                data = result.get('data', {})
                mobile = data.get('mobile', '')
                if mobile:
                    log(f"{remark} 📱 手机号: {mobile[:3]}****{mobile[-4:]}")
                return data
    except Exception as e:
        log(f"{remark} 获取用户信息异常: {e}")
    return None

def get_points(remark, token):
    url = f"{BASE_URL}/miniapp/member/point"
    headers = create_headers(token)
    
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                data = result.get('data', {})
                if isinstance(data, dict):
                    points = data.get('availablePoints', 0)
                else:
                    points = data
                log(f"{remark} 💰 当前积分: {points}")
                return points
    except Exception as e:
        log(f"{remark} 获取积分异常: {e}")
    return 0

def sign_in(remark, token):
    """签到 - 修复了数据类型的兼容性问题"""
    # 检查签到状态
    url = f"{BASE_URL}/miniapp/sign-in/statistics"
    headers = create_headers(token)
    
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                data = result.get('data', {})
                # 修复：确保 data 是字典类型
                if isinstance(data, dict) and data.get('isSign'):
                    log(f"{remark} ✅ 今日已签到 | 连续{data.get('continueDays', 0)}天")
                    return True
    except Exception as e:
        log(f"{remark} 获取签到状态异常: {e}")
    
    # 执行签到
    url = f"{BASE_URL}/miniapp/sign-in"
    try:
        resp = requests.post(url, json={}, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                data = result.get('data', {})
                # 修复：兼容 data 为整数或字典的情况
                if isinstance(data, dict):
                    points = data.get('points', 0)
                    log(f"{remark} ✅ 签到成功！获得{points}积分")
                elif isinstance(data, int):
                    log(f"{remark} ✅ 签到成功！获得{data}积分")
                else:
                    log(f"{remark} ✅ 签到成功")
                return True
            else:
                msg = result.get('msg', '未知错误')
                if '已签到' in msg:
                    log(f"{remark} ✅ 今日已签到")
                else:
                    log(f"{remark} ❌ 签到失败: {msg}")
        else:
            log(f"{remark} ❌ 签到失败: HTTP {resp.status_code}")
    except Exception as e:
        log(f"{remark} 签到异常: {e}")
    return False

def lottery(remark, token):
    log(f"{remark} 🎁 开始抽奖...")
    
    # 获取抽奖次数
    url = f"{BASE_URL}/miniapp/activity/lottery/grid/user/times"
    headers = create_headers(token)
    
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                times = result.get('data', 0)
                if times > 0:
                    log(f"{remark} 🎯 剩余抽奖次数: {times}")
                else:
                    log(f"{remark} ⚠️ 今日无抽奖次数")
                    return
    except Exception as e:
        log(f"{remark} 获取抽奖次数异常: {e}")
        return
    
    # 获取活动信息
    url = f"{BASE_URL}/miniapp/activity/lottery/grid/info"
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code == 200:
            result = resp.json()
            if result.get('code') == 0:
                activity_id = result.get('data', {}).get('id')
                if not activity_id:
                    log(f"{remark} ❌ 未找到活动ID")
                    return
            else:
                log(f"{remark} ❌ 获取活动信息失败")
                return
    except Exception as e:
        log(f"{remark} 获取活动信息异常: {e}")
        return
    
    # 执行抽奖
    url = f"{BASE_URL}/miniapp/activity/lottery/grid"
    for i in range(times):
        payload = {"activityId": activity_id, "lotteryType": "FREE"}
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
            if resp.status_code == 200:
                result = resp.json()
                if result.get('code') == 0:
                    prize = result.get('data', {}).get('prizeName', '未知奖品')
                    log(f"{remark} 🎉 第{i+1}/{times}次抽奖: {prize}")
                else:
                    log(f"{remark} ❌ 第{i+1}次抽奖失败: {result.get('msg')}")
            else:
                log(f"{remark} ❌ 第{i+1}次抽奖失败: HTTP {resp.status_code}")
        except Exception as e:
            log(f"{remark} 第{i+1}次抽奖异常: {e}")
        
        time.sleep(random.randint(1, 2))

def process_account(remark, wxid, yyb_base_url=""):
    log(f"\n{'='*50}")
    log(f"开始处理: {remark}")
    log(f"{'='*50}")
    
    user_id, token = login_with_wxid(remark, wxid, yyb_base_url)
    if not token:
        return False
    
    time.sleep(1)
    get_user_info(remark, token)
    time.sleep(1)
    get_points(remark, token)
    time.sleep(1)
    sign_in(remark, token)
    time.sleep(1)
    lottery(remark, token)
    
    log(f"{remark} ✅ 处理完成")
    return True

def main():
    print(f"\n{'='*50}")
    print(f"{SCRIPT_NAME} 自动化脚本 v{SCRIPT_VERSION}")
    print(f"{'='*50}\n")
    
    # 优先从 YYB 获取账号
    yyb_base_url = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
    accounts = fetch_accounts_from_yyb(yyb_base_url)
    
    # 回退到环境变量
    if not accounts:
        accounts = parse_env_accounts()
    
    if not accounts:
        log("❌ 无有效账号配置")
        return
    
    success_count = 0
    fail_count = 0
    
    for idx, (remark, wxid) in enumerate(accounts, 1):
        log(f"\n📋 进度: {idx}/{len(accounts)}")
        
        try:
            if process_account(remark, wxid, yyb_base_url):
                success_count += 1
            else:
                fail_count += 1
        except Exception as e:
            log(f"{remark} ❌ 处理异常: {e}")
            fail_count += 1
        
        if idx < len(accounts):
            wait_time = random.randint(5, 10)
            log(f"⏰ 等待 {wait_time} 秒...")
            time.sleep(wait_time)
    
    print(f"\n{'='*50}")
    print(f"执行完成！成功: {success_count}, 失败: {fail_count}")
    print(f"{'='*50}")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n⚠️ 脚本被手动终止")
    except Exception as e:
        print(f"\n❌ 脚本执行异常: {e}")