#!/usr/bin/env python3
"""
现金收益参考:每月单号3元现金
name: 天牛旧衣服回收，起提2元
环境变量：
  - YYB_BASE_URL：YYB 协议地址

cron: 0 5 * * *
"""
#import notify
import requests, json, os, sys, time, random, datetime
#---------------------主代码区块---------------------
session = requests.session()

# wechatLoader 配置
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080")  # YYB 协议地址
TIANNIU_APPID = "wx887c2f947bffa76e"  # 天牛回收小程序 appid

def get_code_by_wxid(wxid, appid):
    """通过 YYB 协议获取小程序 code"""
    url = f'{YYB_BASE_URL}/wxapp/getCode'
    header = {
        "Content-Type": "application/json",
    }
    data = {"ref": wxid, "app_id": appid}
    try:
        response = session.post(url=url, headers=header, json=data)
        result = json.loads(response.text)
        if result.get("code") in {0, "0"}:
            data = result.get("data") or {}
            nested = data.get("result") or data
            return nested.get("code")
        else:
            print(f"☁️获取code失败：{result.get('msg', result.get('Message', '未知错误'))}")
            return None
    except Exception as e:
        print(f"☁️获取code异常：{e}")
        return None

def wxid_login(wxid, appid):
    """通过 wxid 登录天牛回收获取 token"""
    # 第一步: 获取小程序 code
    code = get_code_by_wxid(wxid, appid)
    if not code:
        return None
    
    # 第二步: 调用天牛回收登录接口 (使用 getWxMiniProgramSessionKey)
    url = 'https://tianniunew.fzjingzhou.com/api/login/getWxMiniProgramSessionKey'
    header = {
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240501 MMWEBID/3169 MicroMessenger/8.0.50.2701(0x2800325B) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "content-type": "application/x-www-form-urlencoded",
        "platform": "MP-WEIXIN",
    }
    data = f'code={code}&gdtVid=&token=wek2020123456788wek'
    try:
        response = session.post(url=url, headers=header, data=data)
        result = json.loads(response.text)
        if result.get("code") == 1000 and result.get("data", {}).get("token"):
            token = result["data"]["token"]
            mobile = result["data"].get("personInfo", {}).get("mobile", "未知")
            print(f"📱wxid登录成功：{mobile}")
            return token
        else:
            print(f"☁️登录失败：{result.get('msg', result.get('Message', '未知错误'))}")
            return None
    except Exception as e:
        print(f"☁️登录异常：{e}")
        return None

def money(ck):
    url = 'https://tianniunew.fzjingzhou.com/api/cash/scoreWithdraw'
    header = {
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240501 MMWEBID/3169 MicroMessenger/8.0.50.2701(0x2800325B) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "content-type": "application/x-www-form-urlencoded",
        "platform": "MP-WEIXIN",
    }
    data = f'type=wx_account&score=20&token={ck}'
    try:
        response = session.post(url=url, headers=header, data=data)
        tx = json.loads(response.text)
        return tx["msg"]
    except Exception as e:
        #print(e)
        pass

def userinfo(ck):
    url = 'https://tianniunew.fzjingzhou.com/api/Person/index'
    header = {
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240501 MMWEBID/3169 MicroMessenger/8.0.50.2701(0x2800325B) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "content-type": "application/x-www-form-urlencoded",
        "platform": "MP-WEIXIN",
    }
    data = f'token={ck}'
    try:
        response = session.post(url=url, headers=header, data=data)
        info = json.loads(response.text)
        #print(info)
        if "success" in info["msg"]:
            return info["data"]["exchange"],info["data"]["mobile"],info["data"]["sign_in_num"]
    except Exception as e:
        #print(e)
        pass

def run(ck):
    login = 'https://tianniunew.fzjingzhou.com/api/Person/sign'
    header = {
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.188 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240501 MMWEBID/3169 MicroMessenger/8.0.50.2701(0x2800325B) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        "content-type": "application/x-www-form-urlencoded",
        "platform": "MP-WEIXIN",
    }
    data = f'token={ck}'
    try:
        userinfo(ck)
        response = session.post(url=login, headers=header, data=data)
        login = json.loads(response.text)
        a , b, c = userinfo(ck)
        if login["code"] == 1000:
            if int(c) in [1,3,5,7]:
                print(f"📱：{b}\n☁️签到：成功\n☁️获得：0.1元\n🌈现金：{a}元")
            else:
                print(f"📱：{b}\n☁️签到：成功\n🌈现金：{a}元")
            if float(a) >= 2:
                print(f"☁️提现：{money(ck)}")
        else:
            if int(c) in [1,3,5,7]:
                print(f"📱：{b}\n☁️签到：{login['msg']}\n☁️获得：0.1元\n🌈现金：{a}元")
            else:
                print(f"📱：{b}\n☁️签到：{login['msg']}\n🌈现金：{a}元")
            if float(a) >= 2:
                print(f"☁️提现：{money(ck)}")
        time.sleep(2)
    except Exception as e:
        print("📱：账号已过期或异常")

def fetch_accounts_from_yyb(yyb_base_url: str) -> list[dict]:
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
                    accounts.append({"type": "wxid", "value": openid, "appid": TIANNIU_APPID, "remark": nickname})
            return accounts
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []

def main():
    # 收集所有账号
    accounts = []
    
    # 优先从 YYB 协议获取账号
    yyb_url = os.environ.get("YYB_BASE_URL", "").strip()
    if yyb_url:
        accounts = fetch_accounts_from_yyb(yyb_url)
    
    # 回退到环境变量
    if not accounts:
        # 方式1: 传统 token 方式
        if os.environ.get("tnhs"):
            for tk in os.environ.get("tnhs").split('\n'):
                if tk.strip():
                    accounts.append({"type": "token", "value": tk.strip()})
        

        if os.environ.get("tnjy"):
            for wxid_line in os.environ.get("tnjy").split('\n'):
                if wxid_line.strip():
                    parts = wxid_line.strip().split('#')
                    wxid = parts[1] if len(parts) > 1 else parts[0]
                    # 检查是否有自定义 appid
                    appid_parts = wxid.split('|')
                    wxid = appid_parts[0]
                    appid = appid_parts[1] if len(appid_parts) > 1 else TIANNIU_APPID
                    accounts.append({"type": "wxid", "value": wxid, "appid": appid})
    
    if not accounts:
        print("请设置变量 YYB_BASE_URL 或 tnhs(token) 或 tnjy(wxid)")
        sys.exit()
    
    if datetime.datetime.strptime('05:01', '%H:%M').time() <= datetime.datetime.now().time() <= datetime.datetime.strptime('06:59', '%H:%M').time():
        time.sleep(random.randint(100, 500))
    
    print(f"{' ' * 10}꧁༺ 天牛༒回收 ༻꧂\n")
    for i, acc in enumerate(accounts):
        print(f'\n----------- 🍺账号【{i + 1}/{len(accounts)}】执行🍺 -----------')
        try:
            if acc["type"] == "wxid":
                # wxid 方式登录获取 token
                print(f"📱wxid：{acc['value']}")
                ck = wxid_login(acc["value"], acc["appid"])
                if ck:
                    run(ck)
                else:
                    print("☁️wxid登录失败，跳过")
            else:
                # 传统 token 方式
                run(acc["value"])
            time.sleep(random.randint(1, 2))
        except Exception as e:
            print(e)
            #notify.send('title', 'message')

    print(f'\n----------- 🎊 执 行  结 束 🎊 -----------')

if __name__ == '__main__':
    main()
