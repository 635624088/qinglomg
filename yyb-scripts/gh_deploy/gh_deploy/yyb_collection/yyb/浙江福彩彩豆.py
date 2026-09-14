#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
浙江福彩彩豆 签到+阅读+乐园 (YYB版)

入口: 微信公众号"浙江福彩"
功能: 签到 + 阅读文章 + 知识挑战赛 + 接福运

环境变量:
  YYB_BASE_URL  YYB 服务地址 (默认 http://172.17.0.1:18080)
  YYB_REF       指定账号 ref (可选，默认遍历所有账号)
"""

import json
import os
import random
import re
import sys
import time
from datetime import datetime
from typing import Dict, List, Optional

import requests

# ====== YYB 配置 ======
YYB_BASE = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "") or None
# ======================

# ====== 业务常量 ======
APP_NAME = "浙江福彩彩豆"
APPID = "wx1ad1780dde6b2260"
BASE_URL = "https://flcp.hy960.com"
READ_COUNT = 2
READ_ALL = True
SLEEP_MIN = 5
SLEEP_MAX = 10
QUESTION_BANK_FILE = "fucaifanzha_question_bank.json"
RECEIVE_GOOD_MAX_COUNT = 3
RECEIVE_GOOD_TARGET_SCORE = 251
RECEIVE_GOOD_COST_PER_EXTRA = 10
RECEIVE_GOOD_SLEEP_MIN = 5
RECEIVE_GOOD_SLEEP_MAX = 10
# ======================

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541843) XWEB/19339 Flue"
)


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"[✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    payload = {"ref": ref, "app_id": APPID}
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


# ====== 异常类 ======
class ApiBizError(Exception):
    def __init__(self, path: str, code: int, msg: str):
        self.path = path
        self.code = code
        self.msg = msg
        super().__init__(f"接口异常 {path}: code={code} msg={msg}")


class SessionExpiredError(Exception):
    """flcpSession 过期"""
    pass


# ====== OAuth 登录 ======
def oauth_login(base_url: str, oauth_code: str) -> Optional[str]:
    """用 OAuth code 调用 /oauth/mp 登录，返回 flcpSession"""
    try:
        callback_url = f"{base_url}/oauth/mp"
        params = {
            "back_url": f"{base_url}/user/#/",
            "code": oauth_code,
            "state": "",
        }
        headers = {"User-Agent": DEFAULT_UA}
        resp = requests.get(callback_url, params=params, headers=headers, timeout=20, allow_redirects=False)
        if resp.status_code not in (301, 302):
            print(f"    [✗] OAuth 回调返回 {resp.status_code}")
            return None
        for h_val in resp.headers.get("Set-Cookie", "").split(","):
            h_val = h_val.strip()
            if "flcpSession=" in h_val:
                match = re.search(r'flcpSession=([^;]+)', h_val)
                if match:
                    return match.group(1)
        return None
    except Exception as exc:
        print(f"    [✗] OAuth 登录异常: {exc}")
        return None


# ====== FlcpClient ======
class FlcpClient:
    def __init__(self, base_url: str, cookie: str, user_agent: str):
        self.base_url = base_url.rstrip("/")
        self.cookie = cookie
        self.user_agent = user_agent
        self.referer = f"{self.base_url}/user/"
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": user_agent,
            "Referer": self.referer,
            "Origin": self.base_url,
            "Cookie": cookie,
        })

    def _request(self, method: str, path: str, **kwargs) -> Dict:
        url = f"{self.base_url}{path}"
        resp = self.session.request(method, url, timeout=20, **kwargs)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 200:
            raise ApiBizError(path=path, code=data.get("code"), msg=str(data.get("msg") or data.get("message")))
        return data

    def _games_request(self, method: str, path: str, referer: str, json_body: Optional[Dict] = None) -> Dict:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": self.user_agent,
            "Origin": self.base_url,
            "Referer": referer,
            "Cookie": self.cookie,
        }
        url = f"{self.base_url}/games-api{path}"
        resp = self.session.request(method, url, headers=headers, json=json_body, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 200:
            raise ApiBizError(path=f"/games-api{path}", code=data.get("code"), msg=str(data.get("msg") or data.get("message")))
        return data

    # 常规任务
    def member_data(self) -> Dict:
        return self._request("GET", "/api/user/member-data")

    def checkin(self) -> Dict:
        return self._request("POST", "/api/user/checkin")

    def reading_list(self) -> List[Dict]:
        ts = str(int(time.time() * 1000))
        data = self._request("GET", "/api/reading-article/list", params={"t": ts})
        return data.get("data", {}).get("list", [])

    def reading_score(self, article_id: int) -> Dict:
        return self._request("POST", "/api/reading-article/article-score", json={"id": article_id})

    # 乐园任务
    def fanzha_start(self) -> Dict:
        return self._games_request("POST", "/fucaifanzha/start", referer=f"{self.base_url}/games/fucaifanzha/")

    def fanzha_end(self, score: int) -> Dict:
        return self._games_request("POST", "/fucaifanzha/end", referer=f"{self.base_url}/games/fucaifanzha/", json_body={"score": score})

    def receive_good_start(self) -> Dict:
        return self._games_request("POST", "/receive-good/start", referer=f"{self.base_url}/games/jfy20251208/")

    def receive_good_end(self, code: str, score: int) -> Dict:
        return self._games_request("POST", "/receive-good/end", referer=f"{self.base_url}/games/jfy20251208/", json_body={"code": code, "result": {"score": score}})

    def receive_good_index(self) -> Dict:
        return self._games_request("GET", "/receive-good/getIndexData", referer=f"{self.base_url}/games/jfy20251208/")


# ====== 题库 ======
def load_question_bank(path: str) -> Dict[str, Dict]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_question_bank(path: str, bank: Dict[str, Dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(bank, f, ensure_ascii=False, indent=2)


def normalize_question_item(item: Dict) -> Dict:
    return {
        "question": item.get("question", ""),
        "type": item.get("type"),
        "A": item.get("A"), "B": item.get("B"),
        "C": item.get("C"), "D": item.get("D"),
        "answer": item.get("answer"),
        "suggest": item.get("suggest"),
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def valid_answer(ans: str, item: Dict) -> bool:
    if ans not in ("A", "B", "C", "D"):
        return False
    if ans in ("C", "D") and item.get("type") != 1:
        return False
    return True


# ====== 业务任务 ======
def run_regular_tasks(client: FlcpClient) -> Dict:
    print("  [流程] 开始常规任务：签到 + 阅读")

    before = client.member_data().get("data", {})
    before_score = before.get("user", {}).get("score")
    print(f"  [信息] 当前彩豆: {before_score}, 今日已签到: {before.get('isChecked')}")

    if before.get("isChecked") is True:
        print("  [签到] 今天已经签过到了，跳过。")
    else:
        result = client.checkin()
        print(f"  [签到] {result.get('msg', '完成')}")

    limit_hit = False
    articles = client.reading_list()
    unread = [a for a in articles if not a.get("isRead")]

    if not unread:
        print("  [阅读] 没有可读文章，跳过。")
    else:
        targets = unread if READ_ALL else unread[:READ_COUNT]
        print(f"  [阅读] 准备提交 {len(targets)} 篇阅读任务，间隔随机 {SLEEP_MIN}-{SLEEP_MAX} 秒。")
        for idx, article in enumerate(targets, start=1):
            aid = int(article["id"])
            title = article.get("title", "")
            try:
                res = client.reading_score(aid)
                print(f"  [阅读 {idx}] id={aid} 标题={title[:20]}... -> {res.get('msg', '完成')}")
            except ApiBizError as exc:
                if "上限" in exc.msg:
                    limit_hit = True
                    print(f"  [阅读] 命中当日上限（{exc.msg}），阅读任务结束。")
                    break
                raise
            if idx != len(targets):
                wait_sec = random.uniform(SLEEP_MIN, SLEEP_MAX)
                print(f"  [阅读] 等待 {wait_sec:.2f} 秒后继续...")
                time.sleep(wait_sec)

    return {"before": before_score, "limit_hit": limit_hit}


def run_fanzha_task(client: FlcpClient) -> Dict:
    print("  [流程] 开始乐园任务：知识挑战赛")
    bank = load_question_bank(QUESTION_BANK_FILE)

    start_data = client.fanzha_start().get("data", {})
    questions = start_data.get("list") or []
    if not questions:
        return {"message": "知识挑战赛未获取到题目", "question_count": 0, "used_local": 0}

    selected_answers: List[str] = []
    right_answers: List[str] = []
    used_local = 0

    for q in questions:
        q_text = (q.get("question") or "").strip()
        if not q_text:
            continue
        local = bank.get(q_text, {}) if isinstance(bank.get(q_text), dict) else {}
        local_ans = local.get("answer")
        server_ans = q.get("answer")

        if local_ans and valid_answer(local_ans, q):
            chosen = local_ans
            used_local += 1
        elif server_ans and valid_answer(server_ans, q):
            chosen = server_ans
        else:
            chosen = "A"

        if server_ans and chosen != server_ans:
            chosen = server_ans

        selected_answers.append(chosen)
        right_answers.append(server_ans or "")
        bank[q_text] = normalize_question_item(q)

    save_question_bank(QUESTION_BANK_FILE, bank)

    selected = "".join(selected_answers)
    right = "".join(right_answers)

    if selected and selected == right:
        try:
            end_resp = client.fanzha_end(score=100)
            msg = str(end_resp.get("message") or end_resp.get("msg") or "知识挑战赛结算完成")
        except ApiBizError as exc:
            msg = f"知识挑战赛结算提示: {exc.msg}"
    else:
        msg = "知识挑战赛未全对，跳过领奖"

    return {"message": msg, "question_count": len(questions), "used_local": used_local}


def run_receive_good_task(client: FlcpClient) -> Dict:
    print("  [流程] 开始乐园任务：接福运")
    messages: List[str] = []
    success_times = 0
    try:
        idx_data = client.receive_good_index().get("data", {})
        current_count = int(idx_data.get("count") or 0)
        current_score = int(idx_data.get("score") or 0)
    except Exception:
        current_count = 0
        current_score = 0

    messages.append(f"初始次数={current_count}, 初始彩豆={current_score}")

    while current_count < RECEIVE_GOOD_MAX_COUNT:
        next_round = current_count + 1
        if next_round >= 2 and current_score < RECEIVE_GOOD_COST_PER_EXTRA:
            messages.append(f"第{next_round}次需{RECEIVE_GOOD_COST_PER_EXTRA}彩豆，余额不足，停止")
            break

        try:
            start_data = client.receive_good_start().get("data", {})
            code = start_data.get("code")
            if not code:
                messages.append(f"第{next_round}次未拿到code，停止")
                break

            end_data = client.receive_good_end(code=code, score=RECEIVE_GOOD_TARGET_SCORE).get("data", {})
            current_count = int(end_data.get("count") or current_count + 1)
            success_times += 1
            messages.append(f"第{next_round}次提交{RECEIVE_GOOD_TARGET_SCORE}分成功，当前次数={current_count}")

            try:
                idx_data = client.receive_good_index().get("data", {})
                current_score = int(idx_data.get("score") or current_score)
            except Exception:
                pass

        except ApiBizError as exc:
            messages.append(f"第{next_round}次提示: {exc.msg}")
            if any(k in exc.msg for k in ("上限", "已达", "已领取", "不足")):
                break
            break

        if current_count < RECEIVE_GOOD_MAX_COUNT:
            wait_sec = random.uniform(RECEIVE_GOOD_SLEEP_MIN, RECEIVE_GOOD_SLEEP_MAX)
            print(f"  [接福运] 第{next_round}次完成，等待 {wait_sec:.2f} 秒后继续...")
            time.sleep(wait_sec)

    return {"message": "；".join(messages), "success_times": success_times, "final_count": current_count}


# ====== 主流程 ======
def process_account(account, account_index: int, account_total: int):
    ref = str(account.get("id", ""))
    nickname = account.get("nickname", "未知")
    openid = account.get("openid", "")
    display_name = nickname or openid[:16]

    print(f"\n  📱 账号: {display_name}")

    # 1. 获取 wx.login code
    print(f"  [1/3] 获取 wx.login code...")
    code = yyb_get_code(ref)
    if not code:
        print("  [✗] 获取 code 失败，跳过")
        return {"status": "failed", "reason": "getCode失败"}

    # 2. OAuth 登录获取 flcpSession
    print(f"  [2/3] OAuth 登录...")
    flcp_session = oauth_login(BASE_URL, code)
    if not flcp_session:
        print("  [✗] OAuth 登录失败，跳过")
        return {"status": "failed", "reason": "OAuth登录失败"}

    cookie = f"flcpSession={flcp_session}"
    print(f"  [✓] 登录成功")

    # 3. 执行任务
    print(f"  [3/3] 执行任务...")
    client = FlcpClient(base_url=BASE_URL, cookie=cookie, user_agent=DEFAULT_UA)

    regular = run_regular_tasks(client)
    fanzha = run_fanzha_task(client)
    receive = run_receive_good_task(client)

    after = client.member_data().get("data", {})
    after_score = after.get("user", {}).get("score")
    print(f"  [结果] 当前彩豆: {after_score}, 今日已签到: {after.get('isChecked')}, 连续签到: {after.get('continueDay')}")

    before_score = regular.get("before")
    delta = None
    if isinstance(before_score, (int, float)) and isinstance(after_score, (int, float)):
        delta = after_score - before_score
        print(f"  [汇总] 任务前彩豆: {before_score} | 任务后彩豆: {after_score} | 本次增加: {delta}")

    tag = "阅读上限" if regular.get("limit_hit") else "正常"
    print(f"  [知识挑战赛] 题目数: {fanzha.get('question_count')} | 本地命中: {fanzha.get('used_local')} | {fanzha.get('message')}")
    print(f"  [接福运] {receive.get('message')}")

    return {
        "status": "success",
        "before": before_score,
        "after": after_score,
        "delta": delta,
        "tag": tag,
        "fanzha": fanzha,
        "receive": receive,
    }


def main():
    print("=" * 56)
    print(f"  {APP_NAME} 签到+阅读+乐园 (YYB版)")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 56)

    accounts = yyb_get_accounts()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        return

    if YYB_REF:
        accounts = [a for a in accounts if str(a.get("id")) == YYB_REF or a.get("openid") == YYB_REF]
        if not accounts:
            print(f"[✗] 未找到指定账号: {YYB_REF}")
            return

    success = 0
    failed = 0
    lines: List[str] = [f"{APP_NAME} 签到+阅读+乐园", f"账号总数: {len(accounts)}", "-"]

    for i, account in enumerate(accounts, 1):
        print(f"[{i}/{len(accounts)}] {'=' * 40}")
        try:
            result = process_account(account, i, len(accounts))
            if result.get("status") == "success":
                success += 1
                lines.append(f"账号{i}: 前{result.get('before')} 后{result.get('after')} 增加{result.get('delta')} ({result.get('tag')})")
            else:
                failed += 1
                lines.append(f"账号{i}: 失败 {result.get('reason')}")
        except Exception as e:
            failed += 1
            print(f"  [✗] 账号执行异常: {e}")
            lines.append(f"账号{i}: 异常 {e}")

        if i < len(accounts):
            time.sleep(2)

    print(f"\n{'=' * 56}")
    print(f"[📊] 总账号数: {len(accounts)} | 成功: {success} | 失败: {failed}")
    lines.append("-")
    lines.append(f"成功: {success} 失败: {failed}")

    print("全部任务执行完毕!")


if __name__ == "__main__":
    main()
