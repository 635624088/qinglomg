# -*- coding: utf-8 -*-
"""
君品汇(习酒)民俗知识挑战赛 —— 奖池剩余奖品查询 [青龙版]
只读查询, 不答题、不抽奖、不消耗任何额度。

【数据来源】
GET https://fop.exijiu.com/api/festival/lottery/today/{activityId}
返回字段(实测):
  prizeName            奖品名, 如 "53%vol知交酒（100mL）"
  dailyQuotaTotal      今日投放总量 (80)
  dailyWonCount        今日已被抽走数
  dailyRemaining       今日剩余数   <-- 核心
  stockTotal           活动总库存 (2000)
  stockRemaining       活动总库存剩余
  winningProbability   中奖概率 (1.0 = 100%, 有额度必中)
  prizeId / prizePoolId

【鉴权】必须带 X-Access-Token(小程序登录态), 否则 401 用户未登录;
       不需要 member/login。token 经 YYB Go 取 code + wxMiniSilentLogin 换取。

【奖池重置】每日 0 点重置 dailyQuotaTotal 瓶, 先到先得抽完即止。

【环境变量】
  YYB_BASE_URL     YYB Go 地址 (默认 http://172.17.0.1:18080)
  YYB_REF          指定用哪个账号的登录态查询 (默认自动挑, 优先 YYB_PRIORITY)
  YYB_PRIORITY     我的账号 openid 列表(换行/逗号分隔), 优先用这些账号登录
  JPH_ACTIVITY_ID  活动 id (默认 19)
  JPH_STOCK_WATCH  >0 则循环监控, 每 N 秒查一次 (默认 0=查一次退出)
  JPH_STOCK_ROUNDS 监控模式最多查几轮 (默认 60)
  JPH_STOCK_NOTIFY 1=用青龙 notify 推送结果 (默认 0, 由 task_after 统一推)

【命令行】
  python3 jph_prize_stock.py              查一次
  python3 jph_prize_stock.py -w 30        每 30 秒查一次, 持续盯池
  python3 jph_prize_stock.py -w 30 -r 20  每 30 秒查一次, 共 20 轮
  python3 jph_prize_stock.py --json       只输出 JSON (便于其他脚本调用)
  python3 jph_prize_stock.py -n           查完推送到 pushplus(青龙 notify)

依赖: 无(纯标准库)
"""
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

APPID = "wx8d41cdc44c8aeaab"
FOP_BASE = "https://fop.exijiu.com"
FM_BASE = "https://fm.exijiu.com"
APP_VERSION = "1.7"
BASIC_AUTH = "Basic " + base64.b64encode(b"wechat:wechat_secret").decode()
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HIST_FILE = os.path.join(SCRIPT_DIR, "jph_prize_history.json")
CST = timezone(timedelta(hours=8))

YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
YYB_REF = os.environ.get("YYB_REF", "").strip()
PRIORITY_REFS = [x.strip() for x in (os.environ.get("YYB_PRIORITY") or "").replace(",", " ").split() if x.strip()]
ACTIVITY_ID = int(os.environ.get("JPH_ACTIVITY_ID", "19"))
WATCH = int(os.environ.get("JPH_STOCK_WATCH", "0"))
ROUNDS = int(os.environ.get("JPH_STOCK_ROUNDS", "60"))
NOTIFY = os.environ.get("JPH_STOCK_NOTIFY", "0") == "1"
JSON_ONLY = False

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

LOG = []


def log(msg=""):
    print(msg)
    LOG.append(str(msg))


def now_str():
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


# ---------------- HTTP ----------------
def http(method, url, body=None, headers=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return {"code": "HTTP%s" % e.code, "message": "http error"}
    except Exception as e:
        return {"code": "ERR", "message": str(e)}


def biz_headers(token=""):
    return {
        "X-Access-Token": token or "",
        "AppID": APPID,
        "Authorization": BASIC_AUTH,
        "App-Version": APP_VERSION,
        "Content-Type": "application/json",
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781"
                       "(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"),
        "Referer": "https://servicewechat.com/%s/248/page-frame.html" % APPID,
        "Accept": "*/*",
    }


# ---------------- 登录 ----------------
def pick_refs():
    """挑选用于查询的账号: YYB_REF 优先; 否则我的账号(YYB_PRIORITY)优先, 再补其他存活账号。"""
    if YYB_REF:
        return [YYB_REF]
    data = http("GET", "%s/accounts" % YYB_BASE_URL, None, {"Accept": "application/json"}, timeout=20)
    accounts = data.get("data") if isinstance(data, dict) else data
    if not accounts:
        return []
    mine, others = [], []
    pri = set(PRIORITY_REFS)
    for a in accounts:
        if a.get("status") in ("expired", "dead"):
            continue
        ref = str(a.get("id") or a.get("uin") or a.get("openid") or "")
        oid = str(a.get("openid") or "")
        name = a.get("nickname") or a.get("alias") or ref
        if not ref:
            continue
        (mine if oid in pri else others).append((ref, name))
    # 我的账号按 YYB_PRIORITY 声明顺序
    ordered = []
    for p in PRIORITY_REFS:
        for a in accounts:
            if str(a.get("openid") or "") == p:
                ref = str(a.get("id") or a.get("uin") or a.get("openid") or "")
                nm = a.get("nickname") or a.get("alias") or ref
                if ref and (ref, nm) not in ordered:
                    ordered.append((ref, nm))
    return (ordered or mine) + others


