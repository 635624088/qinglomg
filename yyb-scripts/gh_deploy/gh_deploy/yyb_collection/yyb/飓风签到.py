#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import os
import random
import string
import time
from typing import Dict, List, Tuple

import requests

requests.packages.urllib3.disable_warnings()

APP_ID = "wx92782ef90ebc836d"
KDT_ID = "149536603"
CLIENT_ID = "4d65249d377b2c3ed8"
MP_VERSION = "2.226.7.101"
PAGE_FRAME_VERSION = "17"
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
WX_CODE_API = os.getenv("WX_CODE_API", "/wxapp/getCode").strip() or "/wxapp/getCode"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254181d) XWEB/19201"
)

BASE_HEADERS = {
    "user-agent": UA,
    "xweb_xhr": "1",
    "content-type": "application/json",
    "accept": "*/*",
    "referer": f"https://servicewechat.com/{APP_ID}/{PAGE_FRAME_VERSION}/page-frame.html",
    "accept-language": "zh-CN,zh;q=0.9",
}

def gen_random_string(length: int = 24) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=length))

def parse_reward_titles(items: List[Dict]) -> str:
    titles = []
    for item in items or []:
        infos = item.get("infos") or {}
        title = infos.get("title") or infos.get("desc") or ""
        if title:
            titles.append(title)
    return "，".join(titles)

