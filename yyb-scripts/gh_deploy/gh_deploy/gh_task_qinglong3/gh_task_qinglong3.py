#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上海工会「工惠通」多账号每日任务环境变量 (均可选):

  GH_TOKENS       逗号分隔的 token 列表 (如 "tok1,tok2"), 优先级最高
  GH_ONLY_REFS    只处理指定账号 openid (逗号分隔)
  GH_SKIP_REFS    跳过指定账号 openid (逗号分隔)
  GH_SKIP_TASKS   跳过的任务 (signin,dati,sport,tiangong,laomo,lottery)
  GH_DO_LOTTERY   开物寻珍抽奖开关 (默认 0 关闭, 1 启用)
  GH_MAX_FAIL     连续失败熔断阈值 (默认 3)
  GH_DELAY        账号间延迟秒数 (默认 0): 固定值如 "10", 或随机范围如 "5-15"
                  用于换 token / 任务执行之间错峰, 避免触发微信风控

微信代理服务 (默认 http://192.168.3.177:8000, 提供扫码登录 + 取 code):
  GH_WX_BASE      微信代理服务地址 (如 http://192.168.3.177:8000)
  GH_WX_APP_ID    目标小程序 appid (默认 wx21fee1602f5ed3f7, 工惠通)
  GH_AUTO_WX      是否通过微信代理拉取账号/换 token (默认 1 启用, 0 关闭)

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
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

# ============================ 配置 ============================
def env(name: str, default: str = "") -> str:
    """读取环境变量, 优先 QL_ 前缀 (青龙惯例)。"""
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

# 微信代理服务 (扫码登录 / 取 code → token)
GH_WX_BASE = env("GH_WX_BASE", "http://192.168.3.177:8000").rstrip("/")
GH_WX_APP_ID = env("GH_WX_APP_ID", "wx21fee1602f5ed3f7")
GH_AUTO_WX = env("GH_AUTO_WX", "1").lower() in ("1", "true", "yes", "on")

# 账号间延迟 (秒): 固定值如 "10", 或随机范围如 "5-15"
# 用于换 token 和任务执行之间, 避免触发微信风控限流
GH_DELAY = env("GH_DELAY", "0")

# 工惠通 API
GH_BASE = "https://sgxmgl.shszgh.cn/renren-admin"
GH_REFERER = "https://servicewechat.com/wx21fee1602f5ed3f7/5/page-frame.html"
GH_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B)"
)

# 任务常量 (逆向自小程序源码)
SIGN_IN_ACTIVITY_ID = "1930096544729243649"
LAOMO_ACTIVITY_ID = "2069345741944016898"

TASK_LABELS = {
    "signin": "签到",
    "dati": "答题",
    "sport": "运动视频",
    "tiangong": "天工探源",
    "laomo": "劳模星光",
    "lottery": "开物寻珍",
}

