#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
绿袋环保小程序自动签到脚本（wxcode版）

cron: 40 8 * * *
"""

import os
import json
import time
import random
import requests
import urllib3
from datetime import datetime

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ==================== 配置 ====================
# 从环境变量读取配置
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080").strip().rstrip("/")
WX_AUTH = os.environ.get("wx_auth", "")
LVHB_APPID = "wxef20c241ccc93155"

BASE_URL = "https://www.lvdhb.com/MiniProgramApiCore/api/v3"

# 工具函数
def log(index, nickname, msg):
    print(f"[{datetime.now():%H:%M:%S}] [账号#{index}] {nickname}] {msg}")

def random_delay(min_s=1, max_s=3):
    time.sleep(random.uniform(min_s, max_s))

# 账号类
class LvhbBot:
    def __init__(self, openid, index, nickname=None):
        self.index = index
        self.openid = openid
        self.nickname = nickname or openid[:20]
        self.token = None
        self.session = requests.Session()

    def log(self, msg):
        log(self.index, self.nickname, msg)

    def get_wxcode(self):
        if not YYB_BASE_URL:
            raise Exception("未配置 YYB_BASE_URL，请先配置环境变量")
        headers = {"Content-Type": "application/json"}
        if WX_AUTH:
            headers["Authorization"] = f"Bearer {WX_AUTH}"
        data = {"app_id": LVHB_APPID, "ref": self.openid}
        resp = requests.post(f"{YYB_BASE_URL}/wxapp/getCode", headers=headers, json=data, timeout=30)
        result = resp.json()
        if result.get("code") != 0:
            raise Exception(f"获取 wxcode 失败: {result.get('msg', '未知')}")
        code = result.get("data", {}).get("result", {}).get("code")
        if not code:
            raise Exception(f"获取 wxcode 失败: 返回数据中无 code")
        return code

    def login(self):
        """用 wxcode 登录"""
        code = self.get_wxcode()
        url = f"{BASE_URL}/login/auth"
        headers = {"Content-Type": "application/json"}
        data = {"Source": "jywhs", "Code": code}

        resp = self.session.put(url, headers=headers, json=data, timeout=15, verify=False)
        result = resp.json()

        if result.get("token"):
            self.token = result["token"]
            
            return True
        else:
            raise Exception(f"登录失败: {result}")

    def get_headers(self):
        """构造请求头"""
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Referer": f"https://servicewechat.com/{LVHB_APPID}/page-frame.html",
        }
        if self.token:
            headers["token"] = self.token
        return headers

    def get_sign_info(self):
        """获取签到信息"""
        url = f"{BASE_URL}/Login/GetMySign"
        resp = self.session.get(url, headers=self.get_headers(), timeout=10, verify=False)
        return resp.json()

    def do_sign(self):
        """执行签到"""
        self.log("检查签到状态...")
        sign_info = self.get_sign_info()

        if isinstance(sign_info, dict) and sign_info.get("Success"):
            data = sign_info.get("Data", {})
            if data.get("signDates") and len(data["signDates"]) > 0:
                today = datetime.now().strftime("%Y-%m-%d")
                for date in data["signDates"]:
                    if today in date:
                        self.log("今日已签到")
                        return True

        self.log("执行签到...")
        url = f"{BASE_URL}/Login/Sign"
        resp = self.session.post(url, headers=self.get_headers(), json={}, timeout=10, verify=False)
        result = resp.json()

        if result.get("Success"):
            self.log(f"签到成功!")
            return True
        else:
            msg = result.get("Message") or "未知"
            if "已签到" in msg or "已经" in msg:
                self.log("今日已签到")
                return True
            self.log(f"签到失败: {msg}")
            return False

    def get_user_info(self):
        """获取用户信息"""
        url = f"{BASE_URL}/My/GetMyInfo"
        resp = self.session.get(url, headers=self.get_headers(), timeout=10, verify=False)
        result = resp.json()

        if isinstance(result, dict) and result.get("score") is not None:
            self.log(f"积分: {result.get('score', 0)} | 碳减排: {result.get('carbon', 0)}")
            return result
        return None

    def get_score(self):
        """获取积分"""
        url = f"{BASE_URL}/My/GetMyScore"
        resp = self.session.get(url, headers=self.get_headers(), timeout=10, verify=False)
        result = resp.json()

        if isinstance(result, dict) and result.get("score") is not None:
            self.log(f"积分: {result.get('score', 0)}")
            return result
        elif isinstance(result, (int, float)):
            self.log(f"积分: {result}")
            return {"score": result}
        return None

    def run(self):
        """主流程"""
        try:
            self.log("=" * 40)
            self.login()

            # 获取用户信息
            self.get_user_info()

            # 签到
            self.do_sign()

            # 获取积分
            self.get_score()

            self.log("任务完成!")

        except Exception as e:
            self.log(f"执行失败: {e}")

def fetch_accounts_from_server():
    """从 wx_server 获取所有账号 openid 列表"""
    try:
        headers = {"Content-Type": "application/json"}
        if WX_AUTH:
            headers["Authorization"] = f"Bearer {WX_AUTH}"
        r = requests.get(f"{YYB_BASE_URL}/accounts", headers=headers, timeout=10)
        d = r.json()
        if d.get("code") != 0:
            print(f"[获取账号] 失败: {d.get('msg', '')}")
            return []
        accounts = d.get("data", [])
        openids = []
        for acc in accounts:
            oid = acc.get("openid")
            if oid:
                openids.append(oid)
        print(f"[获取账号] 从服务器获取到 {len(openids)} 个账号")
        return [{"openid": oid, "nickname": acc.get("nickname") or acc.get("alias") or oid[:20]} for oid in openids for acc in accounts if acc.get("openid") == oid]
    except Exception as e:
        print(f"[获取账号] 异常: {e}")
        return []

# 主流程
def main():
    print("=" * 50)
    print(f"绿岛环保自动签到 | {datetime.now():%Y-%m-%d %H:%M:%S}")
    print("=" * 50)

    if not YYB_BASE_URL:
        print("❌ 错误：未配置 YYB_BASE_URL")
        return

    accounts = fetch_accounts_from_server()
    if not accounts:
        print("[错误] 未获取到账号, 请确认 wx_server 已登录账号")
        return
    print(f"共 {len(accounts)} 个账号")

    # 执行任务
    for idx, acc in enumerate(accounts, start=1):
        openid = acc.get("openid", "")
        nickname = acc.get("nickname", openid[:20])
        print(f"\n[>] 开始执行第 [{idx}/{len(accounts)}] 个账号...")
        bot = LvhbBot(openid, idx, nickname)
        bot.run()

        if idx < len(accounts):
            cooldown = random.randint(3, 8)
            print(f"[...] 等待 {cooldown} 秒后执行下一个账号...")
            time.sleep(cooldown)

    print("\n" + "=" * 50)
    print("全部完成!")

if __name__ == "__main__":
    main()