class JuFengSignIn:
    def __init__(self) -> None:
        self.yyb_base_url = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
        self.push_token = os.getenv("PUSH_PLUS_TOKEN", "")
        self.fskey = os.getenv("FSKEY", "")
        self.accounts = self.parse_accounts()

    @staticmethod
    def _fetch_accounts_from_yyb(yyb_base_url: str) -> List[Dict]:
        """从 YYB 协议获取账号列表"""
        if not yyb_base_url:
            return []
        try:
            resp = requests.get(f"{yyb_base_url}/accounts", timeout=10)
            data = resp.json()
            if data.get("code") == 0:
                accounts = []
                for item in data.get("data", []):
                    wxid = item.get("openid") or item.get("wxid") or ""
                    if wxid:
                        remark = item.get("nickname") or item.get("remark") or f"账号{len(accounts)+1}"
                        accounts.append({
                            "name": remark,
                            "mode": "wxid",
                            "wxid": wxid,
                        })
                if accounts:
                    print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                    return accounts
        except Exception as e:
            print(f"❌ 从 YYB 获取账号失败: {e}")
        return []

    def parse_accounts(self) -> List[Dict]:
        accounts: List[Dict] = []

        # 优先从 YYB 获取账号
        yyb_accounts = self._fetch_accounts_from_yyb(self.yyb_base_url)
        accounts.extend(yyb_accounts)

        raw_wxid = os.getenv("jfqd", "")
        for item in raw_wxid.replace("\n", "&").split("&"):
            item = item.strip()
            if not item:
                continue
            if "#" in item:
                name, wxid = item.split("#", 1)
            else:
                name, wxid = item, item
            accounts.append(
                {
                    "name": name.strip(),
                    "mode": "wxid",
                    "wxid": wxid.strip(),
                }
            )

        raw_token = os.getenv("jufeng_token", "")
        for item in raw_token.replace("\n", "&").split("&"):
            item = item.strip()
            if not item:
                continue
            parts = item.split("#")
            if len(parts) < 2:
                continue
            name = parts[0].strip()
            access_token = parts[1].strip()
            session_id = parts[2].strip() if len(parts) > 2 else ""
            accounts.append(
                {
                    "name": name,
                    "mode": "token",
                    "access_token": access_token,
                    "session_id": session_id,
                }
            )

        return accounts

    def build_headers(self, session_id: str = "") -> Dict[str, str]:
        ftime = int(time.time() * 1000)
        extra_data = {
            "is_weapp": 1,
            "sid": session_id,
            "version": MP_VERSION,
            "client": "weapp",
            "bizEnv": "wsc",
            "uuid": f"{gen_random_string(16)}{ftime}",
            "ftime": ftime,
        }
        return {
            **BASE_HEADERS,
            "extra-data": json.dumps(extra_data, separators=(",", ":"), ensure_ascii=False),
        }

    def get_wx_code(self, wxid: str) -> str:
        # 优先使用 YYB 协议
        if self.yyb_base_url:
            url = self.yyb_base_url + "/wxapp/getCode"
            payload = {"ref": wxid, "app_id": APP_ID}
            headers = {"Content-Type": "application/json", "User-Agent": UA}

            for attempt in range(3):
                try:
                    response = requests.post(url, json=payload, headers=headers, timeout=15)
                    data = response.json()
                    if data.get("code") == 0:
                        result = data.get("data", {}).get("result") or {}
                        code = result.get("code") or result.get("Code")
                        if code:
                            return str(code)
                    if data.get("Code") == 0:
                        return data.get("Data", {}).get("code", "")
                    if data.get("Success"):
                        return data.get("Data", {}).get("Code", "")
                    if data.get("code") == 200:
                        return data.get("data", {}).get("code", "")
                    
                except Exception as exc:
                    print(f"  YYB 请求异常({attempt + 1}/3): {exc}")
                    if attempt < 2:
                        time.sleep(2)

        # 回退到 WechatServer
        if not self.yyb_base_url:
            return ""

        url = self.yyb_base_url + WX_CODE_API
        payload = {"wxid": wxid, "appid": APP_ID}
        headers = {"Content-Type": "application/json", "User-Agent": UA}

        for attempt in range(3):
            try:
                response = requests.post(url, json=payload, headers=headers, timeout=60)
                data = response.json()
                if data.get("Code") == 0:
                    return data.get("Data", {}).get("code", "")
                if data.get("Success"):
                    return data.get("Data", {}).get("Code", "")
                if data.get("code") == 200:
                    return data.get("data", {}).get("code", "")
                
                return ""
            except Exception as exc:
                
                if attempt < 2:
                    time.sleep(2)

        return ""

    def get_access_token(self, code: str) -> Tuple[str, str]:
        url = f"https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}"
        payload = {
            "appId": APP_ID,
            "code": code,
            "platformName": "weapp",
            "signature": "windows",
            "clientId": CLIENT_ID,
            "grantType": "yz_union",
            "inWsc": True,
            "kdtId": KDT_ID,
            "extraBizData": {
                "enterOptions": {
                    "extKdtId": int(KDT_ID),
                    "path": "pages/home/dashboard/index",
                    "query": {},
                    "scene": 1005,
                    "referrerInfo": {},
                    "apiCategory": "default",
                },
                "guideBizDataMap": {"from_params": ""},
                "sceneData": {},
            },
        }

        headers = self.build_headers("")
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            data = response.json()
        except Exception as exc:
            raise RuntimeError(f"获取 access_token 异常: {exc}") from exc

        if data.get("code") != 0:
            raise RuntimeError(f"获取 access_token 失败: {data}")

        token_data = data.get("data", {})
        return token_data.get("accessToken", ""), token_data.get("sessionId", "")

    def get_checkin_id(self, access_token: str, session_id: str) -> int:
        url = "https://h5.youzan.com/wscump/checkin/check-in-info.json"
        headers = self.build_headers(session_id)
        params = {
            "app_id": APP_ID,
            "kdt_id": KDT_ID,
            "access_token": access_token,
        }

        response = requests.get(url, headers=headers, params=params, timeout=20)
        data = response.json()
        if data.get("code") != 0:
            raise RuntimeError(f"获取签到 ID 失败: {data}")
        return data.get("data", {}).get("checkInId", 0)

    def get_activity(self, access_token: str, session_id: str, checkin_id: int) -> Dict:
        url = "https://h5.youzan.com/wscump/checkin/get_activity_by_yzuid_v2.json"
        headers = self.build_headers(session_id)
        params = {
            "checkinId": checkin_id,
            "app_id": APP_ID,
            "kdt_id": KDT_ID,
            "access_token": access_token,
        }
        response = requests.get(url, headers=headers, params=params, timeout=20)
        data = response.json()
        if data.get("code") != 0:
            raise RuntimeError(f"获取签到状态失败: {data}")
        return data.get("data", {})

    def checkin(self, access_token: str, session_id: str, checkin_id: int) -> Dict:
        url = "https://h5.youzan.com/wscump/checkin/checkinV2.json"
        headers = self.build_headers(session_id)
        params = {
            "checkinId": checkin_id,
            "app_id": APP_ID,
            "kdt_id": KDT_ID,
            "access_token": access_token,
        }
        response = requests.get(url, headers=headers, params=params, timeout=20)
        return response.json()

    def sign_with_token(self, access_token: str, session_id: str) -> Tuple[bool, str]:
        if not access_token:
            return False, "access_token 为空"

        try:
            checkin_id = self.get_checkin_id(access_token, session_id)
            activity = self.get_activity(access_token, session_id, checkin_id)

            if activity.get("isCheckin"):
                day = activity.get("continuesDay", 0)
                daily_rewards = []
                for reward in activity.get("dailyRewards") or []:
                    desc = reward.get("desc")
                    if desc:
                        daily_rewards.append(desc)
                reward_text = "，".join(daily_rewards)
                msg = f"今天已签到，连续 {day} 天"
                if reward_text:
                    msg += f"，今日奖励 {reward_text}"
                return True, msg

            time.sleep(1)
            result = self.checkin(access_token, session_id, checkin_id)
            if result.get("code") != 0:
                msg = result.get("msg") or str(result)
                if "已签到" in msg:
                    return True, f"今天已签到: {msg}"
                return False, f"签到失败: {msg}"

            data = result.get("data", {})
            if data.get("success"):
                times = data.get("times") or data.get("days") or "?"
                reward_text = parse_reward_titles(data.get("list") or [])
                msg = f"签到成功，连续 {times} 天"
                if reward_text:
                    msg += f"，获得 {reward_text}"
                return True, msg

            return False, f"签到返回异常: {result}"
        except Exception as exc:
            return False, f"请求异常: {exc}"

    def sign_account(self, account: Dict) -> Tuple[bool, str]:
        if account["mode"] == "token":
            return self.sign_with_token(account["access_token"], account.get("session_id", ""))

        if not self.yyb_base_url:
            return False, "未配置 YYB_BASE_URL"
        code = self.get_wx_code(account["wxid"])
        if not code:
            return False, "获取 wx code 失败"
        
        try:
            access_token, session_id = self.get_access_token(code)
        except Exception as exc:
            return False, str(exc)

        if not access_token:
            return False, "获取 access_token 失败"
        return self.sign_with_token(access_token, session_id)

    def push_plus(self, title: str, content: str) -> None:
        if not self.push_token:
            return
        try:
            response = requests.post(
                "https://www.pushplus.plus/send",
                json={
                    "token": self.push_token,
                    "title": title,
                    "content": content,
                    "template": "html",
                },
                timeout=15,
            )
            data = response.json()
            print("PushPlus:", "成功" if data.get("code") == 200 else data.get("msg"))
        except Exception as exc:
            print(f"PushPlus 异常: {exc}")

    def feishu(self, title: str, content: str) -> None:
        if not self.fskey:
            return
        try:
            response = requests.post(
                f"https://open.feishu.cn/open-apis/bot/v2/hook/{self.fskey}",
                json={"msg_type": "text", "content": {"text": f"{title}\n{content}"}},
                timeout=15,
            )
            data = response.json()
            print("飞书:", "成功" if data.get("code") == 0 else data.get("msg"))
        except Exception as exc:
            print(f"飞书异常: {exc}")

    def run(self) -> None:
        if not self.accounts:
            print("未找到有效账号")
            return

        print(f"飓风签到，共 {len(self.accounts)} 个账号")
        results = []

        for index, account in enumerate(self.accounts, 1):
            print(f"\n[{index}] {account['name']}")
            ok, msg = self.sign_account(account)
            status = "OK" if ok else "FAIL"
            print(f"  [{status}] {msg}")
            results.append({"name": account["name"], "status": status, "msg": msg})
            if index < len(self.accounts):
                time.sleep(2)

        title = "飓风签到通知"
        content = "\n".join(
            f"[{item['status']}] {item['name']}: {item['msg']}" for item in results
        )
        self.push_plus(title, content)
        self.feishu(title, content)

if __name__ == "__main__":
    JuFengSignIn().run()
