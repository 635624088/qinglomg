#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上海工会「工惠通」劳模星光独立任务 (直连版, 无代理)

背景: 原积分任务脚本中劳模任务失败, 根因 = 观看时长不足。
  add_integral 在观看 0 秒时返回 {"code":0,"data":null} (条件未满足),
  原脚本误判为"额度用完"直接 break, 从未等满 5 分钟。
  手动完成流程 = 进入劳模详情 → 观看满 5 分钟 → 领取 100 积分。

本脚本逻辑:
  1. 从 tokens.json 读取账号 (与积分任务脚本同格式)
  2. 每个账号: 检查今日是否已完成 → 进入劳模详情 → 观看 330 秒
     (5 分 30 秒, 冗余到 5 分多几十秒) → 领取积分 → 验证状态翻转
  3. 领取完成后执行分享模块: 分享小程序 5 次, 每次 +20 分 (上限 5 次/天)
     分享与观看相互独立, 观看已完成的账号也会尝试分享
  4. 单账号异常 → 跳过继续, 不让脚本中断
  5. 直连 API, 不走任何代理

环境变量 (均可选):
  GH_ONLY_REFS       只处理指定账号 openid (逗号分隔), 如测试单账号
  GH_SKIP_REFS       跳过指定账号 openid (逗号分隔)
  GH_WATCH_SECONDS   观看秒数 (默认 330 = 5分30秒)
  GH_MAX_RETRY       领取失败重试次数 (默认 2, 每次间隔 60s)
  GH_SHARE_TIMES     分享次数 (默认 5, 服务端上限 5 次/天)
  GH_SHARE_INTERVAL  分享间隔秒数 (默认 5)

依赖: 仅 Python 标准库。
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

# ============================ 配置 ============================
def env(name: str, default: str = "") -> str:
    return os.environ.get(f"QL_{name}", os.environ.get(name, default))


SCRIPT_DIR = Path(__file__).resolve().parent
TOKENS_FILE = SCRIPT_DIR / "tokens.json"

ONLY_REFS = [x.strip() for x in env("GH_ONLY_REFS", "").split(",") if x.strip()]
SKIP_REFS = [x.strip() for x in env("GH_SKIP_REFS", "").split(",") if x.strip()]
WATCH_SECONDS = int(env("GH_WATCH_SECONDS", "330"))
MAX_RETRY = int(env("GH_MAX_RETRY", "2"))
SHARE_TIMES = int(env("GH_SHARE_TIMES", "5"))
SHARE_INTERVAL = int(env("GH_SHARE_INTERVAL", "5"))

# 工惠通 API
GH_BASE = "https://sgxmgl.shszgh.cn/renren-admin"
GH_REFERER = "https://servicewechat.com/wx21fee1602f5ed3f7/5/page-frame.html"
GH_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B)"
)

LAOMO_ACTIVITY_ID = "2069345741944016898"
LAOMO_MENU_ID = "2057761673986240514"


def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# ============================ API 客户端 (直连, 无代理) ============================
class HttpError(Exception):
    pass