# getDailyTasks 返回的字段名 → 中文标签 (用于汇总展示)
DAILY_TASK_LABELS = {
    "qiandao": "签到",
    "dati": "答题",
    "pkDati": "PK答题",
    "sportVideo": "运动视频",
    "tiangongTanyuan": "天工探源",
    "laomoxingguang": "劳模星光",
    "kaiwuxunzhen": "开物寻珍",
    "workPartner": "工友互助",
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
        from notify import send  # type: ignore

        send(title, content)
    except Exception:
        log(f"[通知] {title}: {content[:200]}")


def sleep_delay(reason: str = "") -> None:
    """按 GH_DELAY 配置休眠, 用于账号间错峰避免触发微信风控。

    支持两种格式:
      - 固定秒数: GH_DELAY=10 → 每次固定睡 10 秒
      - 随机范围: GH_DELAY=5-15 → 每次随机睡 5~15 秒

    Args:
        reason: 延迟原因说明 (日志展示, 可空)。
    """
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
    """读取脚本同目录「天工探源场馆清单.csv」, 失败返回 None。"""
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


# ---- SSL 兼容 (青龙/服务器环境 TLS 握手问题) ----
_SSL_OPENER: Optional[urllib.request.OpenerDirector] = None


def _get_ssl_opener() -> urllib.request.OpenerDirector:
    """构建兼容老 TLS 服务器的 urllib opener。

    工惠通等政务小程序服务器 TLS 配置较老, 青龙容器内 Python/OpenSSL
    默认会因 TLS 版本过低或证书校验失败握手断开 (SSL: UNEXPECTED_EOF)。
    这里放宽: 跳过证书校验 + 允许 TLSv1.2 以下版本。
    """
    global _SSL_OPENER
    if _SSL_OPENER is not None:
        return _SSL_OPENER
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1  # 兼容老设备
    except Exception:
        pass
    try:
        ctx.set_ciphers("DEFAULT:@SECLEVEL=1")  # 降低安全级别, 兼容旧密码套件
    except Exception:
        pass
    _SSL_OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
    return _SSL_OPENER


# ============================ 工惠通客户端 ============================
class GongHuiClient:
    """工惠通小程序 API 客户端 (token 认证)。"""

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

    # ---- 登录 (code→token, 供 --code2token 子命令) ----
    @staticmethod
    def wxlogin(code: str, nickname: str = "") -> tuple[str, str, str]:
        """用微信 code 登录, 返回 (token, openid, mobile)。"""
        # 昵称含 emoji/特殊字符会被工惠通拒绝, 统一清洗
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

    # ---- 任务 ----
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
        """拉取劳模星光栏目列表 (menuid=劳模星光栏目)。

        Args:
            page_size: 每页条数, 默认 10。

        Returns:
            记录列表, 空列表表示栏目无内容。
        """
        d = self._req(
            "POST", "/xxfb/xxfbList",
            body={"pageNum": 1, "pageSize": page_size, "menuid": "2057761673986240514"},
        )
        return (d.get("data") or {}).get("records") or []

    def laomo_detail(self, fid: str) -> dict:
        """加载劳模星光详情 (模拟进入页面, 服务端用于绑定播放会话)。

        Args:
            fid: 文章ID。

        Returns:
            详情数据。
        """
        return (self._req("POST", f"/xxfb/{fid}", body={}).get("data") or {})


# ============================ 微信代理服务客户端 ============================
class WxProxyError(Exception):
    """微信代理服务调用失败。"""


class WxProxyClient:
    """对接微信代理服务 (192.168.3.177:8000)。

    该服务维护一批已扫码登录的微信账号, 提供:
      - 扫码登录新账号 (/qr 系列)
      - 账号列表 / 删除 (/accounts)
      - 获取目标小程序 code (/wxapp/getCode) → 再交工惠通 wxLogin 换 token
    """

    def __init__(self, base: str = GH_WX_BASE, timeout: float = 30) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout

    def _req(self, method: str, path: str, params: Optional[dict] = None,
             body: Optional[dict] = None) -> dict:
        """发起请求并统一解析 {code,msg,data} 响应。

        Args:
            method: HTTP 方法。
            path: 服务路径 (如 /accounts)。
            params: URL 查询参数。
            body: JSON 请求体。

        Returns:
            完整响应 dict。

        Raises:
            WxProxyError: 网络错误或业务错误。
        """
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

    # ---- 账号管理 ----
    def list_accounts(self) -> list[dict]:
        """获取服务上全部微信账号。

        Returns:
            账号 dict 列表, 含 id/openid/nickname/status 等字段。
        """
        data = self._req("GET", "/accounts").get("data")
        return data if isinstance(data, list) else []

    def refresh_account(self, ref: str) -> dict:
        """刷新账号存活状态 (上线微信客户端)。

        Args:
            ref: 账号 ID / UIN / openid。

        Returns:
            服务端返回数据。
        """
        return self._req("POST", "/accounts/refresh", body={"ref": ref}).get("data") or {}

    def delete_account(self, ref: str) -> dict:
        """删除账号。

        Args:
            ref: 账号 ID / UIN / openid。

        Returns:
            服务端返回数据。
        """
        return self._req("DELETE", "/accounts", params={"ref": ref}).get("data") or {}

    # ---- 取小程序 code ----
    def get_code(self, ref: str, app_id: str = GH_WX_APP_ID) -> str:
        """让指定微信账号登录目标小程序并返回 code。

        Args:
            ref: 账号 ID / UIN / openid。
            app_id: 小程序 appid, 默认工惠通。

        Returns:
            小程序登录 code (一次性, 供 wxLogin 换 token)。

        Raises:
            WxProxyError: 账号过期需重新扫码等。
        """
        data = self._req(
            "POST", "/wxapp/getCode", body={"app_id": app_id, "ref": ref}
        ).get("data") or {}
        result = data.get("result") or {}
        code = str(result.get("code") or "")
        if not code:
            raise WxProxyError(f"getCode 未返回 code: {str(data)[:200]}")
        return code

    # ---- 扫码登录 ----
    def create_qr(self, as_base64: bool = True) -> dict:
        """创建扫码登录会话。

        Args:
            as_base64: 是否同时返回二维码图片 data URI。

        Returns:
            {session_id, image_url, image_base64, status}。
        """
        data = self._req(
            "POST", "/qr", params={"as_base64": "true" if as_base64 else "false"}
        ).get("data") or {}
        if not data.get("session_id"):
            raise WxProxyError(f"创建扫码会话失败: {str(data)[:200]}")
        return data

    def poll_qr(self, session_id: str) -> dict:
        """轮询扫码登录状态。

        Args:
            session_id: 会话 ID。

        Returns:
            会话状态 dict (含 status: pending/scanned/confirmed 等)。

        Raises:
            WxProxyError: 轮询失败 (如微信侧超时, 可重试)。
        """
        return self._req("GET", f"/qr/{session_id}/poll").get("data") or {}

    def confirm_qr(self, session_id: str) -> dict:
        """确认已授权的扫码会话并保存账号。

        Args:
            session_id: 会话 ID。

        Returns:
            保存后的账号信息。
        """
        return self._req("POST", f"/qr/{session_id}/confirm", body={}).get("data") or {}


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


def save_token_entry(code: str, nickname: str, token: str, openid: str, mobile: str) -> None:
    tokens = load_saved_tokens()
    tokens[openid or code] = {
        "code": code,
        "nickname": nickname,
        "token": token,
        "openid": openid,
        "mobile": mobile,
        "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    TOKENS_FILE.write_text(
        json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(f"  ✓ 已保存到 {TOKENS_FILE.name}")


# ============================ code→token 子命令 ============================
def cmd_code2token(code: str, nickname: str) -> int:
    log(f"正在用 code 登录工惠通 (code={code[:10]}...)...")
    try:
        token, openid, mobile = GongHuiClient.wxlogin(code, nickname or "账号")
    except HttpError as e:
        log(f"❌ 转换失败: {e}")
        if "授权失败" in str(e):
            log("提示: 这通常是微信侧限流或 code 已过期, 请重新获取 code。")
        return 1
    name, real_openid = nickname or "账号", openid
    try:
        probe = GongHuiClient(token)
        ui = (probe.get_user_info().get("userInfo") or {})
        name = ui.get("realName") or ui.get("nickname") or name
        real_openid = ui.get("openid") or openid
        mobile = ui.get("mobile") or mobile
        log(f"✓ 登录成功: {name} (openid={real_openid}, mobile={mobile})")
    except Exception:
        log("⚠ token 获取成功但验证失败: 请手动确认")
    log(f"✓ token: {token}")
    save_token_entry(code, name, token, real_openid, mobile)
    log("下次运行本脚本将直接使用该 token")
    return 0


def cmd_list_tokens() -> int:
    tokens = load_saved_tokens()
    if not tokens:
        log("tokens.json 为空 (可用 --code2token <code> 或 GH_TOKENS 环境变量)")
        return 0
    log(f"已保存 {len(tokens)} 个 token:")
    for key, t in tokens.items():
        log(f"  openid={key} 昵称={t.get('nickname')} "
            f"token={str(t.get('token'))[:12]}... 保存于 {t.get('saved_at')}")
    return 0


def cmd_clear_token(openid: str) -> int:
    tokens = load_saved_tokens()
    if openid in tokens:
        del tokens[openid]
        TOKENS_FILE.write_text(
            json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        log(f"✓ 已删除 openid={openid}")
    else:
        log(f"未找到 openid={openid}")
    return 0


# ============================ 微信代理服务子命令 ============================
def wx_get_token(proxy: WxProxyClient, acc: dict, retries: int = 1) -> Optional[dict]:
    """用代理服务账号换取工惠通 token。

    Args:
        proxy: 代理服务客户端。
        acc: 代理账号 dict (含 id/openid/nickname/status)。
        retries: wxLogin 授权失败后的重试次数 (微信侧风控限流, 稍候重试)。

    Returns:
        tokens.json 条目 dict; None 表示失败。
    """
    ref = str(acc.get("openid") or acc.get("id") or "")
    nickname = str(acc.get("nickname") or acc.get("alias") or "账号")

    def _fetch() -> tuple[str, str, str, str]:
        """取一次 code 并换 token, 返回 (token, openid, mobile, code)。"""
        code = proxy.get_code(ref)
        token, openid, mobile = GongHuiClient.wxlogin(code, nickname)
        return token, openid, mobile, code

    try:
        token, openid, mobile, code = _fetch()
    except Exception as e:
        # 统一捕获 (含 SSL/网络等异常), 确保单账号失败不拖垮整个脚本
        token, openid, mobile, code = "", "", "", ""
        msg = str(e)
        # 风控 / SSL 握手等问题 → 等待后重新取 code + 重试
        for attempt in range(1, retries + 1):
            wait = 10 * attempt
            log(f"  · {nickname}: {msg[:40]} → 第 {attempt} 次重试 (等待 {wait}s)...")
            time.sleep(wait)
            try:
                token, openid, mobile, code = _fetch()
                break
            except Exception as e2:
                msg = str(e2)
                token = ""
        if not token:
            log(f"  · {nickname}: 换 token 失败 ({msg[:60]})")
            return None
    # 用 token 探测真实身份
    real_name, real_openid = nickname, openid
    try:
        probe = GongHuiClient(token)
        ui = (probe.get_user_info().get("userInfo") or {})
        real_name = ui.get("realName") or ui.get("nickname") or nickname
        real_openid = ui.get("openid") or openid
    except HttpError:
        pass
    entry = {
        "code": code,
        "nickname": real_name,
        "token": token,
        "openid": real_openid,
        "mobile": mobile,
        "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "wx_ref": ref,  # 关联代理服务账号
    }
    log(f"  ✓ {real_name} → token 获取成功 ({token[:12]}...)")
    return entry


def cmd_wx_list(only_alive: bool = False) -> int:
    """列出代理服务上的微信账号。"""
    try:
        proxy = WxProxyClient()
        accounts = proxy.list_accounts()
    except WxProxyError as e:
        log(f"❌ 连接微信代理失败: {e}")
        return 1
    if not accounts:
        log("代理服务上暂无账号 (可用 --wx-login 扫码添加)")
        return 0
    log(f"微信代理共 {len(accounts)} 个账号:")
    for a in accounts:
        status = a.get("status", "?")
        mark = "✅" if status == "alive" else "❌"
        if only_alive and status != "alive":
            continue
        log(f"  {mark} id={a.get('id')} 昵称={a.get('nickname') or a.get('alias') or '-'} "
            f"状态={status} openid={a.get('openid')}")
    return 0


def cmd_wx_sync() -> int:
    """同步代理服务上所有可用账号的 token 到 tokens.json。"""
    try:
        proxy = WxProxyClient()
        accounts = proxy.list_accounts()
    except WxProxyError as e:
        log(f"❌ 连接微信代理失败: {e}")
        return 1
    alive = [a for a in accounts if a.get("status") == "alive"]
    if not alive:
        log("⚠ 没有存活账号 (status=alive)。过期账号需先重新扫码: --wx-login")
        return 1

    log(f"· 存活账号 {len(alive)}/{len(accounts)}, 开始换取 token...")
    tokens = load_saved_tokens()
    ok = 0
    for acc in alive:
        entry = wx_get_token(proxy, acc)
        if entry is None:
            continue
        key = str(entry["openid"]) or str(acc.get("openid") or acc.get("id") or "")
        tokens[key] = entry
        ok += 1
    if not ok:
        log("❌ 所有账号换 token 均失败")
        return 1
    TOKENS_FILE.write_text(json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"✓ 已同步 {ok} 个账号到 {TOKENS_FILE.name} (共 {len(tokens)} 条)")
    return 0


def _cached_entry_for(saved: dict, acc: dict) -> Optional[dict]:
    """在缓存中查找匹配代理账号的条目。

    代理账号通过 wx_ref(代理 openid) 或代理 id 与缓存条目关联;
    兜底用工惠通 openid 直接匹配。

    Args:
        saved: tokens.json 内容。
        acc: 代理账号 dict。

    Returns:
        匹配的缓存条目; 无则 None。
    """
    acc_ref = str(acc.get("openid") or acc.get("id") or "")
    acc_id = str(acc.get("id") or "")
    for key, entry in saved.items():
        if str(entry.get("wx_ref") or "") == acc_ref:
            return entry
        if str(entry.get("wx_ref") or "") == acc_id:
            return entry
        if str(entry.get("openid") or key) == acc_ref:
            return entry
    return None


def refresh_token_from_proxy(acc: dict) -> Optional[str]:
    """通过微信代理 (192.168.3.177:8000) 重新获取 token。

    用于 token 失效时的兜底: getCode → wxLogin 换新 token, 并回写缓存。

    Args:
        acc: 账号 dict (需含 wx_ref 或 openid 用于关联代理账号)。

    Returns:
        新 token 字符串; 失败返回 None。
    """
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
    # 更新内存中的账号 + 回写 tokens.json 缓存
    acc["token"] = new_token
    acc["saved_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    tokens = load_saved_tokens()
    for key, entry in tokens.items():
        if str(entry.get("openid") or key) == str(acc.get("openid") or acc.get("ref") or ""):
            entry["token"] = new_token
            entry["saved_at"] = acc["saved_at"]
            break
    TOKENS_FILE.write_text(json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  ✓ token 已重新获取并更新缓存 ({new_token[:12]}...)")
    return new_token


def collect_accounts_from_proxy() -> tuple[list[dict], list[str]]:
    """从微信代理拉取全部账号, 优先复用缓存 token, 过期才重新换取。

    只有缓存缺失或 token 失效时才调用 wxLogin, 避免频繁触发微信风控。

    Args:
        无。

    Returns:
        (accounts, skipped):
            accounts - 可用于执行任务的账号列表 (含 ref/token/nickname/openid/wx_ref);
            skipped  - 被跳过的账号及原因 (expired / 换 token 失败)。
    """
    accounts: list[dict] = []
    skipped: list[str] = []
    try:
        proxy = WxProxyClient()
        all_accs = proxy.list_accounts()
    except WxProxyError as e:
        return [], [f"微信代理连接失败: {e}"]

    if not all_accs:
        return [], ["微信代理上暂无账号"]

    saved = load_saved_tokens()
    log(f"· 微信代理共 {len(all_accs)} 个账号:")
    first_done = False
    for acc in all_accs:
        # 账号间错峰 (换 token 阶段): 第一个账号前不延迟
        if first_done:
            sleep_delay("(换 token 错峰)")
        first_done = True
        nickname = str(acc.get("nickname") or acc.get("alias") or "账号")
        ref = str(acc.get("openid") or acc.get("id") or "")
        status = str(acc.get("status") or "?")
        if status != "alive":
            log(f"  ⚠ {nickname}: 状态={status}, 跳过 (需重新扫码)")
            skipped.append(f"{nickname}: 状态={status}, 需重新扫码")
            continue

        # 1) 优先复用缓存 token (探测一次 getUserInfo 确认有效)
        token, real_name, real_openid = "", nickname, ref
        cached = _cached_entry_for(saved, acc)
        if cached and cached.get("token"):
            try:
                probe = GongHuiClient(str(cached["token"]))
                ui = (probe.get_user_info().get("userInfo") or {})
                token = str(cached["token"])
                real_name = ui.get("realName") or ui.get("nickname") or nickname
                real_openid = ui.get("openid") or str(cached.get("openid") or ref)
                log(f"  ✓ {nickname}: 复用缓存 token")
            except Exception:
                token = ""  # 缓存已失效, 走重新换取
                log(f"  · {nickname}: 缓存 token 已过期, 重新换取...")

        # 2) 缓存无效 → 重新 getCode + wxLogin
        if not token:
            entry = wx_get_token(proxy, acc)
            if entry is None:
                log(f"  ⚠ {nickname}: 换 token 失败, 跳过")
                skipped.append(f"{nickname}: 换 token 失败")
                continue
            token = str(entry["token"])
            real_name = str(entry["nickname"])
            real_openid = str(entry["openid"] or ref)
            saved[real_openid or ref] = entry  # 回写缓存

        accounts.append({
            "ref": real_openid or ref,
            "token": token,
            "nickname": real_name,
            "openid": real_openid,
            "wx_ref": ref,
        })

    # 统一落盘缓存
    if accounts:
        TOKENS_FILE.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding="utf-8")
    return accounts, skipped


def cmd_wx_login() -> int:
    """扫码登录新微信账号到代理服务 (需人工扫码)。"""
    try:
        proxy = WxProxyClient()
        session = proxy.create_qr()
    except WxProxyError as e:
        log(f"❌ 创建扫码会话失败: {e}")
        return 1
    sid = session["session_id"]
    image_url = f"{GH_WX_BASE}{session.get('image_url', '')}"
    log("=" * 56)
    log("请用微信扫描以下二维码登录新账号:")
    log(f"  二维码图片: {image_url}")
    base64_img = session.get("image_base64")
    if base64_img:
        try:
            import base64

            img_path = SCRIPT_DIR / f"wx_qr_{sid[:8]}.png"
            b64 = base64_img.split(",", 1)[-1]
            img_path.write_bytes(base64.b64decode(b64))
            log(f"  已保存到: {img_path}")
        except Exception as e:
            log(f"  ⚠ 二维码保存失败: {e}")
    log("=" * 56)

    # 轮询直到确认/失败/超时 (最长 5 分钟)
    deadline = time.time() + 300
    last_status = ""
    while time.time() < deadline:
        try:
            state = proxy.poll_qr(sid)
        except WxProxyError as e:
            log(f"  · 轮询失败 ({e}), 2 秒后重试...")
            time.sleep(2)
            continue
        status = state.get("status") or ""
        if status != last_status:
            log(f"  状态: {status}")
            last_status = status
        if status in ("confirmed", "authorized"):
            break
        if status in ("expired", "canceled", "error"):
            log("❌ 会话已失效, 请重新运行 --wx-login")
            return 1
        time.sleep(2)

    if last_status not in ("confirmed", "authorized"):
        log("❌ 等待扫码超时 (5 分钟)")
        return 1

    try:
        account = proxy.confirm_qr(sid)
    except WxProxyError as e:
        log(f"❌ 确认账号失败: {e}")
        return 1
    log(f"✓ 已保存账号: {account.get('nickname') or account.get('alias') or '?'} "
        f"(openid={account.get('openid')})")
    log("提示: 运行 --wx-sync 即可同步该账号的工惠通 token")
    return 0


# ============================ 单账号任务执行 ============================
def run_account_tasks(client: GongHuiClient, ref: str) -> dict:
    result: dict[str, Any] = {"ref": ref, "tasks": {}, "points": None}
    log(f"---- 账号[{ref}] {client.nickname} 执行任务 ----")

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

    # 5. 劳模星光 (先加载详情建立播放会话, 再每60秒调一次 addIntegral)
    if "laomo" not in SKIP_TASKS and not tasks.get("laomoxingguang"):
        try:
            # 5.1 加载一篇劳模星光详情 (模拟进入页面, 服务端据此绑定播放会话)
            recs = client.laomo_list()
            if not recs:
                log("  ⚠ 劳模星光栏目无内容, 跳过")
            else:
                client.laomo_detail(recs[0]["id"])
                log(f"  已进入详情: {recs[0].get('title', '')[:20]}")
                # 5.2 按播放节奏每 60 秒调一次加分, 最多 3 次
                done = False
                for i in range(3):
                    if i > 0:
                        time.sleep(61)
                    earned = client.add_integral(LAOMO_ACTIVITY_ID, "劳模星光")
                    # data=None 表示今日加分额度已用完, 停止尝试
                    if not earned:
                        log("  ⚠ 劳模星光今日加分额度已用完 (data=null)")
                        break
                    log(f"  第{i+1}次加分完成, 检查状态...")
                    if client.get_daily_tasks().get("laomoxingguang"):
                        done = True
                        break
                if done:
                    result["tasks"]["laomoxingguang"] = True
                    log("  ✓ 劳模星光完成")
                else:
                    log("  ⚠ 劳模星光 3 次加分后状态仍未翻转, 可能已达每日上限")
        except HttpError as e:
            log(f"  ⚠ 劳模星光失败: {e}")

    # 6. 开物寻珍 (默认关闭)
    if DO_LOTTERY:
        if "lottery" not in SKIP_TASKS and not tasks.get("kaiwuxunzhen"):
            try:
                data = client.lottery_draw()
                prize = data.get("prizeName") or data.get("name") or "奖品"
                result["prize"] = prize  # 存入结果, 供汇总/通知展示
                log(f"  ✓ 开物寻珍抽奖: {prize}")
            except HttpError as e:
                log(f"  ⚠ 抽奖失败: {e}")
        elif tasks.get("kaiwuxunzhen"):
            log("  · 开物寻珍今日已完成")
    else:
        log("  · 开物寻珍已关闭 (设置 GH_DO_LOTTERY=1 可启用)")

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
    """生成单个账号的汇总日志行 (任务 / 积分 / 奖品)。

    Args:
        r: run_account_tasks 返回的结果 dict。

    Returns:
        多行日志文本, 含账号名、完成任务、积分、奖品。
    """
    name = r.get("nickname", r.get("ref", "?"))
    sep_len = max(1, 40 - len(name.encode("gbk", "ignore")))
    lines = [f"  ── {name} " + "─" * sep_len]
    if r.get("error"):
        lines.append(f"      ❌ {r['error']}")
        return lines
    done = [DAILY_TASK_LABELS.get(k, k) for k, v in r["tasks"].items() if v]
    lines.append(f"      任务: {'、'.join(done) if done else '无'}")
    pts = r.get("points") or {}
    if pts.get("available") is not None:
        lines.append(f"      积分: 可用 {pts.get('available')} / 累计 {pts.get('total')}")
    else:
        lines.append("      积分: 未知")
    prize = r.get("prize")
    if prize:
        lines.append(f"      奖品: {prize}")
    else:
        lines.append("      奖品: 无")
    return lines


def account_notify_line(r: dict) -> str:
    """生成单个账号的通知行 (紧凑单行: 任务 + 积分 + 奖品)。

    Args:
        r: run_account_tasks 返回的结果 dict。

    Returns:
        单行通知文本。
    """
    name = r.get("nickname", r.get("ref", "?"))
    if r.get("error"):
        return f"{name}: 失败({str(r['error'])[:60]})"
    done = [DAILY_TASK_LABELS.get(k, k) for k, v in r["tasks"].items() if v]
    pts = r.get("points") or {}
    parts = [f"{name}: {'、'.join(done) if done else '无新任务'}"]
    if pts.get("available") is not None:
        parts.append(f"积分={pts.get('available')}")
    prize = r.get("prize")
    if prize:
        parts.append(f"奖品={prize}")
    return " ".join(parts)


# ============================ 主流程 ============================
def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="上海工会「工惠通」多账号每日任务 (纯任务版)")
    parser.add_argument("--code2token", metavar="CODE", nargs="?", const="",
                        help="把微信 code 转成 token 并保存")
    parser.add_argument("--nickname", default="账号", help="code2token 时的昵称 (可选)")
    parser.add_argument("--list-tokens", action="store_true", help="查看已保存的 token")
    parser.add_argument("--clear-token", metavar="OPENID", help="删除指定 openid 的 token")
    parser.add_argument("--wx-list", action="store_true", help="列出微信代理服务上的账号")
    parser.add_argument("--wx-sync", action="store_true", help="从微信代理同步所有账号 token")
    parser.add_argument("--wx-login", action="store_true", help="扫码登录新微信账号 (需人工扫码)")
    parser.add_argument("--no-auto-wx", action="store_true",
                        help="运行任务前不自动从微信代理同步 token")
    args = parser.parse_args()

    if args.code2token is not None:
        if not args.code2token:
            parser.error("--code2token 需要提供 code 参数")
        return cmd_code2token(args.code2token, args.nickname)
    if args.list_tokens:
        return cmd_list_tokens()
    if args.clear_token:
        return cmd_clear_token(args.clear_token)
    if args.wx_list:
        return cmd_wx_list()
    if args.wx_sync:
        return cmd_wx_sync()
    if args.wx_login:
        return cmd_wx_login()

    log("=" * 56)
    log("上海工会「工惠通」多账号每日任务 - 微信代理版")
    log("=" * 56)

    # 1. 收集账号 token: 环境变量 > 微信代理全量 > tokens.json 缓存
    accounts: list[dict] = []
    skipped: list[str] = []

    if GH_TOKENS:
        log(f"· 从环境变量 GH_TOKENS 读取 {len(GH_TOKENS)} 个 token")
        for i, tk in enumerate(GH_TOKENS, 1):
            accounts.append({"ref": f"env{i}", "token": tk, "nickname": "", "openid": ""})
    elif GH_AUTO_WX and not args.no_auto_wx:
        log("· 从微信代理拉取全部账号...")
        try:
            accounts, skipped = collect_accounts_from_proxy()
        except Exception as e:
            log(f"  ⚠ 拉取账号异常: {e}, 回退 tokens.json 缓存")
            accounts, skipped = [], []
    else:
        log("· 使用 tokens.json 缓存 token (--no-auto-wx / GH_AUTO_WX=0)")

    # 代理不可用或账号为空时, 回退到 tokens.json 缓存
    if not accounts:
        saved = load_saved_tokens()
        if not saved:
            if skipped:
                log(f"❌ 无可用账号: {'; '.join(skipped[:5])}")
            else:
                log("❌ 未获取到任何账号 token (检查 GH_WX_BASE / GH_TOKENS / tokens.json)")
            return 1
        log(f"· 回退使用 tokens.json 缓存 {len(saved)} 条")
        for key, entry in saved.items():
            accounts.append({
                "ref": str(entry.get("openid") or key),
                "token": str(entry.get("token") or ""),
                "nickname": str(entry.get("nickname") or ""),
                "openid": str(entry.get("openid") or key),
                "wx_ref": str(entry.get("wx_ref") or ""),
            })

    if skipped and accounts:
        log(f"· 跳过 {len(skipped)} 个账号: {'; '.join(skipped[:3])}{'...' if len(skipped) > 3 else ''}")

    # 2. 过滤
    if ONLY_REFS:
        accounts = [a for a in accounts if a["ref"] in ONLY_REFS or a["openid"] in ONLY_REFS]
    if SKIP_REFS:
        accounts = [a for a in accounts if a["ref"] not in SKIP_REFS and a["openid"] not in SKIP_REFS]

    if not accounts:
        log("⚠ 没有可用的 token (检查 GH_WX_BASE / GH_TOKENS / ONLY_REFS)")
        return 1

    # 3. 逐账号执行
    all_results: list[dict] = []
    consecutive_fail = 0
    for i, acc in enumerate(accounts):
        # 账号间错峰 (任务执行阶段), 避免连续调用触发微信风控
        if i > 0:
            sleep_delay(f"(任务执行错峰, 第 {i+1} 个账号前)")

        ref = acc["ref"]
        log("")
        log(f"▶ [{i+1}/{len(accounts)}] 处理账号 ref={ref}")

        # 熔断
        if consecutive_fail >= MAX_CONSECUTIVE_FAIL:
            log(f"⚠ 连续 {consecutive_fail} 个账号失败, 提前终止 (GH_MAX_FAIL={MAX_CONSECUTIVE_FAIL})")
            break

        try:
            # 验证 token 并取真实身份
            client = GongHuiClient(acc["token"])
            try:
                ui = (client.get_user_info().get("userInfo") or {})
                real_name = ui.get("realName") or ui.get("nickname") or acc["nickname"] or f"账号{ref}"
                real_openid = ui.get("openid") or acc["openid"] or ref
            except HttpError:
                # token 过期 → 通过微信代理重新获取后再试
                log(f"  · token 失效, 尝试通过微信代理重取...")
                if GH_AUTO_WX and not args.no_auto_wx:
                    new_token = refresh_token_from_proxy(acc)
                    if new_token:
                        client = GongHuiClient(new_token)
                        try:
                            ui = (client.get_user_info().get("userInfo") or {})
                            real_name = ui.get("realName") or ui.get("nickname") or acc["nickname"]
                            real_openid = ui.get("openid") or acc["openid"] or ref
                        except HttpError:
                            real_name = acc["nickname"] or f"账号{ref}"
                            real_openid = acc["openid"] or ref
                    else:
                        real_name = acc["nickname"] or f"账号{ref}"
                        real_openid = acc["openid"] or ref
                else:
                    log("  ⚠ 已关闭自动重取 (GH_AUTO_WX=0 / --no-auto-wx), 跳过该账号")
                    raise
            log(f"  · 账号: {real_name} (openid={real_openid})")

            client.nickname = real_name
            result = run_account_tasks(client, ref)
            result["nickname"] = real_name
            all_results.append(result)

            if result.get("error"):
                consecutive_fail += 1
            else:
                consecutive_fail = 0
        except Exception as e:
            err = str(e)
            log(f"  ❌ 账号 {ref} 处理失败: {err}")
            all_results.append({"ref": ref, "nickname": acc["nickname"], "error": err})
            if "token" in err or "授权" in err:
                consecutive_fail += 1
            else:
                consecutive_fail = 0

    # 4. 汇总 (任务 / 积分 / 奖品)
    log("")
    log("=" * 56)
    log("任务执行汇总:")
    for r in all_results:
        for line in account_summary_lines(r):
            log(line)
    log("=" * 56)

    if all_results:
        notify_lines = [account_notify_line(r) for r in all_results]
        notify("工惠通每日任务", "\n".join(notify_lines))

    return 0


if __name__ == "__main__":
    sys.exit(main())
