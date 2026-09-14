import requests
import json
import hashlib
import datetime
import time
import os

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "")
wx_auth = os.getenv("wx_auth", "")

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


appid = 'wxc67f02d47590b09c'
secret = "H0WwISkAPNdRo6Ck1FrFb90tFCsOhOGF"

# 获取账号昵称映射

def get_time_str():
    now = datetime.datetime.now()
    return now.strftime("%Y%m%d%H%M%S")

def get_wx_code(YYB_BASE_URL, wx_auth, appid, hfczyyqccode):
    url = f'{YYB_BASE_URL}/wxapp/getCode'
    headers = {
        'Content-Type': 'application/json'
    }
    payload = {
        'app_id': appid,
        'ref': hfczyyqccode
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

hfczyyqccode_list = fetch_accounts_from_yyb()
for nickname, hfczyyqccode in hfczyyqccode_list:


    print(f'账号: {nickname} 执行')
    try:
        # 登录
        wxcode = get_wx_code(YYB_BASE_URL, wx_auth, appid, hfczyyqccode)
        if not wxcode:
            print("未获取到wxcode，跳过当前账号")
            continue

        url = "https://huafei.henanchilong.com/index/login/index"
        headers = {
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Content-Type": "application/json",
            "Host": "huafei.henanchilong.com",
            "Referer": "https://servicewechat.com/wxc67f02d47590b09c/15/page-frame.html",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18151",
            "xweb_xhr": "1"
        }
        data = {
            "code": wxcode
        }
        resp = requests.post(url, headers=headers, json=data)
        print("登录返回:", resp.text)
        data = json.loads(resp.text)
        sessionkey = data["data"]["session_key"]
        time.sleep(1)

        # 签到
        url = "https://huafei.henanchilong.com/index/sign/index"
        headers = {
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Content-Type": "application/json",
            "Host": "huafei.henanchilong.com",
            "Referer": "https://servicewechat.com/wxc67f02d47590b09c/15/page-frame.html",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18151",
            "session-key": sessionkey,
            "xweb_xhr": "1"
        }
        body = {}
        resp = requests.post(url, headers=headers, json=body)
        print("签到返回：", resp.text)

        for i in range(1, 4):
            print(f"第{i}次执行看广告任务")
            # 获取广告
            time_val = get_time_str()
            str1 = f"ad_unit_id=adunit-b876a5eb947859d6&time={time_val}&secret={secret}"
            sign1 = hashlib.md5(str1.encode("utf-8")).hexdigest()
            url = "https://huafei.henanchilong.com/index/ad/create_ad"
            payload = {
                "ad_unit_id": "adunit-b876a5eb947859d6",
                "time": time_val,
                "sign": sign1
            }
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=15)
                print("获取视频返回:", resp.text)
                data = json.loads(resp.text)
                # 判断data["data"]是不是字典
                if isinstance(data.get("data"), dict) and "ad_no" in data["data"]:
                    ad_no = data["data"]["ad_no"]
                else:
                    print("今日广告次数已用完或无广告数据，退出当前账号广告循环")
                    break

                time.sleep(1)
                print("正在延迟35秒")
                time.sleep(35)

                # 看广告
                time_val = get_time_str()
                str2 = f"ad_no={ad_no}&time={time_val}&secret={secret}"
                sign2 = hashlib.md5(str2.encode("utf-8")).hexdigest()
                url = "https://huafei.henanchilong.com/index/ad/send_money"
                payload = {
                    "ad_no": ad_no,
                    "time": time_val,
                    "sign": sign2
                }
                resp = requests.post(url, headers=headers, json=payload, timeout=15)
                print("看视频返回：", resp.text)
                time.sleep(1)
                print("正在延迟4秒")
                time.sleep(4)
            except Exception as e:
                print(f"第{i}次广告任务异常: {str(e)}，继续下一次循环")
                continue
    except Exception as e:
    
        print(f"账号 {nickname} 整体执行异常：{str(e)}，切换下一个账号")
        continue
