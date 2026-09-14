#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
辉山奶每日签到

优先使用 wxid 登录，流程参考:
wxid -> WechatServer 获取 code -> GroupRiskJson -> AutoLoginByWechat

不再依赖 HAR。

支持的环境变量:
  huishan / HSN_WXID / HUISHAN_WXID

  HSN_AUTH_KEY / HUISHAN_AUTH_KEY
    直接传 AuthKey，格式同上

  HSN_BLACKBOX / HUISHAN_BLACKBOX
    可选，不填则使用脚本内置默认值

  WECHAT_SERVER
    WechatServer 地址，例如 http://127.0.0.1:5200
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Dict, List, Optional, Tuple

import requests

requests.packages.urllib3.disable_warnings()

APP_ID = "wx80a4273b996ce85b"
SERVICE_URL = "https://yxrycrm.huishandairy.com/MALLIF/MCSWSIAPI.asmx/Call"
SIGN_SECRET = "R81TW2fy0tb2RrdTK5ERZ845QcB6azwm"
DEFAULT_BLACKBOX = "lMPHz1775215773VUm4YJMsBqc"
WX_CODE_API = os.getenv("WX_CODE_API", "/api/v1/wx/app/get/code").strip() or "/api/v1/wx/app/get/code"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254181d) XWEB/19201"
)

def compact_json(data: Any) -> str:
    if isinstance(data, str):
        return data
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))

def parse_xml_json(xml_text: str) -> Dict[str, Any]:
    root = ET.fromstring(xml_text)
    payload = (root.text or "").strip()
    if not payload:
        raise ValueError(f"接口返回为空: {xml_text[:200]}")
    return json.loads(payload)

def build_sign(method: str, params_text: str, sequence: int, ts_ms: int, auth_key: str = "") -> str:
    raw = (
        f"!Jay!{params_text}!jAy!{auth_key}!jaY!{sequence}!jay!"
        f"{method}{math.ceil(ts_ms / 2) - 11553322}{SIGN_SECRET}"
    )
    return sha256(raw.encode("utf-8")).hexdigest()

def choose_value(*values: str) -> str:
    for value in values:
        if value:
            return value
    return ""

@dataclass
class Account:
    name: str
    mode: str
    wxid: str = ""
    auth_key: str = ""
    openid: str = ""
    appid: str = ""
    blackbox: str = ""
    request_pack: Optional[Dict[str, Any]] = None

def parse_request_pack_text(text: str) -> Dict[str, Any]:
    raw = text.strip()
    if not raw:
        raise ValueError("空 RequestPack")
    try:
        return json.loads(urllib.parse.unquote(raw))
    except Exception:
        return json.loads(raw)

def parse_accounts() -> List[Account]:
    accounts: List[Account] = []

    raw_wxid = (
        os.getenv("huishan", "")
        or os.getenv("HSN_WXID", "")
        or os.getenv("HUISHAN_WXID", "")
    )
    for item in raw_wxid.replace("\n", "&").split("&"):
        item = item.strip()
        if not item:
            continue
        if "#" in item:
            name, wxid = item.split("#", 1)
        else:
            name, wxid = item, item
        wxid = wxid.strip()
        if not wxid:
            continue
        accounts.append(Account(name=name.strip() or wxid, mode="wxid", wxid=wxid))

    raw_auth = os.getenv("HSN_AUTH_KEY", "") or os.getenv("HUISHAN_AUTH_KEY", "")
    for item in raw_auth.replace("\n", "&").split("&"):
        item = item.strip()
        if not item:
            continue
        if "#" in item:
            name, auth_key = item.split("#", 1)
        else:
            name, auth_key = "AuthKey账号", item
        auth_key = auth_key.strip()
        if not auth_key:
            continue
        accounts.append(Account(name=name.strip() or "AuthKey账号", mode="auth_key", auth_key=auth_key))

    raw_pack = os.getenv("hsnf", "") or os.getenv("HSNF", "")
    for index, item in enumerate(raw_pack.replace("\n", "&").split("&"), 1):
        item = item.strip()
        if not item:
            continue
        try:
            pack = parse_request_pack_text(item)
        except Exception:
            continue
        accounts.append(
            Account(
                name=f"RequestPack{index}",
                mode="request_pack",
                auth_key=str(pack.get("AuthKey", "")).strip(),
                appid=str(pack.get("DeviceCode", "")).strip(),
                blackbox=str(pack.get("BlackBox", "")).strip(),
                request_pack=pack,
            )
        )

    raw_openid = os.getenv("HSN_OPENID", "") or os.getenv("HUISHAN_OPENID", "")
    openid_list: List[str] = []
    for item in raw_openid.replace("\n", "&").split("&"):
        item = item.strip()
        if not item:
            continue
        if "#" in item:
            _, openid = item.split("#", 1)
        else:
            openid = item
        openid = openid.strip()
        if openid:
            openid_list.append(openid)

    for idx, openid in enumerate(openid_list):
        if idx < len(accounts):
            accounts[idx].openid = openid

    return accounts

