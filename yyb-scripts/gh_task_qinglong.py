#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上海工会「工惠通」多账号每日任务 (终稿 2026-08-14)

特性:
  * 全部请求强制直连 (ProxyHandler({})，无视环境代理变量)
  * 每账号串行: 签到→答题→运动视频→天工探源→(抽奖)→劳模星光→分享
  * 劳模星光: 以积分明细为准 (每天5次×20分=100分拿满, 翻转只是辅助判据)
    进详情→等65s→领取→查积分明细, 循环至拿满; 每次领取均有日志
  * 分享小程序: 每天5次×20分=100分
  * 同 openid 账号自动去重 (张市场=市场部 同openid坑)
  * 青龙内置通知: 结束时输出汇总并调用 notify (依赖青龙 notify.py)

环境变量 (均可选):
  GH_TOKENS        逗号分隔的 token 列表, 优先级最高
  GH_ONLY_REFS     只处理指定账号 ref/openid (逗号分隔)
  GH_SKIP_REFS     跳过指定账号 ref/openid (逗号分隔)
  GH_SKIP_TASKS    跳过的任务 (signin,dati,sport,tiangong,laomo,share,lottery)
  GH_DO_LOTTERY    开物寻珍抽奖开关 (默认 0 关闭, 1 启用)
  GH_MAX_FAIL      已弃用: 失败账号仅跳过, 不再熔断停止 (默认 3, 不再生效)
  GH_CONCURRENCY   并发账号数 (默认 6, 0=退回串行)
  GH_DELAY         账号启动错峰秒数 (默认 0): 固定值如 "10", 或随机范围 "5-15"
  GH_LAOMO_INTERVAL  劳模领取间隔秒数 (默认 65)
  GH_SHARE_TIMES     分享次数 (默认 5)
  GH_SHARE_INTERVAL  分享间隔秒数 (默认 5)

