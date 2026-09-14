# -*- coding: utf-8 -*-
"""
君品汇(习酒)七夕民俗知识挑战赛 自动答题 —— 青龙版 (yyb 账号池)
fop.exijiu.com/api/festival/challenge/*

【活动规则】
- 闯关答题, 每关 5 题; 第 5/10/15/.../40 题为守关关卡, 通过守关获得 1 次抽奖机会
- 奖品: 53%vol 知交酒(100mL), 每日 80 瓶, 先到先得, 抽完即止, 每日 0 点重置
- 通关不扣挑战次数(只有失败才扣), 故全对可无限续关; 实测服务端每次通关都给抽奖机会
  (中奖关最高见 L64), 并非 40 题封顶 —— 规则文档的"守关到第40题"与服务端实现不符

【脚本逻辑】
1. 账号池调度: ThreadPoolExecutor 按 JPH_CONCURRENCY 个线程跑(默认 1=串行, 原版节奏);
   每账号每轮最多 MAX_Q_PER_ROUND 题(默认40), round_done 则冷却 ROTATE_GAP(默认10s) 后下一轮,
   共 MAX_ROUNDS 轮(默认3); 中奖/额度用尽退出; 登录失败槽内重试 FAIL_LIMIT 次后跳过
2. 答题: 先查本地题库 learned_answers.json 命中直接答, 未命中调 LLM 实时作答;
   答对才写入题库(存选项内容, 因 token 每次下发不同)。所有账号共用同一份题库。
3. 拟人延迟(2026-09-09 回退到原版慢速节奏: 1.5~2.5s 持续触发服务端"繁忙"):
   - 题库命中也不秒提交, 同样走读题延迟
   - 选择/多选题 3~5s; 排序题(type4) 6~9s(可用 JPH_Q_DELAY_MIN/MAX 调节)
4. 抽奖: 每次通关后立即 lottery/draw(实测每次通关服务端都给抽奖机会, 故未中奖可冷却再战)
5. 推送: 跑完用青龙自带 notify 推送汇总, 每账号一行(中奖/累计答题/最高关)

【为何 0 点跑】奖品先到先得, 0 点满池中奖率最高; cron 定 `0 0 * * *` 抢重置后的 80 瓶。

加密: festival-challenge-cipher-v1 = FNV-1a32(salt+":"+nonce) 派生 keystream + XOR

【环境变量】(青龙面板"环境变量"配置, 不配则用默认值)
  YYB_BASE_URL          YYB Go 取码服务地址 (默认 http://172.17.0.1:18080)
  YYB_REF               只跑指定单账号 id/openid (默认空=跑整个账号池)
  JPH_CONCURRENCY       多账号并发线程数 (默认 1=串行; 调大有指纹聚类与"繁忙"风险)
  JPH_ENABLE_LOTTERY    1=通关后抽奖, 0=只答题不抽 (默认 1)
  JPH_MAX_Q_PER_ROUND   单账号单轮答题上限/题 (默认 40, 即 8 个守关点)
  JPH_MAX_ROUNDS        单账号每日轮转轮数上限 (默认 3; 日抽奖数≈轮数×8)
  JPH_FAIL_LIMIT        连续登录失败几次判定失效跳过(默认2); 失败在并发槽内就地重试
  JPH_ROTATE_GAP_MIN    轮转冷却下限/秒 (默认 10)
  JPH_ROTATE_GAP_MAX    轮转冷却上限/秒 (默认 10)
  JPH_Q_DELAY_MIN       每题读题延迟下限/秒, 选择/多选题 (默认 3; 排序题 6~9s)
  JPH_Q_DELAY_MAX       每题读题延迟上限/秒, 选择/多选题 (默认 5)
  LLM_URL / LLM_KEY / LLM_MODEL   LLM 接口配置 (默认 sensenova glm-5.2)

用法：
  python3 junpinhui_dati_yyb.py             答题+抽奖（默认）
  python3 junpinhui_dati_yyb.py --history   查看历史中奖记录（本地持久化，服务端无此接口）

中奖记录: 服务端无个人历史接口(实测 404), 本地持久化到 jph_wins_history.json, 每次中奖自动落盘。

依赖: requests (青龙自带); 推送依赖 /ql/data/scripts/notify.py
"""
import base64
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    requests = None

APPID = "wx8d41cdc44c8aeaab"
ACTIVITY_ID = 19
FOP_BASE = "https://fop.exijiu.com"
FM_BASE = "https://fm.exijiu.com"
APP_VERSION = "1.7"
BASIC_AUTH = "Basic " + base64.b64encode(b"wechat:wechat_secret").decode()
SALT = "festival-challenge-cipher-v1"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEARN_FILE = os.path.join(SCRIPT_DIR, "learned_answers.json")