def get_token(ref):
    """YYB 取 code -> 小程序静默登录 -> access token"""
    d = http("POST", "%s/wxapp/getCode" % YYB_BASE_URL,
             {"app_id": APPID, "ref": ref}, {"Content-Type": "application/json"}, timeout=70)
    if d.get("code") != 0:
        raise RuntimeError("YYB getCode 失败: %s" % (d.get("msg") or d.get("message") or d)[:120])
    code = ((d.get("data") or {}).get("result") or {}).get("code")
    if not code:
        raise RuntimeError("YYB 未返回 code")
    d2 = http("POST", "%s/api/v2/login/wxMiniSilentLogin" % FM_BASE, {"code": code}, biz_headers(), timeout=25)
    tok = (d2.get("data") or {}).get("token") or (d2.get("data") or {}).get("accessToken")
    if not tok:
        raise RuntimeError("silentLogin 失败: %s" % json.dumps(d2, ensure_ascii=False)[:150])
    return tok


def login_any(refs, max_try=3):
    """依次尝试账号, 返回 (token, 账号名)。任一成功即可(查询是全局数据, 用谁的登录态都一样)。"""
    err = ""
    for ref, name in refs[:max_try]:
        try:
            return get_token(ref), name
        except Exception as e:
            err = str(e)
            if not JSON_ONLY:
                log("   .. 账号 %s 登录失败, 换下一个: %s" % (name, err[:80]))
    raise RuntimeError("所有账号均登录失败: %s" % err[:150])


# ---------------- 查询 ----------------
def query_pool(token):
    return http("GET", "%s/api/festival/lottery/today/%d" % (FOP_BASE, ACTIVITY_ID), None, biz_headers(token))


def query_activity(token):
    return http("GET", "%s/api/festival/activity/detail/%d" % (FOP_BASE, ACTIVITY_ID), None, biz_headers(token))


# ---------------- 历史 ----------------
def load_hist():
    try:
        if os.path.exists(HIST_FILE):
            return json.load(open(HIST_FILE, encoding="utf-8"))
    except Exception:
        pass
    return []


