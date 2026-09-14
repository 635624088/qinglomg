#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
燕之坊签到脚本（wxid 登录版）

环境变量：

  YYB_BASE_URL:
    YYB协议地址，默认 http://172.17.0.1:18080
  PUSH_PLUS_TOKEN:
    可选，PushPlus 推送 token
  FSKEY:
    可选，飞书机器人 key

运行：
  python 燕之坊签到.py
"""

from __future__ import annotations

import json
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

APP_NAME = "燕之坊签到"
BASE_URL = "https://xapi.weimob.com"
APP_ID = "wxe8a8a323cc15dc26"
REFERER = f"https://servicewechat.com/{APP_ID}/208/page-frame.html"
DEFAULT_ENV = "yanzhifang"
AUTH_CACHE_FILE = ".yanzhifang_auth_cache.json"
DEFAULT_TIMEOUT = 20

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254181d) XWEB/19201"
)

COMMON_CONTEXT = {
    "appid": APP_ID,
    "queryParameter": None,
    "i18n": {"language": "zh", "timezone": "8"},
    "pid": "100001391942",
    "storeId": "0",
}

SIGN_BASIC_INFO = {
    "vid": 6001416090325,
    "vidType": 2,
    "bosId": 4001553598325,
    "productId": 146,
    "productInstanceId": 3180737325,
    "productVersionId": "14026",
    "merchantId": 2000073997325,
    "tcode": "weimob",
    "cid": 217480325,
}

SIGN_EXTEND_INFO = {
    "wxTemplateId": 8124,
    "analysis": [],
    "bosTemplateId": 1000002173,
    "childTemplateIds": [
        {"customId": 90004, "version": "crm@0.1.86"},
        {"customId": 90002, "version": "ec@81.0"},
        {"customId": 90006, "version": "hudong@0.0.251"},
        {"customId": 90008, "version": "cms@0.0.525"},
        {"customId": 90070, "version": "1.0.14ym"},
    ],
    "quickdeliver": {"enable": False},
    "youshu": {"enable": False},
    "source": 1,
    "channelsource": 5,
    "refer": "onecrm-signgift",
}

def compact_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))

def split_items(raw: str) -> List[str]:
    items: List[str] = []
    for part in str(raw or "").replace("\r", "\n").replace("\n", "&").split("&"):
        part = part.strip()
        if part:
            items.append(part)
    return items

def random_hex(size: int) -> str:
    return secrets.token_hex(size)

def random_uuid() -> str:
    return str(uuid.uuid4())

def mask_value(value: str, keep: int = 6) -> str:
    value = str(value or "").strip()
    if len(value) <= keep * 2:
        return value or "-"
    return f"{value[:keep]}...{value[-keep:]}"

def normalize_errmsg(data: Any) -> str:
    if not isinstance(data, dict):
        return str(data)
    return (
        str(data.get("errmsg") or "")
        or str(data.get("bizErrmsg") or "")
        or str(data.get("message") or "")
        or json.dumps(data, ensure_ascii=False)
    )

def safe_json_loads(text: str) -> Dict[str, Any]:
    try:
        data = json.loads(text or "{}")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def ok_resp(data: Dict[str, Any]) -> bool:
    return str(data.get("errcode", "")) == "0"

def fmt_amount(value: Any) -> str:
    try:
        num = float(value)
    except Exception:
        return str(value)
    if num.is_integer() and num >= 1:
        num = num / 100.0
    return f"{num:.2f}元"

@dataclass
class Account:
    name: str
    wxid: str

    @property
    def label(self) -> str:
        return self.name or self.wxid

@dataclass
class AuthInfo:
    token: str
    wid: int
    openid: str = ""
    source: str = "login"

class AuthCache:
    def __init__(self, path: str = AUTH_CACHE_FILE):
        self.path = path

    def load(self) -> Dict[str, Any]:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def save(self, data: Dict[str, Any]) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def get(self, account: Account) -> Optional[AuthInfo]:
        cache = self.load()
        item = cache.get(account.wxid)
        if not isinstance(item, dict):
            return None
        token = str(item.get("token") or "").strip()
        if not token:
            return None
        return AuthInfo(
            token=token,
            wid=int(item.get("wid") or 0),
            openid=str(item.get("openid") or "").strip(),
            source="cache",
        )

    def set(self, account: Account, auth: AuthInfo) -> None:
        cache = self.load()
        cache[account.wxid] = {
            "name": account.name,
            "wxid": account.wxid,
            "token": auth.token,
            "wid": int(auth.wid or 0),
            "openid": auth.openid,
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
        }
        self.save(cache)

class WeimobClient:
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.verify = False
        self.timeout = DEFAULT_TIMEOUT
        self.conversation_id = random_uuid()
        self.parent_page_id = random_uuid()
        self.cuid = f"{str(int(time.time() * 1000))[-11:]}{random_hex(5)}"

    @staticmethod
    def build_sign_payload(wid: int) -> Dict[str, Any]:
        return {
            **COMMON_CONTEXT,
            "basicInfo": dict(SIGN_BASIC_INFO),
            "extendInfo": json.loads(json.dumps(SIGN_EXTEND_INFO)),
            "customInfo": {"source": 0, "wid": int(wid)},
        }

    @staticmethod
    def build_login_payload(code: str) -> Dict[str, Any]:
        return {
            "appid": APP_ID,
            "basicInfo": {
                "bosId": str(SIGN_BASIC_INFO["bosId"]),
                "cid": str(SIGN_BASIC_INFO["cid"]),
                "tcode": SIGN_BASIC_INFO["tcode"],
                "vid": str(SIGN_BASIC_INFO["vid"]),
            },
            "env": "production",
            "extendInfo": {"source": 1},
            "is_pre_fetch_open": True,
            "parentVid": 0,
            "pid": COMMON_CONTEXT["pid"],
            "storeId": COMMON_CONTEXT["storeId"],
            "code": code,
            "queryAuthConfig": True,
        }

    @staticmethod
    def build_vid_ticket() -> str:
        now = int(time.time())
        left = secrets.randbelow(90000) + 10000
        mid = secrets.randbelow(900) + 100
        node = secrets.randbelow(9000) + 1000
        tail = secrets.randbelow(90000000000) + 10000000000
        return f"{left}-{now}.{mid}-saas-w1-{node}-{tail}"

    @staticmethod
    def build_rpc_id() -> str:
        return random_hex(8)

    @staticmethod
    def infer_req_from(path: str) -> str:
        return "onecrm" if "/onecrm/" in path else "hd_lego"

    @staticmethod
    def infer_component(path: str) -> str:
        return "onecrm/signgift" if "/onecrm/" in path else "hd_lego/index"

    @staticmethod
    def infer_page_route(path: str) -> str:
        return "onecrm/signgift" if "/onecrm/" in path else "hd_lego/index"

    def build_headers(
        self,
        path: str,
        payload: Dict[str, Any],
        token: str = "",
        attempt: int = 0,
    ) -> Dict[str, str]:
        basic_info = payload.get("basicInfo") or {}
        bos_id = str(basic_info.get("bosId") or payload.get("bosId") or "")
        headers: Dict[str, str] = {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            "referer": REFERER,
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9",
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "xweb_xhr": "1",
            "weimob-pid": "N/A",
            "wos-x-channel": "0:TITAN",
            "x-wmsdk-close-store": "v2",
        }

        if token:
            headers["x-wx-token"] = token

        if not path.startswith("/fe/mapi/user/"):
            headers["x-apm-page-id"] = random_uuid()
            headers["x-apm-conversation-id"] = self.conversation_id
            headers["x-cmssdk-vidticket"] = self.build_vid_ticket()
            headers["parentrpcid"] = self.build_rpc_id()
            headers["x-cms-sdk-request"] = "1.5.135"
            headers["cookie"] = f"rprm_cuid={self.cuid}"
            headers["x-req-from"] = self.infer_req_from(path)
            headers["x-component-is"] = self.infer_component(path)
            headers["x-page-route"] = self.infer_page_route(path)
            headers["x-apm-parent-page-id"] = self.parent_page_id
            if basic_info.get("productId") is not None:
                headers["x-biz-id"] = str(basic_info["productId"])
            if basic_info.get("vid") is not None:
                headers["x-wmsdk-vid"] = str(basic_info["vid"])
            headers["x-wmsdk-bc"] = f"1 {int(time.time() * 1000)}"
            if bos_id:
                headers["weimob-bosid"] = bos_id

        return headers

    def post_json(self, path: str, payload: Dict[str, Any], token: str = "") -> Dict[str, Any]:
        last_error: Optional[Exception] = None
        for attempt in range(3):
            try:
                body = compact_json(payload).encode("utf-8")
                resp = self.session.post(
                    f"{BASE_URL}{path}",
                    headers=self.build_headers(path, payload, token, attempt),
                    data=body,
                    timeout=self.timeout,
                )
                text = resp.text.strip()
                data = safe_json_loads(text)
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code}: {normalize_errmsg(data or text)}")
                if not data:
                    raise RuntimeError(f"非 JSON 响应: {text[:160]}")
                if not ok_resp(data):
                    raise RuntimeError(normalize_errmsg(data))
                return data
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(0.8 * (attempt + 1))
        raise RuntimeError(str(last_error or "请求失败"))

    def login_with_code(self, code: str) -> AuthInfo:
        result = self.post_json("/fe/mapi/user/loginX", self.build_login_payload(code), "")
        data = result.get("data") or {}
        token = str(data.get("token") or "").strip()
        wid = int(data.get("wid") or 0)
        openid = str(data.get("openId") or data.get("openid") or "").strip()
        if not token:
            raise RuntimeError("登录成功但未返回 token")
        if not wid:
            raise RuntimeError("登录成功但未返回 wid")
        return AuthInfo(token=token, wid=wid, openid=openid, source="login")

    def sign_main_info(self, token: str, wid: int) -> Dict[str, Any]:
        result = self.post_json(
            "/api3/onecrm/mactivity/sign/misc/sign/activity/c/signMainInfo",
            self.build_sign_payload(wid),
            token,
        )
        return result.get("data") or {}

    def do_sign(self, token: str, wid: int) -> Dict[str, Any]:
        result = self.post_json(
            "/api3/onecrm/mactivity/sign/misc/sign/activity/core/c/sign",
            self.build_sign_payload(wid),
            token,
        )
        return result.get("data") or {}

class YanZhiFangSign:
    def __init__(self) -> None:
        self.yyb_base_url = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").strip().rstrip("/")
        self.push_token = os.getenv("PUSH_PLUS_TOKEN", "").strip()
        self.fskey = os.getenv("FSKEY", "").strip()
        self.accounts = self.parse_accounts()
        self.cache = AuthCache()

    @staticmethod
    def _fetch_accounts_from_yyb(yyb_base_url: str) -> List[Account]:
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
                        accounts.append(Account(name=remark, wxid=wxid))
                if accounts:
                    print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                    return accounts
        except Exception as e:
            print(f"❌ 从 YYB 获取账号失败: {e}")
        return []

    def parse_accounts(self) -> List[Account]:
        # 优先从 YYB 获取账号
        yyb_accounts = self._fetch_accounts_from_yyb(self.yyb_base_url)
        accounts = list(yyb_accounts)
        
        raw = os.getenv(DEFAULT_ENV, "").strip()
        for item in split_items(raw):
            if "#" in item:
                name, wxid = item.split("#", 1)
            else:
                name, wxid = "", item
            wxid = wxid.strip()
            if not wxid:
                continue
            accounts.append(Account(name=name.strip() or wxid, wxid=wxid))
        return accounts

    def push_plus(self, title: str, content: str) -> None:
        if not self.push_token:
            return
        try:
            requests.post(
                "https://www.pushplus.plus/send",
                json={
                    "token": self.push_token,
                    "title": title,
                    "content": content,
                    "template": "html",
                },
                timeout=15,
            )
        except Exception as exc:
            print(f"PushPlus 推送失败: {exc}")

    def feishu(self, title: str, content: str) -> None:
        if not self.fskey:
            return
        try:
            requests.post(
                f"https://open.feishu.cn/open-apis/bot/v2/hook/{self.fskey}",
                json={"msg_type": "text", "content": {"text": f"{title}\n{content}"}},
                timeout=15,
            )
        except Exception as exc:
            print(f"飞书推送失败: {exc}")

    def get_wx_code(self, wxid: str) -> str:
        # 优先使用 YYB 协议
        if self.yyb_base_url:
            url = f"{self.yyb_base_url}/wxapp/getCode"
            headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
            payload = {"ref": wxid, "app_id": APP_ID}

            for attempt in range(3):
                try:
                    resp = requests.post(url, json=payload, headers=headers, timeout=15)
                    data = resp.json()
                    if data.get("code") == 0:
                        result = data.get("data", {}).get("result") or {}
                        code = result.get("code") or result.get("Code")
                        if code:
                            return str(code).strip()
                    if data.get("Code") == 0:
                        return str((data.get("Data") or {}).get("code") or "").strip()
                    if data.get("Success"):
                        return str((data.get("Data") or {}).get("Code") or "").strip()
                    if data.get("code") == 200:
                        return str((data.get("data") or {}).get("code") or "").strip()
                    raise RuntimeError(f"YYB 获取 wx code 失败: {data}")
                except Exception as exc:
                    if attempt == 2:
                        raise RuntimeError(str(exc))
                    time.sleep(2)

        # 回退到 WechatServer
        if not self.wechat_server:
            raise RuntimeError("YYB_BASE_URL 和 WECHAT_SERVER 都未配置")
        url = f"{self.wechat_server}/api/v1/wx/app/get/code"
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        payload = {"wxid": wxid, "appid": APP_ID}

        for attempt in range(3):
            try:
                resp = requests.post(url, json=payload, headers=headers, timeout=60)
                data = resp.json()
                if data.get("Code") == 0:
                    return str((data.get("Data") or {}).get("code") or "").strip()
                if data.get("Success"):
                    return str((data.get("Data") or {}).get("Code") or "").strip()
                if data.get("code") == 200:
                    return str((data.get("data") or {}).get("code") or "").strip()
                raise RuntimeError(f"获取 wx code 失败: {data}")
            except Exception as exc:
                if attempt == 2:
                    raise RuntimeError(str(exc))
                time.sleep(2)
        raise RuntimeError("获取 wx code 失败")

    def validate_cached_auth(self, client: WeimobClient, auth: AuthInfo) -> bool:
        if not auth.token or not auth.wid:
            return False
        try:
            client.sign_main_info(auth.token, auth.wid)
            return True
        except Exception:
            return False

    def resolve_auth(self, client: WeimobClient, account: Account) -> AuthInfo:
        cached = self.cache.get(account)
        if cached and self.validate_cached_auth(client, cached):
            print("  使用缓存 token")
            return cached
        code = self.get_wx_code(account.wxid)
        if not code:
            raise RuntimeError("获取 wx code 失败")
        
        auth = client.login_with_code(code)
        self.cache.set(account, auth)
        print(f"  token={mask_value(auth.token)}")
        return auth

    @staticmethod
    def sign_state_msg(info: Dict[str, Any]) -> str:
        rewards = []
        for item in info.get("signForwardMsg") or []:
            key = str(item.get("key", "")).strip()
            value = str(item.get("value", "")).strip()
            if key and value:
                rewards.append(f"{key}{value}")
            elif value:
                rewards.append(value)

        parts = ["今日已签到"]
        if info.get("keepSignDate") not in (None, ""):
            parts.append(f"连续{info['keepSignDate']}天")
        if info.get("monthCumulativeSignDays") not in (None, ""):
            parts.append(f"本月{info['monthCumulativeSignDays']}天")
        if rewards:
            parts.append(f"奖励: {'，'.join(rewards)}")
        return "，".join(parts)

    @staticmethod
    def reward_msg(data: Dict[str, Any]) -> str:
        parts = []
        fixed = data.get("fixedReward") or {}
        extra = data.get("extraReward") or {}
        point_name = str(data.get("pointName") or "积分")
        balance_name = str(data.get("balanceName") or "余额")
        growth_name = str(data.get("growthName") or "成长值")

        point_total = int(fixed.get("points") or 0) + int(extra.get("points") or 0)
        growth_total = int(fixed.get("growth") or 0) + int(extra.get("growth") or 0)
        amount_total = float(fixed.get("amount") or 0) + float(extra.get("amount") or 0)
        coupon_total = int(fixed.get("couponCount") or 0) + int(extra.get("couponCount") or 0)

        if point_total:
            parts.append(f"{point_name}+{point_total}")
        if growth_total:
            parts.append(f"{growth_name}+{growth_total}")
        if amount_total:
            parts.append(f"{balance_name}+{fmt_amount(amount_total)}")
        if coupon_total:
            parts.append(f"优惠券x{coupon_total}")
        return "，".join(parts)

    def run_one(self, account: Account) -> Tuple[bool, str]:
        client = WeimobClient()
        auth = self.resolve_auth(client, account)

        info = client.sign_main_info(auth.token, auth.wid)
        print(f"  wid={auth.wid}")
        if info.get("hasSign") is True:
            return True, self.sign_state_msg(info)

        sign_data = client.do_sign(auth.token, auth.wid)
        reward_text = self.reward_msg(sign_data)
        time.sleep(1)
        latest = client.sign_main_info(auth.token, auth.wid)

        parts = ["签到成功"]
        if latest.get("keepSignDate") not in (None, ""):
            parts.append(f"连续{latest['keepSignDate']}天")
        if latest.get("monthCumulativeSignDays") not in (None, ""):
            parts.append(f"本月{latest['monthCumulativeSignDays']}天")
        if reward_text:
            parts.append(f"奖励: {reward_text}")
        return True, "，".join(parts)

    def run(self) -> None:
        if not self.accounts:
            print(f"未找到账号，请设置环境变量 {DEFAULT_ENV}")

            return

        if not (self.yyb_base_url or self.wechat_server):
            print("未配置 YYB_BASE_URL 或 WECHAT_SERVER")
            return

        print(f"{APP_NAME}，共 {len(self.accounts)} 个账号")
        results = []

        for index, account in enumerate(self.accounts, 1):
            print(f"\n[{index}] {account.label}")
            try:
                ok, msg = self.run_one(account)
            except Exception as exc:
                ok, msg = False, str(exc)
            status = "OK" if ok else "FAIL"
            print(f"  [{status}] {msg}")
            results.append({"label": account.label, "ok": ok, "msg": msg, "status": status})
            if index < len(self.accounts):
                time.sleep(2)

        title = f"{APP_NAME}通知"
        text = "\n".join(f"[{item['status']}] {item['label']}: {item['msg']}" for item in results)
        html = "<h3>燕之坊签到结果</h3>" + "".join(
            f"<p><b>{item['label']}</b>: [{item['status']}] {item['msg']}</p>" for item in results
        )
        self.push_plus(title, html)
        self.feishu(title, text)
        print("\n执行完成")

if __name__ == "__main__":
    YanZhiFangSign().run()