class HuiShanClient:
    def __init__(
        self,
        appid: str,
        blackbox: str,
        auth_key: str = "",
        openid: str = "",
        wxid: str = "",
        wechat_server: str = "",
        yyb_base_url: str = "",
        timeout: int = 20,
    ) -> None:
        self.appid = appid
        self.blackbox = blackbox
        self.auth_key = auth_key
        self.openid = openid
        self.wxid = wxid
        self.wechat_server = wechat_server.rstrip("/")
        self.yyb_base_url = yyb_base_url.rstrip("/")
        self.timeout = timeout

        self.session = requests.Session()
        self.session.verify = False

    def _headers(self, method: str, params_text: str, sequence: int, ts_ms: int, auth_key: str = "") -> Dict[str, str]:
        return {
            "User-Agent": USER_AGENT,
            "xweb_xhr": "1",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*",
            "Referer": f"https://servicewechat.com/{self.appid}/38/page-frame.html",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "X-TimeStamp-Header": str(ts_ms),
            "X-Sign-Header": build_sign(method, params_text, sequence, ts_ms, auth_key),
        }

    def _request_pack(
        self,
        method: str,
        params: Any,
        *,
        need_auth: bool,
        auth_key: str = "",
        blackbox: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], str]:
        params_text = compact_json(params if params is not None else {})
        pack: Dict[str, Any] = {
            "Sequence": 1,
            "DeviceCode": self.appid,
            "Method": method,
            "Params": params_text,
            "BlackBox": blackbox if blackbox is not None else self.blackbox,
        }
        if need_auth:
            pack["AuthKey"] = auth_key or self.auth_key
        return pack, params_text

    def _extract_code_from_response(self, data: Dict[str, Any]) -> str:
        if data.get("Code") == 0:
            return str(data.get("Data", {}).get("code", "")).strip()
        if data.get("Success"):
            return str(data.get("Data", {}).get("Code", "")).strip()
        if data.get("code") == 200:
            return str(data.get("data", {}).get("code", "")).strip()
        if data.get("code") == 0:
            return str(data.get("data", {}).get("code", "")).strip()
        return ""

    def _explain_wechat_server_error(self, data: Dict[str, Any]) -> str:
        code = data.get("Code", data.get("code"))
        message = str(data.get("Message") or data.get("msg") or data)
        if code == -13 or "用户可能退出" in message:
            return (
                "WechatServer 返回 -13（用户可能退出）。"
                "这通常表示该 wxid 对应的微信当前不在线、已掉线，或 WechatServer 没有绑定到该登录会话。"
                "请先确认电脑微信仍在线，并确认传入的 wxid 就是当前在线账号。"
            )
        return message

    def _wechat_request_code(self, stage: str = "login") -> str:
        if not self.wxid:
            raise RuntimeError("wxid 为空")

        # 优先使用 YYB 协议
        if self.yyb_base_url:
            url = self.yyb_base_url + "/wxapp/getCode"
            payload = {"ref": self.wxid, "app_id": self.appid}
            headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
            last_error = ""

            for attempt in range(3):
                try:
                    resp = requests.post(url, json=payload, headers=headers, timeout=15)
                    text = resp.text.strip()
                    try:
                        data = resp.json()
                    except Exception:
                        last_error = f"{url} 返回非 JSON: {text[:200]}"
                        if attempt < 2:
                            time.sleep(2)
                        continue

                    # YYB 格式: {"code": 0, "data": {"result": {"code": "xxx"}}}
                    if data.get("code") == 0:
                        result = data.get("data", {}).get("result") or {}
                        code = result.get("code") or result.get("Code")
                        if code:
                            return str(code)

                    code = self._extract_code_from_response(data)
                    if code:
                        return code

                    explain = self._explain_wechat_server_error(data)
                    last_error = f"{url} 未返回 code: {explain} | 原始返回: {data}"
                except Exception as exc:
                    last_error = f"{url} 请求异常: {exc}"

                if attempt < 2:
                    time.sleep(2)

        # 回退到 WechatServer
        if not self.wechat_server:
            raise RuntimeError("YYB_BASE_URL 未配置且 WECHAT_SERVER 未配置")

        payload = {"wxid": self.wxid, "appid": self.appid}
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        url = self.wechat_server + WX_CODE_API
        last_error = ""

        for attempt in range(3):
            try:
                resp = requests.post(url, json=payload, headers=headers, timeout=60)
                text = resp.text.strip()
                try:
                    data = resp.json()
                except Exception:
                    last_error = f"{url} 返回非 JSON: {text[:200]}"
                    if attempt < 2:
                        time.sleep(2)
                    continue

                code = self._extract_code_from_response(data)
                if code:
                    return code

                explain = self._explain_wechat_server_error(data)
                last_error = f"{url} 未返回 code: {explain} | 原始返回: {data}"
                if data.get("Code") == -13 or data.get("code") == -13:
                    break
            except Exception as exc:
                last_error = f"{url} 请求异常: {exc}"

            if attempt < 2:
                time.sleep(2)

        raise RuntimeError(
            f"获取 {stage} 阶段 wx code 失败: {last_error}。"
            f"如接口路径不同，请设置 WX_CODE_API。"
        )

    def call_api(
        self,
        method: str,
        params: Any = None,
        *,
        need_auth: bool = True,
        retry_reauth: bool = True,
        auth_key: str = "",
        blackbox: Optional[str] = None,
    ) -> Dict[str, Any]:
        pack, params_text = self._request_pack(
            method,
            params,
            need_auth=need_auth,
            auth_key=auth_key,
            blackbox=blackbox,
        )
        ts_ms = int(time.time() * 1000)
        current_auth = auth_key or (self.auth_key if need_auth else "")
        headers = self._headers(method, params_text, int(pack["Sequence"]), ts_ms, current_auth)

        resp = self.session.post(
            SERVICE_URL,
            data={"RequestPack": compact_json(pack)},
            headers=headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        result = parse_xml_json(resp.text)

        if need_auth and result.get("Return") == -100 and retry_reauth and self.refresh_auth():
            return self.call_api(method, params, need_auth=True, retry_reauth=False)
        return result

    def refresh_auth(self) -> bool:
        if not (self.wxid and self.blackbox):
            return False
        # 如果都没有配置，也无法登录
        if not (self.wechat_server or self.yyb_base_url):
            return False

        print("检测到 AuthKey 失效，尝试使用 wxid 自动登录...")

        try:
            code1 = self._wechat_request_code(stage="风控")
            group_risk_params = {
                "AppID": self.appid,
                "Code": "",
                "JS_Code": code1,
                "PolicyCode": "yx_sp_hscrm_login",
                "ExtParams": compact_json({"logintype": 1}),
            }
            group_resp = self.call_api(
                "MALLIF.GroupRiskJson",
                group_risk_params,
                need_auth=False,
                retry_reauth=False,
            )
            if group_resp.get("Return", -1) < 0:
                print(f"  风控接口失败，继续尝试直接登录: {group_resp}")
        except Exception as exc:
            print(f"  风控阶段失败，继续尝试直接登录: {exc}")

        code2 = self._wechat_request_code(stage="登录")

        login_params = {"AppID": self.appid, "JS_Code": code2}
        login_resp = self.call_api("MALLIF.AutoLoginByWechat", login_params, need_auth=False, retry_reauth=False)
        if login_resp.get("Return", -1) < 0:
            raise RuntimeError(f"AutoLoginByWechat 失败: {login_resp}")

        result = json.loads(login_resp.get("Result") or "{}")
        self.auth_key = result.get("AuthKey", "")
        self.openid = result.get("OpenID", "") or self.openid
        return bool(self.auth_key)

    def get_sign_info(self) -> Dict[str, Any]:
        resp = self.call_api("MALLIF.GetSignDailyInfoJson", {})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"查询签到状态失败: {resp.get('ReturnInfo') or resp}")
        return json.loads(resp.get("Result") or "{}")

    def get_sign_activity(self) -> Dict[str, Any]:
        resp = self.call_api("MALLIF.GetSignActivityInfo", {})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"查询签到活动失败: {resp.get('ReturnInfo') or resp}")
        return json.loads(resp.get("Result") or "{}")

    def get_award_info(self, classify: int) -> Dict[str, Any]:
        resp = self.call_api("MALLIF.GetAwardInfoJson", {"LotteryID": 0, "Classify": str(classify)})
        if resp.get("Return", 0) > 0:
            return json.loads(resp.get("Result") or "{}")
        return {}

    def get_vip_tasks(self) -> List[Dict[str, Any]]:
        resp = self.call_api("MALLIF.GetVipTask", {"TaskType": 2})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"查询任务列表失败: {resp.get('ReturnInfo') or resp}")
        return json.loads(resp.get("Result") or "[]")

    def get_kb_catalogs(self, super_id: int) -> List[Dict[str, Any]]:
        resp = self.call_api("MALLIF.GetKBCatalogsJson", {"SuperID": super_id})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"查询文章分类失败: {resp.get('ReturnInfo') or resp}")
        return json.loads(resp.get("Result") or "[]")

    def search_kb_articles(self, catalog: int = 177) -> List[Dict[str, Any]]:
        resp = self.call_api("MALLIF.KBArticleSearchJson", {"KeyWord": "", "Catalog": catalog})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"查询文章列表失败: {resp.get('ReturnInfo') or resp}")
        return json.loads(resp.get("Result") or "[]")

    def get_kb_article_by_id(self, article_id: int) -> Dict[str, Any]:
        if not self.openid:
            raise RuntimeError("缺少 OpenId，无法打开文章详情")
        resp = self.call_api("MALLIF.KBArticleGetByIDJson", {"KBID": str(article_id), "FansID": self.openid})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"查询文章详情失败: {resp.get('ReturnInfo') or resp}")
        return json.loads(resp.get("Result") or "{}")

    def complete_task(self, task_type: int, **kwargs: Any) -> Dict[str, Any]:
        params: Dict[str, Any] = {"TaskType": task_type}
        params.update(kwargs)
        resp = self.call_api("MALLIF.CompleteTask", params)
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"完成任务失败: {resp.get('ReturnInfo') or resp}")
        return json.loads(resp.get("Result") or "{}")

    def get_qualification_times(self, lottery_id: str) -> int:
        resp = self.call_api("MALLIF.GetQualificationTimesJson", {"LotteryID": str(lottery_id)})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"查询抽奖次数失败: {resp.get('ReturnInfo') or resp}")
        try:
            return int(resp.get("Result") or 0)
        except Exception:
            return 0

    def user_award(self, lottery_id: str) -> Dict[str, Any]:
        if not self.openid:
            raise RuntimeError("缺少 OpenId，无法执行抽奖")
        resp = self.call_api("MALLIF.UserAwardJson", {"LotteryID": str(lottery_id), "FansId": self.openid})
        if resp.get("Return", -1) < 0:
            raise RuntimeError(f"抽奖失败: {resp.get('ReturnInfo') or resp}")
        outer = json.loads(resp.get("Result") or "{}")
        return json.loads(outer.get("ActLotteryJoinInfo") or "{}")

    def get_points_info(self) -> Dict[str, Any]:
        resp = self.call_api("MALLIF.GetMemberStatistics", {"Type": "PointBalance,ExpiredPoint"})
        if resp.get("Return", -1) < 0:
            print(f"积分查询失败: {resp.get('ReturnInfo') or resp}")
            return {}
        return json.loads(resp.get("Result") or "{}")

    def get_points(self) -> Optional[int]:
        return self.get_points_info().get("PointBalance")

    def sign(self) -> Dict[str, Any]:
        return self.call_api("MALLIF.SignDailyAttenceJson", {})