class GongHuiClient:
    """工惠通直连客户端。不配置任何代理, 环境代理也强制禁用。"""

    def __init__(self, token: str, timeout: float = 15) -> None:
        self.token = token
        self.timeout = timeout
        # 强制直连: 忽略 http_proxy/https_proxy 环境变量
        ctx = ssl.create_default_context()
        ctx.minimum_version = ssl.TLSVersion.TLSv1
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),  # 禁用代理
            urllib.request.HTTPSHandler(context=ctx),
        )

    def _req(self, method: str, path: str, params: Optional[dict] = None,
             body: Optional[dict] = None) -> dict:
        url = GH_BASE + path
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
            with self._opener.open(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise HttpError("token 过期或无效")
            raise HttpError(f"HTTP {e.code}")
        except urllib.error.URLError as e:
            raise HttpError(f"网络错误: {e.reason}")
        except TimeoutError:
            raise HttpError("网络超时")
        if result.get("code") not in (0, "0", None):
            raise HttpError(f"业务错误: {result.get('msg')}")
        return result

    def get_daily_tasks(self) -> dict[str, bool]:
        return (self._req("GET", "/whds/user/getDailyTasks").get("data") or {})

    def laomo_list(self, page_size: int = 5) -> list[dict]:
        d = self._req(
            "POST", "/xxfb/xxfbList",
            body={"pageNum": 1, "pageSize": page_size, "menuid": LAOMO_MENU_ID},
        )
        return (d.get("data") or {}).get("records") or []

    def laomo_detail(self, fid: str) -> dict:
        return (self._req("POST", f"/xxfb/{fid}", body={}).get("data") or {})

    def add_integral(self, fid: str) -> dict:
        """领取劳模星光积分。必须带 fid 参数, 否则服务端静默返回 data=None。
        data=None 表示未满足领取条件(观看时长不足); 重复领取报"今日积分已达上限"。"""
        return (self._req(
            "POST", "/whds/pointsmanage",
            body={
                "activityId": LAOMO_ACTIVITY_ID,
                "activityName": "劳模星光",
                "xxfbId": fid,
            },
        ).get("data") or {})

    def share(self) -> str:
        """分享小程序。成功返回 data (如"分享成功"); 已达上限视为已完成。
        返回: "ok" 成功 / "limit" 今日已达上限 / 其他 data 原文。"""
        try:
            d = self._req("POST", "/whds/pointsmanage/share", body={})
            return "ok"
        except HttpError as e:
            if "已达上限" in str(e):
                return "limit"
            raise


# ============================ tokens.json 读取 ============================
def load_saved_tokens() -> dict[str, dict]:
    if not TOKENS_FILE.exists():
        return {}
    try:
        return json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"  ⚠ tokens.json 解析失败: {e}")
        return {}


def get_accounts() -> list[dict]:
    """从 tokens.json 构建账号列表, 支持 ONLY/SKIP 过滤。"""
    cache = load_saved_tokens()
    accounts: list[dict] = []
    for key, info in cache.items():
        if not isinstance(info, dict):
            continue
        token = info.get("token", "")
        if not token:
            continue
        accounts.append({
            "openid": key,
            "ref": info.get("wx_ref", info.get("ref", "")),
            "nickname": info.get("nickname", "?"),
            "token": token,
        })
    if ONLY_REFS:
        accounts = [a for a in accounts if a["ref"] in ONLY_REFS]
    if SKIP_REFS:
        accounts = [a for a in accounts if a["ref"] not in SKIP_REFS]
    return accounts


# ============================ 主流程 ============================
def run_account(acc: dict) -> dict:
    """处理单个账号的劳模任务, 返回结果字典。异常向外抛, 由主循环兜底。"""
    nickname = acc["nickname"]
    ref = acc["ref"]
    client = GongHuiClient(acc["token"])

    result: dict[str, Any] = {
        "nickname": nickname, "ref": ref,
        "skipped": False, "done": False, "error": "",
        "title": "", "watch": 0,
        "share": 0, "share_limit": False,
    }

    # 1. 今日是否已完成
    tasks = client.get_daily_tasks()
    if tasks.get("laomoxingguang"):
        result["skipped"] = True
        log(f"  ⏭ 劳模星光今日已完成, 跳过 (仍会尝试分享)")
        do_share(client, result)
        return result

    # 2. 劳模列表
    recs = client.laomo_list()
    if not recs:
        result["error"] = "劳模栏目无内容"
        log("  ⚠ 劳模星光栏目无内容, 跳过")
        return result
    first = recs[0]
    fid = first.get("id") or first.get("fid")
    title = first.get("title", "")
    result["title"] = title

    # 3. 进入详情 (服务端开始计时)
    client.laomo_detail(fid)
    log(f"  ✓ 已进入详情: {title[:20]}")

    # 4. 观看等待 (满 5 分钟 + 冗余)
    log(f"  ⏳ 观看中, 等待 {WATCH_SECONDS}s (5分{WATCH_SECONDS - 300}秒冗余)...")
    watch_start = time.time()
    time.sleep(WATCH_SECONDS)
    result["watch"] = int(time.time() - watch_start)

    # 5. 领取积分 (失败重试, 带 fid; 成败以状态翻转为准)
    # 注意: add_integral 无论成败都返回 data=null, 必须查 getDailyTasks 确认
    success = False
    for attempt in range(MAX_RETRY + 1):
        if attempt > 0:
            log(f"  ↻ 第 {attempt} 次重试领取 (等待 60s)...")
            time.sleep(60)
        try:
            client.add_integral(fid)
        except HttpError as e:
            # "今日积分已达上限" = 领取成功后再领的提示, 视为成功
            if "已达上限" in str(e):
                log(f"  ✓ 领取提示: {e} (视为已领取)")
                success = True
                break
            raise
        # data=null 可能是成功也可能是观看不足 → 查状态确认
        tasks = client.get_daily_tasks()
        if tasks.get("laomoxingguang"):
            success = True
            break
        log(f"  ⚠ 第 {attempt + 1} 次领取后状态未翻转 (可能观看时长仍不足)")

    if not success:
        result["error"] = "领取失败: 多次调用后状态未翻转"
        log("  ✗ 劳模星光领取失败 (多次调用后状态未翻转)")
        return result

    result["done"] = True
    log("  ✓ 劳模星光完成 (+100积分)")
    do_share(client, result)
    return result