# ---------------- 环境变量配置 ----------------
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
YYB_REF = os.environ.get("YYB_REF", "")
ENABLE_LOTTERY = os.environ.get("JPH_ENABLE_LOTTERY", "1") == "1"
LLM_URL = os.environ.get("LLM_URL", "https://token.sensenova.cn/v1/chat/completions")
LLM_KEY = os.environ.get("LLM_KEY", "sk-FZuLWys2WiApj1rpKobm4B5iWIZpdLkZ")
LLM_MODEL = os.environ.get("LLM_MODEL", "glm-5.2")
MAX_Q_PER_ROUND = int(os.environ.get("JPH_MAX_Q_PER_ROUND", "40"))   # 单轮答题上限(题)
MAX_ROUNDS = int(os.environ.get("JPH_MAX_ROUNDS", "3"))              # 每账号每日轮转上限
FAIL_LIMIT = int(os.environ.get("JPH_FAIL_LIMIT", "2"))              # 连续登录失败上限
ROTATE_GAP_MIN = int(os.environ.get("JPH_ROTATE_GAP_MIN", "10"))     # 轮转冷却下限(秒)
ROTATE_GAP_MAX = int(os.environ.get("JPH_ROTATE_GAP_MAX", "10"))     # 轮转冷却上限(秒)
Q_DELAY_MIN = float(os.environ.get("JPH_Q_DELAY_MIN", "3"))          # 每题读题延迟下限(秒, 选择/多选)
Q_DELAY_MAX = float(os.environ.get("JPH_Q_DELAY_MAX", "5"))          # 每题读题延迟上限(秒, 选择/多选)
CONCURRENCY = int(os.environ.get("JPH_CONCURRENCY", "1"))            # 多账号并发线程数(1=串行, 原版节奏)

LOG = []  # 收集日志用于推送
BANK_LOCK = threading.Lock()                      # 题库/中奖记录并发写锁
# 中奖记录固定放定时任务实际目录(gh_deploy/yyb_wrap), 免得不同入口运行时写到不同位置
_WINS_DIR = "/ql/data/scripts/gh_deploy/yyb_wrap"
WINS_FILE = os.path.join(_WINS_DIR if os.path.isdir(_WINS_DIR) else SCRIPT_DIR,
                         "jph_wins_history.json")   # 本地中奖记录(服务端无查询接口)


def log(msg=""):
    print(msg)
    LOG.append(str(msg))


# ---------------- 加密 ----------------
def _fnv1a32(data: bytes) -> int:
    h = 2166136261
    for b in data:
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def keystream(nonce: str, length: int) -> bytes:
    t = _fnv1a32(("%s:%s" % (SALT, nonce)).encode("utf-8"))
    if t == 0:
        t = 1831565813
    out = bytearray(length)
    for i in range(length):
        t ^= (t << 13) & 0xFFFFFFFF; t &= 0xFFFFFFFF
        t ^= t >> 17; t &= 0xFFFFFFFF
        t ^= (t << 5) & 0xFFFFFFFF; t &= 0xFFFFFFFF
        out[i] = t & 0xFF
    return bytes(out)


def encrypt_payload(obj, nonce: str) -> str:
    plain = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ks = keystream(nonce, len(plain))
    return base64.b64encode(bytes(a ^ b for a, b in zip(plain, ks))).decode()


def decrypt_payload(enc_b64: str, nonce: str) -> dict:
    raw = base64.b64decode(enc_b64)
    ks = keystream(nonce, len(raw))
    return json.loads(bytes(a ^ b for a, b in zip(raw, ks)).decode("utf-8"))


def random_nonce() -> str:
    return "".join(random.choice("0123456789abcdef") for _ in range(32))


# ---------------- API ----------------
def biz_headers(token="", json_body=True):
    h = {
        "X-Access-Token": token or "",
        "AppID": APPID,
        "Authorization": BASIC_AUTH,
        "App-Version": APP_VERSION,
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781"
                       "(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF"),
        "Referer": f"https://servicewechat.com/{APPID}/248/page-frame.html",
        "Accept": "*/*",
    }
    if json_body:
        h["Content-Type"] = "application/json"
    return h