def print_sign_info(title: str, info: Dict[str, Any], points: Optional[int]) -> None:
    signed = "是" if info.get("IsSignToday") else "否"
    print(f"{title}:")
    print(f"  今日已签: {signed}")
    print(f"  今日奖励积分: {info.get('Points', 0)}")
    print(f"  连续签到天数: {info.get('Days', 0)}")
    print(f"  累计签到天数: {info.get('TotalSignDays', 0)}")
    if points is not None:
        print(f"  当前积分: {points}")

def print_points_info(data: Dict[str, Any]) -> None:
    if not data:
        return
    print("积分信息:")
    print(f"  可用积分: {data.get('PointBalance', 0)}")
    print(f"  即将过期积分: {data.get('ExpiredPoint', 0)}")

def print_activity_rules(activity: Dict[str, Any]) -> None:
    gifts = activity.get("Gifts") or []
    if not gifts:
        return
    print("签到奖励规则:")
    for gift in gifts:
        reward: List[str] = []
        if gift.get("SignDaysPoint", 0):
            reward.append(f"{gift.get('SignDaysPoint')}积分")
        if gift.get("SignDaysSeed", 0):
            reward.append(f"{gift.get('SignDaysSeed')}种子")
        if gift.get("SignDaysLottery", 0):
            reward.append(f"{gift.get('SignDaysLottery')}抽奖次数")
        reward_text = "+".join(reward) if reward else "无奖励"
        print(f"  连续{gift.get('SignDays', 0)}天: {reward_text}")

