import requests
import json
import time
import os

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "")
wx_auth = os.getenv("wx_auth", "")

# 获取账号昵称映射

def fetch_accounts_from_yyb():
    """从 YYB 协议获取账号列表，返回 [(nickname, openid), ...]"""
    try:
        url = f"{YYB_BASE_URL}/accounts"
        resp = requests.get(url, timeout=15)
        data = resp.json()
        if data.get('code') == 0 and data.get('data'):
            accounts = data.get('data', [])
            return [(acc.get('nickname', '') or acc.get('alias', '') or acc.get('openid', ''), acc.get('openid', '')) for acc in accounts]
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []


appid = 'wxef20c241ccc93155'
def get_wx_code(YYB_BASE_URL, wx_auth, appid, dshbjyfhscode):
    url = f'{YYB_BASE_URL}/wxapp/getCode'
    headers = {
        'Content-Type': 'application/json'
    }
    payload = {
        'app_id': appid,
        'ref': dshbjyfhscode
    }
    max_retry = 20
    for i in range(max_retry):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=10)
            data = resp.json()
            if data.get('code') == 0:
                wxcode = data['data']['result'].get('code') if isinstance(data['data'].get('result'), dict) else data['data'].get('result')
                print(f"第{i + 1}次请求成功，获取授权码：{wxcode}")
                return wxcode
            else:
                print(f" 第{i + 1}次请求返回错误：{data.get('msg')}")
                if i < max_retry - 1:
                    time.sleep(2)
        except Exception as e:
            print(f" 第{i + 1}次请求失败：{str(e)}")
            if i < max_retry - 1:
                print("⏳ 2秒后重试...")
                time.sleep(2)
    print("❌ 获取授权码失败")
    return None

dshbjyfhscode_list = fetch_accounts_from_yyb()
for nickname, dshbjyfhscode in dshbjyfhscode_list:


    # 登录

    print(f'账号: {nickname} 执行')
    print("正在获取授权码")
    wxcode = get_wx_code(YYB_BASE_URL, wx_auth, appid, dshbjyfhscode)
    url = "https://www.lvdhb.com/MiniProgramApiCore/api/v3/login/auth"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Host": "www.lvdhb.com",
        "Referer": "https://servicewechat.com/wxef20c241ccc93155/331/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18163",
        "xweb_xhr": "1"
    }
    payload = {
        "Source": "jywhs",
        "Code": wxcode
    }
    response = requests.put(url, headers=headers, json=payload, timeout=15)
    print("登录返回：", response.text)
    data = json.loads(response.text)
    token = data["token"]
    time.sleep(1)
    # 签到
    url = "https://www.lvdhb.com/MiniProgramApiCore/api/v3/Login/Sign"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Host": "www.lvdhb.com",
        "Referer": "https://servicewechat.com/wxef20c241ccc93155/331/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18163",
        "token": token,
        "xweb_xhr": "1"
    }
    body = {}
    response = requests.post(url, headers=headers, json=body, timeout=15)
    print("签到返回", response.text)
