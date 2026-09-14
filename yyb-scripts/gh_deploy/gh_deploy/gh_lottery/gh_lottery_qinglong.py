#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上海工会「工惠通」开物寻珍抽奖 - 青龙独立脚本
============================================
专门执行开物寻珍抽奖: 读取同目录 tokens.json 缓存账号, 对每个账号
循环抽奖直到积分不足 (每次消耗 300 积分), 并统计中奖结果。

与主任务脚本 (gh_task_qinglong.py) 解耦, 可单独建青龙定时任务:
  python3 gh_lottery_qinglong.py

Token 管理:
  1. 读取 tokens.json 缓存 (由主脚本 --wx-sync / 自动同步写入)
  2. 缓存 token 有效 → 直接抽奖
  3. 缓存失效 → 通过微信代理 (GH_WX_BASE) 重新换取后抽奖
  4. 无 wx_ref 关联或代理不可用 → 跳过并提示

环境变量 (均可选):
  GH_WX_BASE      微信代理服务地址 (默认 http://192.168.22.214:3003)
  GH_WX_APP_ID    目标小程序 appid (默认 wx21fee1602f5ed3f7, 工惠通)
  GH_AUTO_WX      token 失效时是否通过代理重取 (默认 1 启用)
  GH_ONLY_REFS    只处理指定账号 openid (逗号分隔)
  GH_SKIP_REFS    跳过指定账号 openid (逗号分隔)
  GH_DELAY        账号启动前的随机延迟秒数 (默认 0): 固定值如 "10", 或随机范围如 "5-15" (并发下用作启动抖动)
  GH_CONCURRENCY  并发账号数 (默认 4, 0=串行)

依赖: 仅 Python 标准库。
"""
from __future__ import annotations

import json
import os
import random
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Optional

# ============================ 配置 ============================
def env(name: str, default: str = "") -> str:
    """读取环境变量, 优先 QL_ 前缀 (青龙惯例)。"""
    return os.environ.get(f"QL_{name}", os.environ.get(name, default))


SCRIPT_DIR = Path(__file__).resolve().parent
TOKENS_FILE = SCRIPT_DIR / "tokens.json"

ONLY_REFS = [x.strip() for x in env("GH_ONLY_REFS", "").split(",") if x.strip()]
SKIP_REFS = [x.strip() for x in env("GH_SKIP_REFS", "").split(",") if x.strip()]
GH_DELAY = env("GH_DELAY", "0")
GH_CONCURRENCY = int(env("GH_CONCURRENCY", "4") or "4")
# 优先级账号(我的账号): YYB_PRIORITY (openid 换行分隔), 先串行跑完再并发跑别人
PRIORITY_REFS = [x.strip() for x in env("YYB_PRIORITY", "").replace(",", " ").split() if x.strip()]

# 并发安全: 多个线程可能同时重取并回写 tokens.json, 需用锁保护文件读写
TOKEN_LOCK = threading.Lock()

GH_WX_BASE = env("GH_WX_BASE", "http://172.17.0.1:18080").rstrip("/")
GH_WX_APP_ID = env("GH_WX_APP_ID", "wx21fee1602f5ed3f7")
GH_AUTO_WX = env("GH_AUTO_WX", "1").lower() in ("1", "true", "yes", "on")

# 工惠通 API
GH_BASE = "https://sgxmgl.shszgh.cn/renren-admin"
GH_REFERER = "https://servicewechat.com/wx21fee1602f5ed3f7/5/page-frame.html"
GH_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B)"
)

LOTTERY_COST_PER_DRAW = 300  # 每次抽奖消耗积分 (实测)
LOTTERY_MAX_DRAWS = 50       # 单账号抽奖安全上限 (防死循环)


# ============================ 工具函数 ============================
def log(msg: str = "") -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def clean_nickname(name: str, fallback: str = "账号") -> str:
    if not name:
        return fallback
    cleaned = re.sub(r"[^\w\u4e00-\u9fff-]", "", name)
    cleaned = cleaned.strip("-_ ")
    return cleaned or fallback


def notify(title: str, content: str) -> None:
    try:
        from notify import send  # type: ignore

        send(title, content)
    except Exception:
        log(f"[通知] {title}: {content[:200]}")


def sleep_delay(reason: str = "") -> None:
    """按 GH_DELAY 配置休眠, 用于账号间错峰避免触发微信风控。"""
    if not GH_DELAY:
        return
    d = GH_DELAY.strip()
    if "-" in d:
        try:
            lo, hi = d.split("-", 1)
            secs = random.uniform(float(lo), float(hi))
        except ValueError:
            secs = float(d.split("-", 1)[0] or 0)
    else:
        try:
            secs = float(d)
        except ValueError:
            return
    if secs <= 0:
        return
    log(f"  · 延迟 {secs:.1f}s {reason}".rstrip())
    time.sleep(secs)


# ---- SSL 兼容 (青龙/服务器环境 TLS 握手问题) ----
_SSL_OPENER: Optional[urllib.request.OpenerDirector] = None


def _get_ssl_opener() -> urllib.request.OpenerDirector:
    """构建兼容老 TLS 服务器的 urllib opener (跳过证书校验 + 允许低版本 TLS)。"""
    global _SSL_OPENER
    if _SSL_OPENER is not None:
        return _SSL_OPENER
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            ctx.minimum_version = ssl.TLSVersion.TLSv1  # 兼容老设备
    except Exception:
        pass
    try:
        ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
    except Exception:
        pass
    _SSL_OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
    return _SSL_OPENER


class HttpError(Exception):
    pass


# ============================ 工惠通客户端 ============================
class GongHuiClient:
    """工惠通小程序 API 客户端 (仅抽奖所需接口)。"""

    def __init__(self, token: str, nickname: str = "", timeout: float = 20) -> None:
        self.token = token
        self.nickname = nickname
        self.timeout = timeout

    def _req(self, method: str, path: str, params: Optional[dict] = None,
             body: Optional[dict] = None) -> dict:
        if not path.startswith("/renren-admin"):
            path = f"/renren-admin{path}"
        url = GH_BASE.replace("/renren-admin", "") + path
        headers = {
            "User-Agent": GH_UA,
            "xweb_xhr": "1",
            "Content-Type": "application/json; charset=UTF-8",
            "token": self.token,
            "Referer": GH_REFERER,
        }
        data = json.dumps(body).encode() if body is not None else None
        if params:
            from urllib.parse import urlencode

            url += "?" + urlencode(params)
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with _get_ssl_opener().open(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise HttpError("token 过期或无效")
            raise HttpError(f"HTTP {e.code}")
        except urllib.error.URLError as e:
            raise HttpError(f"网络错误: {e.reason}")
        if result.get("code") not in (0, "0", None):
            raise HttpError(f"业务错误: {result.get('msg')}")
        return result

    @staticmethod
    def wxlogin(code: str, nickname: str = "") -> tuple[str, str, str]:
        """用微信 code 登录, 返回 (token, openid, mobile)。"""
        body = {
            "code": code,
            "nickName": clean_nickname(nickname) or "账号",
            "mobile": "",
            "baseAvatar": "https://sghdsp.sh-service.cn/whj/2026/sgLogo.png",
            "avatarUrl": "https://sghdsp.sh-service.cn/whj/2026/sgLogo.png",
            "unionId": "",
        }
        url = GH_BASE + "/whds/center/wxLogin"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {
            "User-Agent": GH_UA,
            "xweb_xhr": "1",
            "Content-Type": "application/json; charset=UTF-8",
            "Referer": GH_REFERER,
        }
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with _get_ssl_opener().open(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise HttpError(f"HTTP {e.code}: 网络请求失败") from e
        except urllib.error.URLError as e:
            raise HttpError(f"网络错误: {e.reason}") from e
        if result.get("code") != 0:
            raise HttpError(f"wxLogin 失败: {result.get('msg')}")
        data = result.get("data") or {}
        token_raw = str(data.get("token") or "")
        m = re.search(r"token=([^,]+)", token_raw)
        if not m:
            raise HttpError(f"wxLogin 未返回 token: {token_raw[:200]}")
        return m.group(1).strip(), str(data.get("openid") or ""), str(data.get("mobile") or "")

    # ---- 查询 ----
    def get_user_info(self) -> dict[str, Any]:
        return (self._req("GET", "/whds/user/getUserInfo").get("data") or {})

    def get_my_page(self) -> dict[str, Any]:
        return (self._req("GET", "/whds/user/getMyPage").get("data") or {})

    # ---- 抽奖 ----
    def lottery_draw(self) -> dict:
        return (self._req("POST", "/whds/prizewinning/draw", body={}).get("data") or {})


# ============================ 微信代理服务客户端 ============================
class WxProxyError(Exception):
    pass


class WxProxyClient:
    """对接微信代理服务 (取小程序 code, 供 token 失效时重取)。"""

    def __init__(self, base: str = GH_WX_BASE, timeout: float = 30) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout

    def _req(self, method: str, path: str, params: Optional[dict] = None,
             body: Optional[dict] = None) -> dict:
        url = self.base + path
        headers = {
            "User-Agent": GH_UA,
            "Content-Type": "application/json; charset=UTF-8",
        }
        data = json.dumps(body).encode() if body is not None else None
        if params:
            from urllib.parse import urlencode

            url += "?" + urlencode(params)
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise WxProxyError(f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}") from e
        except urllib.error.URLError as e:
            raise WxProxyError(f"网络错误: {e.reason}") from e
        if result.get("code") != 0:
            raise WxProxyError(str(result.get("msg") or f"code={result.get('code')}"))
        return result

    def get_code(self, ref: str, app_id: str = GH_WX_APP_ID) -> str:
        """让指定微信账号登录目标小程序并返回 code。"""
        data = self._req(
            "POST", "/wxapp/getCode", body={"app_id": app_id, "ref": ref}
        ).get("data") or {}
        result = data.get("result") or {}
        code = str(result.get("code") or "")
        if not code:
            raise WxProxyError(f"getCode 未返回 code: {str(data)[:200]}")
        return code

    def list_accounts(self) -> list[dict]:
        """获取代理服务上全部微信账号 (openid -> alias/nickname 映射用)。"""
        data = self._req("GET", "/accounts").get("data")
        return data if isinstance(data, list) else []


# ============================ tokens.json 读写 ============================
def load_saved_tokens() -> dict[str, dict]:
    if not TOKENS_FILE.exists():
        return {}
    try:
        data = json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        log(f"  ⚠ tokens.json 解析失败: {TOKENS_FILE.name}")
        return {}


def save_token_entry(entry: dict) -> None:
    key = str(entry.get("openid") or entry.get("wx_ref") or "")
    if not key:
        return
    with TOKEN_LOCK:
        tokens = load_saved_tokens()
        tokens[key] = entry
        TOKENS_FILE.write_text(json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8")


# ============================ token 失效重取 ============================
def refresh_token_from_proxy(acc: dict) -> Optional[str]:
    """通过微信代理重新获取 token, 成功则回写缓存。"""
    wx_ref = str(acc.get("wx_ref") or acc.get("openid") or acc.get("ref") or "")
    if not wx_ref or wx_ref.startswith("env"):
        log("  ⚠ 该账号无 wx_ref 关联, 无法通过微信代理重取 token")
        return None
    try:
        proxy = WxProxyClient()
        code = proxy.get_code(wx_ref)
        new_token, _, _ = GongHuiClient.wxlogin(code, acc.get("nickname") or "账号")
    except (WxProxyError, HttpError) as e:
        log(f"  ⚠ 微信代理重取 token 失败: {e}")
        return None
    acc["token"] = new_token
    acc["saved_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with TOKEN_LOCK:
        tokens = load_saved_tokens()
        for key, entry in tokens.items():
            if str(entry.get("openid") or key) == str(acc.get("openid") or acc.get("ref") or ""):
                entry["token"] = new_token
                entry["saved_at"] = acc["saved_at"]
                break
        TOKENS_FILE.write_text(json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  ✓ token 已重新获取并更新缓存 ({new_token[:12]}...)")
    return new_token


# ============================ 抽奖逻辑 ============================
def lottery_all_in(client: GongHuiClient, max_draws: int = LOTTERY_MAX_DRAWS) -> tuple[list[str], int, str]:
    """循环抽奖直到积分不足, 把可用积分抽完。

    Args:
        client: 已登录的工惠通客户端。
        max_draws: 最大抽奖次数 (安全上限, 防异常死循环)。

    Returns:
        (prizes, draws, reason):
            prizes - 每次的奖品名列表;
            draws  - 实际抽奖次数;
            reason - 停止原因 ("ok" 抽完 / "no_points" 积分不足 / "error" 接口异常)。
    """
    prizes: list[str] = []
    draws = 0
    reason = "ok"
    for _ in range(max_draws):
        try:
            data = client.lottery_draw()
        except HttpError as e:
            if "积分不足" in str(e):
                reason = "no_points"
            else:
                reason = "error"
                log(f"  ⚠ 抽奖失败: {e}")
            break
        draws += 1
        prize = data.get("prizeName") or data.get("name") or "奖品"
        prizes.append(prize)
        log(f"  · 第 {draws} 抽: {prize}")
        sleep_delay("(抽奖间隔)")
    return prizes, draws, reason


def summarize_prizes(prizes: list[str]) -> str:
    """统计抽奖结果 (合并重复项)。"""
    if not prizes:
        return "无"
    from collections import Counter

    counter = Counter(prizes)
    parts = []
    for name, cnt in counter.most_common():
        parts.append(f"{name}×{cnt}" if cnt > 1 else name)
    return "、".join(parts)


# ============================ 账号来源 ============================
def get_accounts_from_proxy() -> list[dict]:
    """从微信代理拉在线 (alive) 账号, 覆盖所有在线微信。失败返回空列表。"""
    try:
        all_accs = WxProxyClient().list_accounts()
    except WxProxyError as e:
        log(f"  ⚠ 微信代理连接失败: {e}")
        return []
    if not all_accs:
        return []
    accounts = []
    for acc in all_accs:
        status = str(acc.get("status") or "?")
        if status != "alive":
            log(f"  ⚠ {acc.get('nickname', '?')}: 状态={status}, 跳过")
            continue
        ref = str(acc.get("openid") or acc.get("id") or "")
        nickname = str(acc.get("nickname") or acc.get("alias") or "账号")
        accounts.append({
            "ref": ref,
            "nickname": nickname,
            "wx_ref": ref,
            "token": "",
        })
    return accounts


def resolve_client(acc: dict, no_auto_wx: bool) -> tuple[Optional[GongHuiClient], str]:
    """解析并登录单个账号, 返回 (client, real_name)。失败返回 (None, 错误信息)。"""
    ref = acc["ref"]
    wx_ref = str(acc.get("wx_ref") or ref)
    nickname = acc["nickname"] or "账号"

    token = str(acc.get("token") or "")
    if token:
        try:
            client = GongHuiClient(token)
            ui = (client.get_user_info().get("userInfo") or {})
            real_name = ui.get("realName") or ui.get("nickname") or nickname
            return client, real_name
        except HttpError:
            log(f"  · token 失效, 尝试通过微信代理换码重取...")

    if GH_AUTO_WX and not no_auto_wx:
        try:
            code = WxProxyClient().get_code(wx_ref)
            new_token, openid, _ = GongHuiClient.wxlogin(code, nickname)
        except (WxProxyError, HttpError) as e:
            return None, f"token 失效且重取失败: {e}"
        save_token_entry({
            "openid": openid or ref,
            "nickname": nickname,
            "token": new_token,
            "wx_ref": wx_ref,
        })
        return GongHuiClient(new_token), nickname
    return None, "token 失效且已关闭自动重取"


# ============================ 主流程 ============================
def cmd_lottery(no_auto_wx: bool = False) -> int:
    """优先从微信代理拉全部在线账号抽奖; 代理不可用则回退 tokens.json 缓存。"""
    log("=" * 56)
    log("上海工会「工惠通」开物寻珍抽奖 - 独立脚本")
    log("=" * 56)

    # 优先从微信代理拉在线账号 (覆盖所有 alive 微信), 失败再回退 tokens.json
    accounts = get_accounts_from_proxy()
    if accounts:
        log(f"· 从微信代理拉取 {len(accounts)} 个在线账号")
    else:
        saved = load_saved_tokens()
        log(f"· 微信代理不可用, 回退 tokens.json 缓存 {len(saved)} 个账号")
        for key, entry in saved.items():
            acc = {
                "ref": str(entry.get("openid") or key),
                "token": str(entry.get("token") or ""),
                "nickname": str(entry.get("nickname") or ""),
                "openid": str(entry.get("openid") or key),
                "wx_ref": str(entry.get("wx_ref") or ""),
            }
            accounts.append(acc)

    # 过滤 ONLY / SKIP
    filtered: list[dict] = []
    for acc in accounts:
        if ONLY_REFS and acc["ref"] not in ONLY_REFS and acc.get("openid", "") not in ONLY_REFS:
            continue
        if SKIP_REFS and (acc["ref"] in SKIP_REFS or acc.get("openid", "") in SKIP_REFS):
            continue
        filtered.append(acc)
    accounts = filtered

    if not accounts:
        log("⚠ 没有可用的账号 (检查微信代理 / GH_ONLY_REFS / GH_SKIP_REFS)")
        return 1

    # 🔥 优先级: 我的账号(YYB_PRIORITY)先串行跑完, 再并发跑别人
    pri_set = set(PRIORITY_REFS)
    if PRIORITY_REFS:
        mine = [a for a in accounts if a["ref"] in pri_set or a.get("openid", "") in pri_set]
        others = [a for a in accounts if a["ref"] not in pri_set and a.get("openid", "") not in pri_set]
        mine_ordered = []
        for pr in PRIORITY_REFS:
            for a in accounts:
                if a["ref"] == pr or a.get("openid", "") == pr:
                    mine_ordered.append(a)
        accounts = mine_ordered + others

    def process_account(idx: int, acc: dict) -> dict:
        """处理单个账号 (线程内仍串行抽奖直到积分不足)。"""
        wx_ref = str(acc.get("wx_ref") or "")
        proto_name = proxy_aliases.get(wx_ref) or ""
        log("")
        log(f"▶ [{idx}/{len(accounts)}] 账号: {proto_name or acc['nickname'] or acc['ref']}")

        # 并发启动抖动: 若配置了 GH_DELAY, 各账号错开启动, 降低同时打代理/接口压力
        if GH_DELAY:
            sleep_delay(f"(并发启动抖动, 第 {idx} 个)")

        client, real_name = resolve_client(acc, no_auto_wx)
        if not client:
            log(f"  ⚠ {real_name}: {real_name}")
            return {"nickname": real_name, "prize": None, "prize_draws": 0, "error": real_name}

        result: dict = {"nickname": real_name, "prize": None, "prize_draws": 0}
        # 抽奖 (单账号内部仍串行, 直到积分不足)
        prizes, draws, reason = lottery_all_in(client)
        if draws:
            summary = summarize_prizes(prizes)
            log(f"  ✓ 共抽 {draws} 次: {summary}")
            result["prize"] = summary
            result["prize_draws"] = draws
            result["prizes"] = prizes
        else:
            if reason == "no_points":
                log("  · 积分不足 (低于单次消耗 300), 跳过")
            elif reason == "error":
                log("  ⚠ 抽奖接口异常, 跳过")
            else:
                log("  ⚠ 未抽到 (接口无响应)")

        # 抽完看积分
        try:
            page = client.get_my_page()
            pts = {
                "available": page.get("availableTotalPoints"),
                "total": page.get("totalPoints"),
            }
            log(f"  积分: 可用 {pts['available']} / 累计 {pts['total']}")
            result["points"] = pts
        except HttpError:
            pass
        return result

    # 协议账号名映射: openid -> 协议 alias/nickname (日志显示用协议名)
    proxy_aliases: dict[str, str] = {}
    try:
        for _acc in WxProxyClient().list_accounts():
            _oid = str(_acc.get("openid") or "")
            _nm = str(_acc.get("alias") or _acc.get("nickname") or "").strip()
            if _oid and _nm:
                proxy_aliases[_oid] = _nm
        log(f"· 已加载协议账号名 {len(proxy_aliases)} 个")
    except Exception as _e:
        log(f"  ⚠ 拉取协议账号名失败, 日志沿用原昵称: {_e}")

    log(f"· 并发模式: GH_CONCURRENCY={GH_CONCURRENCY}")
    results: list[dict] = [None] * len(accounts)

    # 优先级: 我的账号先串行跑完
    pri_set = set(PRIORITY_REFS)
    mine_idx = [i for i, a in enumerate(accounts)
                if a["ref"] in pri_set or a.get("openid", "") in pri_set]
    other_idx = [i for i, a in enumerate(accounts)
                 if a["ref"] not in pri_set and a.get("openid", "") not in pri_set]

    if mine_idx:
        log(f"· [优先] 我的 {len(mine_idx)} 个账号先串行执行...")
        for i in mine_idx:
            results[i] = process_account(i + 1, accounts[i])

    if GH_CONCURRENCY and GH_CONCURRENCY > 0 and other_idx:
        with ThreadPoolExecutor(max_workers=GH_CONCURRENCY) as pool:
            futures = {
                pool.submit(process_account, i + 1, accounts[i]): i
                for i in other_idx
            }
            for fut in as_completed(futures):
                i = futures[fut]
                try:
                    results[i] = fut.result()
                except Exception as e:
                    results[i] = {
                        "nickname": accounts[i].get("nickname") or accounts[i].get("openid") or "?",
                        "prize": None,
                        "prize_draws": 0,
                        "error": f"线程异常: {e}",
                    }
    else:
        for i in other_idx:
            results[i] = process_account(i + 1, accounts[i])

    # 汇总
    log("")
    log("=" * 56)
    log("抽奖汇总:")
    notify_lines: list[str] = []
    for r in results:
        name = r.get("nickname", "?")
        if r.get("error"):
            log(f"  ── {name}: ❌ {r['error']}")
            notify_lines.append(f"{name}: 失败({r['error'][:60]})")
            continue
        pts = r.get("points") or {}
        pts_s = f"积分={pts.get('available')}" if pts.get("available") is not None else ""
        prize = r.get("prize")
        if prize:
            draws = r.get("prize_draws")
            log(f"  ── {name}: 奖品={prize} ({draws} 次)")
            notify_lines.append(f"{name}: 奖品={prize}{f'({draws}次)' if draws else ''} {pts_s}".rstrip())
        else:
            log(f"  ── {name}: 奖品=无")
            notify_lines.append(f"{name}: 奖品=无 {pts_s}".rstrip())
    log("=" * 56)

    if notify_lines:
        notify("工惠通开物寻珍抽奖", "\n".join(notify_lines))

    return 0


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="上海工会「工惠通」开物寻珍抽奖独立脚本")
    parser.add_argument("--no-auto-wx", action="store_true",
                        help="token 失效时不通过微信代理重取, 直接跳过")
    args = parser.parse_args()
    return cmd_lottery(args.no_auto_wx)


if __name__ == "__main__":
    sys.exit(main())
