#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QingLong - Football Penalty Game Auto Bot
Auto play + lottery, run daily
Uses YYB (172.17.0.1:18080) for WeChat auth to get token

Env:
  FOOTBALL_GAME_TOKEN   (可选，直接传 token 时跳过 YYB 流程)
  YYB_BASE_URL          (可选，默认 http://172.17.0.1:18080)
  YYB_REF               (可选，账号 ref，默认遍历所有账号)
  FOOTBALL_ACT           (可选，活动ID，默认 q5u06IxxQ0B9)
Cron: 0 8 * * *
"""

import requests, json, os, re, time

# ── 配置 ──────────────────────────────────────────────
BASE_URL = "https://rmt.hhl1916.com/act/game/api/footballGame"
GAME_ID = "202607001"
ACT_ID = os.environ.get("FOOTBALL_ACT", "q5u06IxxQ0B9")
APP_ID = "wxbe7126dd88a77df0"

YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
                  "MicroMessenger/8.0.38",
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json, text/plain, */*",
}


# ── YYB 接口 ──────────────────────────────────────────
def yyb_get(path, params=None):
    r = requests.get(YYB_BASE_URL + path, params=params, timeout=15)
    return r.json()


def yyb_post(path, data=None):
    r = requests.post(YYB_BASE_URL + path, json=data or {}, timeout=15)
    return r.json()


def yyb_list_accounts():
    resp = yyb_get("/accounts")
    return resp.get("data", []) or []


def yyb_get_wx_code(ref):
    resp = yyb_post("/wxapp/getCode", {"ref": str(ref), "app_id": APP_ID})
    data = resp.get("data", {})
    result = data.get("result", {})
    code = result.get("code", "")
    if not code:
        raise RuntimeError(f"YYB getCode failed: {resp}")
    return code


# ── 登录流程 ──────────────────────────────────────────
def get_rmt_user_id(code):
    url = "https://rmt.hhl1916.com/thirdparty/v1/wxLogin"
    params = {"act": ACT_ID, "code": code, "state": "hhl"}
    r = requests.get(url, params=params, allow_redirects=False, timeout=15)
    location = r.headers.get("Location", "")
    match = re.search(r"userId=([^&]+)", location)
    if not match:
        raise RuntimeError(f"wxLogin no userId: status={r.status_code} location={location}")
    return match.group(1)


def login_with_user_id(rmt_user_id):
    r = requests.post(
        "https://rmt.hhl1916.com/act/game/api/footballGame/login",
        json={"rmtUserId": rmt_user_id},
        headers={
            "User-Agent": HEADERS["User-Agent"],
            "Content-Type": "application/json;charset=UTF-8",
        },
        timeout=15,
    )
    data = r.json().get("data", {})
    token = data.get("token", "")
    name = data.get("customerName", "Unknown")
    if not token:
        raise RuntimeError(f"login no token: {r.text[:200]}")
    return token, name


def get_token_via_yyb(ref):
    code = yyb_get_wx_code(ref)
    rmt_user_id = get_rmt_user_id(code)
    token, name = login_with_user_id(rmt_user_id)
    return token, name


# ── 游戏 Bot ──────────────────────────────────────────
class Bot:
    def __init__(self, token):
        self.s = requests.Session()
        self.s.headers.update(HEADERS)
        self.token = token

    def post(self, path, data=None):
        r = self.s.post(BASE_URL + path, json=data or {},
                        headers={"Authorization": self.token}, timeout=15)
        return r.json()


def notify(title, content):
    print(f"\n[{title}]\n{content}")


def run_game(token, name):
    bot = Bot(token)
    print(f"\n{'='*50}")
    print(f"  User: {name}")
    print(f"{'='*50}")

    ui = bot.post("/getUserInfo", {"gameId": GAME_ID})
    d = ui.get("data", {})
    score = d.get("score", 0)
    surplus = d.get("surplusNum", 0)
    print(f"Score: {score}  |  Chances: {surplus}")

    while surplus < 1 and score >= 50:
        print("Buying 1 game chance (50 score)...")
        bot.post("/buy", {"buyNum": 1, "gameId": GAME_ID})
        ui = bot.post("/getUserInfo", {"gameId": GAME_ID})
        surplus = ui.get("data", {}).get("surplusNum", 0)
        score = ui.get("data", {}).get("score", 0)
        print(f"  Score: {score} | Chances: {surplus}")

    if surplus < 1:
        msg = f"No chances left, score={score}"
        print(f"SKIP: {msg}")
        notify("FootballGame", f"[{name}] {msg}")
        return

    print("Starting game...")
    bot.post("/startGame", {"gameId": GAME_ID})

    print("Submitting perfect game (5:0)...")
    score_data = json.dumps({
        "playerScore": 5, "aiScore": 0,
        "goals": 5, "saves": 5,
        "isPerfect": True, "isSuddenDeath": False
    })
    submit = bot.post("/gameRecord", {
        "gameId": GAME_ID,
        "scoreData": score_data,
        "result": 1, "isSuccess": True, "needLottery": True
    })
    luck_num = submit.get("data", {}).get("luckNum", 0)

    if luck_num < 1:
        notify("FootballGame", f"[{name}] Submit OK but no luck")
        return

    print(f"  Luck earned: {luck_num}")

    print("Drawing lottery...")
    lottery = bot.post("/lottery", {"type": 1})
    result = lottery.get("data", {})
    pt = result.get("prizeType")
    pn = result.get("prizeName", "N/A")

    result_text = f"User: {name}\nScore: {score}\n"
    if pt and pt != 0:
        result_text += f"WIN! Prize: {pn}"
    else:
        result_text += f"Result: {pn}"

    print(f"\n{'='*50}")
    print(f"  {'WIN!' if pt and pt != 0 else 'No luck'}  {pn}")
    print(f"{'='*50}")

    notify("FootballGame Result", result_text)
    print(f"\nResponse:\n{json.dumps(lottery, ensure_ascii=False, indent=2)}")


# ── 主入口 ──────────────────────────────────────────────
def main():
    print("=" * 50)
    print("  Football Penalty Game - Auto Bot")
    print("=" * 50)

    direct_token = os.environ.get("FOOTBALL_GAME_TOKEN")
    if direct_token:
        print("\n[Mode] Using FOOTBALL_GAME_TOKEN from env")
        run_game(direct_token, "EnvToken")
        return

    print("\n[Mode] Using YYB for auto login")
    ref = os.environ.get("YYB_REF")

    if ref:
        accounts = [{"ref": ref}]
    else:
        raw = yyb_list_accounts()
        accounts = []
        for acc in raw:
            accounts.append({
                "ref": str(acc.get("id", "")),
                "nickname": acc.get("nickname") or acc.get("alias") or "Unknown",
            })
        if not accounts:
            print("ERROR: No YYB accounts found")
            return
        print(f"Found {len(accounts)} YYB account(s)")

    for acc in accounts:
        ref = acc["ref"]
        nick = acc.get("nickname", ref)
        print(f"\n--- Processing account: {nick} (ref={ref}) ---")
        try:
            token, name = get_token_via_yyb(ref)
            print(f"  Token obtained: {token[:30]}...")
            run_game(token, name)
        except Exception as e:
            print(f"  ERROR: {e}")
            notify("FootballGame Error", f"[{nick}] {e}")
        finally:
            time.sleep(2)


if __name__ == "__main__":
    main()
