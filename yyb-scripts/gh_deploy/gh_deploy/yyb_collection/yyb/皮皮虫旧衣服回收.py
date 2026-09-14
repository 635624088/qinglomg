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


appid = 'wx56fd2cd88c6f834c'
def get_wx_code(YYB_BASE_URL, wx_auth, appid, ppcjyfhscode):
    url = f'{YYB_BASE_URL}/wxapp/getCode'
    headers = {
        'Content-Type': 'application/json'
    }
    payload = {
        'app_id': appid,
        'ref': ppcjyfhscode
    }
    max_retry = 20
    for i in range(max_retry):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=10)
            data = resp.json()
            if data.get('code') == 0:
                wxcode = data['data']['result'].get('code') if isinstance(data['data'].get('result'), dict) else data['data'].get('result')
                return wxcode
            else:
                print(f" 第{i + 1}次请求返回错误：{data.get('msg')}")
                if i < max_retry - 1:
                    time.sleep(2)
        except Exception as e:
            print(f"❌ 第{i + 1}次请求失败：{str(e)}")
            if i < max_retry - 1:
                print("⏳ 2秒后重试...")
                time.sleep(2)
    print("❌ 获取授权码失败")
    return None

def get_wx_getphonenumber(YYB_BASE_URL, wx_auth, appid, ppcjyfhscode):
    url = f'{YYB_BASE_URL}/wxapp/getPhoneNumber'
    headers = {
        'Content-Type': 'application/json'
    }
    payload = {
        'app_id': appid,
        'ref': ppcjyfhscode
    }
    max_retry = 20
    for i in range(max_retry):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=10)
            data = resp.json()
            if data.get('code') == 0:
                result = data['data']['result']
                return json.dumps(result)
            else:
                print(f" 第{i + 1}次请求返回错误：{data.get('msg')}")
                if i < max_retry - 1:
                    time.sleep(2)
        except Exception as e:
            print(f"❌ 第{i + 1}次请求失败：{str(e)}")
            if i < max_retry - 1:
                print("⏳ 2秒后重试...")
                time.sleep(2)
    print("❌ 获取手机号失败")
    return None

ppcjyfhscode_list = fetch_accounts_from_yyb()
for nickname, ppcjyfhscode in ppcjyfhscode_list:


    # 登录

    print(f'账号: {nickname} 执行')
    wxcode = get_wx_code(YYB_BASE_URL, wx_auth, appid, ppcjyfhscode)
    wxgetuserinfo = get_wx_getphonenumber(YYB_BASE_URL, wx_auth, appid, ppcjyfhscode)
    data = json.loads(wxgetuserinfo)
    wxencryptedData = data["encryptedData"]
    wxiv = data["iv"]
    url = "https://pp.ppcjw.com/api/v1/passport/authLogin?medium=wx&version=1.0"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Host": "pp.ppcjw.com",
        "Referer": "https://servicewechat.com/wx56fd2cd88c6f834c/6/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18151",
        "authorization": "Bearer 0",
        "xweb_xhr": "1"
    }
    post_data = {
        "encryptedData": wxencryptedData,
        "iv": wxiv,
        "code": wxcode,
        "invite_code": ""
    }
    response = requests.post(url, headers=headers, json=post_data, timeout=15)
    data = response.json()
    msg = data.get("msg", "")
    if msg == "登录成功" or msg.encode('utf-8').decode('unicode_escape') == "登录成功" or data.get("code") == 0:
        print("登录成功")
    else:
        print(f"登录失败: {msg}")
    access_token = data["data"]["access_token"]
    time.sleep(1)

    # 签到
    url = "https://pp.ppcjw.com/api/v1/signin/report?medium=wx&version=1.0"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Host": "pp.ppcjw.com",
        "Referer": "https://servicewechat.com/wx56fd2cd88c6f834c/6/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18151",
        "authorization": "Bearer " + access_token,
        "xweb_xhr": "1"
    }
    body = {}
    resp = requests.post(url, headers=headers, json=body)
    sign_data = resp.json()
    sign_msg = sign_data.get("msg", "")
    if sign_data.get("code") == 1:
        print(f"签到成功: {sign_msg}")
    else:
        print(f"签到结果: {sign_msg}")