def format_lottery_prize(info: Dict[str, Any]) -> str:
    for key in ("AwardName", "PrizeName", "Name", "AwardTitle"):
        value = str(info.get(key, "")).strip()
        if value:
            return value
    award_type = info.get("AwardType")
    award_sort = info.get("AwardSort")
    return f"AwardType={award_type}, AwardSort={award_sort}"

def run_lottery(client: HuiShanClient, classify: int, label: str) -> None:
    activity = client.get_award_info(classify)
    if not activity:
        print(f"{label}: 当前无活动")
        return

    lottery_id = str(activity.get("ID", "")).strip()
    if not lottery_id:
        print(f"{label}: 未获取到 LotteryID")
        return

    times = client.get_qualification_times(lottery_id)
    print(f"{label}: 活动ID={lottery_id} | 剩余抽奖次数={times}")
    if times <= 0:
        return

    if not client.openid:
        print(f"{label}: 缺少 OpenId，跳过抽奖")
        return

    for index in range(1, times + 1):
        prize = client.user_award(lottery_id)
        print(f"{label} 第{index}次: {format_lottery_prize(prize)}")
        time.sleep(1)

def format_task_reward(result: Dict[str, Any]) -> str:
    rewards: List[str] = []
    point = int(result.get("Point", 0) or 0)
    bonus = int(result.get("Bonus", 0) or 0)
    if point > 0:
        rewards.append(f"{point}积分")
    if bonus > 0:
        rewards.append(f"{bonus}成长值")
    return " + ".join(rewards) if rewards else "无奖励"

