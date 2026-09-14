# -*- coding: utf-8 -*-
"""
CDF中免（cdf会员购 海南小程序）签到 + 做任务攒贝壳
new Env('CDF中免签到');
cron: 20 9 * * *

两种账号模式（CDF_ACCOUNTS 每行一条，自动识别）：
  0) 自动模式：填 ALL —— 每次运行自动拉取 YYB 全部在线账号（推荐）
  1) YYB 自动登录模式：直接填 YYB 的 ref（微信账号 openid）
  2) 手动凭据模式：token#openid#unique（抓包三件套）

环境变量：
  CDF_ACCOUNTS   账号列表（每行一条，见上）
  CDF_YYB_URL    YYB 网关地址，默认 http://YOUR_QL_HOST:18080
  CDF_YYB_USER   YYB 用户名（默认 admin）
  CDF_YYB_PASS   YYB 密码
  CDF_PUSH       PushPlus token，可选，结果推送
"""
import os
import sys
import time
import json
import random
import urllib.request
import urllib.parse
import urllib.error

API = "https://service.cdfhnmall.com"
MAPI = "https://mapi.cdfgsanya.com/CDF-MEMBER/v1/api"
APP_ID = "wx83f3046fd293eefa"
ACTIVITY_ID = "1d107b12fad1f000"   # 攒贝壳 赢大奖
ACT_ENV = "0"
DEFAULT_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
              "MicroMessenger/8.0.78(0x18004e26) NetType/4G Language/zh_CN")
REFERER = "https://servicewechat.com/wx83f3046fd293eefa/427/page-frame.html"
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cdf_state.json")