class Api:
    def __init__(self, ref, token):
        self.ref = ref
        self.token = token
        self.ss = requests.Session()
        self.ss.headers.update(biz_headers(token))

    def _refresh_token(self):
        """业务 token 过期(401)时重新取码 + 静默登录, 并刷新会话头"""
        code = yyb_get_code(self.ref)
        self.token = silent_login(code)
        self.ss.headers.update(biz_headers(self.token))
        return self.token

    def _req(self, method, url, payload=None, _depth=0):
        try:
            r = self.ss.request(method, url, json=payload, timeout=20)
            data = r.json()
        except Exception as e:
            return {"code": "ERR", "msg": str(e)}
        # 业务 token 过期 → 自动重新登录一次后重试同一请求
        # (解决"运行一段时间后老是用户未登录": token 有有效期, 但 YYB 微信会话仍可用, 重登即可恢复)
        if isinstance(data, dict) and data.get("code") == "401" and _depth == 0:
            try:
                self._refresh_token()
                log("   ↻ token 已过期, 已自动重新登录并续跑")
                return self._req(method, url, payload, _depth=1)
            except Exception as e:
                log(f"   !! 刷新 token 失败: {e}")
                return data
        return data

    def get(self, url):
        return self._req("GET", url)

    def post(self, url, payload):
        return self._req("POST", url, payload)

    def member_login(self):
        return self.post(f"{FOP_BASE}/api/festival/member/login",
                         {"activityId": str(ACTIVITY_ID), "sourceChannel": "festival-mini-program"})

    def challenge_home(self):
        return self.get(f"{FOP_BASE}/api/festival/challenge/home/{ACTIVITY_ID}")

    def challenge_start(self):
        return self.get(f"{FOP_BASE}/api/festival/challenge/start/{ACTIVITY_ID}")

    def question_current(self):
        return self.get(f"{FOP_BASE}/api/festival/challenge/question/current/{ACTIVITY_ID}")

    def question_submit(self, plain_obj):
        nonce = random_nonce()
        payload = {"cipherVersion": 1, "nonce": nonce,
                   "encryptedPayload": encrypt_payload(plain_obj, nonce)}
        return self.post(f"{FOP_BASE}/api/festival/challenge/question/submit", payload)

    def lottery_draw(self):
        return self.post(f"{FOP_BASE}/api/festival/lottery/draw", {"activityId": ACTIVITY_ID})

    def challenge_share_complete(self):
        return self.get(f"{FOP_BASE}/api/festival/challenge/share/complete/{ACTIVITY_ID}")

    def challenge_revival(self, failed_level_record_id):
        return self.post(f"{FOP_BASE}/api/festival/challenge/revival",
                         {"activityId": ACTIVITY_ID,
                          "failedLevelRecordId": failed_level_record_id,
                          "revivalType": 2})


# ---------------- 登录 ----------------
def yyb_get_code(ref: str) -> str:
    for attempt in range(3):
        try:
            r = requests.post(f"{YYB_BASE_URL}/wxapp/getCode",
                              json={"app_id": APPID, "ref": ref}, timeout=60)
            data = r.json()
            if data.get("code") == 0:
                return data["data"]["result"]["code"]
            raise RuntimeError(f"YYB getCode 失败: {data.get('msg')}")
        except Exception as e:
            # 凭证失效类错误重试无意义, 直接抛出交给轮转层 FAIL_LIMIT 跳过
            if "RC_PARAMS_INVALID" in str(e):
                raise
            if attempt == 2:
                raise
            log(f"   .. YYB getCode 重试 {attempt + 1}/3: {e}")
            time.sleep(5 + attempt * 5)


def silent_login(code: str) -> str:
    """wxMiniSilentLogin 必须带业务头, 否则 60010061"""
    hdrs = {
        "Content-Type": "application/json",
        "X-Access-Token": "",
        "AppID": APPID,
        "Authorization": BASIC_AUTH,
        "App-Version": APP_VERSION,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) MiniProgramEnv/Windows",
        "Referer": f"https://servicewechat.com/{APPID}/248/page-frame.html",
    }
    r = requests.post(f"{FM_BASE}/api/v2/login/wxMiniSilentLogin",
                      json={"code": code}, headers=hdrs, timeout=20)
    data = r.json()
    token = (data.get("data") or {}).get("token") or (data.get("data") or {}).get("accessToken")
    if not token:
        raise RuntimeError(f"wxMiniSilentLogin 失败: {json.dumps(data, ensure_ascii=False)[:200]}")
    return token


# ---------------- 题库 ----------------
LEARNED = {}


def load_learned():
    global LEARNED
    try:
        if os.path.exists(LEARN_FILE):
            LEARNED = json.load(open(LEARN_FILE, encoding="utf-8"))
    except Exception:
        LEARNED = {}