def complete_article_task_once(
    client: HuiShanClient,
    task_type: int,
    label: str,
    catalog_ids: List[int],
    *,
    require_video: bool = False,
) -> bool:
    for catalog_id in catalog_ids:
        articles = client.search_kb_articles(catalog_id)
        for article in articles:
            if int(article.get("StudyFlag", 0) or 0) == 1:
                continue

            article_id = int(article.get("ID", 0) or 0)
            if not article_id:
                continue

            detail = client.get_kb_article_by_id(article_id)
            kb_article = detail.get("KB_Article") or {}
            if require_video:
                video_path = str(kb_article.get("VideoPath") or detail.get("VideoPath") or "").strip()
                if not video_path:
                    continue

            result = client.complete_task(task_type, ArticleID=str(article_id))
            title = str(
                kb_article.get("Title")
                or detail.get("Title")
                or article.get("Title")
                or article_id
            )
            print(f"    完成{label}: {title} | 奖励 {format_task_reward(result)}")
            return True
    return False

def run_vip_tasks(client: HuiShanClient) -> None:
    try:
        tasks = client.get_vip_tasks()
    except Exception as exc:
        print(f"会员任务: 查询失败: {exc}")
        return

    if not tasks:
        print("会员任务: 无任务")
        return

    print("会员任务:")
    for task in tasks:
        task_type = int(task.get("TaskType", 0) or 0)
        name = str(task.get("Name", task.get("TaskTypeName", task_type)))
        total = int(task.get("CycleTimes", 0) or 0)
        done = int(task.get("CompleteTimes", 0) or 0)
        point = task.get("Point", 0)
        print(f"  {name}: {done}/{total}，奖励 {point} 积分")

        if total > 0 and done >= total:
            continue

        if task_type in (10, 11):
            if not client.openid:
                print(f"    跳过: 缺少 OpenId，无法完成{name}任务")
                continue
            try:
                remain = max(total - done, 1) if total > 0 else 1
                if task_type == 10:
                    catalogs = client.get_kb_catalogs(176)
                    catalog_ids = [int(item.get("ID", 0) or 0) for item in catalogs if int(item.get("ID", 0) or 0) > 0]
                    if not catalog_ids:
                        print("    跳过: 未找到观看视频分类")
                        continue
                    for _ in range(remain):
                        if not complete_article_task_once(
                            client,
                            10,
                            "观看视频",
                            catalog_ids,
                            require_video=True,
                        ):
                            print("    观看视频: 没有可完成的视频内容")
                            break
                        time.sleep(1)
                else:
                    for _ in range(remain):
                        if not complete_article_task_once(client, 11, "品牌动向", [177]):
                            print("    品牌动向: 没有可完成的文章")
                            break
                        time.sleep(1)
            except Exception as exc:
                print(f"    {name}失败: {exc}")
        else:
            print(f"    跳过未适配任务类型: {task_type}")