微信代理服务 (默认 http://192.168.22.214:3003, 提供扫码登录 + 取 code):
  GH_WX_BASE       微信代理服务地址
  GH_WX_APP_ID     目标小程序 appid (默认 wx21fee1602f5ed3f7, 工惠通)
  GH_AUTO_WX       是否从微信代理拉账号列表 (默认 1; 失败自动回退 tokens.json)

依赖: 仅 Python 标准库。
"""
from __future__ import annotations

import csv
import json
import os
import random
import re
import ssl
import sys
import time
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Optional

# ============================ 配置 ============================
def env(name: str, default: str = "") -> str:
    return os.environ.get(f"QL_{name}", os.environ.get(name, default))


SCRIPT_DIR = Path(__file__).resolve().parent
VENUES_CSV = SCRIPT_DIR / "天工探源场馆清单.csv"
TOKENS_FILE = SCRIPT_DIR / "tokens.json"

GH_TOKENS = [t.strip() for t in env("GH_TOKENS", "").split(",") if t.strip()]
ONLY_REFS = [x.strip() for x in env("GH_ONLY_REFS", "").split(",") if x.strip()]
SKIP_REFS = [x.strip() for x in env("GH_SKIP_REFS", "").split(",") if x.strip()]
SKIP_TASKS = {x.strip() for x in env("GH_SKIP_TASKS", "").split(",") if x.strip()}
DO_LOTTERY = env("GH_DO_LOTTERY", "0").lower() in ("1", "true", "yes", "on")
MAX_CONSECUTIVE_FAIL = int(env("GH_MAX_FAIL", "3"))

GH_DELAY = env("GH_DELAY", "0")
GH_CONCURRENCY = int(env("GH_CONCURRENCY", "6"))

# 并发安全: tokens.json 写入锁 + 跨线程 openid 去重
TOKEN_LOCK = threading.Lock()
SEEN_OPENIDS: set[str] = set()
SEEN_LOCK = threading.Lock()

# 劳模 / 分享
LAOMO_INTERVAL = max(60.0, float(env("GH_LAOMO_INTERVAL", "65")))
SHARE_TIMES = int(env("GH_SHARE_TIMES", "5"))
SHARE_INTERVAL = max(2.0, float(env("GH_SHARE_INTERVAL", "5")))

# 微信代理服务
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

SIGN_IN_ACTIVITY_ID = "1930096544729243649"
LAOMO_ACTIVITY_ID = "2069345741944016898"

DAILY_TASK_LABELS = {
    "qiandao": "签到",
    "dati": "答题",
    "pkDati": "PK答题",
    "sportVideo": "运动视频",
    "tiangongTanyuan": "天工探源",
    "laomoxingguang": "劳模星光",
    "kaiwuxunzhen": "开物寻珍",
    "workPartner": "工友互助",
    "share": "分享小程序",
}


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
        from notify import send
        send(title, content)
        log("[通知] 已通过青龙 notify 发送")
    except Exception:
        log(f"[通知] {title}: {content[:500]}")


def sleep_delay(reason: str = "") -> None:
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


def load_venues_csv() -> Optional[list[dict]]:
    if not VENUES_CSV.exists():
        log(f"  · 未找到场馆清单 {VENUES_CSV.name}, 使用接口拉取")
        return None
    try:
        with open(VENUES_CSV, encoding="utf-8-sig", newline="") as f:
            venues = []
            for row in csv.DictReader(f):
                vid = (row.get("场馆ID") or "").strip()
                lat_s, lng_s = row.get("纬度", ""), row.get("经度", "")
                if not vid or not lat_s or not lng_s:
                    continue
                try:
                    venues.append({
                        "id": vid,
                        "latitude": float(lat_s),
                        "longitude": float(lng_s),
                        "name": (row.get("场馆名称") or "").strip(),
                    })
                except ValueError:
                    continue
        log(f"  · 已加载场馆清单 {len(venues)} 个 (来自 CSV)")
        return venues
    except Exception as e:
        log(f"  ⚠ 读取场馆清单失败: {e}, 使用接口拉取")
        return None


class HttpError(Exception):
    pass


# ---- SSL 兼容 + 强制直连 ----
_SSL_OPENER: Optional[urllib.request.OpenerDirector] = None


def _get_ssl_opener() -> urllib.request.OpenerDirector:
    global _SSL_OPENER
    if _SSL_OPENER is not None:
        return _SSL_OPENER
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1
    except Exception:
        pass
    try:
        ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
    except Exception:
        pass
    # 🔥 ProxyHandler({}) 显式禁用一切代理 (含环境 HTTP_PROXY/HTTPS_PROXY)
    _SSL_OPENER = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ctx),
    )
    return _SSL_OPENER


# ============================ 工惠通客户端 ============================
class GongHuiClient:
    def __init__(self, token: str, nickname: str = "", timeout: float = 30) -> None:
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
        body = {"code": code}
        url = GH_BASE + "/whds/center/wxLogin"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {
            "User-Agent": GH_UA,
            "xweb_xhr": "1",
            "Content-Type": "application/json; charset=UTF-8",
            "token": "",
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
        token = m.group(1).strip()
        try:
            probe = GongHuiClient(token)
            ui = (probe.get_user_info().get("userInfo") or {})
            openid = ui.get("openid") or ""
            mobile = ui.get("mobile") or str(data.get("mobile") or "")
        except Exception:
            openid = ""
            mobile = str(data.get("mobile") or "")
        return token, openid, mobile

    def get_daily_tasks(self) -> dict[str, bool]:
        return (self._req("GET", "/whds/user/getDailyTasks").get("data") or {})

    def get_user_info(self) -> dict[str, Any]:
        return (self._req("GET", "/whds/user/getUserInfo").get("data") or {})

    def get_my_page(self) -> dict[str, Any]:
        return (self._req("GET", "/whds/user/getMyPage").get("data") or {})

    def get_question_bank(self) -> list[dict]:
        return (self._req("GET", "/whds/questionmanage/getQuestionBank").get("data") or [])

    def tiangong_nearby(self, lat: float = 31.2304, lng: float = 121.4737) -> list[dict]:
        return (self._req(
            "GET", "/whds/tiangongtanyuan/nearby",
            params={"latitude": lat, "longitude": lng},
        ).get("data") or [])

    def add_integral(self, activity_id: str, name: str) -> dict:
        return (self._req(
            "POST", "/whds/pointsmanage",
            body={"activityId": activity_id, "activityName": name},
        ).get("data") or {})

    def sign_in(self) -> dict:
        return self.add_integral(SIGN_IN_ACTIVITY_ID, "签到")

    def sport_video_checkin(self) -> dict:
        return (self._req("POST", "/whds/pointsmanage/sportVideoCheckIn", body={}).get("data") or {})

    def submit_answer(self, correct: int) -> dict:
        return (self._req(
            "POST", "/whds/questionmanage/addAnswer",
            body={"answerCorrectlyCount": correct, "answerTime": ""},
        ).get("data") or {})

    def tiangong_check_in(self, venue_id: str, lat: float, lng: float) -> Any:
        return (self._req(
            "POST", "/whds/tiangongtanyuan/checkIn",
            body={"venueId": venue_id, "latitude": lat, "longitude": lng},
        ).get("data"))

    def lottery_draw(self) -> dict:
        return (self._req("POST", "/whds/prizewinning/draw", body={}).get("data") or {})

    def laomo_list(self, page_size: int = 10) -> list[dict]:
        d = self._req(
            "POST", "/xxfb/xxfbList",
            body={"pageNum": 1, "pageSize": page_size, "menuid": "2057761673986240514"},
        )
        return (d.get("data") or {}).get("records") or []

    def laomo_detail(self, fid: str) -> dict:
        return (self._req("POST", f"/xxfb/{fid}", body={}).get("data") or {})

    def share(self) -> str:
        d = self._req("POST", "/whds/pointsmanage/share", body={})
        return str(d.get("msg") or "分享成功")

    def laomo_points_today(self) -> tuple[int, int]:
        """查询今日劳模星光积分明细, 返回 (次数, 总分)。"""
        today = time.strftime("%Y-%m-%d")
        data = self._req("GET", "/whds/pointsmanage/page", params={"page": 1, "limit": 50})
        records = (data.get("data") or {}).get("list") or []
        hits = [
            r for r in records
            if r.get("activityName") == "劳模星光" and str(r.get("createTime", "")).startswith(today)
        ]
        pts = sum(int(r.get("points") or 0) for r in hits)
        return len(hits), pts


# ============================ 微信代理服务客户端 ============================
class WxProxyError(Exception):
    pass


class WxProxyClient:
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
        # 🔥 强制直连
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise WxProxyError(f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}") from e
        except urllib.error.URLError as e:
            raise WxProxyError(f"网络错误: {e.reason}") from e
        if result.get("code") != 0:
            raise WxProxyError(str(result.get("msg") or f"code={result.get('code')}"))
        return result

    def list_accounts(self) -> list[dict]:
        """获取微信代理上的账号列表"""
        data = self._req("GET", "/accounts").get("data")
        return data if isinstance(data, list) else []

    def get_code(self, ref: str, app_id: str = GH_WX_APP_ID) -> str:
        """获取微信 code"""
        data = self._req(
            "POST", "/wxapp/getCode", body={"app_id": app_id, "ref": ref}
        ).get("data") or {}
        result = data.get("result") or {}
        code = str(result.get("code") or "")
        if not code:
            raise WxProxyError(f"getCode 未返回 code: {str(data)[:200]}")
        return code


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


def normalize_tokens(tokens: dict) -> dict:
    by_ref: dict[str, dict] = {}
    no_ref: dict[str, dict] = {}
    for key, entry in tokens.items():
        if not isinstance(entry, dict):
            continue
        wx_ref = str(entry.get("wx_ref") or "")
        if wx_ref:
            cur = by_ref.get(wx_ref)
            if cur is None:
                by_ref[wx_ref] = entry
            else:
                cur_ok = bool(cur.get("openid") and cur.get("token"))
                new_ok = bool(entry.get("openid") and entry.get("token"))
                if (not cur_ok and new_ok) or (
                    cur_ok == new_ok
                    and str(entry.get("saved_at") or "") >= str(cur.get("saved_at") or "")
                ):
                    by_ref[wx_ref] = entry
        else:
            no_ref[key] = entry
    result: dict[str, dict] = {}
    for wx_ref, entry in by_ref.items():
        openid = str(entry.get("openid") or "")
        result[openid or wx_ref] = entry
    for key, entry in no_ref.items():
        result[key] = entry
    return result


def save_token_entry(openid: str, nickname: str, token: str, mobile: str = "", wx_ref: str = "") -> None:
    with TOKEN_LOCK:
        tokens = load_saved_tokens()
        tokens[openid] = {
            "nickname": nickname,
            "token": token,
            "openid": openid,
            "mobile": mobile,
            "wx_ref": wx_ref,
            "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        TOKENS_FILE.write_text(json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  ✓ 已保存 token 到 {TOKENS_FILE.name}")


# ============================ 获取账号列表 ============================
def get_accounts_from_proxy() -> tuple[list[dict], list[str]]:
    """从微信代理获取账号列表"""
    try:
        proxy = WxProxyClient()
        all_accs = proxy.list_accounts()
    except WxProxyError as e:
        return [], [f"微信代理连接失败: {e}"]

    if not all_accs:
        return [], ["微信代理上暂无账号"]

    accounts = []
    skipped = []
    log(f"· 微信代理共 {len(all_accs)} 个账号:")
    for acc in all_accs:
        status = str(acc.get("status") or "?")
        if status != "alive":
            log(f"  ⚠ {acc.get('nickname', '?')}: 状态={status}, 跳过")
            skipped.append(f"{acc.get('nickname', '?')}: 状态={status}")
            continue

        ref = str(acc.get("openid") or acc.get("id") or "")
        nickname = str(acc.get("nickname") or acc.get("alias") or "账号")
        accounts.append({
            "ref": ref,
            "nickname": nickname,
            "wx_ref": ref,
        })
        log(f"  ✓ {nickname}: 已加入任务列表")

    return accounts, skipped


def get_accounts_from_tokens() -> list[dict]:
    """回退方案: 直接用 tokens.json 里的账号"""
    accounts = []
    for key, entry in normalize_tokens(load_saved_tokens()).items():
        if not entry.get("token"):
            continue
        accounts.append({
            "ref": str(entry.get("wx_ref") or key),
            "openid": str(entry.get("openid") or key),
            "nickname": clean_nickname(str(entry.get("nickname") or ""), "账号"),
            "token": entry["token"],
        })
    return accounts


def dedupe_accounts(accounts: list[dict]) -> list[dict]:
    """按 ref 去重 (张市场=市场部 同 ref 的坑)"""
    seen: set[str] = set()
    result = []
    for a in accounts:
        ref = a.get("ref", "")
        if ref in seen:
            log(f"  ⏭ 重复账号(同ref), 跳过: {a.get('nickname')}")
            continue
        seen.add(ref)
        result.append(a)
    return result


# ============================ 单账号登录（直连） ============================
def login_account(account: dict) -> Optional[dict]:
    """单个账号登录，换取 token（全直连）"""
    ref = account["ref"]
    nickname = account["nickname"]
    wx_ref = account.get("wx_ref", ref)

    # 1. 账号自带 token (tokens.json 回退模式)
    inline_token = account.get("token")
    # 2. 缓存 token
    cache = load_saved_tokens()
    cached = cache.get(ref) or cache.get(account.get("openid", ""))
    token = inline_token or (cached.get("token") if cached else "")

    if token:
        try:
            probe = GongHuiClient(token)
            ui = probe.get_user_info().get("userInfo") or {}
            real_name = ui.get("realName") or ui.get("nickname") or nickname
            real_openid = ui.get("openid") or account.get("openid") or ref
            log(f"  ✅ {nickname}: 复用缓存 token")
            return {
                "ref": real_openid or ref,
                "token": token,
                "nickname": real_name,
                "openid": real_openid,
            }
        except Exception:
            log(f"  · {nickname}: 缓存 token 已过期, 重新登录...")

    # 3. 取 code 换 token
    try:
        code = WxProxyClient().get_code(wx_ref)
    except WxProxyError as e:
        log(f"  ❌ {nickname}: 获取 code 失败: {e}")
        return None

    try:
        token, openid, mobile = GongHuiClient.wxlogin(code, nickname)
    except HttpError as e:
        log(f"  ❌ {nickname}: wxLogin 失败: {e}")
        return None

    save_token_entry(openid or ref, nickname, token, mobile, wx_ref)
    return {
        "ref": openid or ref,
        "token": token,
        "nickname": nickname,
        "openid": openid or ref,
    }


# ============================ 单账号任务执行 ============================
def run_laomo_task(client: GongHuiClient, result: dict) -> None:
    """劳模星光: 积分明细为准, 每天 5 次 × 20 分 = 100 分。"""
    try:
        cnt, pts = client.laomo_points_today()
        log(f"  劳模星光: 今日已领 {cnt} 次 / {pts} 分")
        result["laomo_today"] = pts
    except HttpError as e:
        log(f"  ⚠ 查询劳模积分明细失败: {e}, 按未完成处理")
        cnt, pts = 0, 0

    if pts >= 100 or cnt >= 5:
        result["tasks"]["laomoxingguang"] = True
        log("  ✓ 劳模星光今日已拿满 (100分)")
        return

    try:
        recs = client.laomo_list()
    except HttpError as e:
        log(f"  ⚠ 劳模星光失败: 拉取栏目失败 {e}")
        return
    if not recs:
        log("  ⚠ 劳模星光栏目无内容, 跳过")
        return

    rec = random.choice(recs[:5])
    fid = str(rec.get("id"))
    title = str(rec.get("title", ""))[:20]
    try:
        client.laomo_detail(fid)
        log(f"  已进入详情: {title}")
    except HttpError as e:
        log(f"  ⚠ 劳模星光失败: 进详情失败 {e}")
        return

    need = max(1, min(5 - cnt, 5))
    got = 0
    for i in range(need):
        log(f"  ⏳ 观看中, 等待 {LAOMO_INTERVAL:.0f}s 后第 {i+1}/{need} 次领取...")
        time.sleep(LAOMO_INTERVAL)
        try:
            client.add_integral(LAOMO_ACTIVITY_ID, "劳模星光")
        except HttpError as e:
            if "上限" in str(e):
                log(f"  ✓ 今日劳模积分已达上限 → 完成 ({e})")
                result["tasks"]["laomoxingguang"] = True
                break
            log(f"  ⚠ 第 {i+1} 次领取失败: {e}")
            continue
        got += 1
        time.sleep(3)

        # 🔥 以积分明细为准判据
        try:
            cnt2, pts2 = client.laomo_points_today()
        except HttpError:
            cnt2, pts2 = cnt + got, pts + got * 20
            log("  ⚠ 积分明细查询失败, 按推算值记录")
        flip = False
        try:
            flip = bool(client.get_daily_tasks().get("laomoxingguang"))
        except HttpError:
            pass
        log(f"  ✓ 第 {got} 次领取 → 今日劳模积分={pts2} ({cnt2}/5次) | 状态翻转={flip}")
        result["laomo_today"] = pts2

        if pts2 >= 100 or cnt2 >= 5 or flip:
            result["tasks"]["laomoxingguang"] = True
            log("  ✓ 劳模星光完成 (100分拿满)")
            return

        if pts2 <= pts and i < need - 1:
            log("  ⚠ 本次积分未增加, 重新进入详情再试")
            try:
                client.laomo_detail(fid)
            except HttpError:
                pass
        pts, cnt = pts2, cnt2

    if not result["tasks"].get("laomoxingguang"):
        log(f"  ⚠ 劳模星光今日未拿满 (当前 {result.get('laomo_today', 0)} 分), 明日继续")


def run_share_task(client: GongHuiClient, result: dict) -> None:
    """分享小程序: 每天 5 次 × 20 分 = 100 分。"""
    ok = 0
    for i in range(SHARE_TIMES):
        try:
            client.share()
            ok += 1
            log(f"  ✓ 分享成功 {ok}/{SHARE_TIMES} (+20分)")
        except HttpError as e:
            if "上限" in str(e):
                log(f"  ⏭ 分享已达今日上限 (本次分享 {ok} 次)")
            else:
                log(f"  ⚠ 分享失败: {e}")
            break
        time.sleep(SHARE_INTERVAL)
    if ok:
        result["tasks"]["share"] = True
        result["share_count"] = ok
        log(f"  📈 分享完成: 共 {ok} 次 (+{ok * 20}分)")


def run_account_tasks(client: GongHuiClient, ref: str, nickname: str) -> dict:
    result: dict[str, Any] = {"ref": ref, "tasks": {}, "points": None}
    log(f"---- 账号[{nickname}] 执行任务 ----")

    try:
        tasks = client.get_daily_tasks()
        result["tasks"] = tasks
    except HttpError as e:
        log(f"  ⚠ 查询任务状态失败: {e}")
        result["error"] = str(e)
        return result

    # 1. 签到
    if "signin" not in SKIP_TASKS and not tasks.get("qiandao"):
        try:
            client.sign_in()
            result["tasks"]["qiandao"] = True
            log("  ✓ 签到")
        except HttpError as e:
            log(f"  ⚠ 签到失败: {e}")
    elif tasks.get("qiandao"):
        log("  · 已签到")

    # 2. 答题
    if "dati" not in SKIP_TASKS and not tasks.get("dati"):
        try:
            bank = client.get_question_bank()
            if bank:
                correct = len([q for q in bank if q.get("answer")])
                earned = client.submit_answer(correct)
                result["tasks"]["dati"] = True
                log(f"  ✓ 答题完成 ({correct}题, +{earned})")
            else:
                log("  ⚠ 题库为空")
        except HttpError as e:
            log(f"  ⚠ 答题失败: {e}")

    # 3. 运动视频
    if "sport" not in SKIP_TASKS and not tasks.get("sportVideo"):
        try:
            data = client.sport_video_checkin()
            result["tasks"]["sportVideo"] = True
            log(f"  ✓ 运动视频打卡 (+{data.get('pointsEarned', 0)})")
        except HttpError as e:
            log(f"  ⚠ 运动视频失败: {e}")

    # 4. 天工探源
    if "tiangong" not in SKIP_TASKS and not tasks.get("tiangongTanyuan"):
        try:
            checked_ids: set[str] = set()
            try:
                for v in client.tiangong_nearby():
                    if v.get("checkIn"):
                        checked_ids.add(str(v["id"]))
            except HttpError:
                pass

            venues = load_venues_csv()
            if venues is None:
                api_venues = client.tiangong_nearby()
                venues = [
                    {
                        "id": v["id"],
                        "latitude": v.get("latitude") or 31.2304,
                        "longitude": v.get("longitude") or 121.4737,
                        "name": v.get("venueName", ""),
                    }
                    for v in api_venues if not v.get("checkIn")
                ]
            else:
                venues = [v for v in venues if str(v["id"]) not in checked_ids]
                if not venues:
                    log("  ⚠ CSV 场馆今天均已打卡")
            done = 0
            for v in venues[:3]:
                client.tiangong_check_in(v["id"], v["latitude"], v["longitude"])
                done += 1
            if done:
                result["tasks"]["tiangongTanyuan"] = True
                names = "、".join(v.get("name", "") or v["id"] for v in venues[:done])
                log(f"  ✓ 天工探源打卡 {done} 个场馆: {names}")
            else:
                log("  ⚠ 无可打卡场馆")
        except HttpError as e:
            log(f"  ⚠ 天工探源失败: {e}")

    # 5. 开物寻珍 (可选)
    if DO_LOTTERY:
        if "lottery" not in SKIP_TASKS and not tasks.get("kaiwuxunzhen"):
            try:
                data = client.lottery_draw()
                prize = data.get("prizeName") or data.get("name") or "奖品"
                result["prize"] = prize
                log(f"  ✓ 开物寻珍抽奖: {prize}")
            except HttpError as e:
                log(f"  ⚠ 抽奖失败: {e}")
        elif tasks.get("kaiwuxunzhen"):
            log("  · 开物寻珍今日已完成")

    # 6. 劳模星光 (重头戏, 放最后; 积分明细为准)
    if "laomo" not in SKIP_TASKS:
        if tasks.get("laomoxingguang"):
            log("  · 劳模星光今日已完成 (状态已翻转)")
            result["laomo_today"] = 100
        else:
            run_laomo_task(client, result)

    # 7. 分享小程序
    if "share" not in SKIP_TASKS:
        run_share_task(client, result)

    # 积分
    try:
        page = client.get_my_page()
        result["points"] = {
            "available": page.get("availableTotalPoints"),
            "total": page.get("totalPoints"),
        }
        log(f"  积分: 可用 {result['points']['available']} / 累计 {result['points']['total']}")
    except HttpError:
        pass

    return result


def account_summary_lines(r: dict) -> list[str]:
    name = r.get("nickname", r.get("ref", "?"))
    sep_len = max(1, 40 - len(name.encode("gbk", "ignore")))
    lines = [f"  ── {name} " + "─" * sep_len]
    if r.get("error"):
        lines.append(f"      ❌ {r['error']}")
        return lines
    done = [DAILY_TASK_LABELS.get(k, k) for k, v in r["tasks"].items() if v]
    lines.append(f"      任务: {'、'.join(done) if done else '无'}")
    laomo = r.get("laomo_today")
    if laomo is not None:
        lines.append(f"      劳模星光: 今日 {laomo}/100 分")
    if r.get("share_count"):
        lines.append(f"      分享: {r['share_count']} 次 (+{r['share_count'] * 20}分)")
    pts = r.get("points") or {}
    if pts.get("available") is not None:
        lines.append(f"      积分: 可用 {pts.get('available')} / 累计 {pts.get('total')}")
    else:
        lines.append("      积分: 未知")
    prize = r.get("prize")
    lines.append(f"      奖品: {prize}" if prize else "      奖品: 无")
    return lines


def account_notify_line(r: dict) -> str:
    name = r.get("nickname", r.get("ref", "?"))
    if r.get("error"):
        return f"{name}: 失败({str(r['error'])[:60]})"
    parts = []
    laomo = r.get("laomo_today")
    parts.append(f"劳模{'满' if (laomo or 0) >= 100 else str(laomo) + '分'}" if laomo is not None else "劳模?")
    if r.get("share_count"):
        parts.append(f"分享{r['share_count']}次")
    pts = r.get("points") or {}
    if pts.get("available") is not None:
        parts.append(f"积分={pts.get('available')}")
    prize = r.get("prize")
    if prize:
        parts.append(f"奖品={prize}")
    return f"{name}: " + " ".join(parts)


# ============================ 主流程 ============================
def main() -> int:
    log("=" * 56)
    log("上海工会「工惠通」多账号每日任务 (全直连/多账号并发/积分判据)")
    log(f"  时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"  网络: 强制直连 (无代理)")
    log(f"  微信代理: {GH_WX_BASE}")
    log(f"  劳模间隔: {LAOMO_INTERVAL:.0f}s | 分享: {SHARE_TIMES}次 间隔{SHARE_INTERVAL:.0f}s")
    log("=" * 56)

    accounts: list[dict] = []
    skipped: list[str] = []

    if GH_TOKENS:
        accounts = [
            {"ref": f"tok{i+1}", "nickname": f"token账号{i+1}", "token": t}
            for i, t in enumerate(GH_TOKENS)
        ]
        log(f"· GH_TOKENS 模式: {len(accounts)} 个 token")
    elif GH_AUTO_WX:
        accounts, skipped = get_accounts_from_proxy()
        if not accounts:
            log(f"⚠ 微信代理无账号 ({'; '.join(skipped[:3])}), 回退 tokens.json")
            accounts = get_accounts_from_tokens()
    else:
        accounts = get_accounts_from_tokens()

    if not accounts:
        log("❌ 无可用账号")
        notify("工惠通每日任务", "❌ 无可用账号, 请检查微信代理/tokens.json")
        return 1

    # 过滤
    if ONLY_REFS:
        accounts = [a for a in accounts if a["ref"] in ONLY_REFS or a.get("openid", "") in ONLY_REFS]
    if SKIP_REFS:
        accounts = [a for a in accounts if a["ref"] not in SKIP_REFS and a.get("openid", "") not in SKIP_REFS]

    # 🔥 ref 去重 (同 openid 双昵称坑)
    accounts = dedupe_accounts(accounts)

    log(f"✅ 共 {len(accounts)} 个账号待处理")
    if skipped:
        log(f"· 跳过 {len(skipped)} 个账号")

    log(f"· 并发模式: GH_CONCURRENCY={GH_CONCURRENCY}")

    def worker(idx: int, account: dict) -> dict:
        nickname = account.get("nickname", "?")
        ref = account.get("ref", "")
        if GH_DELAY:
            sleep_delay("(并发启动错峰)")
        log("")
        log(f"▶ [{idx+1}/{len(accounts)}] 处理账号: {nickname} (ref={ref})")
        try:
            auth = login_account(account)
            if not auth:
                log(f"  ❌ {nickname}: 登录失败")
                return {"ref": ref, "nickname": nickname, "error": "登录失败"}
            # 🔥 openid 去重 (跨线程)
            openid = auth.get("openid") or ""
            if openid:
                with SEEN_LOCK:
                    if openid in SEEN_OPENIDS:
                        log(f"  ⏭ {nickname}: openid 与之前账号重复, 跳过")
                        return {"ref": ref, "nickname": nickname, "openid": openid, "skip": "openid 重复"}
                    SEEN_OPENIDS.add(openid)
            client = GongHuiClient(auth["token"], auth["nickname"])
            result = run_account_tasks(client, ref, auth["nickname"])
            result["nickname"] = auth["nickname"]
            log(f"  ✓ {nickname}: 任务完成")
            return result
        except Exception as e:
            log(f"  ❌ {nickname} 处理失败: {e}")
            return {"ref": ref, "nickname": nickname, "error": str(e)}

    all_results: list[dict] = [None] * len(accounts)
    if GH_CONCURRENCY and GH_CONCURRENCY > 0:
        with ThreadPoolExecutor(max_workers=GH_CONCURRENCY) as pool:
            futures = {pool.submit(worker, i, acc): i for i, acc in enumerate(accounts)}
            for fut in as_completed(futures):
                i = futures[fut]
                try:
                    all_results[i] = fut.result()
                except Exception as e:
                    all_results[i] = {
                        "ref": accounts[i].get("ref", "?"),
                        "nickname": accounts[i].get("nickname", "?"),
                        "error": str(e),
                    }
    else:
        for i, acc in enumerate(accounts):
            all_results[i] = worker(i, acc)

    # 汇总
    full_cnt = sum(1 for r in all_results if (r.get("laomo_today") or 0) >= 100)
    share_total = sum(r.get("share_count") or 0 for r in all_results)
    log("")
    log("=" * 56)
    log(f"任务执行汇总 (劳模拿满 {full_cnt}/{len(all_results)} | 分享 {share_total} 次 +{share_total * 20}分):")
    for r in all_results:
        for line in account_summary_lines(r):
            log(line)
    log("=" * 56)

    if all_results:
        notify_lines = [account_notify_line(r) for r in all_results]
        notify(
            "工惠通每日任务",
            f"劳模拿满 {full_cnt}/{len(all_results)} | 分享 {share_total} 次\n" + "\n".join(notify_lines),
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