def save_learned():
    try:
        with open(LEARN_FILE, "w", encoding="utf-8") as f:
            json.dump(LEARNED, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


# ---------------- LLM 答题 ----------------
def re_search_json(s: str):
    try:
        b = s.find("{")
        e = s.rfind("}")
        if b >= 0 and e > b:
            return json.loads(s[b:e + 1])
    except Exception:
        return None
    return None


def llm_ask(question: dict) -> dict:
    qtype = int(question["questionType"])
    opts = question["options"]
    lines = [f"题目: {question['questionContent']}"]
    for o in opts:
        lines.append(f"{o['optionCode']}. {o['optionContent']}")
    if qtype == 2:
        lines.append(f"(多选题, 正确选项数量: {question.get('correctOptionCount')})")
    if qtype == 4:
        lines.append("(排序题, 请按正确顺序输出全部诗句)")
    tname = {1: "单选题", 2: "多选题", 4: "排序题"}[qtype]
    prompt = "\n".join([
        "你是民俗文化知识答题助手, 只输出 JSON, 不含任何解释。",
        f"题型: {tname}",
    ] + lines + [
        "",
        '输出格式(严格 JSON):',
        '  单选: {"answer":"A"}',
        '  多选: {"answers":["A","C"]}',
        '  排序: {"order":["选项A内容","选项B内容",...]}  # 全部选项按正确顺序',
    ])

    body = {"model": LLM_MODEL, "messages": [{"role": "user", "content": prompt}],
            "temperature": 0, "max_tokens": 1500}
    last_err = None
    for attempt in range(3):
        try:
            r = requests.post(LLM_URL, json=body, timeout=90,
                              headers={"Authorization": f"Bearer {LLM_KEY}"})
            if r.status_code == 429:
                last_err = f"HTTP 429 限流"
                time.sleep(8 + attempt * 8)
                continue
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            if not content or not content.strip():
                last_err = "空输出"
                time.sleep(5)
                continue
            break
        except Exception as e:
            last_err = str(e)
            time.sleep(5)
    else:
        return {"ok": False, "err": f"LLM 调用失败: {last_err}"}

    s = content.strip().strip("`")
    if s.startswith("json"):
        s = s[4:].strip()
    try:
        parsed = json.loads(s)
    except Exception:
        parsed = re_search_json(s)
    if parsed is None:
        return {"ok": False, "err": f"LLM 输出无法解析: {content[:150]}"}

    # 兼容 {"排序": {...}} 嵌套
    if isinstance(parsed, dict) and len(parsed) == 1:
        inner = next(iter(parsed.values()))
        if isinstance(inner, dict):
            parsed = inner

    oc_map = {o["optionCode"]: o for o in opts}
    inv_oc = {o["optionContent"]: o["optionCode"] for o in opts}
    try:
        if qtype == 4:
            order = parsed.get("order") or []
            import re
            code_map = {"S" + str(i + 1): o["optionCode"] for i, o in enumerate(opts)}
            code_to_content = {o["optionCode"]: o["optionContent"] for o in opts}
            cleaned = []
            for item in order:
                item = item.strip()
                if item in code_map:
                    cleaned.append(code_to_content[code_map[item]])
                else:
                    m = re.match(r"^S\d+\.\s*(.+)", item)
                    if m:
                        cleaned.append(m.group(1))
                    else:
                        cleaned.append(item)
            order = cleaned
            allc = {o["optionContent"] for o in opts}
            if len(order) != len(opts) or not allc.issubset(set(order)):
                return {"ok": False, "err": f"LLM 排序不完整: {order}"}
            return {"ok": True, "order": order}
        elif qtype == 2:
            codes = parsed.get("answers") or []
            contents = [oc_map[c.strip()]["optionContent"] for c in codes if c.strip() in oc_map]
            cc = question.get("correctOptionCount")
            if cc is not None and len(contents) != int(cc):
                return {"ok": False, "err": f"LLM 多选数量 {len(contents)} != correctOptionCount {cc}"}
            return {"ok": True, "contents": contents}
        else:
            code = str(parsed.get("answer") or "").strip()
            if code not in oc_map:
                if parsed.get("answer") in inv_oc:
                    return {"ok": True, "contents": [parsed["answer"]]}
                return {"ok": False, "err": f"LLM 选项字母无效: {code}"}
            return {"ok": True, "contents": [oc_map[code]["optionContent"]]}
    except Exception as e:
        return {"ok": False, "err": str(e)}


def build_submit(question: dict, rec: dict):
    qtype = int(question["questionType"])
    opts = question["options"]
    by_content = {o["optionContent"]: o for o in opts}
    if qtype == 4:
        order = rec.get("order") or []
        pos = {content: i + 1 for i, content in enumerate(order)}
        out = []
        for o in opts:
            if not o.get("sortable"):
                continue
            if o["optionContent"] not in pos:
                return None
            out.append({"optionToken": o["optionToken"], "positionNo": pos[o["optionContent"]]})
        if not out:
            return None
        return {"answerId": question["answerId"], "options": out}
    answers = rec.get("answer") or []
    if len(answers) != len(set(answers)):
        return None
    tokens = []
    for content in answers:
        o = by_content.get(content)
        if o is None:
            return None
        tokens.append(o["optionToken"])
    if qtype == 2:
        cc = question.get("correctOptionCount")
        if cc is not None and len(tokens) != int(cc):
            return None
    if not tokens:
        return None
    return {"answerId": question["answerId"], "options": [{"optionToken": t} for t in tokens]}


def answer_question(question: dict, use_llm: bool):
    qtext = question["questionContent"]
    if qtext in LEARNED:
        sub = build_submit(question, LEARNED[qtext])
        if sub is not None:
            return sub, "题库", None
        with BANK_LOCK:
            LEARNED.pop(qtext, None)
            save_learned()
    if not use_llm:
        return None, None, None
    res = llm_ask(question)
    if not res["ok"]:
        log(f"   !! LLM 失败: {res.get('err')}")
        return None, None, None
    if "order" in res:
        rec = {"type": 4, "order": res["order"]}
    else:
        rec = {"type": int(question["questionType"]), "answer": res["contents"]}
    sub = build_submit(question, rec)
    if sub is None:
        log("   !! LLM 答案与选项匹配失败")
        return None, None, None
    return sub, "LLM", rec


def record_wins(ref, nickname, prizes, max_level):
    """中奖落盘(服务端无历史查询接口, 本地持久化)"""
    if not prizes:
        return
    try:
        with BANK_LOCK:
            hist = []
            if os.path.exists(WINS_FILE):
                hist = json.load(open(WINS_FILE, encoding="utf-8"))
            for p in prizes:
                hist.append({"date": time.strftime("%Y-%m-%d"), "ref": str(ref),
                             "nickname": nickname or "", "prize": p,
                             "maxLevel": max_level})
            with open(WINS_FILE, "w", encoding="utf-8") as f:
                json.dump(hist, f, ensure_ascii=False, indent=1)
    except Exception as e:
        log(f"   !! 中奖记录保存失败: {e}")


def show_history():
    """打印本地历史中奖记录"""
    if not os.path.exists(WINS_FILE):
        print(f"暂无中奖记录（{WINS_FILE} 不存在）")
        return
    try:
        hist = json.load(open(WINS_FILE, encoding="utf-8"))
    except Exception:
        print("中奖记录文件损坏")
        return
    if not hist:
        print("暂无中奖记录")
        return
    print(f"===== 君品汇历史中奖记录（共 {len(hist)} 条）=====")
    for h in sorted(hist, key=lambda x: x.get("date", ""), reverse=True):
        who = h.get("nickname") or ("ref" + str(h.get("ref", "?")))
        print(f"{h.get('date', '?')}  {who}: {h.get('prize', '?')} (最高L{h.get('maxLevel', 0)})")


# ---------------- 主流程 ----------------
def mask(s: str, keep=8):
    if not s:
        return s
    if len(s) <= keep + 4:
        return s[:3] + "···" + s[-2:] + f"({len(s)}字符)"
    return s[:keep] + "···" + s[-4:] + f"({len(s)}字符)"


def run_account(ref: str, max_questions: int = 0):
    if not LEARNED:
        load_learned()
    log(f"\n===== 账号 ref={ref} (题库 {len(LEARNED)} 题) =====")
    try:
        code = yyb_get_code(ref)
        log(f"   code: {code[:10]}···")
        token = silent_login(code)
        log(f"   token: {mask(token)}")
    except Exception as e:
        log(f"   !! 登录失败: {e}")
        return {"login": "FAIL", "error": str(e), "status": "login_fail"}

    api = Api(ref, token)
    ml = api.member_login()
    md = ml.get("data") or {}
    if ml.get("code") != "10000":
        log(f"   !! member/login 失败: {json.dumps(ml, ensure_ascii=False)[:200]}")
        return {"login": "FAIL", "error": str(ml), "status": "login_fail"}
    nickname = md.get("wechatNickName") or md.get("nickName") or md.get("phone") or "?"
    phone_masked = mask(str(md.get("phone") or ""))
    log(f"   会员: {nickname} phone={phone_masked}")

    home = api.challenge_home()
    d = home.get("data") or {}
    if home.get("code") != "10000":
        log(f"   !! 查询失败: {json.dumps(home, ensure_ascii=False)[:200]}")
        return {"status": "error", "error": "查询失败"}
    log(f"   可挑战={d.get('canChallenge')} 已用={d.get('challengeUsed')}/{d.get('challengeLimit')} "
        f"分享复活={d.get('shareRevivalRemaining')}/{d.get('revivalLimit')}")
    if d.get("challengeUnavailableMessage"):
        log(f"   ⚠ {d['challengeUnavailableMessage']}")
    if not d.get("canChallenge") and not (d.get("shareRevivalRemaining") or 0):
        log("   ≡ 今日额度已用尽, 跳过")
        return {"challengeUsed": d.get("challengeUsed"), "skipped": True, "status": "exhausted"}

    total_attempts = 0
    passed_levels = []
    prizes = []
    answered_total = 0
    won_flag = False
    exhausted = False
    while True:
        if won_flag or (max_questions and answered_total >= max_questions):
            break
        home = api.challenge_home()
        d = home.get("data") or {}
        if home.get("code") != "10000":
            log(f"   !! 状态查询失败: {json.dumps(home, ensure_ascii=False)[:200]}")
            break
        can = d.get("canChallenge")
        revive_left = d.get("shareRevivalRemaining") or 0
        can_revive = d.get("canRevive")
        log(f"≡ 状态: 可挑战={can} 已用={d.get('challengeUsed')}/{d.get('challengeLimit')} "
            f"分享复活剩={revive_left} canRevive={can_revive}")

        if not can:
            if revive_left > 0 and can_revive:
                failed_id = d.get("revivableFailedLevelRecordId")
                if not failed_id:
                    log("   !! 无可复活关卡记录, 退出")
                    break
                log(f"≡ 分享复活 (失败关卡记录 {failed_id})")
                sc = api.challenge_share_complete()
                rv = api.challenge_revival(failed_id)
                log(f"   revival: {json.dumps(rv, ensure_ascii=False)[:150]}")
                if rv.get("code") != "10000":
                    log("   !! 复活失败, 退出")
                    break
                time.sleep(2)
                continue
            log("≡ 次数与复活均用尽, 额度跑满 ✓")
            exhausted = True
            break

        total_attempts += 1
        log(f"\n≡ 第 {total_attempts} 次挑战 (start)")
        st = api.challenge_start()
        if st.get("code") != "10000":
            log(f"   !! start 失败: {json.dumps(st, ensure_ascii=False)[:150]}")
            break
        level_no = st["data"].get("levelNo")
        log(f"   level=L{level_no} record={st['data'].get('levelRecordId')}")

        failed_id = None
        passed = False
        answered = 0
        attempts = 0
        err_streak = 0   # 连续异常计数(每道题独立, 正常响应清零)
        seen_q = set()
        while answered < 5 and attempts < 15:
            attempts += 1
            cur = api.question_current()
            if cur.get("code") != "10000":
                log(f"   !! 取题失败 [尝试{attempts}]: {json.dumps(cur, ensure_ascii=False)[:100]}")
                break
            raw = cur["data"]
            q = decrypt_payload(raw["encryptedPayload"], raw["nonce"])
            qtext = q["questionContent"]
            if qtext not in seen_q:
                log(f"— 第{answered + 1}/5题 [type{q['questionType']}] {qtext[:60]} (限时{q.get('limitSeconds')}s)")
                seen_q.add(qtext)
            else:
                log(f"— (重试第{answered + 1}/5题) {qtext[:50]}")

            sub, src, llm_rec = answer_question(q, True)
            if sub is None:
                log("   !! 无法作答, 跳过本关")
                break
            # 提交前模拟读题延迟: 服务端风控 "操作过于频繁" (答题过快即触发)
            # 2026-09-09 回退到原版慢速节奏(1.5~2.5s 会持续触发"繁忙"); 排序题(type4)更耗时单独加大
            # 题库命中也走此延迟(不秒提交)
            if int(q["questionType"]) == 4:
                time.sleep(random.uniform(Q_DELAY_MIN + 3, Q_DELAY_MAX + 4))
            else:
                time.sleep(random.uniform(Q_DELAY_MIN, Q_DELAY_MAX))
            resp = api.question_submit(sub)
            rd = resp.get("data")
            if not isinstance(rd, dict):
                # 响应异常(data 缺失/错误信封): 打印诊断, 连续 3 次异常才放弃本关
                log(f"   !! submit 响应异常: {json.dumps(resp, ensure_ascii=False)[:200]}")
                err_streak += 1
                if err_streak >= 3:
                    log("   !! 连续异常, 跳过本关")
                    break
                time.sleep(random.uniform(4, 6))
                continue
            err_streak = 0
            ok = rd.get("correct")
            log(f"   [{src}] 提交 {len(sub['options'])} 项 -> correct={ok} timeout={rd.get('timeout')}")
            if ok is True:
                if llm_rec is not None and qtext not in LEARNED:
                    with BANK_LOCK:
                        LEARNED[qtext] = llm_rec
                        save_learned()
                    log(f"   ✓ 写入题库 (共 {len(LEARNED)} 题)")
                answered += 1
                answered_total += 1
            elif rd.get("levelFailed"):
                log(f"   ❌ 本关失败 (复活剩 {rd.get('revivalRemaining')})")
                failed_id = rd.get("failedLevelRecordId") or failed_id
                break
            elif rd.get("timeout") is True:
                log("   ⏱ 超时, 同题重答")
                continue
            elif ok is None:
                # correct=None 且非超时: 状态未知, 打印完整响应诊断, 保守重试(不删题库)
                log(f"   ?? correct=None 响应: {json.dumps(resp, ensure_ascii=False)[:250]}")
                if attempts >= 6:
                    log("   !! 连续状态未知, 跳过本关")
                    break
                time.sleep(3)
                continue
            else:
                if qtext in LEARNED:
                    with BANK_LOCK:
                        LEARNED.pop(qtext, None)
                        save_learned()
                    log("   ✗ 题库记录错误已移除")
            if rd.get("levelPassed"):
                log(f"   ✅ 关卡通过! 用时 {rd.get('totalDuration')} 下一关 L{rd.get('nextLevelNo')}")
                passed = True
                if ENABLE_LOTTERY:
                    # HAR 时间线: 通关给1次抽奖资格, 通关后立即抽, 再开下一关
                    lr = api.lottery_draw()
                    ld = lr.get("data")
                    if isinstance(ld, dict):
                        log(f"≡ 抽奖: won={ld.get('won')} prize={ld.get('prizeName')} 剩余={ld.get('remainingChances')}")
                        if ld.get("won"):
                            prizes.append(ld.get("prizeName") or "?")
                            won_flag = True
                    else:
                        log(f"≡ 抽奖响应异常: {json.dumps(lr, ensure_ascii=False)[:150]}")
                break

        if not passed and not failed_id:
            home2 = api.challenge_home()
            d2 = home2.get("data") or {}
            if d2.get("currentLevelNo") != level_no:
                log(f"   ℹ 关卡进度已推进 (L{d2.get('currentLevelNo')}), 视为完成")
                passed = True

        if passed:
            passed_levels.append(level_no)
            continue
        home2 = api.challenge_home()
        d2 = home2.get("data") or {}
        fid = d2.get("revivableFailedLevelRecordId") or failed_id
        if fid and (d2.get("shareRevivalRemaining") or 0) > 0 and d2.get("canRevive"):
            log(f"≡ 挑战失败, 分享复活 (failedLevelRecordId={fid})")
            # 必须先 share/complete 再 revival, 否则服务端 500 "请先完成分享后再复活"
            sc = api.challenge_share_complete()
            log(f"   share/complete: {json.dumps(sc, ensure_ascii=False)[:120]}")
            rv = api.challenge_revival(fid)
            log(f"   revival: {json.dumps(rv, ensure_ascii=False)[:150]}")
            if rv.get("code") != "10000":
                log("   !! 复活失败")
                break
            time.sleep(2)
            continue
        log("≡ 无可复活次数, 退出")
        break

    max_lv = max(passed_levels, default=0)
    if prizes:
        status = "won"
    elif exhausted:
        status = "exhausted"
    elif max_questions and answered_total >= max_questions:
        status = "round_done"
    else:
        status = "done"
    result = {"attempts": total_attempts, "maxLevel": max_lv, "prizes": prizes,
              "qbankSize": len(LEARNED), "nickname": nickname,
              "answered": answered_total, "status": status}
    record_wins(ref, nickname, prizes, max_lv)
    log(f"≡ 账号完成: 挑战 {total_attempts} 次, 本轮答题 {answered_total}, 最高通关 L{max_lv}, 中奖 {len(prizes)} 次, 状态={status}")
    return result


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
            return
        except Exception as e:
            print(f"青龙推送失败({p}): {e}")
            return
    print("青龙推送失败: 未找到 notify.py")


def main():
    if "--history" in sys.argv:
        show_history()
        return

    log("≡ 君品汇·七夕民俗知识挑战赛 自动答题 [青龙版]")
    log(f"   LLM: {LLM_MODEL}  抽奖: {ENABLE_LOTTERY}  并发: {CONCURRENCY}  节奏: 每轮≤{MAX_Q_PER_ROUND}题×{MAX_ROUNDS}轮 冷却{ROTATE_GAP_MIN}-{ROTATE_GAP_MAX}s 每题{Q_DELAY_MIN}-{Q_DELAY_MAX}s (原版慢速)")
    if requests is None:
        log("!! 缺少 requests 库")
        return

    if YYB_REF:
        refs = [YYB_REF]
        log(f"   YYB_REF 指定单账号: {refs}")
    else:
        r = requests.get(f"{YYB_BASE_URL}/accounts", timeout=15)
        accounts = r.json().get("data") or []
        refs = []
        for a in accounts:
            status = a.get("status")
            if status in ("expired", "dead"):
                continue
            refs.append(str(a.get("id") or a.get("uin") or a.get("openid")))
        log(f"   账号池存活 {len(refs)} 个")

    load_learned()
    log(f"   题库 {len(LEARNED)} 题")

    def worker(ref):
        # 2026-09-09 恢复原版轮转调度: 每轮≤MAX_Q_PER_ROUND 题, round_done 则冷却后下一轮, 共 MAX_ROUNDS 轮
        res = None
        rounds = 0
        while True:
            for attempt in range(FAIL_LIMIT):
                try:
                    res = run_account(ref, max_questions=MAX_Q_PER_ROUND)
                except Exception as e:
                    log(f"   !! 账号 {ref} 异常: {e}")
                    res = {"error": str(e), "status": "error"}
                status = res.get("status", "done")
                if status in ("login_fail", "error") and attempt < FAIL_LIMIT - 1:
                    log(f"   ↻ 账号 {ref} 失败{attempt + 1}次, 重试(槽内)")
                    time.sleep(5)
                    continue
                break
            if res is None:
                res = {"status": "login_fail", "error": "重试耗尽"}
            status = res.get("status", "done")
            rounds += 1
            if status == "round_done" and rounds < MAX_ROUNDS:
                gap = random.uniform(ROTATE_GAP_MIN, ROTATE_GAP_MAX)
                log(f"   ↻ 账号 {ref} 本轮{res.get('answered', 0)}题未中, 冷却{gap:.0f}s 后下一轮 ({rounds}/{MAX_ROUNDS})")
                time.sleep(gap)
                continue
            break
        return res

    results = []
    with ThreadPoolExecutor(max_workers=max(1, CONCURRENCY)) as ex:
        futs = {ex.submit(worker, ref): ref for ref in refs}
        for fu in as_completed(futs):
            ref = futs[fu]
            try:
                res = fu.result()
            except Exception as e:
                log(f"   !! worker {ref} 崩溃: {e}")
                res = {"error": str(e), "status": "error"}
            results.append((ref, res))
            status = res.get("status", "done")
            if status == "won":
                log(f"   ★ 账号 {ref} 已中奖, 移出(每日1瓶上限)")
            elif status == "exhausted":
                log(f"   ≡ 账号 {ref} 额度用尽")
            elif status in ("login_fail", "error"):
                log(f"   ✖ 账号 {ref} 失败: {(res.get('error') or status)[:60]}")

    agg = {}
    for ref, res in results:
        a = agg.setdefault(ref, {"name": res.get("nickname") or ref[:8],
                                 "answered": 0, "max_lv": 0, "prizes": [],
                                 "status": "done", "error": None})
        if res.get("nickname"):
            a["name"] = res["nickname"]
        a["answered"] += res.get("answered", 0)
        a["max_lv"] = max(a["max_lv"], res.get("maxLevel", 0))
        a["prizes"] += res.get("prizes", [])
        a["status"] = res.get("status", a["status"])
        if res.get("error"):
            a["error"] = res["error"]

    summary = []
    for ref, a in agg.items():
        if a["status"] in ("login_fail", "error") or a["error"]:
            summary.append(f"{a['name']}: FAIL {(a['error'] or '登录失败')[:50]}")
        elif a["prizes"]:
            summary.append(f"{a['name']}: ★中奖:{','.join(a['prizes'])} 累计答{a['answered']}题 最高L{a['max_lv']}")
        elif a["status"] == "exhausted":
            summary.append(f"{a['name']}: 额度用尽 累计答{a['answered']}题 最高L{a['max_lv']}")
        else:
            summary.append(f"{a['name']}: 未中奖 累计答{a['answered']}题 最高L{a['max_lv']}")
    log("\n===== 汇总 =====")
    for s in summary:
        log(s)
    push("君品汇答题", "\n".join(summary))


if __name__ == "__main__":
    main()