def do_share(client: GongHuiClient, result: dict) -> None:
    """分享小程序: 最多 SHARE_TIMES 次, 每次 +20 分。
    已达上限 (limit) 视为当天已分享满, 停止。"""
    for i in range(1, SHARE_TIMES + 1):
        try:
            r = client.share()
        except HttpError as e:
            log(f"  ⚠ 分享第 {i} 次失败: {e}")
            break
        if r == "limit":
            result["share_limit"] = True
            log(f"  ⏭ 分享已达今日上限 (已分享 {result['share']} 次)")
            break
        result["share"] += 1
        log(f"  ✓ 分享成功 {result['share']}/{SHARE_TIMES} (+20分)")
        if i < SHARE_TIMES:
            time.sleep(SHARE_INTERVAL)
    if result["share"]:
        log(f"  📈 分享完成: 共 {result['share']} 次 (+{result['share'] * 20}分)")


def main() -> int:
    log("=" * 56)
    log("上海工会「劳模星光」独立任务 (直连, 无代理)")
    log(f"  时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log(f"  观看时长: {WATCH_SECONDS}s | 领取重试: {MAX_RETRY}次 | 分享: {SHARE_TIMES}次")
    log("=" * 56)

    accounts = get_accounts()
    if not accounts:
        log("❌ 无可用账号 (tokens.json 为空或全部被过滤)")
        return 1

    log(f"✅ 共 {len(accounts)} 个账号待处理")
    results: list[dict] = []
    for i, acc in enumerate(accounts):
        log("")
        log(f"▶ [{i + 1}/{len(accounts)}] 处理账号: {acc['nickname']} (ref={acc['ref']})")
        try:
            r = run_account(acc)
        except HttpError as e:
            r = {"nickname": acc["nickname"], "ref": acc["ref"],
                 "skipped": False, "done": False, "error": str(e), "title": "", "watch": 0,
                 "share": 0, "share_limit": False}
            log(f"  ✗ 账号失败: {e}")
        except Exception as e:
            r = {"nickname": acc["nickname"], "ref": acc["ref"],
                 "skipped": False, "done": False, "error": f"{type(e).__name__}: {e}", "title": "", "watch": 0,
                 "share": 0, "share_limit": False}
            log(f"  ✗ 账号异常: {type(e).__name__}: {e}")
        results.append(r)

    # 汇总
    done = [r for r in results if r["done"]]
    skipped = [r for r in results if r["skipped"]]
    failed = [r for r in results if not r["done"] and not r["skipped"]]
    log("")
    log("=" * 56)
    shared = sum(r.get("share", 0) for r in results)
    log(f"📊 汇总: 成功 {len(done)} | 跳过 {len(skipped)} | 失败 {len(failed)} | 分享 {shared} 次 (+{shared * 20}分)")
    for r in failed:
        log(f"  ✗ {r['nickname']}: {r['error']}")
    log("=" * 56)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
