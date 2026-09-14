import requests
import time
import json
import hashlib
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


appid = 'wxc5a4e4ddde94f63f'
def get_wx_code(YYB_BASE_URL, wx_auth, appid, btwjyfhs):
    url = f'{YYB_BASE_URL}/wxapp/getCode'
    headers = {
        'Content-Type': 'application/json'
    }
    payload = {
        'app_id': appid,
        'ref': btwjyfhs
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

btwjyfhs_list = fetch_accounts_from_yyb()
for nickname, btwjyfhs in btwjyfhs_list:


    print(f"账号: {nickname} 执行")
    # 登录
    wxcode = get_wx_code(YYB_BASE_URL, wx_auth, appid, btwjyfhs)
    timestamp_ms = int(time.time() * 1000)
    url = "https://baitouweng.haliaeetus.cn/yixun/recy/api/user/registerAuthCode"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Authorization": "***",
        "Content-Type": "application/json",
        "Host": "baitouweng.haliaeetus.cn",
        "Referer": "https://servicewechat.com/wxc5a4e4ddde94f63f/36/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18163",
        "channelNo": "",
        "plateForm": "WX",
        "xweb_xhr": "1"
    }
    data_body = {
        "authCode": wxcode,
        "userName": "",
        "advatar": ""
    }
    str_m = str(timestamp_ms)
    json_data_str = json.dumps(data_body, separators=(',', ':'))
    sign_src = str_m + json_data_str
    sorted_chars = sorted(sign_src)
    result = "".join(sorted_chars).strip()
    md5_obj = hashlib.md5(result.encode('utf-8'))
    s_sign = md5_obj.hexdigest()
    payload = {
        "data": data_body,
        "m": timestamp_ms,
        "s": s_sign
    }
    response = requests.post(url, headers=headers, json=payload, timeout=15)
    data = response.json()
    msg = data.get("msg", "")
    if msg == "success":
        print("登录成功")
    else:
        print(f"登录失败: {msg}")
    token = data["data"]["token"]
    time.sleep(1)
    # 签到
    url = "https://baitouweng.haliaeetus.cn/yixun/fuli/api/fuli/signed"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Authorization": token,
        "Content-Type": "application/json",
        "Host": "baitouweng.haliaeetus.cn",
        "Referer": "https://servicewechat.com/wxc5a4e4ddde94f63f/36/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18163",
        "channelNo": "",
        "plateForm": "WX",
        "xweb_xhr": "1"
    }
    resp = requests.get(url, headers=headers, timeout=15)
    print("签到返回", resp.text)
