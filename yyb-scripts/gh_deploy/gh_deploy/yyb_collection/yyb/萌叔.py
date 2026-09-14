#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
作者: A
名称: 萌叔宝贝鹅服务中心 - 签到 + 发布心愿任务
#小程序://萌叔宝贝鹅服务中心/x3qkK01hWCre65I


- MENGSHU_TIMEOUT
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import pathlib
import random
import string
import sys
import time
import zlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


WECHAT_ACCOUNT_LINES = """
a#wxid_xxxxx
""".strip()


IN_SCRIPT_ENV: dict[str, Any] = {
    "ssbb": "",
    "wxid": "",
    "wxid_lines": WECHAT_ACCOUNT_LINES,
    "yyb_base_url": "",
    "wx_code": "",
    "har_path": "",
    "authorization": "",
    "appid": "wxbc996a6b14810c99",
    "version": "2.30.3",
    "envversion": "release",
    "xy_extra_data": "",
    "do_sign": True,
    "do_wish": True,
    "wish_times": 1,
    "wish_content": "",
    "wish_category": "",
    "wish_brand": "",
    "wish_prod": "",
    "timeout": 20,
}


API_BASE = "https://smp-api.iyouke.com"
TASK_TYPE_SIGN = 4
TASK_TYPE_WISH = 22
DEFAULT_APPID = "wxbc996a6b14810c99"
DEFAULT_VERSION = "2.30.3"
DEFAULT_ENVVERSION = "release"
DEFAULT_SCENE_ID = "1005"
DEFAULT_REFERER = f"https://servicewechat.com/{DEFAULT_APPID}/23/page-frame.html"
DEFAULT_YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
    "UnifiedPCWindowsWechat(0xf2541917) XWEB/19749"
)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 0, payload: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload


@dataclass
class HarContext:
    authorization: str = ""
    appid: str = DEFAULT_APPID
    version: str = DEFAULT_VERSION
    envversion: str = DEFAULT_ENVVERSION
    xy_extra_data: str = ""
    referer: str = DEFAULT_REFERER
    user_agent: str = DEFAULT_USER_AGENT
    har_path: pathlib.Path | None = None


def cfg(name: str, env_keys: tuple[str, ...], default: Any = "") -> Any:
    for key in env_keys:
        value = os.getenv(key)
        if value not in (None, ""):
            return value
    value = IN_SCRIPT_ENV.get(name, default)
    return default if value in (None, "") else value