def fetch_accounts_from_yyb(yyb_base_url: str) -> List[Account]:
    """从 YYB 协议获取账号列表"""
    if not yyb_base_url:
        return []
    try:
        resp = requests.get(f"{yyb_base_url}/accounts", timeout=10)
        data = resp.json()
        if data.get("code") == 0:
            accounts = []
            for item in data.get("data", []):
                wxid = item.get("openid") or item.get("wxid") or ""
                if wxid:
                    remark = item.get("nickname") or item.get("remark") or f"账号{len(accounts)+1}"
                    accounts.append(Account(name=remark, mode="wxid", wxid=wxid))
            if accounts:
                print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                return accounts
    except Exception as e:
        print(f"❌ 从 YYB 获取账号失败: {e}")
    return []

def build_runtime() -> Tuple[str, str, List[Account], str, str]:
    appid = choose_value(
        os.getenv("HSN_APPID", ""),
        APP_ID,
    )
    blackbox = choose_value(
        os.getenv("HSN_BLACKBOX", ""),
        os.getenv("HUISHAN_BLACKBOX", ""),
        DEFAULT_BLACKBOX,
    )
    wechat_server = os.getenv("WECHAT_SERVER", "").strip()
    yyb_base_url = os.getenv("YYB_BASE_URL", "").strip()
    accounts = fetch_accounts_from_yyb(yyb_base_url)
    if not accounts:
        accounts = parse_accounts()

    if not appid:
        raise RuntimeError("未获取到 AppID")
    if not blackbox:
        raise RuntimeError("未获取到 BlackBox，请先提供 HSN_BLACKBOX")
    if not accounts:
        raise RuntimeError("未找到有效账号")

    return appid, blackbox, accounts, wechat_server, yyb_base_url