def log(msg):
    print("%s | %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


def http_json(url, headers=None, data=None, method="GET", form=False):
    req = urllib.request.Request(url, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    body = None
    if data is not None:
        body = (urllib.parse.urlencode(data).encode() if form
                else json.dumps(data).encode())
    with urllib.request.urlopen(req, body, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


# ======================= YYB 网关 =======================
class Yyb(object):
    def __init__(self):
        self.url = env_or_db("CDF_YYB_URL",
                             env_or_db("FRW_YYB_URL",
                                       "http://YOUR_QL_HOST:18080")).strip().rstrip("/")
        self.user = env_or_db("CDF_YYB_USER", env_or_db("FRW_YYB_USER", "admin"))
        self.pass_ = env_or_db("CDF_YYB_PASS", env_or_db("FRW_YYB_PASS", ""))
        self.cookie = ""

    def _login_console(self):
        r = urllib.request.Request(self.url + "/login", method="POST")
        r.add_header("Content-Type", "application/json")
        r.data = json.dumps({"username": self.user,
                             "password": self.pass_}).encode()
        resp = urllib.request.urlopen(r, timeout=20)
        self.cookie = (resp.headers.get("Set-Cookie") or "").split(";")[0]

    def _req(self, path, data):
        h = {"Content-Type": "application/json"}
        if self.cookie:
            h["Cookie"] = self.cookie
        try:
            return http_json(self.url + path, h, data, "POST")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and self.pass_:   # 控制台重新登录
                self._login_console()
                h["Cookie"] = self.cookie
                return http_json(self.url + path, h, data, "POST")
            raise

    def list_accounts(self):
        """控制台账号列表（GET /accounts，需管理员 cookie）"""
        try:
            return http_json(self.url + "/accounts",
                             {"Cookie": self.cookie} if self.cookie else {})
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and self.pass_:
                self._login_console()
                return http_json(self.url + "/accounts", {"Cookie": self.cookie})
            raise

    def get_code(self, ref):
        j = self._req("/wxapp/getCode", {"ref": ref, "app_id": APP_ID})
        return (j.get("data", {}).get("result", {}) or {}).get("code", "")

    def get_phone(self, ref):
        j = self._req("/wxapp/getPhoneNumber", {"ref": ref, "app_id": APP_ID})
        r = j.get("data", {}).get("result", {}) or {}
        return r.get("iv", ""), r.get("encryptedData", "")


def gen_unique():
    t = time.strftime("%Y%m%d%H%M%S")
    rnd = "".join(random.choice("0123456789") for _ in range(23))
    return "weapp-" + t + rnd


def load_state():
    try:
        return json.load(open(STATE_FILE, encoding="utf-8"))
    except Exception:
        return {}


def save_state(st):
    try:
        json.dump(st, open(STATE_FILE, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    except Exception as e:
        log("[状态] 保存失败：%s" % e)


def cdf_login(ref):
    """YYB ref -> 完整登录链 -> {token, openid, unique}"""
    yyb = Yyb()
    uniq = gen_unique()
    wxcode = yyb.get_code(ref)
    if not wxcode:
        raise RuntimeError("YYB getCode 返回空 code")
    j2 = http_json(MAPI + "/members/wechat_mini_program/code2session?code=" + wxcode,
                   {"unique": uniq, "apiVersion": "2.0",
                    "channel": "big_frontend_hyg_weapp", "terminalId": "11",
                    "User-Agent": DEFAULT_UA, "Referer": REFERER,
                    "content-type": "application/json"})
    openid = j2.get("openId") or ""
    if not openid:
        raise RuntimeError("code2session 失败：%s" % j2)
    iv, ed = yyb.get_phone(ref)
    if not iv or not ed:
        raise RuntimeError("YYB getPhoneNumber 失败")
    j4 = http_json(MAPI + "/members/wechat_mini_program/wechat/login",
                   {"unique": uniq, "openid": "", "token": "", "device-no": "",
                    "apiVersion": "2.0", "appVersion": "10.12.83",
                    "nativeVersion": "10.12.80", "businessType": "HNYX",
                    "terminalId": "11", "channel": "big_frontend_hyg_weapp",
                    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "User-Agent": DEFAULT_UA, "Referer": REFERER},
                   {"iv": iv, "encryptedData": ed}, "POST", form=True)
    token = j4.get("token", "")
    if not token:
        raise RuntimeError("wechat/login 失败：%s" % j4)
    return {"token": token, "openid": openid, "unique": uniq,
            "saved_at": time.strftime("%Y-%m-%d %H:%M:%S")}


def base_headers(cred):
    return {"token": cred["token"], "openid": cred["openid"],
            "unique": cred["unique"], "device-no": cred["openid"],
            "Appkey": "850226", "apiVersion": "2.0",
            "channelType": "big_frontend_weapp", "terminalId": "11",
            "stockId": "6868", "warehouseId": "10", "subsiteId": "10",
            "User-Agent": DEFAULT_UA, "Referer": REFERER,
            "content-type": "application/json"}


def db_first(name):
    """青龙 task 注入失败时直读数据库兜底"""
    try:
        import sqlite3
        c = sqlite3.connect("/ql/data/db/database.sqlite", timeout=5)
        row = c.execute("select value from Envs where name=?", (name,)).fetchone()
        c.close()
        return (row[0] if row else "") or ""
    except Exception:
        return ""


def env_or_db(name, default=""):
    v = os.environ.get(name, "").strip()
    if v:
        return v
    v = db_first(name).strip()
    return v if v else default


def get_accounts():
    accs = []
    raw = env_or_db("CDF_ACCOUNTS")
    # ALL/AUTO：每次运行自动从 YYB 拉取全部在线账号
    if raw.strip().upper() in ("ALL", "AUTO"):
        try:
            j = Yyb().list_accounts()
            data = j.get("data") if isinstance(j, dict) else None
            items = (data.get("accounts") if isinstance(data, dict) else data) or data or []
            if isinstance(items, dict):
                items = items.get("accounts") or []
            alive = [a for a in items if (a.get("status") == "alive" and a.get("openid"))]
            log("[YYB] 自动发现在线账号 %d/%d 个" % (len(alive), len(items)))
            for a in alive:
                accs.append({"mode": "yyb", "ref": a["openid"],
                             "name": (a.get("alias") or a.get("nickname") or "").strip()})
        except Exception as e:
            log("[YYB] 拉取账号列表失败：%s" % e)
        return accs
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if "#" in line:
            parts = (line.split("#") + ["", ""])[:3]
            accs.append({"mode": "manual", "token": parts[0].strip(),
                         "openid": parts[1].strip(), "unique": parts[2].strip()})
        else:
            accs.append({"mode": "yyb", "ref": line})
    if not accs and os.environ.get("CDF_TOKEN"):
        accs.append({"mode": "manual",
                     "token": os.environ["CDF_TOKEN"].strip(),
                     "openid": os.environ.get("CDF_OPENID", "").strip(),
                     "unique": os.environ.get("CDF_UNIQUE", "").strip()})
    return accs


class Cdf(object):
    def __init__(self, acc, state):
        self.acc = acc
        self.state = state

    def cred(self, force=False):
        """取得可用凭据（yyb 模式带缓存 + 失效重登）"""
        if self.acc["mode"] == "manual":
            return {"token": self.acc["token"], "openid": self.acc["openid"],
                    "unique": self.acc["unique"]}
        ref = self.acc["ref"]
        if not force:
            cached = self.state.get(ref)
            if cached:
                return cached
        log("[登录] YYB 自动登录中（ref=%s...）..." % ref[:12])
        cred = cdf_login(ref)
        self.state[ref] = cred
        save_state(self.state)
        log("[登录] 成功，token=%s..." % cred["token"][:12])
        return cred

    def api(self, path, cred, method="GET", body=None):
        return http_json(path if path.startswith("http") else API + path,
                         base_headers(cred), body, method)

    def valid(self, cred):
        j = self.api("/api/inc/signin/baseInfo", cred)
        if j.get("code") == 0:
            return True
        log("[凭据] 失效：%s" % j.get("message"))
        return False

    def run(self):
        if self.acc["mode"] == "yyb":
            cred = self.cred()
            if not self.valid(cred):
                cred = self.cred(force=True)     # 失效自动重登
                if not self.valid(cred):
                    log("[账号] YYB 重登后仍不可用，跳过")
                    return None
        else:
            cred = self.cred()
            if not self.valid(cred):
                log("[账号] 手动凭据已失效，请重新抓包更新")
                return "expired"
        self.do_signin(cred)
        self.do_tasks(cred)
        bal = self.shell_balance(cred)
        log("当前贝壳余额：%s" % bal)
        return bal

    # ---------- 签到 ----------
    def do_signin(self, cred):
        j = self.api("/api/inc/signin/submit", cred)
        if j.get("code") == 0:
            prizes = []
            for it in (j.get("data") or []):
                p = it.get("prizeInfo", {})
                prizes.append("%s x%d" % (p.get("prizeName", "贝壳"),
                                          p.get("prizeNum", 1)))
            log("[签到] 成功：%s" % "，".join(prizes))
        else:
            msg = j.get("message", "")
            if "已签到" in msg or "重复" in msg:
                log("[签到] 今日已签到")
            else:
                log("[签到] 失败：%s" % msg)

    # ---------- 任务 ----------
    def do_tasks(self, cred):
        j = self.api("/api/inc/task/list?activityId=%s&activityEnv=%s"
                     % (ACTIVITY_ID, ACT_ENV), cred)
        tasks = j.get("data") or []
        if not tasks:
            log("[任务] 列表为空（%s %s）" % (j.get("code"), j.get("message")))
            return
        got = 0
        for t in tasks:
            name = t.get("taskName", "")
            tid = t.get("taskId", "")
            ttype = t.get("taskType", 0)
            finish, mx = t.get("finishNumber", 0), t.get("maxNumber", 1)
            status = t.get("status", 0)
            if status != 0 or finish >= mx:
                log("[任务] %s —— 已完成，跳过" % name)
                continue
            reward = (t.get("prizeInfo") or {}).get("rewardNumber", "?")
            if ttype == 2:
                # 浏览类：todo 拿 browseTaskId -> 等浏览时长 -> 上报完成 -> 领奖
                stop = t.get("taskTypeCnfInfo", {}).get("stopTime", 15)
                stop = min(int(stop or 15), 20)
                jt = self.api("/api/inc/task/todo?activityId=%s&taskId=%s"
                              % (ACTIVITY_ID, tid), cred)
                bid = (jt.get("data") or {}).get("browseTaskId")
                if not bid:
                    log("[任务] %s —— 获取 browseTaskId 失败：%s"
                        % (name, jt.get("message")))
                    continue
                log("[任务] %s —— 浏览 %d 秒..." % (name, stop))
                time.sleep(stop + 2)
                jb = self.api("/api/inc/task/browseTask?browseTaskId=%s&isFinish=1"
                              % bid, cred)
                if jb.get("code") != 0:
                    log("[任务] %s —— 上报浏览失败：%s" % (name, jb.get("message")))
                    continue
                time.sleep(1)
                jc = self.api("/api/inc/task/claimRewards?activityId=%s&taskId=%s"
                              % (ACTIVITY_ID, tid), cred)
                if jc.get("code") == 0 and jc.get("data"):
                    n = jc["data"].get("number", reward)
                    got += int(n or 0)
                    log("[任务] %s —— 领到贝壳 +%s" % (name, n))
                else:
                    log("[任务] %s —— 领奖失败：%s" % (name, jc.get("message")))
            elif ttype in (4, 6):
                log("[任务] %s —— 需要真实关注/分享，跳过（贝壳+%s）" % (name, reward))
            else:
                jc = self.api("/api/inc/task/claimRewards?activityId=%s&taskId=%s"
                              % (ACTIVITY_ID, tid), cred)
                if jc.get("code") == 0 and jc.get("data"):
                    n = jc["data"].get("number", 0)
                    got += int(n or 0)
                    log("[任务] %s —— 领到贝壳 +%s" % (name, n))
                else:
                    log("[任务] %s —— 类型%d 无法自动完成，跳过" % (name, ttype))
            time.sleep(2)
        log("[任务] 本轮共领贝壳 +%d" % got)

    def shell_balance(self, cred):
        j = self.api("/api/inc/welfareValueDesc/headerInfo?activityId=%s&activityEnv=%s"
                     % (ACTIVITY_ID, ACT_ENV), cred)
        d = j.get("data") or {}
        return d.get("welfareValue", "?")


def push(title, content):
    token = env_or_db("CDF_PUSH")
    if not token:
        return
    try:
        http_json("https://www.pushplus.plus/send",
                  {"content-type": "application/json"},
                  {"token": token, "title": title, "content": content,
                   "template": "txt"}, "POST")
    except Exception as e:
        log("[推送] 失败：%s" % e)


def main():
    accs = get_accounts()
    if not accs:
        log("未配置 CDF_ACCOUNTS，退出")
        sys.exit(1)
    log("共 %d 个账号" % len(accs))
    state = load_state()
    summary = []
    for i, acc in enumerate(accs, 1):
        log("===== 账号 %d %s=====" % (i, ("[%s] " % acc["name"]) if acc.get("name") else ""))
        c = Cdf(acc, state)
        try:
            r = c.run()
        except Exception as e:
            log("[账号 %d] 异常：%s" % (i, e))
            r = None
        if r == "expired":
            summary.append("账号%d：token失效，需重新抓包 ❌" % i)
        elif r is None:
            summary.append("账号%d：运行异常 ❌" % i)
        else:
            summary.append("账号%d：贝壳余额 %s" % (i, r))
        time.sleep(3)
    push("CDF中免签到", "\n".join(summary))


if __name__ == "__main__":
    main()