def to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_wechat_account_lines(text: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for line_no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        alias, sep, wxid = line.partition("#")
        alias = alias.strip()
        wxid = wxid.strip()
        if not sep or not alias or not wxid:
            raise ValueError(f"wxid_lines 第{line_no}行格式错误: {raw}")
        mapping[alias] = wxid
    return mapping


def resolve_wxid_selector(selector: str, account_map: dict[str, str]) -> tuple[str, str]:
    value = selector.strip()
    if not value:
        return "", ""
    if value in account_map:
        return value, account_map[value]
    for alias, wxid in account_map.items():
        if wxid == value:
            return alias, wxid
    return "", value


def parse_ssbb_accounts(raw_text: str) -> list[dict[str, str]]:
    accounts: list[dict[str, str]] = []
    seen: set[str] = set()
    for line_no, raw in enumerate(raw_text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        parts = [part.strip() for part in line.split("#")]
        remark = f"account_{line_no}"
        wxid = ""
        authorization = ""
        wx_code = ""

        if len(parts) == 1:
            value = parts[0]
            remark = value or remark
            if value.lower().startswith("bearer"):
                authorization = value
            else:
                wxid = value
        elif len(parts) == 2:
            remark = parts[0] or remark
            value = parts[1]
            if value.lower().startswith("bearer"):
                authorization = value
            elif value.lower().startswith("code:"):
                wx_code = value[5:].strip()
            else:
                wxid = value
        else:
            remark = parts[0] or remark
            wxid = parts[1]
            value = parts[2]
            if value.lower().startswith("bearer"):
                authorization = value
            else:
                wx_code = value

        if not (wxid or authorization or wx_code):
            continue
        key = f"{wxid}|{authorization}|{wx_code}"
        if key in seen:
            continue
        seen.add(key)
        accounts.append(
            {
                "remark": remark,
                "wxid": wxid,
                "authorization": authorization,
                "wx_code": wx_code,
            }
        )
    return accounts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MengShuBaoBei sign + wish task script")
    parser.add_argument(
        "--ssbb",
        default=cfg("ssbb", ("ssbb", "SSBB"), ""),
        help="multi-account lines from env ssbb",
    )
    parser.add_argument(
        "--wxid",
        default=cfg("wxid", ("MENGSHU_WXID", "WXID"), ""),
        help="wxid or alias in --wxid-lines",
    )
    parser.add_argument(
        "--wxid-lines",
        default=cfg("wxid_lines", ("MENGSHU_WXID_LINES", "WECHAT_ACCOUNT_LINES"), WECHAT_ACCOUNT_LINES),
        help="alias#wxid lines",
    )
    parser.add_argument(
        "--yyb-base-url",
        default=cfg("yyb_base_url", ("MENGSHU_YYB_BASE_URL", "YYB_BASE_URL"), DEFAULT_YYB_BASE_URL),
        help="YYB 协议地址",
    )
    parser.add_argument(
        "--wx-code",
        default=cfg("wx_code", ("MENGSHU_WX_CODE",), ""),
        help="manual wx.login code (skip WechatServer)",
    )
    parser.add_argument(
        "--har",
        default=cfg("har_path", ("MENGSHU_HAR",), ""),
        help="HAR file path",
    )
    parser.add_argument(
        "--authorization",
        default=cfg("authorization", ("MENGSHU_AUTHORIZATION", "MENGSHU_TOKEN"), ""),
        help="authorization header",
    )
    parser.add_argument("--appid", default=cfg("appid", ("MENGSHU_APPID",), DEFAULT_APPID), help="appid header")
    parser.add_argument("--version", default=cfg("version", ("MENGSHU_VERSION",), DEFAULT_VERSION), help="version header")
    parser.add_argument(
        "--envversion",
        default=cfg("envversion", ("MENGSHU_ENVVERSION",), DEFAULT_ENVVERSION),
        help="envversion header",
    )
    parser.add_argument(
        "--xy-extra-data",
        default=cfg("xy_extra_data", ("MENGSHU_XY_EXTRA_DATA",), ""),
        help="xy-extra-data header",
    )
    parser.add_argument(
        "--wish-content",
        default=cfg("wish_content", ("MENGSHU_WISH_CONTENT",), ""),
        help="wish content",
    )
    parser.add_argument(
        "--category",
        default=cfg("wish_category", ("MENGSHU_WISH_CATEGORY",), ""),
        help="wish category",
    )
    parser.add_argument("--brand", default=cfg("wish_brand", ("MENGSHU_WISH_BRAND",), ""), help="wish brand")
    parser.add_argument("--prod-name", default=cfg("wish_prod", ("MENGSHU_WISH_PROD",), ""), help="wish product name")
    parser.add_argument(
        "--wish-times",
        type=int,
        default=to_int(cfg("wish_times", ("MENGSHU_WISH_TIMES",), 1), 1),
        help="publish wish + submit times",
    )
    parser.add_argument("--sleep", type=float, default=1.0, help="sleep seconds between wish loops")
    parser.add_argument(
        "--timeout",
        type=float,
        default=to_float(cfg("timeout", ("MENGSHU_TIMEOUT",), 20), 20),
        help="HTTP timeout seconds",
    )
    parser.add_argument("--status-only", action="store_true", help="only query status")
    parser.add_argument("--verbose", action="store_true", help="print more details")
    parser.add_argument("--do-sign", dest="do_sign", action="store_true", help="run sign task")
    parser.add_argument("--no-sign", dest="do_sign", action="store_false", help="skip sign task")
    parser.add_argument("--do-wish", dest="do_wish", action="store_true", help="run wish task")
    parser.add_argument("--no-wish", dest="do_wish", action="store_false", help="skip wish task")
    parser.set_defaults(
        do_sign=to_bool(cfg("do_sign", ("MENGSHU_DO_SIGN",), True), True),
        do_wish=to_bool(cfg("do_wish", ("MENGSHU_DO_WISH",), True), True),
    )
    return parser.parse_args()


def pick_har_file(explicit_path: str) -> pathlib.Path | None:
    text = explicit_path.strip()
    if not text:
        return None
    path = pathlib.Path(text).expanduser()
    return path if path.exists() else None


def load_json(path: pathlib.Path) -> dict[str, Any]:
    if not path.exists():
        raise RuntimeError(f"HAR 文件不存在: {path}")
    if path.stat().st_size == 0:
        raise RuntimeError(f"HAR 文件为空: {path}")
    try:
        with path.open("r", encoding="utf-8-sig") as file:
            return json.load(file)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"HAR JSON 格式错误: {path} | {exc}") from exc
    except OSError as exc:
        raise RuntimeError(f"读取 HAR 文件失败: {path} | {exc}") from exc


def header_map(headers: list[dict[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in headers:
        name = str(item.get("name", "")).lower().strip()
        value = str(item.get("value", "")).strip()
        if name:
            result[name] = value
    return result


def extract_har_context(har_path: pathlib.Path) -> HarContext:
    data = load_json(har_path)
    entries = data.get("log", {}).get("entries", [])
    context = HarContext(har_path=har_path)
    for entry in reversed(entries):
        request = entry.get("request", {})
        url = str(request.get("url", ""))
        if API_BASE not in url:
            continue
        headers = header_map(request.get("headers", []))
        path = urlsplit(url).path
        if not path.startswith("/dtapi/"):
            continue
        if not context.authorization and headers.get("authorization"):
            context.authorization = headers["authorization"]
        if headers.get("appid"):
            context.appid = headers["appid"]
        if headers.get("version"):
            context.version = headers["version"]
        if headers.get("envversion"):
            context.envversion = headers["envversion"]
        if headers.get("xy-extra-data"):
            context.xy_extra_data = headers["xy-extra-data"]
        if headers.get("referer"):
            context.referer = headers["referer"]
        if headers.get("user-agent"):
            context.user_agent = headers["user-agent"]
    if not context.xy_extra_data:
        context.xy_extra_data = (
            f"appid={context.appid};version={context.version};"
            f"envVersion={context.envversion};senceId={DEFAULT_SCENE_ID}"
        )
    return context


def parse_json_text(text: str) -> dict[str, Any]:
    if not text:
        return {}
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        return {}


def mask_secret(value: str) -> str:
    if len(value) <= 16:
        return value
    return f"{value[:8]}...{value[-8:]}"


def normalize_yyb_server(server: str) -> str:
    value = server.strip().rstrip("/")
    if not value:
        return ""
    if value.endswith("/wxapp/getCode"):
        return value
    return value + "/wxapp/getCode"


def extract_wechat_code(response: dict[str, Any]) -> str:
    # YYB 格式：code=0, data.result.code
    if isinstance(response, dict):
        data = response.get("data") or {}
        if isinstance(data, dict):
            result = data.get("result")
            if isinstance(result, dict):
                code = result.get("code")
                if code:
                    return str(code).strip()
    # 旧格式兼容
    if response.get("Code") == 0:
        data = response.get("Data") or {}
        return str(data.get("code") or data.get("Code") or "").strip()
    if response.get("Success") is True:
        data = response.get("Data") or {}
        return str(data.get("Code") or data.get("code") or "").strip()
    if response.get("code") in (0, 200):
        data = response.get("data") or {}
        return str(data.get("code") or data.get("Code") or "").strip()
    return ""


def request_wechat_code(server: str, wxid: str, appid: str, user_agent: str, timeout: float) -> str:
    url = normalize_yyb_server(server)
    if not url:
        raise ApiError("YYB_BASE_URL 为空")
    
    # 判断是否使用 YYB 协议
    is_yyb = "yyb" in server or ":3003" in server or "18080" in server
    
    if is_yyb:
        payload = {"ref": wxid, "app_id": appid}
    else:
        payload = {"wxid": wxid, "appid": appid}
    
    req = Request(
        url=url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": user_agent},
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"{'YYB' if is_yyb else 'WechatServer'} HTTP 异常 {exc.code}", status=int(exc.code or 0), payload=text) from exc
    except URLError as exc:
        raise ApiError(f"{'YYB' if is_yyb else 'WechatServer'} 网络错误: {exc}") from exc

    data = parse_json_text(text)
    if not data:
        raise ApiError(f"{'YYB' if is_yyb else 'WechatServer'} 返回非 JSON", payload=text)
    code = extract_wechat_code(data)
    if not code:
        raise ApiError(f"{'YYB' if is_yyb else 'WechatServer'} 未返回 code", payload=data)
    return code


class MengShuClient:
    def __init__(self, context: HarContext, timeout: float = 20.0, verbose: bool = False) -> None:
        self.context = context
        self.timeout = timeout
        self.verbose = verbose

    def _headers(self, include_auth: bool = True) -> dict[str, str]:
        headers = {
            "accept": "*/*",
            "content-type": "application/json",
            "xweb_xhr": "1",
            "accept-language": "zh-CN,zh;q=0.9",
            "appid": self.context.appid,
            "version": self.context.version,
            "envversion": self.context.envversion,
            "xy-extra-data": self.context.xy_extra_data,
            "referer": self.context.referer,
            "user-agent": self.context.user_agent,
        }
        if include_auth and self.context.authorization:
            headers["authorization"] = self.context.authorization
        return {k: v for k, v in headers.items() if v}

    @staticmethod
    def _decode_body(raw: bytes, content_encoding: str) -> str:
        encoding = content_encoding.lower().strip()
        data = raw
        if encoding == "gzip":
            try:
                data = gzip.decompress(raw)
            except OSError:
                pass
        elif encoding == "deflate":
            try:
                data = zlib.decompress(raw)
            except zlib.error:
                try:
                    data = zlib.decompress(raw, -zlib.MAX_WBITS)
                except zlib.error:
                    pass
        return data.decode("utf-8", errors="replace")

    def request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        allow_api_error: bool = False,
        allow_empty: bool = False,
        include_auth: bool = True,
    ) -> dict[str, Any]:
        final_path = path
        if params:
            query = urlencode({k: v for k, v in params.items() if v is not None})
            if query:
                final_path = f"{path}?{query}"
        url = f"{API_BASE}{final_path}"
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(url=url, data=body, headers=self._headers(include_auth=include_auth), method=method.upper())

        if self.verbose:
            print(f"[调试] {method.upper()} {final_path} 请求体={payload}")

        status = 0
        raw = b""
        headers: dict[str, str] = {}
        try:
            with urlopen(request, timeout=self.timeout) as response:
                status = int(response.getcode() or 0)
                headers = dict(response.headers)
                raw = response.read()
        except HTTPError as exc:
            status = int(exc.code or 0)
            headers = dict(exc.headers or {})
            raw = exc.read()
        except URLError as exc:
            raise ApiError(f"网络错误: {exc}") from exc

        text = self._decode_body(raw, headers.get("Content-Encoding", ""))
        data = parse_json_text(text)

        if status >= 400:
            raise ApiError(f"HTTP {status} 接口异常: {final_path}", status=status, payload=data or text)
        if not text and allow_empty:
            return {}
        if not data:
            raise ApiError(f"接口返回非 JSON: {final_path}", status=status, payload=text)
        if not allow_api_error and data.get("error") not in (None, 0, "0"):
            raise ApiError(
                f"接口业务异常: {final_path}, error={data.get('error')}",
                status=status,
                payload=data,
            )
        return data

    def app_login(self, wx_code: str, app_type: int = 1) -> dict[str, Any]:
        payload = {"appType": app_type, "principal": wx_code}
        resp = self.request_json(
            "POST",
            "/dtapi/appLogin",
            payload=payload,
            allow_api_error=True,
            include_auth=False,
        )
        if resp.get("error") not in (None, 0, "0"):
            raise ApiError(f"appLogin 失败: error={resp.get('error')}", payload=resp)

        data = resp.get("data") if isinstance(resp.get("data"), dict) else resp
        access_token = (
            str(data.get("access_token") or resp.get("access_token") or "").strip()
            if isinstance(data, dict)
            else ""
        )
        if not access_token:
            raise ApiError("appLogin 成功但 access_token 为空", payload=resp)

        self.context.authorization = f"bearer{access_token}"
        return data if isinstance(data, dict) else resp

    def get_task_list(self) -> dict[str, Any]:
        return self.request_json("GET", "/dtapi/points/task/list")

    def get_task_detail(self, task_type: int) -> dict[str, Any]:
        return self.request_json("GET", f"/dtapi/points/task/{task_type}")

    def get_sign_info(self) -> dict[str, Any]:
        return self.request_json("GET", "/dtapi/pointsSign/user/pointsInfo/query")

    def sign_today(self) -> dict[str, Any]:
        return self.request_json(
            "GET",
            "/dtapi/pointsSign/user/sign",
            params={"time": str(int(time.time() * 1000))},
            allow_api_error=True,
        )

    def get_content_conf(self) -> dict[str, Any]:
        return self.request_json("POST", "/dtapi/p/wish/contentConf", {})

    def publish_wish(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.request_json("POST", "/dtapi/p/myWish/wish", payload)

    def submit_task(self, task_type: int, biz_id: str) -> dict[str, Any]:
        return self.request_json("POST", "/dtapi/points/task/submit", {"taskType": task_type, "bizId": biz_id})


def extract_task_from_list(task_list_payload: dict[str, Any], task_type: int) -> dict[str, Any]:
    groups = task_list_payload.get("data", {}).get("taskGroupList", [])
    for group in groups:
        for task in group.get("tasks", []):
            try:
                cur_type = int(task.get("type"))
            except (TypeError, ValueError):
                continue
            if cur_type == task_type:
                return task
    return {}


def extract_categories(content_conf_payload: dict[str, Any]) -> list[str]:
    conf_list = content_conf_payload.get("data", {}).get("contentConfTOList", [])
    for item in conf_list:
        if item.get("bizKey") != "cate":
            continue
        content_conf = item.get("contentConf") or {}
        names = content_conf.get("cateName") or []
        if isinstance(names, list):
            return [str(name).strip() for name in names if str(name).strip()]
    return []


def random_suffix(length: int = 4) -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def make_wish_payload(
    idx: int,
    categories: list[str],
    wish_content: str,
    category: str,
    brand: str,
    prod_name: str,
) -> dict[str, str]:
    now_tag = datetime.now().strftime("%Y%m%d%H%M%S")
    content = wish_content.strip() if wish_content.strip() else f"auto wish {now_tag}-{idx}-{random_suffix()}"
    chosen_category = category.strip() if category.strip() else (categories[0] if categories else "鍏朵粬")
    chosen_brand = brand.strip() if brand.strip() else "auto-brand"
    chosen_prod = prod_name.strip() if prod_name.strip() else chosen_brand
    return {
        "wishContent": content,
        "pic": "",
        "category": chosen_category,
        "brand": chosen_brand,
        "prodName": chosen_prod,
    }


def ensure_xy_extra_data(context: HarContext) -> None:
    if not context.xy_extra_data:
        context.xy_extra_data = (
            f"appid={context.appid};version={context.version};"
            f"envVersion={context.envversion};senceId={DEFAULT_SCENE_ID}"
        )


def run_single_account(
    args: argparse.Namespace,
    account_map: dict[str, str],
    account_remark: str = "",
    account_wxid: str = "",
    account_authorization: str = "",
    account_wx_code: str = "",
) -> int:
    alias, wxid = resolve_wxid_selector(account_wxid or args.wxid, account_map)

    har_path = pick_har_file(args.har)
    if args.har.strip() and not har_path:
        print(
            f"[警告] HAR 文件不存在，已忽略: {pathlib.Path(args.har.strip()).expanduser()}",
            file=sys.stderr,
        )

    context = HarContext(har_path=har_path)
    if har_path:
        try:
            context = extract_har_context(har_path)
        except RuntimeError as exc:
            print(f"[警告] 解析 HAR 上下文失败: {exc}", file=sys.stderr)

    if account_authorization.strip():
        context.authorization = account_authorization.strip()
    elif args.authorization.strip():
        context.authorization = args.authorization.strip()
    if args.appid.strip():
        context.appid = args.appid.strip()
    if args.version.strip():
        context.version = args.version.strip()
    if args.envversion.strip():
        context.envversion = args.envversion.strip()
    if args.xy_extra_data.strip():
        context.xy_extra_data = args.xy_extra_data.strip()
    ensure_xy_extra_data(context)

    client = MengShuClient(context=context, timeout=args.timeout, verbose=args.verbose)

    login_user_id = ""
    wx_code = account_wx_code.strip() or args.wx_code.strip()
    if wxid and not wx_code:
        try:
            wx_code = request_wechat_code(args.yyb_base_url, wxid, context.appid, context.user_agent, args.timeout)
            print(f"[信息] 已获取 wxid 登录 code: {alias or wxid}")
        except ApiError as exc:
            print(f"[警告] wxid 获取 code 失败: {exc}", file=sys.stderr)
            if exc.payload:
                print(f"[警告] 返回内容: {exc.payload}", file=sys.stderr)

    if wx_code:
        try:
            login_data = client.app_login(wx_code, app_type=1)
            login_user_id = str(login_data.get("userId", "")).strip()
            print(f"[信息] appLogin 成功, userId={login_user_id or '未知'}")
        except ApiError as exc:
            print(f"[警告] appLogin 失败: {exc}", file=sys.stderr)
            if exc.payload:
                print(f"[警告] 返回内容: {exc.payload}", file=sys.stderr)

    if not context.authorization:
        print(
            "[错误] authorization 为空。"
            "请在文件开头 IN_SCRIPT_ENV 里填写 authorization，"
            "或填写 wxid + yyb_base_url（也可提供 wx_code），"
            "或设置环境变量 ssbb（多账号换行）。",
            file=sys.stderr,
        )
        return 1

    if account_remark:
        print(f"[信息] 账号: {account_remark}")
    print(f"[信息] HAR: {context.har_path or '无'}")
    print(f"[信息] 授权: {mask_secret(context.authorization)}")
    print(f"[信息] 应用信息(appid/version/envversion): {context.appid} / {context.version} / {context.envversion}")
    if wxid:
        print(f"[信息] wxid: {alias or wxid}")

    try:
        before_list = client.get_task_list()
        before_points = before_list.get("data", {}).get("pointsBalance")
        sign_task = extract_task_from_list(before_list, TASK_TYPE_SIGN)
        wish_task = extract_task_from_list(before_list, TASK_TYPE_WISH)
        sign_info_before = client.get_sign_info().get("data", {})
    except ApiError as exc:
        print(f"[错误] 查询当前状态失败: {exc}", file=sys.stderr)
        if exc.payload:
            print(f"[错误] 返回内容: {exc.payload}", file=sys.stderr)
        return 1

    print(
        f"[信息] 签到任务(type={TASK_TYPE_SIGN}): 状态={sign_task.get('status')} "
        f"标题={sign_task.get('title')} 奖励={sign_task.get('prizeDesc')}"
    )
    print(
        f"[信息] 心愿任务(type={TASK_TYPE_WISH}): 状态={wish_task.get('status')} "
        f"标题={wish_task.get('title')} 奖励={wish_task.get('prizeDesc')}"
    )
    print(
        f"[信息] 签到信息: 积分={sign_info_before.get('pointsNums')} "
        f"连签天数={sign_info_before.get('seriesDays')} "
        f"今日已签={sign_info_before.get('signTodayResult')}"
    )
    print(f"[信息] 执行前积分: {before_points}")

    if args.status_only:
        return 0

    if args.do_sign:
        already_signed = bool(sign_info_before.get("signTodayResult"))
        if already_signed:
            print("[信息] 签到: 今天已签到")
        else:
            try:
                sign_resp = client.sign_today()
                if sign_resp.get("error") in (0, "0"):
                    print(f"[成功] 签到成功: {sign_resp}")
                else:
                    msg = str(sign_resp.get("errorMsg") or sign_resp.get("error_msg") or "")
                    if ("已签到" in msg) or ("宸茬鍒" in msg):
                        print(f"[信息] 签到已完成: {msg}")
                    else:
                        print(f"[警告] 签到返回异常: {sign_resp}", file=sys.stderr)
            except ApiError as exc:
                print(f"[警告] 签到失败: {exc}", file=sys.stderr)
                if exc.payload:
                    print(f"[警告] 返回内容: {exc.payload}", file=sys.stderr)

    wish_ids: list[str] = []
    if args.do_wish and args.wish_times > 0:
        for idx in range(1, args.wish_times + 1):
            try:
                conf = client.get_content_conf()
                categories = extract_categories(conf)
                payload = make_wish_payload(
                    idx=idx,
                    categories=categories,
                    wish_content=args.wish_content,
                    category=args.category,
                    brand=args.brand,
                    prod_name=args.prod_name,
                )
                publish_data = client.publish_wish(payload).get("data", {})
                wish_id = str(publish_data.get("id", "")).strip()
                if not wish_id:
                    raise ApiError("发布心愿成功但 id 为空", payload=publish_data)
                submit_data = client.submit_task(TASK_TYPE_WISH, wish_id)
                wish_ids.append(wish_id)
                print(f"[成功] 心愿第{idx}次: wish_id={wish_id}, 提交结果={submit_data.get('success')}")
            except ApiError as exc:
                print(f"[错误] 心愿第{idx}次失败: {exc}", file=sys.stderr)
                if exc.payload:
                    print(f"[错误] 返回内容: {exc.payload}", file=sys.stderr)
                break
            if idx < args.wish_times and args.sleep > 0:
                time.sleep(args.sleep)
    elif args.do_wish and args.wish_times <= 0:
        print("[警告] wish_times <= 0，已跳过心愿任务")

    try:
        after_list = client.get_task_list()
        after_points = after_list.get("data", {}).get("pointsBalance")
        sign_info_after = client.get_sign_info().get("data", {})
    except ApiError as exc:
        print(f"[警告] 查询最终状态失败: {exc}", file=sys.stderr)
        if exc.payload:
            print(f"[警告] 返回内容: {exc.payload}", file=sys.stderr)
        after_points = None
        sign_info_after = {}

    print(f"[信息] 心愿ID列表: {wish_ids if wish_ids else '无'}")
    print(f"[信息] 执行后积分: {after_points}")
    print(
        f"[信息] 签到后状态: 今日已签={sign_info_after.get('signTodayResult')} "
        f"连签天数={sign_info_after.get('seriesDays')}"
    )
    if isinstance(before_points, (int, float)) and isinstance(after_points, (int, float)):
        print(f"[信息] 积分变化: {after_points - before_points}")
    return 0


def fetch_accounts_from_yyb() -> list[dict[str, str]]:
    """从 YYB 协议获取账号列表"""
    try:
        import urllib.request
        url = f"{DEFAULT_YYB_BASE_URL}/accounts"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode("utf-8", errors="replace")
        data = json.loads(text)
        if data.get("code") == 0 and data.get("data"):
            accounts = []
            for acc in data["data"]:
                openid = acc.get("openid", "")
                nickname = acc.get("nickname", "") or acc.get("alias", "") or openid
                if openid:
                    accounts.append({
                        "remark": nickname,
                        "wxid": openid,
                        "authorization": "",
                        "wx_code": "",
                    })
            return accounts
    except Exception as e:
        print(f"[信息] 从 YYB 协议获取账号失败: {e}")
    return []


def main() -> int:
    args = parse_args()

    try:
        account_map = parse_wechat_account_lines(args.wxid_lines or "")
    except ValueError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 1

    ssbb_raw = args.ssbb.strip()
    if ssbb_raw:
        accounts = parse_ssbb_accounts(ssbb_raw)
        if not accounts:
            print("[错误] 已设置 ssbb，但未解析到有效账号", file=sys.stderr)
            return 1

        success = 0
        total = len(accounts)
        for index, account in enumerate(accounts, start=1):
            print("=" * 68)
            print(f"[信息] 账号 {index}/{total}: {account['remark']}")
            code = run_single_account(
                args=args,
                account_map=account_map,
                account_remark=account["remark"],
                account_wxid=account["wxid"],
                account_authorization=account["authorization"],
                account_wx_code=account["wx_code"],
            )
            if code == 0:
                success += 1
        print("=" * 68)
        print(f"[信息] 批量汇总: 成功={success} 失败={total - success} 总计={total}")
        return 0 if success == total else 1

    # 从 YYB 协议获取账号
    yyb_accounts = fetch_accounts_from_yyb()
    if yyb_accounts:
        print(f"[信息] 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
        success = 0
        total = len(yyb_accounts)
        for index, account in enumerate(yyb_accounts, start=1):
            print("=" * 68)
            print(f"[信息] 账号 {index}/{total}: {account['remark']}")
            code = run_single_account(
                args=args,
                account_map=account_map,
                account_remark=account["remark"],
                account_wxid=account["wxid"],
                account_authorization=account["authorization"],
                account_wx_code=account["wx_code"],
            )
            if code == 0:
                success += 1
        print("=" * 68)
        print(f"[信息] 批量汇总: 成功={success} 失败={total - success} 总计={total}")
        return 0 if success == total else 1

    return run_single_account(args=args, account_map=account_map)


if __name__ == "__main__":
    sys.exit(main())


