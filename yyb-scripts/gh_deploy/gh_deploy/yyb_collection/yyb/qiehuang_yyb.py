#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一快乐星球茄皇（五期）- YYB版

入口: 微信小程序搜索"茄皇" -> 统一快乐星球
功能: 自动完成任务（签到/浏览/分享）+ 收取好友能量 + 使用能量

自动获取 wid/openId:
  - 首次运行: YYB getCode -> 微盟 loginX -> 自动获取 wid/openId，缓存到 qh.txt
  - 后续运行: 直接读取 qh.txt 缓存，减少 YYB 调用
  - 缓存过期: 登录失败时自动重新获取并更新缓存

缓存文件 qh.txt（与脚本同目录）:
  - JSON 格式，自动管理，无需手动修改

环境变量:
  YYB_BASE_URL   YYB 服务地址 (默认 http://172.17.0.1:18080)
  YYB_REF        指定账号 ref (可选，默认遍历所有账号)
"""

import base64
import json
import os
import random
import sys
import time
from datetime import datetime

import requests
from notify import send

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    CRYPTO_BACKEND = "cryptography"
except ImportError:
    try:
        from Crypto.Cipher import AES, PKCS1_OAEP
        from Crypto.Hash import SHA256
        from Crypto.PublicKey import RSA

        CRYPTO_BACKEND = "pycryptodome"
    except ImportError:
        CRYPTO_BACKEND = None


# ================== 通用配置 ==================
BASE_URL = "https://farmgames.ioutu.cn"
APP_ID = "wx532ecb3bdaaf92f9"
WEIMOB_LOGIN_URL = "https://xapi.weimob.com/fe/mapi/user/loginX"
WEIMOB_CID = "176205957"
WEIMOB_BOS_ID = "4020112618957"
WEIMOB_VID = "6013753979957"
PUBLIC_KEY = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA70sK419vy3MabW3lEGlk"
    "7Zh1u78OdnVlioVazp5Y46eBh+/TDqo/wZ9VrQ/4MmAtoP0vJ2vmwP5gqO3WPoj"
    "b07WddXfF1eU+5M+Rj3s0eSRrvZvBcGZ3qK0dOgZJScK66IDQazt/c4xqhDcsI"
    "tIyNRahUqB/IKc6E80GZJvMvFtZVSCseAXC0mAJXhi1AdUOlP+3Pv0fiUVejTJp"
    "1j7LBNWJ7Z5/8mRcclQH0vmxsdYsaV3qZiJ2d/CfNoKcwmI2IWmeZy8NP5U8Hn"
    "0AsxPEwjdHoEqG/iy/SoA46TZL+RLtWqUSHXpaKR/VFN0rbl25SE91X8FTfLqyD"
    "8LfGMCwRQIDAQAB"
)
USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.75(0x18004b42) NetType/WIFI Language/zh_CN "
    "miniProgram/wx532ecb3bdaaf92f9"
)
SUPPORTED_TASK_TYPES = {"SIGN", "BROWSE", "SHARE"}
FRIEND_TASK_TYPE = "FRIEND_STEAL_ENERGY"
FRIEND_STATUS_CLAIMABLE = "0"

# ====== YYB 配置 ======
YYB_BASE = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "") or None
# ======================

# ====== wid/openId 缓存 ======
QH_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qh.txt")

def load_qh_cache():
    """读取 qh.txt 缓存，返回 {yyb_id: {wid, openId, nickname}}"""
    if not os.path.exists(QH_CACHE_FILE):
        return {}
    try:
        with open(QH_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {}

def save_qh_cache(cache):
    """保存缓存到 qh.txt"""
    try:
        with open(QH_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"  [⚠] 写入 qh.txt 缓存失败: {e}")
# =============================


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    """从 YYB 服务获取已保存的微信账号列表"""
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"[✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    """通过 YYB 服务获取微信小程序 code，返回 code 或 None"""
    payload = {"ref": ref, "app_id": APP_ID}
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
# ==========================


# ====== 微盟登录 ======
def weimob_login(code):
    """
    通过微信 code 登录微盟，返回 (wid, openId)
    这是获取 wid 的关键——微盟 loginX 接口直接返回 wid
    """
    payload = {
        "basicInfo": {
            "cid": WEIMOB_CID,
            "vid": WEIMOB_VID,
            "tcode": "weimob",
            "bosId": WEIMOB_BOS_ID,
        },
        "extendInfo": {"source": 1},
        "parentVid": 0,
        "is_pre_fetch_open": True,
        "env": "production",
        "storeId": "0",
        "appid": APP_ID,
        "pid": WEIMOB_BOS_ID,
        "code": code,
        "queryAuthConfig": True,
        "relevanceAuthRequest": None,
    }
    resp = requests.post(
        WEIMOB_LOGIN_URL,
        json=payload,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": f"https://servicewechat.com/{APP_ID}/288/page-frame.html",
            "Content-Type": "application/json",
            "x-biz-id": "1",
            "cloud-pid": WEIMOB_BOS_ID,
            "weimob-cid": WEIMOB_CID,
            "weimob-bosid": WEIMOB_BOS_ID,
            "x-req-from": "cms",
            "cloud-project-name": "tongyixiangmu",
            "weimob-pid": WEIMOB_BOS_ID,
        },
        timeout=20,
    )
    resp.raise_for_status()
    result = resp.json()
    data = result.get("data") or {}
    errcode = result.get("errcode")
    wid = data.get("wid")
    open_id = data.get("openId") or data.get("openid")
    if str(errcode) != "0" or not wid or not open_id:
        message = result.get("errmsg") or "未返回 wid/openId"
        raise RuntimeError(f"微盟登录失败：{message}")
    return str(wid), str(open_id)
# ======================


def encrypt_payload(payload):
    """Match the H5 client: RSA-OAEP-SHA256 + AES-256-GCM."""
    if CRYPTO_BACKEND is None:
        raise RuntimeError(
            "缺少加密依赖，请安装 cryptography（pip install cryptography）"
        )

    plaintext = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    aes_key = os.urandom(32)
    iv = os.urandom(12)
    public_key_der = base64.b64decode(PUBLIC_KEY)

    if CRYPTO_BACKEND == "cryptography":
        public_key = serialization.load_der_public_key(public_key_der)
        encrypted_data = AESGCM(aes_key).encrypt(iv, plaintext, None)
        encrypted_key = public_key.encrypt(
            aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
    else:
        cipher = AES.new(aes_key, AES.MODE_GCM, nonce=iv)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext)
        encrypted_data = ciphertext + tag
        public_key = RSA.import_key(public_key_der)
        encrypted_key = PKCS1_OAEP.new(public_key, hashAlgo=SHA256).encrypt(aes_key)

    return {
        "data": base64.b64encode(encrypted_data).decode(),
        "key": base64.b64encode(encrypted_key).decode(),
        "iv": base64.b64encode(iv).decode(),
    }


class TomatoClient:
    def __init__(self, wid, open_id):
        self.wid = wid
        self.open_id = open_id
        self.tomato_user_id = None
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
                "Origin": BASE_URL,
                "Referer": f"{BASE_URL}/?wid={wid}&openId={open_id}",
            }
        )

    def request(self, method, path, payload=None, encrypted=True, retry=2):
        url = f"{BASE_URL}{path}"
        for attempt in range(retry + 1):
            kwargs = {"timeout": 20}
            if payload:
                kwargs["json"] = encrypt_payload(payload) if encrypted else payload
                if encrypted:
                    kwargs["headers"] = {"X-Request-Encrypted": "true"}
            response = self.session.request(method, url, **kwargs)
            if response.status_code == 429 and attempt < retry:
                retry_after = response.headers.get("Retry-After", "2")
                try:
                    wait_seconds = max(1.0, float(retry_after))
                except ValueError:
                    wait_seconds = 2.0
                time.sleep(wait_seconds + attempt)
                continue
            response.raise_for_status()
            try:
                result = response.json()
            except ValueError as exc:
                raise RuntimeError(f"接口返回非 JSON 数据：{response.text[:200]}") from exc

            msg = str(result.get("msg", ""))
            if result.get("code") == 200:
                return result
            if attempt < retry and (
                response.status_code == 429 or "频繁" in msg or "稍后" in msg
            ):
                time.sleep(2.5 + attempt * 1.5)
                continue
            raise RuntimeError(msg or f"接口返回 code={result.get('code')}")
        raise RuntimeError("请求重试后仍未成功")

    def login(self):
        result = self.request(
            "POST",
            "/api/web/open/tomato/login",
            {
                "shareTomatoUserId": None,
                "openId": self.open_id,
                "wid": self.wid,
                "queryCardStatus": True,
            },
        )
        data = result.get("data") or {}
        token = data.get("token")
        if not token:
            raise RuntimeError("登录响应中没有 token")
        self.session.headers["Authorization"] = token
        self.tomato_user_id = data.get("tomatoUserId")
        return data

    def home(self):
        return self.request("GET", "/api/web/member/tomato/home").get("data") or {}

    def tasks(self):
        return self.request("GET", "/api/web/member/tomato/tasks").get("data") or []

    def complete_task(self, task):
        task_type = task.get("taskType")
        payload = {"taskType": task_type}
        if task_type != "SHARE":
            payload["browseTarget"] = task.get("browseTarget") or ""
        elif self.tomato_user_id:
            try:
                self.request(
                    "POST",
                    "/api/web/member/tomato/miniprogram/qrcode/create",
                    {
                        "page": "packages/wm-cloud-qiehuang/home/index",
                        "scene": str(self.tomato_user_id),
                    },
                )
            except Exception:
                pass
        return self.request(
            "POST", "/api/web/member/tomato/tasks/complete", payload
        ).get("data") or {}

    def friends(self, page_size=20):
        friends = []
        page_num = 1
        while True:
            result = self.request(
                "GET",
                f"/api/web/member/tomato/friends?pageNum={page_num}&pageSize={page_size}",
            )
            rows = result.get("rows") or []
            friends.extend(rows)
            total = int(result.get("total") or 0)
            if not rows or (total and len(friends) >= total) or len(rows) < page_size:
                break
            page_num += 1
        return friends

    def friend_home(self, friend_user_id):
        return self.request(
            "GET",
            f"/api/web/member/tomato/friends/{friend_user_id}/home",
        ).get("data") or {}

    def steal_friend_energy(self, friend_user_id):
        return self.request(
            "POST",
            "/api/web/member/tomato/friends/steal",
            {"friendTomatoUserId": friend_user_id},
        ).get("data")

    def use_energy(self):
        return self.request(
            "POST", "/api/web/member/tomato/energy/use", encrypted=False
        ).get("data") or {}


def short_open_id(open_id):
    return f"{open_id[:6]}...{open_id[-4:]}" if len(open_id) > 12 else open_id


def home_line(data, prefix="当前状态"):
    return (
        f"{prefix}：能量 {data.get('energyBalance', 0)}，"
        f"番茄 {data.get('tomatoBalance', 0)}，"
        f"{data.get('stageName', '未知阶段')} "
        f"{data.get('currentExp', 0)}/{data.get('stageRequiredExp', 0)}"
    )


def process_user(wid, open_id, nickname, index):
    logs = [f"账号{index}（{nickname}，wid={wid}）"]
    client = TomatoClient(wid, open_id)

    login_data = client.login()
    logs.append(f"登录成功：{login_data.get('nickName') or '未设置昵称'}")
    home = client.home()
    logs.append(home_line(home))

    completed = 0
    skipped = 0
    friend_task = None
    for task in client.tasks():
        name = task.get("taskName") or task.get("taskCode") or "未知任务"
        task_type = task.get("taskType")
        if task_type == FRIEND_TASK_TYPE:
            friend_task = task
            if str(task.get("completed")) == "1":
                logs.append(f"任务已完成：{name}")
            continue
        if str(task.get("completed")) == "1":
            logs.append(f"任务已完成：{name}")
            continue
        if task_type not in SUPPORTED_TASK_TYPES:
            skipped += 1
            logs.append(f"跳过任务：{name}（需在小程序内操作）")
            continue
        try:
            result = client.complete_task(task)
            reward = result.get("rewardText") or task.get("rewardText") or "已领取"
            logs.append(f"任务完成：{name}，{reward}")
            completed += 1
        except Exception as exc:
            logs.append(f"任务失败：{name}，{exc}")
        time.sleep(random.uniform(2.5, 3.5))

    try:
        claimable_friends = [
            friend
            for friend in client.friends()
            if str(friend.get("friendStatus")) == FRIEND_STATUS_CLAIMABLE
            and friend.get("friendTomatoUserId")
        ]
        stolen_count = 0
        stolen_energy = 0
        failed_count = 0
        for friend in claimable_friends:
            friend_user_id = friend["friendTomatoUserId"]
            try:
                friend_home = client.friend_home(friend_user_id)
                amount = int(friend_home.get("stealAmount") or 0)
                if str(friend_home.get("canSteal")) != "1" or amount <= 0:
                    continue
                client.steal_friend_energy(friend_user_id)
                stolen_count += 1
                stolen_energy += amount
            except Exception:
                failed_count += 1
            time.sleep(random.uniform(1.5, 2.5))

        if stolen_count:
            detail = f"好友能量：成功收取 {stolen_count} 位好友，共 {stolen_energy} 能量"
            if failed_count:
                detail += f"，失败 {failed_count} 位"
            logs.append(detail)
            if friend_task and str(friend_task.get("completed")) != "1":
                completed += 1
        elif failed_count:
            logs.append(f"好友能量：收取失败 {failed_count} 位")
        else:
            logs.append("好友能量：暂无可收取能量")
    except Exception as exc:
        logs.append(f"好友能量失败：{exc}")

    home = client.home()
    logs.append(home_line(home, "任务后状态"))
    energy = int(home.get("energyBalance") or 0)
    if energy > 0:
        before_tomato = int(home.get("tomatoBalance") or 0)
        try:
            grown = client.use_energy()
            after_tomato = int(grown.get("tomatoBalance") or 0)
            gained = int(grown.get("gainedTomatoAmount") or 0)
            if not gained:
                gained = max(0, after_tomato - before_tomato)
            logs.append(
                f"使用能量：消耗 {grown.get('usedEnergyAmount', energy)}，"
                f"成长到 {grown.get('stageName', '未知阶段')} "
                f"{grown.get('currentExp', 0)}/{grown.get('stageRequiredExp', 0)}，"
                f"获得番茄 {gained}"
            )
            home = grown
        except Exception as exc:
            logs.append(f"使用能量失败：{exc}")
    else:
        logs.append("使用能量：当前没有可用能量")

    logs.append(home_line(home, "最终状态"))
    logs.append(f"本次完成任务 {completed} 个，跳过 {skipped} 个")
    return logs


def render_report(all_logs):
    lines = ["统一茄皇五期 (YYB版)"]
    for logs in all_logs:
        lines.append("━━━━━━━━━━━━━━━━━━━━")
        lines.extend(logs)
    lines.append("━━━━━━━━━━━━━━━━━━━━")
    return "\n".join(lines)


def main():
    print("=" * 56)
    print(f"  统一快乐星球【茄皇五期】(YYB版)")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 56)

    if CRYPTO_BACKEND is None:
        message = "缺少加密依赖，请安装 cryptography：pip install cryptography"
        print(message)
        send("统一茄皇五期", message)
        return

    # ---- 读取本地缓存 ----
    cache = load_qh_cache()
    cached_count = len(cache)
    if cached_count:
        print(f"\n[✓] qh.txt 缓存命中: {cached_count} 个账号")

    # ---- 获取 YYB 账号列表 ----
    print("\n[1/3] 获取 YYB 账号列表...")
    accounts = yyb_get_accounts()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        print(f"  请先通过 YYB 扫码登录添加账号: POST {YYB_BASE}/qr")
        send("统一茄皇五期", "没有可用账号，请先通过 YYB 扫码登录添加账号")
        return

    if YYB_REF:
        accounts = [
            a for a in accounts
            if str(a.get("id")) == YYB_REF or a.get("openid") == YYB_REF
        ]
        if not accounts:
            print(f"[✗] 未找到 ref={YYB_REF} 的账号")
            return
        print(f"[✓] 指定账号, 共 1 个\n")
    else:
        print(f"[✓] 共 {len(accounts)} 个账号\n")

    # ---- 准备任务清单: (nickname, wid, openId, is_from_cache) ----
    task_list = []
    refresh_ids = set()  # 需要重新获取的 YYB_ID

    for account in accounts:
        yyb_id = str(account.get("id"))
        nickname = account.get("nickname", "未知") or "未知"

        if yyb_id in cache:
            entry = cache[yyb_id]
            wid = entry.get("wid")
            open_id = entry.get("openId")
            if wid and open_id:
                task_list.append((nickname, wid, open_id, True, yyb_id))
                continue

        # 不在缓存中 → 需要通过 YYB 获取
        refresh_ids.add(yyb_id)

    # ---- 刷新缺失的账号 ----
    for yyb_id in refresh_ids:
        account = next((a for a in accounts if str(a.get("id")) == yyb_id), None)
        if not account:
            continue
        nickname = account.get("nickname", "未知") or "未知"

        print(f"  [→] 通过 YYB 获取 {nickname} 的 wid/openId...")
        wx_code = yyb_get_code(yyb_id)
        if not wx_code:
            print(f"  [✗] 获取 code 失败")
            continue
        try:
            wid, open_id = weimob_login(wx_code)
            cache[yyb_id] = {"wid": wid, "openId": open_id, "nickname": nickname}
            task_list.append((nickname, wid, open_id, False, yyb_id))
            print(f"  [✓] wid={wid}, openId={short_open_id(open_id)}")
        except Exception as e:
            print(f"  [✗] 微盟登录失败: {e}")
            continue
        time.sleep(1)

    # ---- 保存缓存 ----
    save_qh_cache(cache)

    if not task_list:
        msg = "没有可用的账号（wid/openId 获取失败）"
        print(f"\n[✗] {msg}")
        send("统一茄皇五期", msg)
        return

    # ---- 执行任务 ----
    all_logs = []
    for i, (nickname, wid, open_id, from_cache, yyb_id) in enumerate(task_list, 1):
        print(f"[{i}/{len(task_list)}] {'=' * 40}")
        tag = "缓存" if from_cache else "新获取"
        print(f"  📱 账号: {nickname} [{tag}]")

        try:
            logs = process_user(wid, open_id, nickname, i)
        except Exception as exc:
            logs = [
                f"账号{i}（{nickname}，wid={wid}）",
                f"处理失败：{exc}",
            ]
            # 如果缓存账号登录失败 → 重新刷新
            if from_cache:
                print(f"  [→] 缓存账号登录失败，尝试重新获取...")
                wx_code = yyb_get_code(yyb_id)
                if wx_code:
                    try:
                        wid, open_id = weimob_login(wx_code)
                        cache[yyb_id] = {"wid": wid, "openId": open_id, "nickname": nickname}
                        save_qh_cache(cache)
                        print(f"  [✓] 已更新缓存")
                        # 重试
                        try:
                            logs = process_user(wid, open_id, nickname, i)
                        except Exception as exc2:
                            logs = [f"账号{i}（{nickname}）重试仍失败：{exc2}"]
                    except Exception:
                        print(f"  [✗] 重新获取也失败")
        all_logs.append(logs)
        print("\n".join(logs))
        if i < len(task_list):
            time.sleep(random.uniform(3, 5))

    if all_logs:
        report = render_report(all_logs)
        print("\n" + report)
        send("统一茄皇五期", report)
    else:
        msg = "没有成功执行任何账号"
        print(f"\n[✗] {msg}")
        send("统一茄皇五期", msg)


if __name__ == "__main__":
    main()
