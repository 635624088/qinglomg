#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OPPO 商城 签到+浏览任务 (YYB版)

入口: 微信小程序搜索"OPPO商城" #小程序://OPPO商城/oOwmvDIitsysjIJ
功能: 每日签到 + 浏览任务(5个) + 领取奖励

环境变量:
  YYB_BASE_URL  YYB 服务地址 (默认 http://172.17.0.1:18080)
  YYB_REF       指定账号 ref (可选，默认遍历所有账号)
"""

import json
import os
import time
from datetime import datetime

import requests

# ====== YYB 配置 ======
YYB_BASE = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
YYB_REF = os.getenv("YYB_REF", "") or None
# ======================

# ====== 业务常量 ======
APP_NAME = "OPPO商城"
APPID = "wxe705c556754a1de2"
APP_VERSION = "080457"

MINI_API = "https://omoapplet-api-cn.heytap.com"
H5_API = "https://hd.opposhop.cn"

# 签到活动
SIGN_ACTIVITY_ID = "2071966512754991104"
CREDITS_ADD_ACTION_ID = "1788913e6d9e4683b8b9ab0088733560"
BUSINESS = 1

# 任务活动
TASK_ACTIVITY_ID = "1919591795180969984"

# 浏览任务列表: (名称, taskId, 链接)
BROWSE_TASKS = [
    ("浏览省心狂补节货品会场", "2077218228668735488",
     "https://hd.opposhop.cn/bp/374b7029f2e4e57d?nightModelEnable=true"),
    ("浏览OPPO商城小课堂", "2076840814201544704",
     "https://hd.opposhop.cn/bp/c8e46eeef31f63df?nightModelEnable=true"),
    ("浏览教育优惠", "1919592548679294976",
     "https://hd.opposhop.cn/bp/66c59b72a332c528?nightModelEnable=true&us=wode&um=qiandaobanner&uc=xueshengrenzheng"),
    ("查看附近门店", "2010985754897162240",
     "https://www.opposhop.cn/cn/m/onlineStore/nearbyShop?us=shouye&um=icon&uc=mendian"),
    ("浏览活动中心", "2009574225412890624",
     "https://hd.oppo.com/act/userActivity?us=shouye&um=icon&uc=huodongzhongxin"),
]

USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; M2012K11AC Build/TKQ1.221114.001; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 "
    "Mobile Safari/537.36 XWEB/1460217 MMWEBSDK/20260502 MMWEBID/9223 "
    "MicroMessenger/8.0.76.3140(0x28004C30) WeChat/arm64 Weixin NetType/4G "
    "Language/zh_CN ABI/arm64 miniProgram/wx9c825da1a7ba062e"
)
# ======================


# ====== YYB 接口封装 ======
def yyb_get_accounts():
    """从 YYB 服务获取已保存的微信账号列表"""
    resp = requests.get(f"{YYB_BASE}/accounts", timeout=10)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"[✗] 获取账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    """通过 YYB 服务获取微信小程序 code"""
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


# ====== HTTP 请求工具 ======
def short_json(value, max_len=300):
    text = json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else str(value)
    return text if len(text) <= max_len else text[:max_len] + "..."

def request(method, url, **kwargs):
    kwargs.setdefault("timeout", 25)
    headers = kwargs.pop("headers", {})
    headers.setdefault("User-Agent", USER_AGENT)
    headers.setdefault("Accept", "application/json, text/plain, */*")
    try:
        resp = requests.request(method, url, headers=headers, **kwargs)
        return resp.status_code, resp.json() if resp.text else {}
    except Exception as e:
        return 0, {"_error": str(e)}


# ====== OPPO 任务类 ======
class OppoTask:
    def __init__(self, account, index):
        self.index = index
        self.nickname = account.get("nickname", "未知")
        self.openid = account.get("openid", "")
        self.ref = str(account.get("id", ""))
        self.display_name = self.nickname or self.openid[:16] if self.openid else "未知"

        self.session_id = ""
        self.encrypted_session = ""
        self.open_id = ""
        self.member_info = {}

    def log(self, msg):
        print(f"    {msg}")

    def mini_headers(self):
        return {
            "Content-Type": "application/json",
            "s_channel": "oppo",
            "source_type": "2",
            "s_version": "010000",
            "spCallSource": "oppohy",
            "Referer": f"https://servicewechat.com/{APPID}/{APP_VERSION}/page-frame.html",
            "sessionId": self.session_id or "",
            "NEWOPPOSID": self.encrypted_session or "",
            "openid": self.open_id or "",
            "sa_distinct_id": self.open_id or "",
            "constToken": self.session_id or "",
        }

    def h5_headers(self):
        return {
            "Content-Type": "application/json",
            "Origin": H5_API,
            "Referer": f"https://servicewechat.com/{APPID}/{APP_VERSION}/page-frame.html",
            "sessionId": self.session_id or "",
            "NEWOPPOSID": self.encrypted_session or "",
            "openid": self.open_id or "",
            "sa_distinct_id": self.open_id or "",
            "constToken": self.session_id or "",
        }

    def parse_response(self, resp_data):
        """统一解析 h5 响应"""
        code = resp_data.get("code")
        succeed = resp_data.get("succeed")
        if code == 200 or succeed is True:
            return resp_data.get("data")
        msg = resp_data.get("message") or resp_data.get("errorMessage") or short_json(resp_data)
        raise Exception(msg)

    # ---- 登录 ----
    def login(self):
        self.log("[1/8] 获取 wx.login code...")
        code = yyb_get_code(self.ref)
        if not code:
            raise Exception("获取 code 失败")

        self.log("[2/8] 登录 OPPO 商城...")
        status, data = request("POST", f"{MINI_API}/user/pre/auth",
                               json={"code": code})
        if status != 200 or str(data.get("ret")) != "1":
            raise Exception(f"登录失败: {short_json(data)}")

        info = data.get("data") or {}
        self.session_id = info.get("sessionId") or ""
        self.encrypted_session = info.get("encryptedSession") or ""
        self.open_id = info.get("openId") or ""
        if not self.session_id:
            raise Exception(f"登录响应缺少 sessionId: {short_json(data)}")
        self.log(f"[✓] 登录成功 openId={self.open_id[:16] if self.open_id else '未知'}...")

    # ---- 查询用户信息 ----
    def query_member(self):
        self.log("[3/8] 查询用户信息...")
        status, data = request("GET", f"{MINI_API}/member/info",
                               params={"sessionId": self.session_id},
                               headers=self.mini_headers())
        if status == 200 and str(data.get("ret")) == "1":
            self.member_info = data.get("data") or {}
        else:
            self.log(f"[⚠] 查询会员信息异常: {short_json(data)}")

        status, data = request("GET", f"{MINI_API}/member/baseInfo",
                               params={"sessionId": self.session_id},
                               headers=self.mini_headers())
        base_info = {}
        if status == 200 and str(data.get("ret")) == "1":
            base_info = data.get("data") or {}

        user_name = self.member_info.get("userName") or base_info.get("userName") or "未知"
        points = self.member_info.get("pointAmount", 0)
        growth = self.member_info.get("growthValue", 0)
        grade = self.member_info.get("gradeCode") or "未知"
        self.log(f"[✓] 用户: {user_name}, 积分: {points}, 成长值: {growth}, 等级: {grade}")

    # ---- 签到 ----
    def get_sign_detail(self):
        status, data = request("GET",
                               f"{H5_API}/api/cn/oapi/marketing/cumulativeSignIn/getSignInDetail",
                               params={"activityId": SIGN_ACTIVITY_ID},
                               headers=self.h5_headers())
        if status != 200:
            self.log(f"[✗] 查询签到详情失败: HTTP {status}")
            return None
        return self.parse_response(data)

    def do_sign_in(self):
        self.log("[4/8] 执行签到...")
        detail = self.get_sign_detail()
        if detail is None:
            return
        today = datetime.now().strftime("%Y-%m-%d")
        awards = detail.get("baseAwards") or []
        today_award = next((a for a in awards if str(a.get("signTime", ""))[:10] == today), {})
        if str(today_award.get("status")) == "1":
            self.log(f"[→] 今日已签到，跳过")
            return
        days = detail.get("signInDayNum", 0)

        # 执行签到
        status, data = request("POST",
                               f"{H5_API}/api/cn/oapi/marketing/cumulativeSignIn/signIn",
                               json={
                                   "activityId": SIGN_ACTIVITY_ID,
                                   "creditsAddActionId": CREDITS_ADD_ACTION_ID,
                                   "business": BUSINESS,
                               },
                               headers=self.h5_headers())
        if status != 200:
            self.log(f"[✗] 签到请求失败: HTTP {status}")
            return
        try:
            result = self.parse_response(data)
        except Exception as e:
            self.log(f"[✗] 签到失败: {e}")
            return

        if result.get("receiveStatus") is True:
            award_value = result.get("awardValue", "-")
            award_type_map = {1: "积分", 2: "优惠券", 3: "抽奖机会"}
            atype = award_type_map.get(result.get("awardType"), "")
            self.log(f"[✓] 签到成功！获得 {award_value}{atype}")
        else:
            fail_msg = result.get("receiveFailMsg") or "未知"
            self.log(f"[✗] 签到失败: {fail_msg}")

        # 签到后查询确认
        detail2 = self.get_sign_detail()
        if detail2:
            days2 = detail2.get("signInDayNum", 0)
            self.log(f"[✓] 累计签到: {days2} 天")

    # ---- 浏览任务 ----
    def process_browse_tasks(self):
        """处理所有浏览任务"""
        self.log("[5/8] 查询浏览任务列表...")

        for task_name, task_id, task_link in BROWSE_TASKS:
            self.log(f"  ── {task_name} ──")

            # ① checkCrowd 检查资格
            status, data = request("GET",
                                   f"{H5_API}/api/cn/oapi/marketing/task/checkCrowd",
                                   params={
                                       "activityId": TASK_ACTIVITY_ID,
                                       "taskId": task_id,
                                   },
                                   headers=self.h5_headers())
            if status != 200:
                self.log(f"  [✗] checkCrowd 失败: HTTP {status}")
                continue
            try:
                crowd = self.parse_response(data)
            except Exception as e:
                self.log(f"  [✗] 无资格: {e}")
                continue
            if not crowd.get("result"):
                self.log(f"  [→] 不符合任务条件，跳过")
                continue

            # ② queryTaskInfo 获取详情
            status, data = request("GET",
                                   f"{H5_API}/api/cn/oapi/marketing/task/queryTaskInfo",
                                   params={
                                       "activityId": TASK_ACTIVITY_ID,
                                       "taskId": task_id,
                                   },
                                   headers=self.h5_headers())
            if status != 200:
                self.log(f"  [✗] queryTaskInfo 失败: HTTP {status}")
                continue
            try:
                info = self.parse_response(data)
            except:
                self.log(f"  [✗] 获取任务详情失败")
                continue
            browse_time = (info.get("attachConfigOne") or {}).get("browseTime", 5)
            self.log(f"  [→] 浏览 {browse_time} 秒...")
            time.sleep(browse_time)

            # ③ signInOrShareTask 上报浏览
            status, data = request("GET",
                                   f"{H5_API}/api/cn/oapi/marketing/taskReport/signInOrShareTask",
                                   params={
                                       "taskId": task_id,
                                       "activityId": TASK_ACTIVITY_ID,
                                       "taskType": 1,
                                   },
                                   headers=self.h5_headers())
            if status != 200:
                self.log(f"  [✗] 上报浏览失败: HTTP {status}")
                continue
            self.log(f"  [✓] 上报成功")

            # ④ receiveAward 领取奖励
            status, data = request("GET",
                                   f"{H5_API}/api/cn/oapi/marketing/task/receiveAward",
                                   params={
                                       "taskId": task_id,
                                       "activityId": TASK_ACTIVITY_ID,
                                       "creditsAddActionId": CREDITS_ADD_ACTION_ID,
                                       "business": BUSINESS,
                                   },
                                   headers=self.h5_headers())
            if status != 200:
                self.log(f"  [✗] 领取奖励失败: HTTP {status}")
                continue
            try:
                award = self.parse_response(data)
                if award.get("receiveStatus") is True:
                    av = award.get("awardValue", "-")
                    self.log(f"[✓] 领取成功！获得 {av} 积分")
                else:
                    self.log(f"[✗] 领取失败: {award.get('receiveFailMsg') or '未知'}")
            except Exception as e:
                self.log(f"[✗] 领取奖励异常: {e}")

            self.log("")

    # ---- 查询积分 ----
    def query_credits(self):
        self.log("[6/8] 查询当前积分...")
        status, data = request("GET",
                               f"{H5_API}/api/cn/oapi/marketing/member/queryMemberCreditInfo",
                               headers=self.h5_headers())
        if status != 200:
            self.log(f"[✗] 查询积分失败: HTTP {status}")
            return
        try:
            result = self.parse_response(data)
            amount = result.get("amount", 0)
            expire = result.get("expireAmount", 0)
            self.log(f"[📊] 当前积分: {amount} 分" +
                     (f" (本月过期: {expire} 分)" if expire else ""))
        except:
            self.log(f"[✗] 解析积分数据失败")

    # ---- 主流程 ----
    def run(self):
        try:
            self.login()
            self.query_member()
            self.do_sign_in()
            self.process_browse_tasks()
            self.query_credits()
        except Exception as e:
            self.log(f"[✗] 执行失败: {e}")


# ====== 主函数 ======
def main():
    print("=" * 56)
    print(f"  {APP_NAME} 签到+浏览任务 (YYB版)")
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 56)

    print("\n[1/3] 获取 YYB 账号列表...")
    accounts = yyb_get_accounts()
    if not accounts:
        print("[✗] 没有可用的微信账号")
        print(f"  请先通过 YYB 扫码登录添加账号: POST {YYB_BASE}/qr")
        return

    if YYB_REF:
        accounts = [
            a for a in accounts
            if str(a.get("id")) == YYB_REF or a.get("openid") == YYB_REF
        ]
        if not accounts:
            print(f"[✗] 未找到 ref={YYB_REF} 的账号")
            return
        print(f"[✓] 指定账号, 共 1 个\n")
    else:
        print(f"[✓] 共 {len(accounts)} 个账号\n")

    print(f"[2/3] 开始执行任务...\n")

    for i, account in enumerate(accounts, 1):
        print(f"[{i}/{len(accounts)}] {'=' * 40}")
        nickname = account.get("nickname") or account.get("openid", "")[:16] or "未知"
        print(f"  📱 账号: {nickname}")

        task = OppoTask(account, i)
        task.run()

        if i < len(accounts):
            time.sleep(3)

    print(f"\n[3/3] 全部任务执行完毕!")
    print(f"  {APP_NAME} 任务完成")
    print("=" * 56)


if __name__ == "__main__":
    main()
