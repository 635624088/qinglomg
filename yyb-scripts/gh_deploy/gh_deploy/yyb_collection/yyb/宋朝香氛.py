# 宋朝香氛小程序签到脚本
# 入口: 微信小程序搜索宋朝香氛
#
# 环境变量：
#   YYB_BASE_URL - YYB 协议地址


import requests
import time
import urllib3
import json
import os
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

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

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
wx_auth = os.getenv("wx_auth", "")
# 优先从 YYB 协议获取账号
yyb_url = YYB_BASE_URL.strip()

scxxcode_list = fetch_accounts_from_yyb(yyb_url)

appid = 'wx7ee0e0b22778858e'
def get_wx_code(yyb_base_url, wx_auth, appid, scxxcode):
    url = f'{yyb_base_url}/wxapp/getCode'
    headers = {
        'Content-Type': 'application/json'
    }
    payload = {
        'app_id': appid,
        'ref': scxxcode
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
                print(f"  获取授权码失败: {data.get('msg')}")
                if i < max_retry - 1:
                    time.sleep(2)
        except Exception as e:
            print(f"  获取授权码异常: {str(e)}")
            if i < max_retry - 1:
                time.sleep(2)
    print("  获取授权码失败")
    return None

for nickname, scxxcode in scxxcode_list:
    if not scxxcode:
        continue
    print(f'账号: {nickname} 执行')
    # 登录
    wxcode = get_wx_code(YYB_BASE_URL, wx_auth, appid, scxxcode)
    if not wxcode:
        print('  登录失败')
        continue
    url = "https://xapi.weimob.com/fe/mapi/user/loginX"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18163",
        "Referer": "https://servicewechat.com/wx7ee0e0b22778858e/25/page-frame.html",
        "Cookie": "rprm_cuid=11003921266ug6unmomf",
        "Content-Type": "application/json",
        "weimob-bosId": "4022477719421",
        "weimob-cid": "1052599421",
        "x-biz-id": "1",
        "x-req-from": "cms",
        "xweb_xhr": "1"
    }
    data = {
        "appid": "wx7ee0e0b22778858e",
        "basicInfo": {"bosId": "4022477719421", "cid": "1052599421", "tcode": "weimob", "vid": "6017285246421"},
        "env": "production",
        "extendInfo": {"source": 1},
        "is_pre_fetch_open": True,
        "parentVid": 0,
        "pid": "",
        "storeId": "",
        "code": wxcode,
        "queryAuthConfig": True
    }
    resp = requests.post(url=url, headers=headers, json=data)
    result = resp.json()
    if result.get("errcode") == 0 and result.get("data", {}).get("token"):
        print("  登录成功")
        XWXToken = result["data"]["token"]
    else:
        print(f"  登录失败: {result.get('errmsg', '未知错误')}")
        continue
    time.sleep(1)

    # 签到
    url = "https://xapi.weimob.com/api3/onecrm/mactivity/sign/misc/sign/activity/core/c/sign"
    headers = {
        "Content-Type": "application/json",
        "Cookie": "rprm_cuid=4331148852b111be17kg",
        "Referer": "https://servicewechat.com/wx7ee0e0b22778858e/20/page-frame.html",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18163",
        "cloud-bosid": "4022477719421",
        "parentrpcid": "b2666807449e214e",
        "weimob-bosId": "4022477719421",
        "weimob-pid": "N/A",
        "wos-x-channel": "0:TITAN",
        "x-apm-conversation-id": "4a38fce0-5ba5-022d-c0e7-bd878307f7",
        "x-apm-page-id": "8eba3cc9-48ec-65a9-a6c4-6634be58fc",
        "x-apm-parent-page-id": "af9ddea4-836c-edf9-7275-328bd6807e",
        "x-biz-id": "146",
        "x-cms-sdk-request": "1.5.130",
        "x-cmssdk-vidticket": "10917-1774331192.100-saas-w1-1806-28195654262",
        "x-component-is": "onecrm/signgift",
        "x-page-route": "onecrm/signgift",
        "x-req-from": "onecrm",
        "x-wmsdk-bc": "1 1774331148868",
        "x-wmsdk-close-store": "v2",
        "x-wmsdk-vid": "6017285246421",
        "X-WX-Token": XWXToken,
        "xweb_xhr": "1"
    }
    data = {
        "appid": "wx7ee0e0b22778858e",
        "basicInfo": {
            "vid": 6017285246421,
            "vidType": 2,
            "bosId": 4022477719421,
            "productId": 146,
            "productInstanceId": 20939645421,
            "productVersionId": "10003",
            "merchantId": 2000501316421,
            "tcode": "weimob",
            "cid": 1052599421
        },
        "extendInfo": {
            "wxTemplateId": 8097,
            "analysis": [],
            "bosTemplateId": 1000002146,
            "childTemplateIds": [
                {"customId": 90004, "version": "crm@0.1.79"},
                {"customId": 90002, "version": "ec@79.0-ai"},
                {"customId": 90006, "version": "hudong@0.0.249"},
                {"customId": 90008, "version": "cms@0.0.523"},
                {"customId": 90070, "version": "1.0.12"}
            ],
            "quickdeliver": {"enable": True},
            "youshu": {"enable": False},
            "source": 1,
            "channelsource": 5,
            "refer": "onecrm-signgift",
            "mpScene": 1145
        },
        "queryParameter": None,
        "i18n": {"language": "zh", "timezone": "8"},
        "pid": "",
        "storeId": "",
        "customInfo": {"source": 0, "wid": 11923665071}
    }
    response = requests.post(url, headers=headers, json=data, verify=False, proxies={"https": None, "http": None})
    try:
        sign_result = response.json()
        errcode = sign_result.get("errcode", "")
        if errcode == "0" or errcode == 0:
            fixed = sign_result.get("data", {}).get("fixedReward", {})
            points = fixed.get("points", 0)
            print(f"  签到成功获得{points}个币")
        else:
            errmsg = sign_result.get("errmsg", "未知错误")
            print(f"  签到失败: {errmsg}")
    except Exception:
        print(f"  签到失败: 解析返回异常")
