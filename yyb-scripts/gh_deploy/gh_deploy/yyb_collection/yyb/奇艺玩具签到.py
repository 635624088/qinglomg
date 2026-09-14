#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
奇艺玩具旗舰店（有赞）签到脚本
基于有赞小程序接口实现

账号输入：
  1) --wxid wxid_xxx
  2) 环境变量 `qiyi` 或 `QIYI`，格式：
     备注#wxid
     备注2#wxid2
     （支持 & 或换行分隔）

必填：
  - YYB_BASE_URL，用于 wxid 登录：
    POST {YYB_BASE_URL}/wxapp/getCode

可选：
  - QIYI_DO_SIGN=1/0，默认 1
  - --cache-file 指定缓存文件（默认脚本同目录）
"""

from __future__ import annotations

import argparse
import json
import os
import random
import string
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

requests.packages.urllib3.disable_warnings()

SCRIPT_NAME = "奇艺玩具旗舰店签到"
APP_ID = "wx6b934944093bc7f5"
KDT_ID = "100408527"
DEFAULT_CHECKIN_ID = "1883412"
APP_VERSION = "2.240.4"  # 从日志中获取
DEFAULT_CACHE_PATH = str((Path(__file__).resolve().parent / "qiyi_cache.json"))

# 使用 Android 微信小程序的 UA（从日志中提取）
UA = (
    "Mozilla/5.0 (Linux; Android 11; IN2010 Build/RP1A.201005.001; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.178 "
    "Mobile Safari/537.36 XWEB/1460205 MMWEBSDK/20260101 MMWEBID/4118 "
    "MicroMessenger/8.0.68.3020(0x28004458) WeChat/arm64 Weixin NetType/WIFI "
    "Language/zh_CN ABI/arm64 MiniProgramEnv/android"
)

BASE_HEADERS = {
    "user-agent": UA,
    "content-type": "application/json",
    "accept": "*/*",
    "referer": f"https://servicewechat.com/{APP_ID}/377/page-frame.html",
    "accept-language": "zh-CN,zh;q=0.9",
}

SUCCESS_FLAGS = {0, "0", True, "true", "True"}


def _gen_uuid(length: int = 24) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=length))


def _env_bool(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _shorten(value: Any, limit: int = 240) -> str:
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + "..."

def _extract_first(obj: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(obj, dict):
        return None
    for key in keys:
        if key in obj and obj[key] not in ("", None):
            return obj[key]
    return None


def parse_accounts(raw: str) -> list[dict[str, str]]:
    accounts: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw.replace("\n", "&").split("&"):
        item = item.strip()
        if not item:
            continue
        if "#" in item:
            remark, wxid = item.split("#", 1)
        else:
            remark, wxid = item, item
        wxid = wxid.strip()
        if not wxid or wxid in seen:
            continue
        seen.add(wxid)
        accounts.append({"remark": remark.strip() or wxid, "wxid": wxid})
    return accounts




def fetch_accounts_from_yyb(yyb_base_url: str) -> list[dict[str, str]]:
    """从 YYB 协议获取账号列表"""
    if not yyb_base_url:
        return []
    try:
        resp = requests.get(f"{yyb_base_url}/accounts", timeout=15)
        data = resp.json()
        if data.get("code") != 0:
            print(f"❌ YYB 获取账号失败: {data.get('msg', '未知错误')}")
            return []
        accounts = []
        for item in data.get("data", []):
            openid = item.get("openid") or item.get("wxid") or ""
            if not openid:
                continue
            remark = item.get("nickname") or item.get("alias") or item.get("remark") or f"账号{len(accounts)+1}"
            accounts.append({"remark": remark, "wxid": openid})
        if accounts:
            print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
        return accounts
    except Exception as e:
        print(f"❌ 从 YYB 获取账号失败: {e}")
        return []

class QiYiSign:
    def __init__(self, yyb_base_url: str, timeout: int, do_sign: bool, cache_file: str):
        self.yyb_base_url = yyb_base_url.rstrip("/")
        self.timeout = timeout
        self.do_sign = do_sign
        self.cache_file = Path(cache_file).expanduser()
        self.cache_data: dict[str, Any] = self._load_cache()

    def _load_cache(self) -> dict[str, Any]:
        if not self.cache_file.exists():
            return {}
        try:
            text = self.cache_file.read_text(encoding="utf-8").strip()
            if not text:
                return {}
            data = json.loads(text)
            if isinstance(data, dict):
                return data
        except Exception:
            return {}
        return {}

    def _save_cache(self) -> None:
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            self.cache_file.write_text(
                json.dumps(self.cache_data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _get_cache_entry(self, wxid: str) -> dict[str, Any]:
        data = self.cache_data.get(wxid)
        return data if isinstance(data, dict) else {}

    def _set_cache_entry(self, wxid: str, access_token: str, session_id: str, checkin_id: str) -> None:
        self.cache_data[wxid] = {
            "access_token": access_token,
            "session_id": session_id,
            "checkin_id": checkin_id,
            "updated_at": int(time.time()),
            "updated_at_text": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        self._save_cache()

    def _clear_cache_entry(self, wxid: str) -> None:
        if wxid in self.cache_data:
            self.cache_data.pop(wxid, None)
            self._save_cache()

    @staticmethod
    def _looks_like_token_invalid(text: str) -> bool:
        t = text.lower()
        keys = ("token", "access_token", "401", "过期", "失效", "invalid", "登录态")
        return any(key in t for key in keys)

    def _make_auth_headers(self, sid: str = "") -> dict[str, str]:
        ftime = int(time.time() * 1000)
        extra_data = {
            "sid": sid,
            "version": APP_VERSION,
            "clientType": "weapp-miniprogram",
            "client": "weapp",
            "bizEnv": "",
            "uuid": _gen_uuid(15) + str(ftime),
            "ftime": ftime,
        }
        return {**BASE_HEADERS, "extra-data": json.dumps(extra_data, separators=(",", ":"))}

    def _make_biz_headers(self, sid: str = "") -> dict[str, str]:
        ftime = int(time.time() * 1000)
        extra_data = {
            "is_weapp": 1,
            "sid": sid or f"YZ{ftime}{_gen_uuid(8)}",
            "version": APP_VERSION,
            "client": "weapp",
            "bizEnv": "wsc",
            "uuid": _gen_uuid(15) + str(ftime),
            "ftime": ftime,
        }
        return {**BASE_HEADERS, "extra-data": json.dumps(extra_data, separators=(",", ":"))}

    def _request_json(self, method: str, url: str, **kwargs: Any) -> tuple[bool, dict[str, Any]]:
        timeout = kwargs.pop("timeout", self.timeout)
        try:
            resp = requests.request(method=method, url=url, timeout=timeout, verify=False, **kwargs)
            data = resp.json()
            if isinstance(data, dict):
                data["_status"] = resp.status_code
                return True, data
            return False, {"_error": f"响应JSON不是对象: {type(data).__name__}", "_status": resp.status_code}
        except Exception as exc:
            return False, {"_error": str(exc)}

    def _fetch_wx_code(self, wxid: str) -> tuple[bool, str]:
        if not self.yyb_base_url:
            return False, "YYB_BASE_URL 未配置"
        url = f"{self.yyb_base_url}/wxapp/getCode"
        payload = {"ref": wxid.strip(), "app_id": APP_ID}
        headers = {"Content-Type": "application/json", "User-Agent": UA}

        last = "空响应"
        for _ in range(3):
            ok, result = self._request_json("POST", url, json=payload, headers=headers, timeout=60)
            if not ok:
                last = result.get("_error", "请求失败")
                time.sleep(2)
                continue

            # YYB 格式: code=0, data.result.code
            if result.get("code") == 0:
                data = result.get("data") or {}
                nested = data.get("result") or data
                code = nested.get("code") or nested.get("Code")
                if code:
                    return True, str(code)
            # 兼容旧格式
            if result.get("Code") in SUCCESS_FLAGS or result.get("code") in {200, "200"}:
                data = result.get("Data") or result.get("data") or {}
                code = _extract_first(data, ("code", "Code", "app_code", "appCode"))
                if code:
                    return True, str(code)
            if result.get("Success") is True:
                data = result.get("Data") or {}
                code = _extract_first(data, ("Code", "code", "app_code", "appCode"))
                if code:
                    return True, str(code)
            last = _shorten(result)
            time.sleep(2)
        return False, f"获取 code 失败: {last} (ref={wxid})"

    def _fetch_access_token(self, code: str) -> tuple[bool, str, str, str]:
        url = f"https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}"
        payload = {
            "appId": APP_ID,
            "code": code,
            "platformName": "weapp",
            "signature": "android",  # 从日志中看到 signature 为 android
            "clientBiz": "weapp_wsc",
            "inWsc": True,
            "kdtId": KDT_ID,
            "extraBizData": {
                "enterOptions": {
                    "extKdtId": int(KDT_ID),
                    "path": "pages/home/dashboard/index",
                    "query": {},
                    "scene": 1008,
                    "referrerInfo": {},
                    "chatType": 3,
                    "mode": "default",
                    "apiCategory": "default",
                },
                "guideBizDataMap": {"from_params": ""},
                "sceneData": {},
            },
        }

        ok, result = self._request_json(
            "POST",
            url,
            headers=self._make_auth_headers(""),
            json=payload,
            timeout=30,
        )
        if not ok:
            return False, "", "", f"登录请求失败: {result.get('_error')}"

        code_value = result.get("code", result.get("Code"))
        if code_value not in SUCCESS_FLAGS:
            return False, "", "", f"登录失败: {_shorten(result)}"

        data = result.get("data") or result.get("Data") or {}
        token = _extract_first(data, ("accessToken", "access_token", "AccessToken"))
        sid = _extract_first(data, ("sessionId", "session_id", "SessionId")) or ""
        if token:
            return True, str(token), str(sid), "登录成功"
        return False, "", "", f"登录成功但未返回 accessToken: {_shorten(result)}"

    def _get_checkin_id(self, access_token: str, session_id: str) -> tuple[bool, str]:
        ok, result = self._request_json(
            "GET",
            "https://h5.youzan.com/wscump/checkin/check-in-info.json",
            headers=self._make_biz_headers(session_id),
            params={"app_id": APP_ID, "kdt_id": KDT_ID, "access_token": access_token},
            timeout=20,
        )
        if not ok:
            return False, f"查询 checkin_id 失败: {result.get('_error')}"
        if result.get("code") != 0:
            return False, f"查询 checkin_id 失败: {_shorten(result)}"

        cid = _extract_first(result.get("data") or {}, ("checkInId", "checkinId", "checkin_id"))
        if not cid:
            return False, f"响应中缺少 checkin_id: {_shorten(result)}"
        return True, str(cid)

    def _get_activity(self, access_token: str, checkin_id: str, session_id: str) -> tuple[bool, dict[str, Any] | str]:
        ok, result = self._request_json(
            "GET",
            "https://h5.youzan.com/wscump/checkin/get_activity_by_yzuid_v2.json",
            headers=self._make_biz_headers(session_id),
            params={
                "checkinId": checkin_id,
                "app_id": APP_ID,
                "kdt_id": KDT_ID,
                "access_token": access_token,
            },
            timeout=20,
        )
        if not ok:
            return False, f"查询签到活动失败: {result.get('_error')}"
        if result.get("code") != 0:
            return False, f"查询签到活动失败: {_shorten(result)}"
        data = result.get("data")
        if not isinstance(data, dict):
            return False, f"查询签到活动返回异常: {_shorten(result)}"
        return True, data

    def _get_month_info(self, access_token: str, checkin_id: str, session_id: str) -> tuple[bool, dict[str, Any] | str]:
        now = datetime.now()
        ok, result = self._request_json(
            "GET",
            "https://h5.youzan.com/wscump/checkin/find_checkin_info_by_month.json",
            headers=self._make_biz_headers(session_id),
            params={
                "checkin_id": checkin_id,
                "year": now.year,
                "month": now.month,
                "app_id": APP_ID,
                "kdt_id": KDT_ID,
                "access_token": access_token,
            },
            timeout=20,
        )
        if not ok:
            return False, f"查询当月签到失败: {result.get('_error')}"
        if result.get("code") != 0:
            return False, f"查询当月签到失败: {_shorten(result)}"
        data = result.get("data")
        if not isinstance(data, dict):
            return False, f"查询当月签到返回异常: {_shorten(result)}"
        return True, data

    def _do_sign(self, access_token: str, checkin_id: str, session_id: str) -> tuple[bool, str]:
        ok, result = self._request_json(
            "GET",
            "https://h5.youzan.com/wscump/checkin/checkinV2.json",
            headers=self._make_biz_headers(session_id),
            params={
                "checkinId": checkin_id,
                "app_id": APP_ID,
                "kdt_id": KDT_ID,
                "access_token": access_token,
            },
            timeout=20,
        )
        if not ok:
            return False, f"签到请求失败: {result.get('_error')}"

        if result.get("code") == 0:
            data = result.get("data") or {}
            if data.get("success"):
                days = data.get("times") or data.get("days") or "?"
                reward = ""
                items = data.get("list")
                if isinstance(items, list) and items and isinstance(items[0], dict):
                    infos = items[0].get("infos")
                    if isinstance(infos, dict):
                        reward = str(infos.get("title") or infos.get("desc") or "")
                msg = f"签到成功，第 {days} 天"
                if reward:
                    msg += f"，奖励={reward}"
                return True, msg
            # 如果 success 为 false 但 code=0，可能今天已签到
            if data.get("isCheckin") is True or data.get("hasCheckin") is True:
                return True, "今天已签到"
            return False, f"签到接口返回失败: {_shorten(result)}"

        err_code = result.get("code")
        msg = result.get("msg", _shorten(result))
        if err_code in (401, 40101, 10004, 1000030071):
            return False, f"access_token 已过期: {msg}"
        return False, f"签到失败: {msg}"

    @staticmethod
    def _format_status(activity: dict[str, Any], month: dict[str, Any]) -> str:
        is_checkin = bool(activity.get("isCheckin"))
        continues = activity.get("continuesDay", "?")
        month_days = 0
        checkin_date = month.get("checkin_date")
        if isinstance(checkin_date, list):
            month_days = len(checkin_date)

        daily_desc = ""
        rewards = activity.get("dailyRewards")
        if isinstance(rewards, list) and rewards and isinstance(rewards[0], dict):
            daily_desc = str(rewards[0].get("desc") or "")

        text = f"{'已签到' if is_checkin else '未签到'}，连续={continues}天，本月签到={month_days}天"
        if daily_desc:
            text += f"，日常奖励={daily_desc}"
        return text

    def _acquire_session(self, wxid: str, lines: list[str]) -> tuple[bool, str, str, str]:
        # 优先用 wxid，回退到备注作为缓存 key
        cache_key = wxid or lines[0].replace("备注=", "") if lines else wxid
        entry = self._get_cache_entry(cache_key)
        if entry:
            token = str(entry.get("access_token", "")).strip()
            session_id = str(entry.get("session_id", "")).strip()
            checkin_id = str(entry.get("checkin_id", "")).strip() or DEFAULT_CHECKIN_ID
            updated = str(entry.get("updated_at_text", "")).strip() or "-"
            if token:
                ok, cid_or_msg = self._get_checkin_id(token, session_id)
                if ok:
                    checkin_id = str(cid_or_msg)
                    self._set_cache_entry(cache_key, token, session_id, checkin_id)
                    return True, token, session_id, checkin_id
                self._clear_cache_entry(cache_key)

        lines.append("开始重新获取登录参数")
        ok, code_or_msg = self._fetch_wx_code(wxid)
        if not ok:
            lines.append(code_or_msg)
            return False, "", "", ""
        app_code = code_or_msg

        ok, token, session_id, msg = self._fetch_access_token(app_code)
        if not ok:
            lines.append(f"登录失败: {msg}")
            return False, "", "", ""

        ok, cid_or_msg = self._get_checkin_id(token, session_id)
        checkin_id = str(cid_or_msg) if ok else DEFAULT_CHECKIN_ID

        self._set_cache_entry(cache_key, token, session_id, checkin_id)
        return True, token, session_id, checkin_id

    def _run_sign_flow(self, access_token: str, session_id: str, checkin_id: str) -> tuple[bool, list[str], bool]:
        lines: list[str] = []
        ok, activity_result = self._get_activity(access_token, checkin_id, session_id)
        if not ok:
            msg = str(activity_result)
            lines.append(msg)
            return False, lines, self._looks_like_token_invalid(msg)
        assert isinstance(activity_result, dict)

        ok, month_result = self._get_month_info(access_token, checkin_id, session_id)
        if not ok:
            msg = str(month_result)
            lines.append(msg)
            return False, lines, self._looks_like_token_invalid(msg)
        assert isinstance(month_result, dict)

        status_before = self._format_status(activity_result, month_result)
        lines.append(f"签到前状态={status_before}")

        if not self.do_sign:
            return True, lines, False

        if activity_result.get("isCheckin") is True:
            lines.append("今天已签到")
            return True, lines, False

        ok, sign_msg = self._do_sign(access_token, checkin_id, session_id)
        lines.append(sign_msg)
        if not ok:
            return False, lines, self._looks_like_token_invalid(sign_msg)

        ok, activity_after = self._get_activity(access_token, checkin_id, session_id)
        ok2, month_after = self._get_month_info(access_token, checkin_id, session_id)
        if ok and ok2 and isinstance(activity_after, dict) and isinstance(month_after, dict):
            lines.append(f"签到后状态={self._format_status(activity_after, month_after)}")
        return True, lines, False

    def run_for_account(self, remark: str, wxid: str) -> tuple[bool, list[str]]:
        lines: list[str] = []
        lines.append(f"备注={remark}")
        lines.append(f"wxid={wxid}")

        ok, access_token, session_id, checkin_id = self._acquire_session(wxid, lines)
        if not ok:
            return False, lines


        ok, flow_lines, token_invalid = self._run_sign_flow(access_token, session_id, checkin_id)
        lines.extend(flow_lines)
        if ok:
            return True, lines

        if token_invalid:
            self._clear_cache_entry(wxid)
            ok, access_token, session_id, checkin_id = self._acquire_session(wxid, lines)
            if not ok:
                return False, lines
            lines.append("已重新获取参数，开始重试")
            ok2, flow_lines2, _ = self._run_sign_flow(access_token, session_id, checkin_id)
            lines.extend(flow_lines2)
            return ok2, lines

        return False, lines


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="奇艺玩具旗舰店有赞签到脚本（wxid登录，支持参数缓存，基于YYB协议）")
    parser.add_argument("--wxid", default="", help="单个 wxid")
    parser.add_argument("--remark", default="", help="配合 --wxid 使用的备注")
    parser.add_argument("--yyb-base-url", default=os.getenv("YYB_BASE_URL", ""), help="YYB 协议服务地址")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP超时秒数")
    parser.add_argument("--cache-file", default=DEFAULT_CACHE_PATH, help="缓存文件路径")
    parser.add_argument(
        "--do-sign",
        choices=("1", "0"),
        default=None,
        help="1=执行签到(默认), 0=仅查询",
    )
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    do_sign = _env_bool("QIYI_DO_SIGN", True) if args.do_sign is None else args.do_sign == "1"

    accounts: list[dict[str, str]] = []
    # 优先从 YYB 协议获取账号
    yyb_accounts = fetch_accounts_from_yyb(args.yyb_base_url.strip())
    if yyb_accounts:
        accounts = yyb_accounts
    elif args.wxid.strip():
        wxid = args.wxid.strip()
        accounts = [{"remark": args.remark.strip() or wxid, "wxid": wxid}]
    else:
        raw = os.getenv("qiyi", "") or os.getenv("QIYI", "")
        accounts = parse_accounts(raw)

    if not accounts:
        print("未找到账号")
        print("用法1: python qiyi_sign.py --wxid wxid_xxx")
        print("用法2: 设置环境变量 qiyi='备注#wxid&备注2#wxid2'")
        print("用法3: 设置环境变量 YYB_BASE_URL，自动从 YYB 获取账号")
        return 1

    worker = QiYiSign(
        yyb_base_url=args.yyb_base_url.strip(),
        timeout=max(args.timeout, 5),
        do_sign=do_sign,
        cache_file=args.cache_file,
    )

    mode = "签到+查询" if do_sign else "仅查询"
    print(f"{SCRIPT_NAME} | 模式={mode} | 账号数={len(accounts)}")

    success = 0
    for idx, account in enumerate(accounts, 1):
        remark = account["remark"]
        wxid = account["wxid"]
        print(f"\n[{idx}/{len(accounts)}] {remark}")
        ok, lines = worker.run_for_account(remark, wxid)
        for line in lines:
            print(f"  {line}")
        print(f"  结果={'成功' if ok else '失败'}")
        if ok:
            success += 1
        if idx < len(accounts):
            time.sleep(2)

    print(f"\n执行完成：成功={success}，失败={len(accounts) - success}")
    return 0 if success == len(accounts) else 2


if __name__ == "__main__":
    raise SystemExit(main())