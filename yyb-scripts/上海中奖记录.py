#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上海职工文化网络大赛 (OUTPUT15) 奖品查询脚本

环境变量:
    - YYB_BASE_URL: YYB Go 地址（可选，默认 http://172.17.0.1:18080）
    - shzg_appid: 小程序 appid（可选，默认 wx21fee1602f5ed3f7）

账号来源:
    - 自动从 YYB Go /accounts 读取 status=alive 的微信账号

数据缓存:
    - 同级目录 shzg.json
"""

import os
import random
import time
import json
import re
import sys
import warnings
from datetime import datetime
from pathlib import Path

import requests
from fake_useragent import UserAgent

warnings.filterwarnings("ignore", category=requests.packages.urllib3.exceptions.InsecureRequestWarning)

# ===================== 配置 =====================
BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "shzg.json"
BASE_URL = "https://sgxmgl.shszgh.cn"
YYB_BASE = os.getenv("YYB_BASE_URL") or os.getenv("YYB_URL") or "http://172.17.0.1:18080"

RETRY_TIMES = 3
RETRY_DELAY = 3

# 奖品状态映射（与小程序 mine.js 一致）
PRIZE_STATUS = {
    0: "待处理",
    1: "处理中",
    2: "已发奖",
}


# ===================== 辅助函数 =====================
def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def random_wait(min_sec=2, max_sec=4):
    time.sleep(random.randint(min_sec, max_sec))


def sc_ua():
    try:
        return UserAgent().random
    except Exception:
        return (
            "Mozilla/5.0 (Linux; Android 10; SM-G960U Build/QP1A.190711.020; wv) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 "
            "Mobile Safari/537.36 MicroMessenger/8.0.62(0x18003e26) "
            "miniProgram/wx8d41cdc44c8aeaab"
        )


def fetch_code(openid):
    """通过 YYB Go /wxapp/getCode 让指定微信登录上海职工大赛小程序，返回 code。

    YYB 偶发返回空 code（"假成功"），加重试吸收抖动。
    """
    appid = os.getenv("shzg_appid", "wx21fee1602f5ed3f7")
    url = f"{YYB_BASE}/wxapp/getCode"
    payload = {"app_id": appid, "ref": openid}

    for attempt in range(1, 4):
        try:
            resp = requests.post(url, json=payload, timeout=30)
            rd = resp.json()
            if rd.get("code") == 0:
                result = (rd.get("data") or {}).get("result") or {}
                code = str(result.get("code") or "")
                if code:
                    log(f"✅ 成功获取code: {code}")
                    return code
                log(f"⚠️ getCode 返回空 code (第{attempt}次): {str(rd)[:160]}")
            else:
                msg = rd.get("msg") or f"code={rd.get('code')}"
                log(f"❌ getCode 失败：{msg}")
                return None
        except Exception as e:
            log(f"❌ 获取code异常 (第{attempt}次)：{e}")
        if attempt < 3:
            random_wait(2, 4)
    log("❌ 获取code失败（重试耗尽）")
    return None


def load_data():
    if not DATA_FILE.exists():
        return {}
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"⚠️ 读取 {DATA_FILE.name} 失败：{e}")
        return {}


def save_data(data):
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log(f"⚠️ 写入 {DATA_FILE.name} 失败：{e}")


def parse_accounts():
    """从 YYB Go /accounts 获取 alive 微信账号列表。"""
    try:
        resp = requests.get(f"{YYB_BASE}/accounts", timeout=15)
        rd = resp.json()
    except Exception as e:
        log(f"❌ 读取 YYB Go 账号失败：{e}")
        return []
    if rd.get("code") != 0:
        log(f"❌ YYB Go /accounts 异常：{rd.get('msg')}")
        return []
    accounts = []
    for a in rd.get("data") or []:
        if a.get("status") != "alive":
            continue
        openid = a.get("openid")
        nick = (a.get("nickname") or a.get("alias") or "unknown").strip()
        if openid:
            accounts.append({"remark": nick, "env_openid": openid})
    return accounts


def extract_token(data):
    if not data:
        return ""
    if isinstance(data, dict):
        token = data.get("token")
        if isinstance(token, str):
            m = re.search(r"(?:^|[,{]\s*)token=([^,}\s]+)", token)
            return m.group(1) if m else token
    if isinstance(data, str):
        m = re.search(r"(?:^|[,{]\s*)token=([^,}\s]+)", data)
        return m.group(1) if m else ""
    return ""


def extract_expiration_time(data):
    if not data:
        return 0
    if isinstance(data, dict):
        if data.get("expirationTime") is not None:
            try:
                return int(data["expirationTime"])
            except (ValueError, TypeError):
                return 0
        token = data.get("token")
        if isinstance(token, str):
            m = re.search(r"(?:^|[,{]\s*)expirationTime=(\d+)", token)
            if m:
                return int(m.group(1))
    if isinstance(data, str):
        m = re.search(r"(?:^|[,{]\s*)expirationTime=(\d+)", data)
        if m:
            return int(m.group(1))
    return 0


class ShzgClient:
    def __init__(self, remark, env_openid, cache_entry):
        self.remark = remark
        self.env_openid = env_openid
        self.token = cache_entry.get("token", "")
        self.openid = cache_entry.get("openid", "")
        self.nickname = cache_entry.get("nickname", "")
        self.mobile = cache_entry.get("mobile", "")
        self.expiration_time = cache_entry.get("expiration_time", 0)
        self.user_info = cache_entry.get("user_info", {})
        self.headers = {
            "Content-Type": "application/json; charset=UTF-8",
            "User-Agent": sc_ua(),
        }
        self.refreshing = False

    def _request(self, method, path, data=None, retry=0):
        url = BASE_URL + path
        headers = dict(self.headers)
        if self.token:
            headers["token"] = self.token

        try:
            if method.upper() == "GET":
                resp = requests.get(url, headers=headers, verify=False, timeout=30)
            else:
                payload = json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else data
                resp = requests.post(url, headers=headers, data=payload.encode("utf-8"), verify=False, timeout=30)

            try:
                result = resp.json()
            except Exception:
                result = {"code": -1, "msg": f"非JSON响应: {resp.text[:200]}", "_raw": resp.text}

            if result.get("code") == 401 and not self.refreshing and "/center/wxLogin" not in path:
                log("🔄 token 失效，尝试重新登录")
                if self._do_login():
                    return self._request(method, path, data, retry=retry)
                return result
            return result
        except requests.exceptions.RequestException as e:
            if retry < RETRY_TIMES:
                log(f"⚠️ 请求异常，{RETRY_DELAY}秒后重试({retry+1}/{RETRY_TIMES})：{e}")
                time.sleep(RETRY_DELAY)
                return self._request(method, path, data, retry=retry + 1)
            return {"code": -1, "msg": f"请求失败：{e}"}

    def get(self, path):
        return self._request("GET", path)

    def post(self, path, data=None):
        if data is None:
            data = {}
        return self._request("POST", path, data)

    def _do_login(self):
        self.refreshing = True
        try:
            code = fetch_code(self.env_openid)
            if not code:
                log("❌ 获取 code 失败，无法登录")
                return False

            random_wait(2, 4)
            login_res = self.post("/renren-admin/whds/center/wxLogin", {"code": code})
            if login_res.get("code") != 0:
                log(f"❌ 登录失败：{login_res.get('msg')}")
                return False

            token = extract_token(login_res.get("data"))
            exp = extract_expiration_time(login_res.get("data"))
            if not token:
                log("❌ 登录响应中未解析到 token")
                return False

            self.token = token
            self.expiration_time = exp
            if exp:
                log(f"✅ 登录成功，token 有效期至 {datetime.fromtimestamp(exp/1000)}")
            else:
                log("✅ 登录成功")

            random_wait(1, 2)
            user_res = self.get("/renren-admin/whds/user/getUserInfo")
            if user_res.get("code") == 0 and user_res.get("data"):
                self._update_user_info(user_res["data"])
            else:
                log(f"⚠️ 获取用户信息失败：{user_res.get('msg')}")
            return True
        finally:
            self.refreshing = False

    def _update_user_info(self, data):
        user = data.get("userInfo", data)
        self.nickname = user.get("nickname") or user.get("realName") or self.nickname
        self.mobile = user.get("mobile") or self.mobile
        self.openid = user.get("openid") or user.get("id") or self.openid
        self.user_info = user

    def ensure_login(self):
        if self.token:
            user_res = self.get("/renren-admin/whds/user/getUserInfo")
            if user_res.get("code") == 0:
                self._update_user_info(user_res.get("data", {}))
                log("✅ 本地 token 有效，跳过登录")
                return True
            if user_res.get("code") == 401:
                log("🔄 本地 token 已失效（401），准备重新登录")
            else:
                log(f"⚠️ 校验 token 失败：{user_res.get('msg')}，尝试重新登录")
            return self._do_login()
        return self._do_login()

    def to_cache_entry(self):
        return {
            "nickname": self.nickname,
            "token": self.token,
            "openid": self.openid,
            "mobile": self.mobile,
            "saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }


def query_prizes(client):
    log("🎁 查询奖品记录...")
    res = client.get("/renren-admin/whds/prizewinning/page?page=1&limit=100")
    if res.get("code") != 0:
        log(f"❌ 查询奖品失败：{res.get('msg')}")
        return

    data = res.get("data", {})
    records = data.get("list", []) or data.get("records", []) or []
    if not records:
        log("📭 暂无奖品记录")
        return

    total = len(records)
    log(f"✅ 共查询到 {total} 条奖品记录")

    for item in records:
        status_code = int(item.get("status", 0) or 0)
        status = PRIZE_STATUS.get(status_code, f"未知({status_code})")

        # 小程序源码中虚拟奖品判定：status == 2 且 trackingTime 为空
        tracking_time = item.get("trackingTime")
        is_virtual = (status_code == 2) and (tracking_time is None or tracking_time == "")
        prize_type = "虚拟" if is_virtual else "实物"

        prize_name = item.get("prizeName") or item.get("name") or "-"

        if is_virtual:
            # 券码优先取 trackingNumber，兜底从 note 提取
            code = (item.get("trackingNumber") or "").strip()
            if not code:
                note = item.get("note", "")
                parts = note.split(",")
                code = parts[-1].strip() if len(parts) >= 2 else note.strip()
            log(f"  - | {prize_name} | {prize_type} | 状态：{status} | 券码：{code}")
        else:
            address = item.get("receivingAddress") or "❌ 未填写地址信息"
            img = item.get("prizeImg") or "-"
            log(f"  - | {prize_name} | {prize_type} | 状态：{status} | 地址：{address}")
            log(f"  - | 图片：{img}")
            # 有快递信息时额外输出一行
            express = (item.get("expressCompany") or "").strip()
            tracking = (item.get("trackingNumber") or "").strip()
            if express or tracking:
                log(f"  - | {express or '-'}：{tracking or '-'}")


def main():
    accounts = parse_accounts()
    if not accounts:
        log("❌ 未读取到账号，请检查 shzgck 环境变量")
        sys.exit(1)

    log(f"📦 共读取到 {len(accounts)} 个账号")
    all_data = load_data()

    for idx, acc in enumerate(accounts, start=1):
        remark = acc["remark"]
        env_openid = acc["env_openid"]
        print()
        log(f"===== 执行第 {idx}/{len(accounts)} 🎐 账号 {remark} =====")

        cache_entry = all_data.get(env_openid, {})
        client = ShzgClient(remark, env_openid, cache_entry)

        if not client.ensure_login():
            log("❌ 登录失败，跳过该账号")
            continue

        query_prizes(client)
        all_data[env_openid] = client.to_cache_entry()
        save_data(all_data)

        if idx < len(accounts):
            random_wait(2, 4)

    log("✅ 全部账号查询完成")


if __name__ == "__main__":
    main()