def run_account(
    account: Account,
    appid: str,
    blackbox: str,
    wechat_server: str,
    yyb_base_url: str,
    check_only: bool,
) -> Tuple[bool, str]:
    account_appid = account.appid or appid
    account_blackbox = account.blackbox or blackbox
    client = HuiShanClient(
        appid=account_appid,
        blackbox=account_blackbox,
        auth_key=account.auth_key,
        openid=account.openid,
        wxid=account.wxid,
        wechat_server=wechat_server,
        yyb_base_url=yyb_base_url,
    )

    if account.mode == "wxid" and not client.auth_key:
        client.refresh_auth()

    before_info = client.get_sign_info()
    before_points_info = client.get_points_info()
    before_points = before_points_info.get("PointBalance")
    print_sign_info("签到前", before_info, before_points)
    print_points_info(before_points_info)

    if check_only:
        return True, "仅查询状态完成"

    already_signed = bool(before_info.get("IsSignToday"))

    if already_signed:
        print("今日已签到，继续执行抽奖和会员任务")
    else:
        activity = client.get_sign_activity()
        if activity:
            print(
                "当前活动:",
                f"基础积分={activity.get('Points', 0)}",
                f"活动ID={activity.get('ID', '')}",
            )
            print_activity_rules(activity)

        sign_resp = client.sign()
        print(f"签到接口返回: Return={sign_resp.get('Return')} ReturnInfo={sign_resp.get('ReturnInfo', '')}")

    after_info = client.get_sign_info()
    after_points_info = client.get_points_info()
    after_points = after_points_info.get("PointBalance")
    print_sign_info("签到后", after_info, after_points)
    print_points_info(after_points_info)
    run_lottery(client, 2, "签到抽奖")
    run_vip_tasks(client)

    if after_info.get("IsSignToday"):
        action_text = "今日已签到" if already_signed else "签到成功"
        if before_points is not None and after_points is not None:
            gained = after_points - before_points
            return True, f"{action_text}，积分变化: {before_points} -> {after_points} (+{gained})"
        return True, action_text

    return False, "执行后仍未显示今日已签"

def main() -> int:
    parser = argparse.ArgumentParser(description="辉山奶签到")
    parser.add_argument("--check-only", action="store_true", help="仅查询状态，不执行签到")
    args = parser.parse_args()

    appid, blackbox, accounts, wechat_server, yyb_base_url = build_runtime()

    print(f"辉山奶签到 共 {len(accounts)} 个账号")
    failed = False

    for idx, account in enumerate(accounts, 1):
        print(f"\n[{idx}] {account.name}")
        try:
            ok, msg = run_account(account, appid, blackbox, wechat_server, yyb_base_url, args.check_only)
        except Exception as exc:
            ok, msg = False, str(exc)

        status = "OK" if ok else "FAIL"
        print(f"[{status}] {msg}")
        if not ok:
            failed = True

        if idx < len(accounts):
            time.sleep(2)

    return 1 if failed else 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("用户中断")
        sys.exit(130)
    except Exception as exc:
        print(f"运行失败: {exc}")
        sys.exit(1)
