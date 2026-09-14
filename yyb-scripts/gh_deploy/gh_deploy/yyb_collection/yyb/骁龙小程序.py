#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""骁友会日常任务自动完成脚本 (YYB 版)"""


import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import requests

YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = ""
QUALCOMM_APPID = "wx026c06df6adc5d06"
API_ROOT = "https://qualcomm.boysup.cn/qualcomm-app"

ENABLE_BURY_POINT = True
SKIP_LONG_TASKS = False
QUESTION_DB_PATH = Path(__file__).parent / "question_db.json"

class QuestionDB:
    """{question_text: {answerNo, answer, correct_count, wrong_count, last_seen}}"""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.data: dict = self._load()

    def _load(self) -> dict:
        if self.db_path.exists():
            try:
                with open(self.db_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                return {}
        return {}

    def _save(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.db_path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    def get_answer(self, question_text: str) -> str | None:
        """返回本地记录的正确答案 answerNo，没有则返回 None"""
        record = self.data.get(question_text)
        if record and record.get("correct_count", 0) > record.get("wrong_count", 0):
            return record["answerNo"]
        return None

    def record_correct(self, question_text: str, answer_no: str, answer_text: str):
        """记录正确答案"""
        if question_text not in self.data:
            self.data[question_text] = {
                "answerNo": answer_no,
                "answer": answer_text,
                "correct_count": 0,
                "wrong_count": 0,
                "last_seen": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
        self.data[question_text]["correct_count"] = self.data[question_text].get("correct_count", 0) + 1
        self.data[question_text]["last_seen"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self._save()

    def record_wrong(self, question_text: str, answer_no: str, answer_text: str):
        """记录答错的答案"""
        if question_text not in self.data:
            self.data[question_text] = {
                "answerNo": answer_no,
                "answer": answer_text,
                "correct_count": 0,
                "wrong_count": 0,
                "last_seen": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
        self.data[question_text]["wrong_count"] = self.data[question_text].get("wrong_count", 0) + 1
        self.data[question_text]["last_seen"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self._save()

    def get_all_questions(self) -> dict:
        """返回所有题目记录"""
        return self.data

class YYBClient:
    """YYB 平台客户端"""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def _get(self, path: str, params: dict = None) -> dict:
        resp = requests.get(f"{self.base_url}{path}", params=params, timeout=15)
        return resp.json()

    def _post(self, path: str, data: dict = None) -> dict:
        resp = requests.post(f"{self.base_url}{path}", json=data, timeout=15)
        return resp.json()

    def health(self) -> bool:
        data = self._get("/health")
        return data.get("data", {}).get("ok", False)

    def list_accounts(self) -> list:
        data = self._get("/accounts")
        return data.get("data", [])

    def refresh_account(self, ref: str) -> dict:
        data = self._post("/accounts/refresh", {"ref": ref})
        return data.get("data")

    def get_wxapp_code(self, ref: str, app_id: str) -> str:
        data = self._post("/wxapp/getCode", {"ref": ref, "app_id": app_id})
        result = data.get("data", {}).get("result", {})
        return result.get("code", "")

def join_json(params: dict) -> str:
    """URL 编码参数拼接 (与小程序 joinJson 一致)"""
    if not params:
        return ""
    parts = []
    for key, value in params.items():
        if value is not None:
            parts.append(f"{key}={quote(str(value), safe='')}")
    return "&".join(parts)

def generate_request_id() -> str:
    return uuid.uuid4().hex

def generate_sign(params: dict, request_id: str, timestamp: int) -> str:
    return hashlib.md5((join_json(params) + request_id + str(timestamp)).encode("utf-8")).hexdigest()

class QualcommClient:
    """骁友会 API 客户端"""

    HEADERS_BASE = {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781"
                      "(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF "
                      "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541b35) XWEB/20089",
        "Referer": "https://servicewechat.com/wx026c06df6adc5d06/701/page-frame.html",
    }

    def __init__(self, open_id: str, user_id: str, session_key: str, refresh_callback=None, question_db: QuestionDB = None):
        self.open_id = open_id
        self.user_id = user_id
        self.session_key = session_key
        self.refresh_callback = refresh_callback  # 登录过期时调用: () -> (open_id, user_id, session_key)
        self.question_db = question_db

    def _build_headers(self, params: dict = None) -> dict:
        timestamp = int(time.time() * 1000)
        request_id = generate_request_id()
        sign = generate_sign(params or {}, request_id, timestamp)
        return {
            **self.HEADERS_BASE,
            "openId": self.open_id,
            "userId": self.user_id,
            "sessionKey": self.session_key,
            "timestamp": str(timestamp),
            "requestId": request_id,
            "sign": sign,
        }

    def _request(self, method: str, path: str, params: dict = None) -> dict:
        """带自动刷新 session 的请求"""
        url = f"{API_ROOT}{path}"
        for attempt in range(2):
            headers = self._build_headers(params or {})
            if method == "GET":
                resp = requests.get(url, params=params, headers=headers, timeout=15)
            else:
                resp = requests.post(url, data=params, headers=headers, timeout=15)
            data = resp.json()

            if data.get("code") == 40001 and self.refresh_callback and attempt == 0:
                old_sk = self.session_key
                result = self.refresh_callback()
                if result and result[2] != old_sk:
                    self.open_id, self.user_id, self.session_key = result
                    continue
                elif result:
                    pass
            return data
        return data

    def _get(self, path: str, params: dict = None) -> dict:
        return self._request("GET", path, params)

    def _post(self, path: str, params: dict = None) -> dict:
        return self._request("POST", path, params)

    def bury_point(self, event_name: str, **kwargs):
        """上报埋点事件"""
        if not ENABLE_BURY_POINT:
            return
        params = {
            "userId": self.user_id,
            "openId": self.open_id,
            "isWifi": "1",
            "model": "microsoft",
            "manufacturer": "microsoft",
            "scene": "1256",
            "eventNameEn": event_name,
        }
        params.update(kwargs)
        try:
            self._post("/api/buryPointApp/save", params)
        except Exception:
            pass

    @staticmethod
    def login_with_code(code: str) -> dict:
        ts = int(time.time() * 1000)
        rid = generate_request_id()
        params = {"code": code}
        sign = generate_sign(params, rid, ts)
        headers = {
            **QualcommClient.HEADERS_BASE,
            "openId": "",
            "userId": "0",
            "sessionKey": "",
            "timestamp": str(ts),
            "requestId": rid,
            "sign": sign,
            "Referer": "https://servicewechat.com/wx026c06df6adc5d06/701/page-frame.html",
        }
        resp = requests.post(
            f"{API_ROOT}/api/user/getOpenId",
            data=params,
            headers=headers,
            timeout=15,
        )
        data = resp.json()
        if data.get("code") == 200:
            result = data.get("data", {})
            if "userInfo" in result:
                user_info = result["userInfo"]
                user_info["openId"] = result.get("openId", user_info.get("openId", ""))
                user_info["sessionKey"] = result.get("sessionKey", user_info.get("sessionKey", ""))
                return user_info
            return result
        return {}

    def get_user_info(self) -> dict:
        data = self._get("/api/user/info", {"userId": self.user_id})
        if data.get("code") == 200:
            return data.get("data", {})
        return {}

    def get_daily_tasks(self) -> list:
        data = self._get("/api/home/taskDaily", {"userId": self.user_id})
        if data.get("code") == 200:
            return data.get("data", [])
        return []

    def get_newuser_tasks(self) -> list:
        data = self._get("/api/home/taskNewUser", {"userId": self.user_id})
        if data.get("code") == 200:
            return data.get("data", [])
        return []

    def get_activity_tasks(self) -> list:
        data = self._get("/api/home/taskActivity", {"userId": self.user_id})
        if data.get("code") == 200:
            return data.get("data", [])
        return []

    def get_sign_list(self) -> dict:
        data = self._get("/api/user/signList", {"userId": self.user_id})
        if data.get("code") == 200:
            return data.get("data", {})
        return {}

    def sign_in(self) -> bool:
        sign_list = self.get_sign_list()
        if sign_list.get("isSignToday") == 1:
            print(f"  ⏭️  今日已签到，跳过")
            return True
        data = self._get("/api/user/signIn", {"userId": self.user_id})
        if data.get("code") == 200:
            result = data.get("data", {})
            if result.get("state") == 1:
                print(f"  ✅ 签到成功！获得芯动值 +{result.get('coreCoin', 10)}")
                self.bury_point("MPClick", elementName="任务中心_今日签到", stallsName="任务中心_今日签到")
                return True
        if data.get("code") == 40001:
            print(f"  ⏭️  签到接口返回登录过期（可能今日已签到）")
            return True
        return False

    def luck_draw(self) -> bool:
        list_data = self._get("/api/luckDraw/list", {"userId": self.user_id, "activityId": "7"})
        if list_data.get("code") != 200:
            print(f"  ⚠️  获取抽奖列表失败: {list_data.get('message', '')}")
            return False
        draw_info = list_data.get("data", {})
        free_count = draw_info.get("freeCountDay", 0)
        luck_count = draw_info.get("luckDrawCount", 0)
        sum_count = draw_info.get("luckDrawSumCount", 0)
        print(f"  ℹ️  免费次数: {free_count}, 已抽: {sum_count - luck_count}/{sum_count}")
        if free_count <= 0:
            print(f"  ⏭️  今日已抽过奖")
            return True
        self.bury_point("MPClick", elementName="点击抽奖", activityId="7", activitySource="Xcx_MeiRiRenWu")
        self._post("/api/activity/rules", {"activityId": "7"})
        result = self._post("/api/luckDraw/getLuck", {"userId": self.user_id, "activityId": "7"})
        if result.get("code") == 200:
            prize = result.get("data", {}).get("name", "未知")
            print(f"  ✅ 抽奖成功！获得: {prize}")
            return True
        if result.get("code") == 1:
            print(f"  ⏭️  抽奖暂不可用: {result.get('message', '')} (data={result.get('data', '')})")
            return True
        print(f"  ❌ 抽奖失败: {result.get('message', '')} (code={result.get('code')})")
        return False

    def like_article(self) -> bool:
        articles = self._get("/api/home/articles", {
            "page": "1", "size": "20",
            "userId": self.user_id, "type": "0",
            "articleShowPlace": "骁友资讯列表页"
        })
        article_list = articles.get("data", {}).get("articleList", [])
        target = next((a for a in article_list if a.get("isLike") == 0), None)
        if not target:
            print("  ⏭️  所有文章都已点赞")
            return True
        aid = target["id"]
        print(f"  ℹ️  点赞: {target.get('title', '未知')}")
        self.bury_point("MPClick", elementName="文章详情页_点赞点击", stallsName="文章详情页_点赞点击",
                        urlQuery=json.dumps({"id": str(aid), "channel": "Xcx_ShouYeShortCut"}),
                        urlPath="pages/article-details/index", urlName="文章详情页")
        result = self._get("/api/article/like", {"articleId": str(aid), "userId": self.user_id})
        if result.get("code") == 200:
            print("  ✅ 点赞成功！")
            return True
        return False

    def answer_question(self) -> bool:
        detail = self._post("/api/interactQuestion/detail", {"userId": self.user_id})
        if detail.get("code") != 200:
            return False
        qdata = detail.get("data", {})
        if qdata.get("state") == 1:
            print("  ✅ 今日已答题闯关成功！")
            return True
        question = qdata.get("question", {})
        if not question:
            return False
        qid = question.get("id")
        question_text = question.get("question", "未知")
        answers = question.get("answers", [])
        print(f"  ℹ️  题目: {question_text}")
        for ans in answers:
            print(f"     选项 {ans['answerNo']}: {ans['answer']}")

        # 优先查本地数据库
        if self.question_db:
            cached = self.question_db.get_answer(question_text)
            if cached:
                print(f"  📖 本地记录命中，直接选答案: {cached}")
                result = self._post("/api/interactQuestion/answerOne", {
                    "questionId": qid, "answer": cached, "userId": self.user_id
                })
                if result.get("code") == 200 and result.get("data", {}).get("isCorrect") == 1:
                    print("  ✅ 回答正确！")
                    self.question_db.record_correct(question_text, cached,
                                                     next((a["answer"] for a in answers if a["answerNo"] == cached), cached))
                    if result.get("data", {}).get("state") == 1:
                        print("  🎉 闯关成功！")
                        self._post("/api/interactQuestion/subCoreCoin", {"userId": self.user_id})
                    return True
                else:
                    print(f"  ❌ 本地记录失效，回答错误，重新尝试...")
                    self.question_db.record_wrong(question_text, cached,
                                                   next((a["answer"] for a in answers if a["answerNo"] == cached), cached))

        # 有「以上都是」选项则优先选择
        all_above = [a for a in answers if "以上都是" in a.get("answer", "")]
        if all_above:
            chosen = all_above[0]["answerNo"]
            print(f"  🤖 检测到「以上都是」选项，优先选择: {chosen}")
            result = self._post("/api/interactQuestion/answerOne", {
                "questionId": qid, "answer": chosen, "userId": self.user_id
            })
            if result.get("code") == 200 and result.get("data", {}).get("isCorrect") == 1:
                print("  ✅ 回答正确！")
                if self.question_db:
                    self.question_db.record_correct(question_text, chosen, all_above[0]["answer"])
                if result.get("data", {}).get("state") == 1:
                    print("  🎉 闯关成功！")
                    self._post("/api/interactQuestion/subCoreCoin", {"userId": self.user_id})
                return True
            print("  ❌ 「以上都是」回答错误")
            if self.question_db:
                self.question_db.record_wrong(question_text, chosen, all_above[0]["answer"])

        # 排除本地已知错误答案后逐个尝试
        wrong_answers = set()
        if self.question_db:
            q_record = self.question_db.data.get(question_text, {})
            if q_record.get("wrong_count", 0) > q_record.get("correct_count", 0):
                wrong_answers.add(q_record["answerNo"])

        for ans in answers:
            chosen = ans["answerNo"]
            if chosen in wrong_answers:
                print(f"  ⏭️  跳过已知错误答案: {chosen}")
                continue
            print(f"  🤖 尝试答案: {chosen}")
            result = self._post("/api/interactQuestion/answerOne", {
                "questionId": qid, "answer": chosen, "userId": self.user_id
            })
            if result.get("code") == 200 and result.get("data", {}).get("isCorrect") == 1:
                print("  ✅ 回答正确！")
                if self.question_db:
                    self.question_db.record_correct(question_text, chosen, ans["answer"])
                if result.get("data", {}).get("state") == 1:
                    print("  🎉 闯关成功！")
                    self._post("/api/interactQuestion/subCoreCoin", {"userId": self.user_id})
                return True
            print("  ❌ 回答错误")
            if self.question_db:
                self.question_db.record_wrong(question_text, chosen, ans["answer"])
        return False

    def read_article(self) -> bool:
        articles = self._get("/api/home/articles", {
            "page": "1", "size": "20",
            "userId": self.user_id, "type": "0",
            "articleShowPlace": "骁友资讯列表页"
        })
        article_list = articles.get("data", {}).get("articleList", [])
        if not article_list:
            return False
        target = article_list[0]
        aid = target["id"]
        print(f"  ℹ️  阅读: {target.get('title', '未知')}")
        self.bury_point("MPViewScreen",
                        urlQuery=json.dumps({"id": str(aid), "channel": "Xcx_ShouYeShortCut"}),
                        urlPath="pages/article-details/index", urlName="文章详情页")
        self.bury_point("MPViewArticle", articleTitle=target.get("title", ""), articleTime="0",
                        urlQuery=json.dumps({"id": str(aid), "channel": "Xcx_ShouYeShortCut"}),
                        urlPath="pages/article-details/index", urlName="文章详情页")
        self._post("/api/article/enterReadDaily", {"articleId": str(aid), "userId": self.user_id})
        print("  📖 阅读中，等待 5 分钟...")
        for minute in range(1, 6):
            time.sleep(60)
            self.bury_point("MPViewScreen", viewTime=str(minute),
                            urlQuery=json.dumps({"id": str(aid), "channel": "Xcx_ShouYeShortCut"}),
                            urlPath="pages/article-details/index", urlName="文章详情页")
            print(f"    {minute}/5 分钟")
        self._post("/api/article/exitReadDaily", {"articleId": str(aid), "userId": self.user_id})
        print("  ✅ 阅读完成！")
        return True

    def watch_vlog(self) -> bool:
        vlog_data = self._get("/api/article/vlogList", {
            "page": "1", "size": "20", "userId": self.user_id, "sortBy": "1"
        })
        vlogs = vlog_data.get("data", {}).get("records", [])
        if not vlogs:
            return False
        target = vlogs[0]
        aid = target["id"]
        print(f"  ℹ️  观看: {target.get('title', '未知')}")
        self.bury_point("MPViewScreen",
                        urlQuery=json.dumps({"id": str(aid), "channel": "Xcx_MeiRiRenWu"}),
                        urlPath="pages/vlog/detail", urlName="骁友vlog_详情页",
                        activitySource="Xcx_MeiRiRenWu")
        self._post("/api/article/enterReadDaily", {"articleId": str(aid), "userId": self.user_id})
        print("  📺 观看中，等待 1 分钟...")
        time.sleep(70)
        self._post("/api/article/exitReadDaily", {"articleId": str(aid), "userId": self.user_id})
        print("  ✅ 观看完成！")
        return True

    def newuser_level_privilege(self) -> bool:
        result = self._post("/api/home/doTaskReadLevelPrivilege", {"userId": self.user_id})
        if result.get("code") == 200:
            print("  ✅ 了解等级权益完成！+20")
            return True
        return False

    def newuser_join_activity(self) -> bool:
        self.bury_point("MPViewScreen", urlPath="pages/activity-list/index",
                        urlName="活动列表页", activitySource="Xcx_XinShouRenWu")
        self._post("/api/home/channelConfig", {"channel": "Xcx_XinShouRenWu"})
        activity_list = self._post("/api/home/listByTypeNew", {
            "page": "1", "size": "10", "userId": self.user_id,
            "type": "1", "selectLikeState": "true"
        })
        records = activity_list.get("data", {}).get("records", [])
        if records:
            print(f"  ℹ️  浏览活动: {records[0].get('title', '未知')}")
        print("  ✅ 参与活动完成！+30")
        return True

    def newuser_subscribe_exchange(self) -> bool:
        result = self._post("/api/home/doTaskSubscribeExchange", {"userId": self.user_id})
        if result.get("code") == 200:
            print("  ✅ 订阅芯动值兑换完成！+30")
            return True
        return False

    def evaluation_report(self) -> bool:
        task_state = self._post("/api/evaluation/taskState", {"userId": self.user_id})
        if task_state.get("data", {}).get("finished", False):
            print("  ✅ 评测任务已完成！")
            return True
        self.bury_point("MPViewScreen", urlPath="packageEvaluation/pages/index/index",
                        urlName="先享体验计划首页", activitySource="Xcx_HuoDongRenWu")
        self._post("/api/evaluation/home", {"userId": self.user_id})
        report_list = self._post("/api/evaluationReport/page", {
            "userId": self.user_id, "page": "1", "reportType": "0",
            "size": "10", "productBrand": "0", "productType": "0", "evaluationId": ""
        })
        records = report_list.get("data", {}).get("records", [])
        if records:
            print(f"  ℹ️  浏览报告: {records[0].get('title', '未知')}")
        result = self._post("/api/evaluation/doTask", {"userId": self.user_id})
        if result.get("code") == 200:
            print("  ✅ 评测任务完成！+5")
            return True
        return False

def login_qualcomm(yyb: YYBClient, account: dict, question_db: QuestionDB = None) -> QualcommClient | None:
    openid = account["openid"]
    nickname = account.get("nickname", "未知")
    alias = account.get("alias", "")

    def do_login() -> tuple | None:
        code = yyb.get_wxapp_code(openid, QUALCOMM_APPID)
        if not code:
            print(f"  ❌ 获取小程序 code 失败")
            return None
        login_data = QualcommClient.login_with_code(code)
        if not login_data:
            print(f"  ❌ 登录骁友会失败")
            return None
        sk = login_data.get("sessionKey", "")
        qo = login_data.get("openId", "")
        qu = str(login_data.get("id", "0"))
        if not sk or not qo:
            print(f"  ❌ 登录返回数据不完整")
            return None
        return (qo, qu, sk)

    print(f"\n  🔑 正在登录骁友会...")
    result = do_login()
    if not result:
        return None

    q_openid, q_userid, q_sessionkey = result
    

    def refresh():
        print(f"  🔄 自动刷新 session...")
        r = do_login()
        if r:
            print(f"  ✅ session 刷新成功")
        return r

    return QualcommClient(q_openid, q_userid, q_sessionkey, refresh_callback=refresh,
                          question_db=question_db)

def process_account(yyb: YYBClient, account: dict, question_db: QuestionDB = None):
    openid = account["openid"]
    nickname = account.get("nickname", "未知")
    alias = account.get("alias", "")

    display_name = f"{nickname}({alias})" if alias else nickname
    print(f"\n{'=' * 60}")
    print(f"  👤 账号: {display_name}")
    print(f"  📱 openId: {openid}")
    print(f"{'=' * 60}")

    print(f"\n  🔄 刷新账号状态...")
    yyb.refresh_account(openid)

    qc = login_qualcomm(yyb, account, question_db)
    if not qc:
        print(f"  ❌ 账号 {display_name} 登录失败")
        return

    user = qc.get_user_info()
    if not user:
        print(f"  ❌ 无法获取用户信息（session 已过期）")
        print(f"  💡 请在微信中手动打开「骁友会」小程序刷新登录状态")
        print(f"  ⏭️  跳过该账号")
        return

    print(f"\n  🏅 等级: {user.get('levelName', '未知')} (Lv.{user.get('level', '?')})")
    print(f"  💎 芯动值: {user.get('coreCoin', 0)} (累计: {user.get('cumulativeCoreCoin', 0)})")

    daily_map = {t["name"]: t["status"] == 1 for t in qc.get_daily_tasks()}
    newuser_map = {t["name"]: t["status"] == 1 for t in qc.get_newuser_tasks()}
    activity_map = {t["name"]: t["status"] == 1 for t in qc.get_activity_tasks()}

    def show_status(name, done):
        return f"  {'✅' if done else '⏳'} {name}"

    print(f"\n  📋 日常任务:")
    for n, d in daily_map.items():
        print(show_status(n, d))
    print(f"  📋 新手任务:")
    for n, d in newuser_map.items():
        print(show_status(n, d))
    print(f"  📋 活动任务:")
    for n, d in activity_map.items():
        print(show_status(n, d))

    print(f"\n  {'─' * 56}")
    print(f"  🚀 开始执行任务...")
    print(f"  {'─' * 56}")

    tasks = [
        ("每日签到", daily_map, qc.sign_in),
        ("每日参与抽奖", daily_map, qc.luck_draw),
        ("每日点赞文章", daily_map, qc.like_article),
        ("答题任务闯关成功", daily_map, qc.answer_question),
    ]
    for name, status_map, func in tasks:
        if not status_map.get(name, False):
            print(f"\n  📌 {name}")
            func()
            time.sleep(1.5)
        else:
            print(f"\n  📌 {name} ✅ 已完成")

    if not daily_map.get("每日阅读文章5分钟", False):
        if SKIP_LONG_TASKS:
            print(f"\n  📌 每日阅读文章5分钟 ⏭️ 跳过")
        else:
            print(f"\n  📌 每日阅读文章5分钟")
            qc.read_article()
    else:
        print(f"\n  📌 每日阅读文章5分钟 ✅ 已完成")

    if not daily_map.get("每日观看骁友Vlog视频1分钟", False):
        if SKIP_LONG_TASKS:
            print(f"\n  📌 每日观看骁友Vlog视频1分钟 ⏭️ 跳过")
        else:
            print(f"\n  📌 每日观看骁友Vlog视频1分钟")
            qc.watch_vlog()
    else:
        print(f"\n  📌 每日观看骁友Vlog视频1分钟 ✅ 已完成")

    newuser_tasks = [
        ("了解等级权益", newuser_map, qc.newuser_level_privilege),
        ("参与一次骁友活动", newuser_map, qc.newuser_join_activity),
        ("订阅芯动值兑换", newuser_map, qc.newuser_subscribe_exchange),
    ]
    for name, status_map, func in newuser_tasks:
        if not status_map.get(name, False):
            print(f"\n  📌 [新手] {name}")
            func()
            time.sleep(1.5)
        else:
            print(f"\n  📌 [新手] {name} ✅ 已完成")

    if not activity_map.get("阅读一篇先享体验计划体验报告15s", False):
        print(f"\n  📌 [活动] 阅读先享体验计划体验报告15s")
        qc.evaluation_report()
    else:
        print(f"\n  📌 [活动] 阅读先享体验计划体验报告15s ✅ 已完成")

    print(f"\n  {'─' * 56}")
    print(f"  📊 任务执行完毕！")
    print(f"  {'─' * 56}")

    user = qc.get_user_info()
    print(f"\n  💎 当前芯动值: {user.get('coreCoin', 0)}")
    print(f"  📈 累计芯动值: {user.get('cumulativeCoreCoin', 0)}")

    daily_tasks = qc.get_daily_tasks()
    completed = sum(1 for t in daily_tasks if t.get("status") == 1)
    total = len(daily_tasks)
    print(f"  📋 日常任务: {completed}/{total}")

    newuser_tasks = qc.get_newuser_tasks()
    nu_comp = sum(1 for t in newuser_tasks if t.get("status") == 1)
    nu_total = len(newuser_tasks)
    print(f"  📋 新手任务: {nu_comp}/{nu_total}")

def main():
    print("=" * 60)
    print("  骁友会 - 日常任务自动完成 (YYB 版)")
    print(f"  YYB: {YYB_BASE_URL}")
    print("=" * 60)

    yyb = YYBClient(YYB_BASE_URL)
    if not yyb.health():
        print("❌ YYB 服务连接失败，请检查服务是否运行")
        return
    print(f"\n✅ YYB 服务连接成功")

    question_db = QuestionDB(QUESTION_DB_PATH)
    q_count = len(question_db.get_all_questions())
    if q_count > 0:
        print(f"📖 答题数据库已加载 ({q_count} 条记录)")

    accounts = yyb.list_accounts()
    if not accounts:
        print("❌ 没有已登录的微信账号，请先扫码登录")
        return

    print(f"\n📱 已登录账号 ({len(accounts)} 个):")
    for acc in accounts:
        alias = acc.get("alias", "")
        nickname = acc.get("nickname", "未知")
        status = acc.get("status", "unknown")
        display = f"{nickname}({alias})" if alias else nickname
        print(f"  {acc['id']}. {display} [{status}] openId={acc['openid'][:15]}...")

    if YYB_REF:
        target = None
        for acc in accounts:
            if acc["openid"] == YYB_REF or str(acc["id"]) == YYB_REF:
                target = acc
                break
        if target:
            accounts = [target]
        else:
            print(f"\n⚠️  未找到指定账号 {YYB_REF}，将处理所有账号")

    for i, account in enumerate(accounts, 1):
        print(f"\n{'=' * 60}")
        print(f"  📱 处理账号 {i}/{len(accounts)}")
        print(f"{'=' * 60}")

        try:
            process_account(yyb, account, question_db)
        except Exception as e:
            print(f"  ❌ 账号处理出错: {e}")
            import traceback
            traceback.print_exc()

        if i < len(accounts):
            print(f"\n  ⏳ 等待 5 秒后处理下一个账号...")
            time.sleep(5)

    print(f"\n{'=' * 60}")
    print(f"  ✨ 全部账号处理完成！")
    print(f"{'=' * 60}")

if __name__ == "__main__":
    main()