#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
谷雨会员 每日签到 (YYB版)

入口: 微信小程序搜索"谷雨会员"
功能: 每日签到 + 查询积分

环境变量:
  YYB_BASE_URL  YYB 服务地址 (默认 http://172.17.0.1:18080)
  YYB_REF       指定账号 ref (可选，默认遍历所有账号)
"""

import hashlib
import json
import os
import time
import uuid
import warnings
from datetime import datetime

import requests
import urllib3

warnings.filterwarnings("ignore", category=requests.packages.urllib3.exceptions.InsecureRequestWarning)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ====== YYB 配置 ======
YYB_BASE = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "") or None
# ======================

# ====== 业务常量 ======
APP_NAME = "谷雨会员"
APPID = "wxda948f3be0afc375"

RY_API_BASE = "https://mall-mobile-v6.vecrp.com"
RY_WXAPP_LOGIN = f"{RY_API_BASE}/mobile/wxAppLogin"

SHOP_ID = "100186753"
ACTIVITY_ID = "cdd30467-abb8-4944-8941-2879aa950a86"
SECRET_KEY = "R6WbJ830wNsEdjH9GumwKYiYxHz0K9QD"

USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; M2012K11AC Build/TKQ1.221114.001; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 "
    "Mobile Safari/537.36 XWEB/1460243 MMWEBSDK/20260502 MMWEBID/1538 "
    "MicroMessenger/8.0.76.3140(0x28004C30) WeChat/arm64 Weixin NetType/4G "
    "Language/zh_CN ABI/arm64 MiniProgramEnv/android"
)
# ======================


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"[✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    payload = {"ref": ref, "app_id": APPID}
    resp = requests.post(f"{YYB_BASE}/wxapp/getCode", json=payload, timeout=30)
    data = resp.json()
    if data.get("code") == 0:
        result = data.get("data", {}).get("result", {})
        code = result.get("code")
        if code:
            return code
        print(f"    [✗] getCode 返回中没有 code: {json.dumps(result, ensure_ascii=False)}")
        return None
    print(f"    [✗] YYB getCode 失败: {data.get('msg', '未知错误')}")
    return None


# ====== 谷雨签名算法 ======
def generate_sort_string(params):
    """把 dict 转成 sorted key+value 拼接字符串"""
    items = []
    for k in params:
        v = params[k]
        items.append(f"{k}{v}")
    items.sort()
    return "".join(items)


def generate_sign(data_dict, is_post=True, timestamp=None):
    """生成谷雨 API 签名"""
    ts = timestamp or int(time.time() * 1000)
    if is_post:
        sign_params = {
            "body": json.dumps(data_dict, separators=(",", ":")),
            "secretKey": SECRET_KEY,
            "ts": str(ts),
        }
    else:
        sign_params = dict(data_dict)
        sign_params["secretKey"] = SECRET_KEY
        sign_params["ts"] = str(ts)

    raw = generate_sort_string(sign_params)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def ry_request(method, url, token, data=None, params=None):
    """发送带签名的请求到谷雨 API"""
    timestamp = int(time.time() * 1000)
    traced_id = str(uuid.uuid4())
    is_post = method.upper() == "POST"

    sign = generate_sign(data if is_post else (params or {}), is_post=is_post, timestamp=timestamp)

    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json;charset=UTF-8",
        "appid": APPID,
        "token": token or "",
        "sign": sign,
        "ts": str(timestamp),
        "starttime": str(timestamp + 1),
        "x-tracedid": traced_id,
        "charset": "utf-8",
        "Referer": f"https://servicewechat.com/{APPID}/73/page-frame.html",
    }

    kwargs = {"headers": headers, "timeout": 25, "verify": False}
    if is_post:
        # 关键：用 data=body_str 而不是 json=，确保 body 和签名时一致（无空格）
        body_str = json.dumps(data, separators=(",", ":"))
        kwargs["data"] = body_str
    else:
        kwargs["params"] = params

    try:
        resp = requests.request(method, url, **kwargs)
        return resp.json() if resp.text else {}
    except Exception as e:
        return {"success": False, "msg": str(e)}


# ====== 谷雨会员任务 ======
class GuyuTask:
    def __init__(self, account, index):
        self.index = index
        self.nickname = account.get("nickname", "未知")
        self.ref = str(account.get("id", ""))
        self.token = None

    def log(self, msg):
        print(f"    {msg}")

    def login(self):
        self.log("[1/6] 获取 wx.login code...")
        code = yyb_get_code(self.ref)
        if not code:
            raise Exception("获取 code 失败")

        self.log("[2/6] 登录谷雨会员...")
        headers = {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json;charset=UTF-8",
            "appid": APPID,
            "token": "",
            "Referer": f"https://servicewechat.com/{APPID}/73/page-frame.html",
        }
        body = {
            "code": code,
            "appid": APPID,
            "shopId": SHOP_ID,
            "envVersion": "release",
            "isEnterpriseWx": False,
            "scene": 1027,
            "referrerInfo": {},
        }
        try:
            resp = requests.post(RY_WXAPP_LOGIN, json=body, headers=headers, verify=False, timeout=30)
            result = resp.json()
        except Exception as e:
            raise Exception(f"登录请求异常: {e}")

        if result.get("success"):
            self.token = result.get("result", {}).get("mobileToken")
            if self.token:
                self.log(f"[✓] 登录成功, token={self.token[:20]}...")
                return
        raise Exception(f"登录失败: {result.get('msg') or json.dumps(result, ensure_ascii=False)}")

    def get_my_member(self):
        """加载会员信息（签到前必须调用，否则部分账号报 用户id不能为空）"""
        self.log("[3/6] 加载会员信息...")
        result = ry_request("GET",
                            f"{RY_API_BASE}/mobile/customer/getMyMember",
                            self.token,
                            params={"shopId": SHOP_ID, "guideId": "", "guideShopId": ""})
        if result.get("success"):
            info = result.get("result", {})
            card = info.get("memberCard", "")
            grade = info.get("gradeName", "")
            self.log(f"[✓] 会员卡: {card}, 等级: {grade}")
        else:
            self.log(f"  [⚠] 加载会员信息异常: {result.get('msg', '')}")

    def check_activity(self):
        """查询签到活动信息"""
        self.log("[4/6] 查询签到活动...")
        result = ry_request("GET",
                            f"{RY_API_BASE}/mobile/activity/sign/loadActivityInfo",
                            self.token,
                            params={
                                "activityId": ACTIVITY_ID,
                                "source": "undefined",
                                "shopId": SHOP_ID,
                            })
        if result.get("success"):
            info = result.get("result", {})
            title = info.get("title", "")
            sign_days = info.get("signDays", 0)
            points = info.get("customerIntegral", "?")
            state = info.get("customerState")
            self.log(f"[✓] {title}")
            self.log(f"  当前积分: {points}, 已签天数: {sign_days}")
            if state == 3:
                self.log(f"  [→] 今日已签到")
                return True
            return False
        self.log(f"[✗] 查询活动信息失败: {result.get('msg', '')}")
        return None

    def query_sign_list(self):
        """查询本月签到记录"""
        now = datetime.now()
        start = f"{now.year}-{now.month}-01"
        end = f"{now.year}-{now.month}-{now.day}"
        result = ry_request("POST",
                            f"{RY_API_BASE}/mobile/activity/sign/querySignInfoList",
                            self.token,
                            data={
                                "activityId": ACTIVITY_ID,
                                "startDate": start,
                                "endDate": end,
                            })
        if result.get("success"):
            dates = result.get("result", {}).get("signDateList", [])
            today = f"{now.year}-{now.month}-{now.day}"
            if today in dates:
                self.log(f"  [→] 签到列表确认: 今日已签")
                return True
            return False
        self.log(f"  [⚠] 查询签到列表失败")
        return None

    def sign_in(self):
        """执行签到"""
        self.log("[5/6] 执行签到...")
        now = datetime.now()
        sign_date = f"{now.year}-{now.month}-{now.day}"

        result = ry_request("POST",
                            f"{RY_API_BASE}/mobile/activity/sign/sign",
                            self.token,
                            data={
                                "shopId": SHOP_ID,
                                "activityId": ACTIVITY_ID,
                                "signDate": sign_date,
                            })
        if result.get("success"):
            r = result.get("result", {})
            points = r.get("integral", "?")
            self.log(f"[✓] 签到成功！获得 {points} 积分")
            return True
        self.log(f"[✗] 签到失败: {result.get('msg', '未知')}")
        return False

    def get_points(self):
        """查询积分"""
        self.log("[6/6] 查询积分...")
        result = ry_request("GET",
                            f"{RY_API_BASE}/mobile/customer/getMyAllPoint",
                            self.token,
                            params={"shopId": SHOP_ID})
        if result.get("success"):
            score = result.get("result", [{}])[0].get("score", "?")
            self.log(f"[📊] 当前积分: {score}")
        else:
            self.log(f"[✗] 查询积分失败")

    def run(self):
        try:
            self.login()
            self.get_my_member()
            signed = self.check_activity()
            if signed is True:
                self.log(f"  [→] 跳过签到")
            elif signed is False:
                self.query_sign_list()
                self.sign_in()
                # 签到后再确认
                self.check_activity()
            self.get_points()
        except Exception as e:
            self.log(f"[✗] 执行失败: {e}")


# ====== 主函数 ======
def main():
    print("=" * 56)
    print(f"  {APP_NAME} 每日签到 (YYB版)")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 56)

    print("\n[1/3] 获取 YYB 账号列表...")
    accounts = yyb_get_accounts()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        return

    if YYB_REF:
        accounts = [a for a in accounts
                    if str(a.get("id")) == YYB_REF or a.get("openid") == YYB_REF]
        if not accounts:
            print(f"[✗] 未找到 ref={YYB_REF} 的账号")
            return
        print(f"[✓] 指定账号, 共 1 个\n")
    else:
        print(f"[✓] 共 {len(accounts)} 个账号\n")

    results = []
    for i, account in enumerate(accounts, 1):
        print(f"[{i}/{len(accounts)}] {'=' * 40}")
        nickname = account.get("nickname") or account.get("openid", "")[:16] or "未知"
        print(f"  📱 账号: {nickname}")

        task = GuyuTask(account, i)
        try:
            task.run()
            results.append(True)
        except Exception as e:
            print(f"  [✗] 异常: {e}")
            results.append(False)

        if i < len(accounts):
            time.sleep(3)

    print(f"\n[✓] 完成! 成功 {sum(results)}/{len(accounts)}")
    print("=" * 56)


if __name__ == "__main__":
    main()
