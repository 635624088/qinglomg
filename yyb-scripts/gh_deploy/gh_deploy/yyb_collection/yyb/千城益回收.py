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


appid = 'wx433df2006009fd27'

def get_wx_code(YYB_BASE_URL, wx_auth, appid, qcyhscode):
    url = f'{YYB_BASE_URL}/wxapp/getCode'
    headers = {
        'Content-Type': 'application/json'
    }
    payload = {
        'app_id': appid,
        'ref': qcyhscode
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
                print(f"❌ 第{i + 1}次请求返回错误：{data.get('msg')}")
                if i < max_retry - 1:
                    time.sleep(2)
        except Exception as e:
            print(f"❌ 第{i + 1}次请求失败：{str(e)}")
            if i < max_retry - 1:
                print("⏳ 2秒后重试...")
                time.sleep(2)
    print("❌ 获取授权码失败")
    return None

qcyhscode_list = fetch_accounts_from_yyb()
for nickname, qcyhscode in qcyhscode_list:


    # 登录

    print(f'账号: {nickname} 执行')
    wxcode = get_wx_code(YYB_BASE_URL, wx_auth, appid, qcyhscode)
    url = "https://api.litao2580.cn/index.php/api/weapp/login"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Host": "api.litao2580.cn",
        "Referer": "https://servicewechat.com/wx433df2006009fd27/35/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Linux; Android 9; MI 8 SE Build/PKQ1.181121.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.180 Mobile Safari/537.36 XWEB/1380327 MMWEBSDK/20251101 MMWEBID/6046 MicroMessenger/8.0.67.3000(0x28004351) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "channel": "weapp",
        "site-id": "100000",
        "xweb_xhr": "1"
    }
    payload = {
        "code": wxcode,
        "nickname": "",
        "headimg": "",
        "mobile": "",
        "mobile_code": ""
    }
    resp = requests.post(url, headers=headers, json=payload)
    data = resp.json()
    msg = data.get("msg", "")
    if msg == "操作成功" or data.get("code") == 1:
        print("登录成功")
    else:
        print(f"登录失败: {msg}")
    token = data["data"]["token"]
    time.sleep(1)

    # 签到
    url = "https://api.litao2580.cn/index.php/api/member/sign"
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "Host": "api.litao2580.cn",
        "Referer": "https://servicewechat.com/wx433df2006009fd27/35/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Linux; Android 9; MI 8 SE Build/PKQ1.181121.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.180 Mobile Safari/537.36 XWEB/1380327 MMWEBSDK/20251101 MMWEBID/6046 MicroMessenger/8.0.67.3000(0x28004351) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "channel": "weapp",
        "site-id": "100000",
        "token": token,
        "xweb_xhr": "1"
    }
    payload = {}
    response = requests.post(url, headers=headers, json=payload)
    sign_data = response.json()
    sign_msg = sign_data.get("msg", "")
    if sign_data.get("code") == 0:
        print(f"签到成功: {sign_msg}")
    else:
        print(f"签到结果: {sign_msg}")

    headers = {
        "Host": "api.litao2580.cn",
        "site-id": "100000",
        "channel": "weapp",
        "token": token,
        "Content-Type": "application/json",
        "charset": "utf-8",
        "referer": "https://servicewechat.com/wx433df2006009fd27/35/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Linux; Android 9; MI 8 SE Build/PKQ1.181121.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.180 Mobile Safari/537.36 XWEB/1380327 MMWEBSDK/20251101 MMWEBID/6046 MicroMessenger/8.0.67.3000(0x28004351) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
    }
    # 看视频
    url = "https://api.litao2580.cn/index.php/api/clothes_recycle/lottery/add_times"
    data = {}
    for i in range(1, 12):
        print(f"第{i}次看视频")
        resp = requests.post(url, headers=headers, json=data)
        video_data = resp.json()
        video_msg = video_data.get("msg", "")
        if video_data.get("code") == 1:
            print(f"  视频任务完成")
        else:
            print(f"  视频结果: {video_msg}")
        time.sleep(1)
        print("正在延迟30秒")
        time.sleep(30)

    # 抽奖
    url = "https://api.litao2580.cn/index.php/api/clothes_recycle/lottery/draw"
    data = {}
    for i in range(1, 12):
        print(f"第{i}次抽奖")
        resp = requests.post(url, headers=headers, json=data)
        draw_data = resp.json()
        draw_msg = draw_data.get("msg", "")
        if draw_data.get("code") == 1:
            prize = draw_data.get("data", {}).get("prize_name", draw_data.get("data", {}).get("name", ""))
            print(f"  抽中: {prize}" if prize else f"  抽奖成功")
        else:
            print(f"  抽奖结果: {draw_msg}")
        time.sleep(1)
        print("正在延迟3秒")
        time.sleep(3)