def save_hist(hist):
    try:
        json.dump(hist[-300:], open(HIST_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    except Exception as e:
        log("   (历史写入失败: %s)" % e)


# ---------------- 展示 ----------------
def bar(used, total, width=22):
    if not total:
        return "-" * width
    filled = int(round(width * used / float(total)))
    filled = max(0, min(width, filled))
    return "█" * filled + "░" * (width - filled)


def fmt_gap(sec):
    sec = int(sec)
    if sec < 60:
        return "%d 秒" % sec
    if sec < 3600:
        return "%d 分 %d 秒" % (sec // 60, sec % 60)
    return "%d 小时 %d 分" % (sec // 3600, (sec % 3600) // 60)


def render(pool_items, act, hist):
    """输出人类可读报告, 返回 (摘要行列表, 本次记录列表)"""
    ts = time.time()
    stamp = now_str()
    d = act.get("data") or {}
    log("=" * 52)
    log("君品汇奖池实况   %s" % stamp)
    if d:
        log("活动: %s (id=%s)  截止 %s" % (d.get("activityName"), d.get("id"), d.get("endTime")))
        log("规则: 每账号每日限中 %s 瓶 / 活动累计限中 %s 瓶" % (d.get("dailyWinLimit"), d.get("totalWinLimit")))
    log("=" * 52)

    records, summary = [], []
    for it in pool_items:
        name = it.get("prizeName") or "?"
        pid = it.get("prizeId")
        q_total = it.get("dailyQuotaTotal") or 0
        won = it.get("dailyWonCount") or 0
        left = it.get("dailyRemaining")
        left = q_total - won if left is None else left
        s_total = it.get("stockTotal") or 0
        s_left = it.get("stockRemaining") or 0
        prob = it.get("winningProbability")

        pct = (won / float(q_total) * 100) if q_total else 0
        log("")
        log("奖品: %s   (prizeId=%s poolId=%s)" % (name, pid, it.get("prizePoolId")))
        log("  今日投放 %4d 瓶" % q_total)
        log("  今日已中 %4d 瓶" % won)
        log("  今日剩余 %4d 瓶   [%s] 已抽走 %.1f%%" % (left, bar(won, q_total), pct))
        if prob is not None:
            log("  中奖概率 %s%s" % (("%g%%" % (float(prob) * 100)), "  (有额度即必中)" if float(prob) >= 1 else ""))
        if s_total:
            log("  活动库存 %d / %d 瓶  (总量剩 %.1f%%, 按每日 %d 瓶约够 %.1f 天)"
                % (s_left, s_total, s_left / float(s_total) * 100, q_total or 1,
                   (s_left / float(q_total)) if q_total else 0))

        if left <= 0:
            nxt = datetime.now(CST).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
            log("  ⚠ 今日已抽完 — 距 0 点重置还有 %s" % fmt_gap((nxt - datetime.now(CST)).total_seconds()))
        elif left <= 10:
            log("  ⚠ 仅剩 %d 瓶, 随时抽完" % left)

        # 与上一次同奖品记录对比, 算消耗速率与预计耗尽
        prev = None
        for h in reversed(hist):
            if h.get("prizeId") == pid:
                prev = h
                break
        if prev:
            dt = ts - prev.get("ts", ts)
            dwon = won - (prev.get("won") or 0)
            if dt > 5:
                log("  ── 对比上次查询 (%s, %s前): 剩余 %s → %s (%+d 瓶)"
                    % (prev.get("time", "?"), fmt_gap(dt), prev.get("left"), left, -dwon))
                if dwon > 0:
                    rate = dwon / (dt / 60.0)          # 瓶/分钟
                    log("     消耗速率 %.2f 瓶/分钟" % rate)
                    if left > 0 and rate > 0:
                        eta_min = left / rate
                        eta = datetime.now(CST) + timedelta(minutes=eta_min)
                        log("     按此速率预计 %s 后抽完 (约 %s)" % (fmt_gap(eta_min * 60), eta.strftime("%H:%M")))
                elif dwon == 0:
                    log("     期间无人中奖 (奖池未动)")

        records.append({"ts": ts, "time": stamp, "prizeId": pid, "prizeName": name,
                        "quota": q_total, "won": won, "left": left,
                        "stockRemaining": s_left, "stockTotal": s_total})
        summary.append("%s: 今日剩 %d/%d 瓶 (已中 %d), 总库存剩 %d" % (name, left, q_total, won, s_left))
    log("")
    log("=" * 52)
    return summary, records


def push(title, content):
    import importlib.util
    for p in ("/ql/data/scripts/notify.py", "/ql/scripts/notify.py", "/data/scripts/notify.py"):
        if not os.path.exists(p):
            continue
        try:
            spec = importlib.util.spec_from_file_location("ql_notify", p)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod.send(title, content)
            print("已推送")
            return
        except Exception as e:
            print("推送失败(%s): %s" % (p, e))
            return
    print("推送失败: 未找到 notify.py")


def parse_args():
    global WATCH, ROUNDS, NOTIFY, JSON_ONLY
    a = sys.argv[1:]
    i = 0
    while i < len(a):
        x = a[i]
        if x in ("-w", "--watch") and i + 1 < len(a):
            WATCH = int(a[i + 1]); i += 1
        elif x in ("-r", "--rounds") and i + 1 < len(a):
            ROUNDS = int(a[i + 1]); i += 1
        elif x in ("-n", "--notify"):
            NOTIFY = True
        elif x == "--json":
            JSON_ONLY = True
        i += 1


def main():
    parse_args()
    if not JSON_ONLY:
        log("≡ 君品汇奖池查询 (只读, 不消耗额度)  活动id=%d" % ACTIVITY_ID)

    refs = pick_refs()
    if not refs:
        log("!! 未取到可用账号 (YYB %s/accounts 无数据)" % YYB_BASE_URL)
        sys.exit(1)
    token, who = login_any(refs)
    if not JSON_ONLY:
        log("   借用账号登录态: %s" % who)

    act = query_activity(token)
    hist = load_hist()
    last_summary = []

    total_rounds = ROUNDS if WATCH > 0 else 1
    for r in range(total_rounds):
        res = query_pool(token)
        if res.get("code") != "10000":
            msg = res.get("message") or res.get("msg") or json.dumps(res, ensure_ascii=False)[:150]
            # token 过期(401)则换号重登一次
            if str(res.get("code")) == "401":
                log("   token 失效, 重新登录…")
                token, who = login_any(refs)
                res = query_pool(token)
            if res.get("code") != "10000":
                log("!! 查询失败: %s" % msg)
                sys.exit(2)

        items = res.get("data") or []
        if JSON_ONLY:
            print(json.dumps({"time": now_str(), "activityId": ACTIVITY_ID, "data": items},
                             ensure_ascii=False, indent=1))
        else:
            last_summary, recs = render(items, act, hist)
            hist.extend(recs)
            save_hist(hist)

        if WATCH > 0 and r < total_rounds - 1:
            all_gone = all((it.get("dailyRemaining") or 0) <= 0 for it in items) if items else False
            if all_gone:
                log("≡ 奖池已空, 停止监控 (次日 0 点重置)")
                break
            time.sleep(WATCH)

    if NOTIFY and last_summary:
        push("君品汇奖池 %s" % datetime.now(CST).strftime("%m-%d %H:%M"), "\n".join(last_summary))


if __name__ == "__main__":
    main()
