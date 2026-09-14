#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
孩视宝有赞签到脚本
基于HAR文件分析：小程序ID wxf7c51121c72bfb05，商户ID 45216658
签到活动ID通过接口动态获取，无需硬编码。
支持多账，缓存登录态，自动重试。

命令行参数：
 
 
  --cache-file 缓存文件路径

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

SCRIPT_NAME = "孩视宝有赞签到"
APP_ID = "wxf7c51121c72bfb05"
KDT_ID = "45216658"
APP_VERSION = "3.195.7"  # 取自HAR
DEFAULT_CACHE_PATH = str((Path(__file__).resolve().parent / "haishibao_cache.json"))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf2541917) XWEB/19749"
)

BASE_HEADERS = {
    "user-agent": UA,
    "xweb_xhr": "1",
    "content-type": "application/json",
    "accept": "*/*",
    "referer": f"https://servicewechat.com/{APP_ID}/203/page-frame.html",  # HAR中为203
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
    try:
        url = f"{yyb_base_url}/accounts"
        resp = requests.get(url, timeout=15)
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            accounts = []
            for acc in data["data"]:
                openid = acc.get("openid", "")
                nickname = acc.get("nickname", "") or acc.get("alias", "") or openid
                if openid:
                    accounts.append({"remark": nickname, "wxid": openid})
            return accounts
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []

class HaishibaoSign:
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
            "bizEnv": "retail",  # HAR中大部分请求使用retail
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

            if result.get("Code") in SUCCESS_FLAGS or result.get("code") in SUCCESS_FLAGS:
                data = result.get("Data") or result.get("data") or {}
                # YYB 协议返回 data.result.code，兼容其他格式
                nested = data.get("result") or data.get("Result") or data
                code = _extract_first(nested, ("code", "Code", "app_code", "appCode"))
                if code:
                    return True, str(code)
            if result.get("Success") is True:
                data = result.get("Data") or {}
                code = _extract_first(data, ("Code", "code", "app_code", "appCode"))
                if code:
                    return True, str(code)
            last = _shorten(result)
            time.sleep(2)
        return False, f"获取 wx code 失败: {last}"

    def _fetch_access_token(self, code: str) -> tuple[bool, str, str, str]:
        url = f"https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}"
        # 参考HAR中的请求体，使用较通用的payload
        payload = {
            "appId": APP_ID,
            "code": code,
            "platformName": "weapp",
            "signature": "windows",
            "clientBiz": "weapp_wsc",
            "inWsc": True,
            "kdtId": KDT_ID,
            "extraBizData": {
                "enterOptions": {
                    "extKdtId": int(KDT_ID),
                    "path": "pages/home/dashboard/index",
                    "query": {},
                    "scene": 1005,
                    "referrerInfo": {},
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
            return False, "", "", result.get("_error", "请求失败")

        code_value = result.get("code", result.get("Code"))
        success = code_value in SUCCESS_FLAGS or result.get("Success") is True
        if not success:
            return False, "", "", f"登录失败: {_shorten(result)}"

        data = result.get("data") or result.get("Data") or {}
        token = _extract_first(data, ("accessToken", "access_token", "AccessToken"))
        sid = _extract_first(data, ("sessionId", "session_id", "SessionId")) or ""
        if token:
            return True, str(token), str(sid), "登录成功"
        return False, "", "", f"登录成功但未返回accessToken: {_shorten(result)}"

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

    def _get_activity(
        self, access_token: str, checkin_id: str, session_id: str
    ) -> tuple[bool, dict[str, Any] | str]:
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

    def _get_month_info(
        self, access_token: str, checkin_id: str, session_id: str
    ) -> tuple[bool, dict[str, Any] | str]:
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
            return True, "今天已签到"

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
        entry = self._get_cache_entry(wxid)
        if entry:
            token = str(entry.get("access_token", "")).strip()
            session_id = str(entry.get("session_id", "")).strip()
            checkin_id = str(entry.get("checkin_id", "")).strip()
            updated = str(entry.get("updated_at_text", "")).strip() or "-"
            if token:
                lines.append(f"读取缓存参数：更新时间={updated}")
                if not checkin_id:
                    ok, cid = self._get_checkin_id(token, session_id)
                    if ok:
                        checkin_id = cid
                        lines.append(f"动态获取 checkin_id={checkin_id}")
                    else:
                        lines.append(f"获取 checkin_id 失败: {cid}")
                        checkin_id = ""  # 后续重新获取
                if checkin_id:
                    # 验证缓存是否有效
                    ok, _ = self._get_checkin_id(token, session_id)  # 用该接口验证token
                    if ok:
                        lines.append("缓存有效，直接使用缓存参数")
                        self._set_cache_entry(wxid, token, session_id, checkin_id)
                        return True, token, session_id, checkin_id
                    else:
                        lines.append("缓存失效，重新获取")
                        self._clear_cache_entry(wxid)
                else:
                    lines.append("缓存中无 checkin_id，重新获取")
                    self._clear_cache_entry(wxid)

        lines.append("开始重新获取登录参数")
        ok, code_or_msg = self._fetch_wx_code(wxid)
        if not ok:
            lines.append(code_or_msg)
            return False, "", "", ""
        app_code = code_or_msg
        lines.append(f"app_code={app_code[:16]}...")

        ok, token, session_id, msg = self._fetch_access_token(app_code)
        if not ok:
            lines.append(f"登录失败: {msg}")
            return False, "", "", ""

        ok, cid_or_msg = self._get_checkin_id(token, session_id)
        if ok:
            checkin_id = str(cid_or_msg)
            lines.append(f"checkin_id={checkin_id}")
        else:
            lines.append(f"获取 checkin_id 失败: {cid_or_msg}")
            return False, "", "", ""

        self._set_cache_entry(wxid, token, session_id, checkin_id)
        lines.append(f"参数已缓存到文件：{self.cache_file}")
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
            lines.append("仅查询模式，跳过签到")
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

        lines.append(f"access_token={access_token[:16]}...")
        lines.append(f"session_id={session_id[:16]}..." if session_id else "session_id=(空)")
        lines.append(f"checkin_id={checkin_id}")

        ok, flow_lines, token_invalid = self._run_sign_flow(access_token, session_id, checkin_id)
        lines.extend(flow_lines)
        if ok:
            return True, lines

        if token_invalid:
            lines.append("检测到参数疑似失效，清理缓存并重试一次")
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
    parser = argparse.ArgumentParser(description="孩视宝有赞签到脚本（wxid登录，支持参数缓存）")
    parser.add_argument("--wxid", default="", help="单个 wxid")
    parser.add_argument("--remark", default="", help="配合 --wxid 使用的备注")
    parser.add_argument("--yyb-base-url", default=os.getenv("YYB_BASE_URL", ""), help="YYB 协议地址")
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
    do_sign = _env_bool("HAISHIBAO_DO_SIGN", True) if args.do_sign is None else args.do_sign == "1"

    accounts: list[dict[str, str]] = []
    if args.wxid.strip():
        wxid = args.wxid.strip()
        accounts = [{"remark": args.remark.strip() or wxid, "wxid": wxid}]
    else:
        # 优先从 YYB 协议获取账号
        yyb_url = args.yyb_base_url.strip()
        if yyb_url:
            accounts = fetch_accounts_from_yyb(yyb_url)
        # 回退到环境变量
        if not accounts:
            raw = os.getenv("haishibao", "") or os.getenv("HAISHIBAO", "")
            accounts = parse_accounts(raw)

    if not accounts:
        print("未找到账号")

        return 1

    worker = HaishibaoSign(
        yyb_base_url=args.yyb_base_url.strip(),
        timeout=max(args.timeout, 5),
        do_sign=do_sign,
        cache_file=args.cache_file,
    )

    mode = "签到+查询" if do_sign else "仅查询"
    print(f"{SCRIPT_NAME} | 模式={mode} | 账号数={len(accounts)}")
    print(f"缓存文件: {worker.cache_file}")

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
