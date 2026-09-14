#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
绿地酒店小程序签到 + 任务积分脚本（青龙面板版）

环境变量:
    1) YYB_BASE_URL
       - 含义: YYB协议地址
       - 默认: http://172.17.0.1:18080


    3) LVDI_VERIFY_SSL
       - 含义: 是否验证SSL证书
       - 默认: 0（不验证）

通知模块: 自动对接青龙面板的 notify.py
"""

import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple, Set, Union

import requests
import urllib3

# ==================== 青龙面板通知模块接入 ====================
try:
    from notify import send
    NOTIFY_ENABLED = True
except ImportError:
    NOTIFY_ENABLED = False
    print("[WARN] 未找到青龙 notify 模块，通知功能禁用")


def send_notification(title: str, content: str) -> None:
    """发送青龙面板通知"""
    if NOTIFY_ENABLED:
        try:
            send(title, content)
            print(f"[INFO] 通知已发送: {title}")
        except Exception as e:
            print(f"[ERR] 通知发送失败: {e}")
    else:
        print(f"[INFO] [通知]{title}\n{content}")


# ==================== 配置区域 ====================
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
WECHAT_SERVER = YYB_BASE_URL
LOADER_BASE = WECHAT_SERVER
LOADER_DOC_URL = f"{LOADER_BASE}/api/document/page_api.json"
LOADER_APP_CODE_URL = f"{LOADER_BASE}/wxapp/getCode"

BASE_URL = "https://wx17d27ce1cca04bd7.wx.gcihotel.net/guardian"
APP_ID = "wx17d27ce1cca04bd7"
SIGN_BASE_URL = "https://wx4a359c7b9ddf878b.wx.gcihotel.net/guardian"
SIGN_APP_ID = "wx4a359c7b9ddf878b"
COMPONENT_APP_ID = "wxe715bd146a4e468b"
HOTEL_GROUP_CODE = "GIHG"
HOTEL_GROUP_ID = "1"
HOTEL_CODE = "0"
SIGN_CODE = "LDJFQD"
REQUEST_VERIFY = os.getenv("LVDI_VERIFY_SSL", "0").strip() not in ("0", "false", "False", "")

if not REQUEST_VERIFY:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HEADERS = {
    "Accept": "*/*",
    "Content-Type": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 "
        "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
        "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
        "UnifiedPCWindowsWechat(0xf2541022) XWEB/16467"
    ),
    "Referer": "https://wx17d27ce1cca04bd7.wx.gcihotel.net/wechat/?/",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


# ==================== 工具函数 ====================
def mask_mobile(mobile: str) -> str:
    if mobile and len(mobile) == 11:
        return f"{mobile[:3]}****{mobile[7:]}"
    return mobile or ""


def mask_string(s: str, show_head: int = 6, show_tail: int = 4) -> str:
    """通用字符串脱敏"""
    if not s or len(s) <= show_head + show_tail:
        return s or ""
    return f"{s[:show_head]}...{s[-show_tail:]}"


def to_float(value: Any, default: float = 0.0) -> float:
    """安全转换为浮点数"""
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _extract_first(payload: Any, target_keys: Tuple[str, ...]) -> Optional[Any]:
    if isinstance(payload, dict):
        for key in target_keys:
            value = payload.get(key)
            if value not in (None, "", 0, "0", [], {}):
                return value
        for value in payload.values():
            result = _extract_first(value, target_keys)
            if result not in (None, "", 0, "0", [], {}):
                return result
    elif isinstance(payload, list):
        for item in payload:
            result = _extract_first(item, target_keys)
            if result not in (None, "", 0, "0", [], {}):
                return result
    return None


def fetch_accounts_from_yyb(yyb_base_url: str) -> List[Dict[str, str]]:
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
                    accounts.append({"alias": remark, "value": wxid})
            if accounts:
                print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                return accounts
    except Exception as e:
        print(f"❌ 从 YYB 获取账号失败: {e}")
    return []


def parse_accounts(raw_value: str) -> List[Dict[str, str]]:
    """解析账号配置"""
    accounts: List[Dict[str, str]] = []
    for item in re.split(r"[&\n]", raw_value):
        token = item.strip()
        if not token:
            continue
        if "#" in token:
            alias, value = token.split("#", 1)
            alias = alias.strip()
            value = value.strip()
        else:
            alias = ""
            value = token
        if not value:
            continue
        accounts.append({"alias": alias, "value": value})
    return accounts


def is_probable_openid(value: str) -> bool:
    text = (value or "").strip()
    return bool(re.fullmatch(r"o[a-zA-Z0-9_-]{10,}", text))


# ==================== Loader客户端 ====================
class LoaderClient:
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.session.verify = REQUEST_VERIFY
        self.loader_ok = False
        self._init_loader()

    def _init_loader(self) -> None:
        try:
            resp = self.session.get(LOADER_DOC_URL, timeout=8)
            if resp.status_code == 200:
                self.loader_ok = True
                print("[OK] WeChat Loader 可用，优先走 Loader 调用")
            else:
                print(f"[WARN] WeChat Loader 文档接口异常: HTTP {resp.status_code}，将回退直连")
        except Exception as err:
            print(f"[WARN] WeChat Loader 不可用({err})，将回退直连")

    @staticmethod
    def _norm_url(api_path: str) -> str:
        if api_path.startswith("http://") or api_path.startswith("https://"):
            return api_path
        return f"{BASE_URL}{api_path}"

    def _try_loader_call(
        self,
        method: str,
        url: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        if not self.loader_ok:
            return None

        payload = {
            "method": method.upper(),
            "url": url,
            "params": params or {},
            "json": json_data or {},
            "headers": HEADERS,
        }
        candidate_paths = [
            "/api/request",
            "/api/proxy/request",
            "/api/wechat/request",
            "/api/document/request",
        ]
        for path in candidate_paths:
            try:
                resp = self.session.post(f"{LOADER_BASE}{path}", json=payload, timeout=12)
                if resp.status_code != 200:
                    continue
                data = resp.json()
                if isinstance(data, dict):
                    if "result" in data or "retVal" in data or "msg" in data:
                        return data
                    inner = data.get("data")
                    if isinstance(inner, dict):
                        if "result" in inner or "retVal" in inner or "msg" in inner:
                            return inner
            except Exception:
                continue
        return None

    def request(
        self,
        method: str,
        api_path: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = self._norm_url(api_path)

        loader_resp = self._try_loader_call(method=method, url=url, params=params, json_data=json_data)
        if loader_resp is not None:
            return loader_resp

        if method.upper() == "GET":
            resp = self.session.get(url, params=params, timeout=12)
        else:
            resp = self.session.post(url, json=json_data or {}, timeout=12)
        return resp.json()

    def fetch_app_code(self, wxid: str) -> Tuple[bool, str]:
        # 优先使用 YYB 协议
        if YYB_BASE_URL:
            url = YYB_BASE_URL + "/wxapp/getCode"
            payload = {"ref": wxid.strip(), "app_id": APP_ID}
            try:
                resp = self.session.post(url, json=payload, timeout=15)
                if resp.status_code != 200:
                    return False, f"HTTP {resp.status_code}"
                data = resp.json()
                # YYB 格式: {"code": 0, "data": {"result": {"code": "xxx"}}}
                if data.get("code") == 0:
                    result = data.get("data", {}).get("result") or {}
                    code = result.get("code") or result.get("Code")
                    if code:
                        return True, str(code)
                app_code = _extract_first(data, ("code", "Code", "app_code", "appCode"))
                if app_code:
                    return True, str(app_code)
                return False, f"未返回code: {data}"
            except Exception as err:
                return False, str(err)
        
        # 回退到 WechatServer
        payload = {"wxid": wxid.strip(), "appid": APP_ID}
        try:
            resp = self.session.post(LOADER_APP_CODE_URL, json=payload, timeout=12)
            if resp.status_code != 200:
                return False, f"HTTP {resp.status_code}"
            data = resp.json()
            app_code = _extract_first(data, ("code", "Code", "app_code", "appCode"))
            if not app_code:
                return False, f"未返回code: {data}"
            return True, str(app_code)
        except Exception as err:
            return False, str(err)


# ==================== 签到核心类 ====================
class LvDiSigner:
    def __init__(self) -> None:
        self.client = LoaderClient()
        # 用于收集通知内容
        self.results: List[str] = []

    def _log(self, msg: str, is_error: bool = False) -> None:
        """记录日志并收集到通知内容中"""
        print(msg)
        self.results.append(msg)

    def sign_request(self, openid: str, user_info: Dict[str, Any]) -> Tuple[bool, Union[int, float]]:
        """执行签到，返回(是否成功, 获得积分)"""
        params = {
            "signCode": SIGN_CODE,
            "appid": SIGN_APP_ID,
            "componentAppid": COMPONENT_APP_ID,
            "memberId": user_info["memberId"],
            "openid": openid,
            "memberToken": user_info["token"],
        }
        payload = {
            "signCode": SIGN_CODE,
            "openid": openid,
            "memberId": user_info["memberId"],
            "memberName": user_info["name"],
            "appid": SIGN_APP_ID,
            "componentAppid": COMPONENT_APP_ID,
            "hotelGroupCode": HOTEL_GROUP_CODE,
            "memberToken": user_info["token"],
        }
        try:
            config_resp = self.client.request(
                "GET",
                f"{SIGN_BASE_URL}/api/wechat/platform/sign/wechatSignConfig.json",
                params={"appid": SIGN_APP_ID, "componentAppid": COMPONENT_APP_ID},
            )
            if config_resp.get("result") != 1:
                self._log(f"[INFO] 签到配置结果: {config_resp.get('msg', '未知')}")

            record_resp = self.client.request(
                "GET",
                f"{SIGN_BASE_URL}/api/wechat/platform/sign/wechatSignRecord.json",
                params=params,
            )
            if record_resp.get("result") == 1:
                self._log("[INFO] 已查询签到记录")

            resp = self.client.request(
                "POST",
                f"{SIGN_BASE_URL}/api/wechat/platform/sign/wechatSign.json",
                json_data=payload,
            )
            if resp.get("result") == 1:
                points = to_float(_extract_first(resp, ("points", "point", "score")), 0)
                self._log(f"[OK] 签到成功，获得 {points} 积分")
                return True, points

            msg = resp.get("msg", "")
            raw_text = str(resp)
            if "已签到" in msg or "已签到" in raw_text:
                self._log("[INFO] 今日已签到")
                return True, 0
            else:
                self._log(f"[INFO] 签到结果: {msg or raw_text}")
                return False, 0
        except Exception as err:
            self._log(f"[ERR] 签到异常: {err}", is_error=True)
            return False, 0

    def login(self, openid: str) -> Optional[Dict[str, Any]]:
        """用户登录"""
        params = {
            "hotelCode": HOTEL_CODE,
            "hotelGroupCode": HOTEL_GROUP_CODE,
            "hotelGroupId": HOTEL_GROUP_ID,
            "openid": openid,
            "appid": APP_ID,
            "componentAppid": COMPONENT_APP_ID,
        }
        try:
            resp = self.client.request("GET", "/api/member/memberLoginOpen.json", params=params)
            if resp.get("result") != 1:
                self._log(f"[ERR] 登录失败({mask_string(openid)}): {resp.get('msg', '未知错误')}")
                return None
            data = resp.get("retVal", {})
            user_info = {
                "token": data.get("memberToken", ""),
                "memberId": data.get("memberId", ""),
                "mobile": data.get("mobile", ""),
                "name": data.get("name", "未命名用户"),
            }
            
            return user_info
        except Exception as err:
            self._log(f"[ERR] 登录请求异常: {err}", is_error=True)
            return None

    def resolve_openid_from_wxid(self, wxid: str) -> Tuple[bool, str]:
        """通过wxid获取openid"""
        ok, app_code_or_err = self.client.fetch_app_code(wxid)
        if not ok:
            return False, f"wxid换code失败: {app_code_or_err}"

        payload = {"code": app_code_or_err, "appid": APP_ID}
        try:
            resp = self.client.request("POST", "/api/microSoftWare/getOpenidSessionKeyV2.json", json_data=payload)
            openid = _extract_first(resp, ("openid", "openId"))
            if not openid:
                return False, f"code换openid失败: {resp}"
            return True, str(openid)
        except Exception as err:
            return False, f"code换openid异常: {err}"

    def _walk_collect_claim_ids(self, node: Any, out: Set[str]) -> None:
        """递归收集可领取的任务ID"""
        if isinstance(node, dict):
            id_keys = ("id", "taskId", "historyId", "rewardId", "prizeId")
            can_keys = ("canReceive", "canGet", "isCanReceive", "isReceive", "isGet")
            candidate_id = None
            for key in id_keys:
                if key in node and node.get(key) not in (None, "", 0, "0"):
                    candidate_id = str(node.get(key))
                    break
            can_claim = False
            for key in can_keys:
                if key in node:
                    val = node.get(key)
                    if val in (True, 1, "1", "T"):
                        can_claim = True
                    if key in ("isGet", "isReceive") and val in (0, "0", False, "F"):
                        can_claim = True
            if candidate_id and can_claim:
                out.add(candidate_id)
            for value in node.values():
                self._walk_collect_claim_ids(value, out)
        elif isinstance(node, list):
            for item in node:
                self._walk_collect_claim_ids(item, out)

    def do_task_points(self, openid: str, user_info: Dict[str, Any]) -> int:
        """执行任务领取积分，返回成功领取数量"""
        base_params = {
            "openid": openid,
            "memberId": user_info["memberId"],
            "memberToken": user_info["token"],
            "appid": APP_ID,
            "componentAppid": COMPONENT_APP_ID,
            "hotelGroupCode": HOTEL_GROUP_CODE,
            "hotelGroupId": HOTEL_GROUP_ID,
            "hotelCode": HOTEL_CODE,
        }
        claim_ids: Set[str] = set()
        apis = [
            "/api/wechat/platform/game/getMemberCallerConfig.json",
            "/api/wechat/platform/game/getMemberUpdateConfig.json",
            "/api/wechat/platform/game/gameinfo.json",
            "/api/wechat/platform/game/rewardlist.json",
            "/api/member/findInviteFriendsHistory.json",
            "/api/wechat/platform/game/getInviteFriendHistoryDetailsStep.json",
            "/api/wechat/platform/game/getInviteFriendHistoryDetails.json",
        ]
        for api in apis:
            try:
                resp = self.client.request("GET", api, params=base_params)
                if isinstance(resp, dict):
                    self._walk_collect_claim_ids(resp, claim_ids)
            except Exception:
                pass

        if not claim_ids:
            return 0

        self._log(f"[INFO] 发现 {len(claim_ids)} 个可尝试领取的任务奖励")
        success = 0
        for cid in sorted(claim_ids):
            payload = dict(base_params)
            payload.update(
                {
                    "id": cid,
                    "taskId": cid,
                    "historyId": cid,
                    "rewardId": cid,
                    "prizeId": cid,
                }
            )
            try:
                resp = self.client.request("GET", "/api/wechat/platform/game/inviteFriendGetPrize.json", params=payload)
                if resp.get("result") == 1:
                    success += 1
                    self._log(f"[OK] 任务奖励领取成功: {cid}")
                else:
                    self._log(f"[INFO] 任务奖励领取失败({cid}): {resp.get('msg', '未知')}")
            except Exception as err:
                self._log(f"[ERR] 任务奖励领取异常({cid}): {err}")
        self._log(f"[INFO] 任务领取完成: 成功 {success}/{len(claim_ids)}")
        return success

    def query_points(self, openid: str, user_info: Dict[str, Any]) -> Optional[float]:
        """查询积分，返回积分值(浮点数)"""
        params = {
            "hotelCode": HOTEL_CODE,
            "hotelGroupCode": HOTEL_GROUP_CODE,
            "hotelGroupId": HOTEL_GROUP_ID,
            "memberId": user_info["memberId"],
            "openid": openid,
            "appid": APP_ID,
            "componentAppid": COMPONENT_APP_ID,
            "memberToken": user_info["token"],
        }
        try:
            resp = self.client.request("GET", "/api/member/memberLoginOpen.json", params=params)
            if resp.get("result") != 1:
                self._log(f"[ERR] 查询积分失败: {resp.get('msg', '未知错误')}")
                return None
            card_list = resp.get("retVal", {}).get("cardListDto", [])
            points = None
            if isinstance(card_list, list) and card_list:
                points = card_list[0].get("pointBalance")
            points_float = to_float(points)
            self._log(f"[INFO] 当前账号积分: {points_float}")
            return points_float
        except Exception as err:
            self._log(f"[ERR] 查询积分异常: {err}", is_error=True)
            return None


# ==================== 主函数 ====================
def main() -> None:
    # 收集所有账号的汇总信息
    summary = []
    total_sign_success = 0
    total_sign_points = 0.0
    total_task_success = 0
    total_points_current = 0.0

    # 优先从 YYB 获取账号
    accounts = fetch_accounts_from_yyb(YYB_BASE_URL)
    
    # 回退到环境变量
    if not accounts:
        lvdi_env = os.getenv("lvdi")
        if not lvdi_env:
            msg = "[WARN] 未找到账号，请设置 lvdi 环境变量或 YYB_BASE_URL"
            print(msg)
            send_notification("绿地酒店签到", msg)
            return
        accounts = parse_accounts(lvdi_env)
    
    if not accounts:
        msg = "[WARN] 未解析到有效账号，请检查环境变量格式"
        print(msg)
        send_notification("绿地酒店签到", msg)
        return

    print(f"[INFO] WECHAT_SERVER: {WECHAT_SERVER}")
    print(f"[INFO] 文档接口: {LOADER_DOC_URL}")
    print(f"[INFO] 开始执行，账号数: {len(accounts)}")
    print("=" * 50)

    signer = LvDiSigner()

    for idx, account in enumerate(accounts, 1):
        alias = account["alias"] or f"账号{idx}"
        value = account["value"]
        openid = value
        # 判断是否来自 YYB：如果账号 value 像 openid 且不是 wxid 开头，
        # 仍需走 resolve_openid_from_wxid，因为 YYB openid 不等同于绿地酒店 openid
        treat_as_wxid = value.lower().startswith("wxid")
        # 如果环境变量里有 lvdi，且 value 不是 wxid 开头，也尝试走转换流程
        # 因为 YYB 返回的 openid 不能直接用于绿地酒店登录

        print(f"\n{'='*40}")
        print(f"处理账号 [{idx}/{len(accounts)}] {alias}")
        print(f"{'='*40}")

        if treat_as_wxid:
            ok, openid_or_err = signer.resolve_openid_from_wxid(value)
            if not ok:
                signer._log(f"[ERR] {openid_or_err}")
                summary.append({
                    "alias": alias,
                    "status": "失败",
                    "reason": openid_or_err,
                    "sign_points": 0,
                    "task_count": 0,
                    "points_current": 0
                })
                continue
            openid = openid_or_err
            signer._log("[INFO] 已通过 WECHAT_SERVER 获取 openid")
        else:
            # YYB 返回的 openid 不能直接使用，必须走 code→openid 转换
            signer._log(f"[INFO] YYB openid 需转换，尝试获取绿地酒店 openid...")
            ok, openid_or_err = signer.resolve_openid_from_wxid(value)
            if not ok:
                signer._log(f"[ERR] {openid_or_err}")
                summary.append({
                    "alias": alias,
                    "status": "失败",
                    "reason": openid_or_err,
                    "sign_points": 0,
                    "task_count": 0,
                    "points_current": 0
                })
                continue
            openid = openid_or_err
            signer._log("[INFO] 已通过 WECHAT_SERVER 转换 openid")

        user_info = signer.login(openid)
        if not user_info:
            summary.append({
                "alias": alias,
                "status": "失败",
                "reason": "登录失败",
                "sign_points": 0,
                "task_count": 0,
                "points_current": 0
            })
            continue

        sign_success, sign_points = signer.sign_request(openid, user_info)
        task_success = signer.do_task_points(openid, user_info)
        current_points = signer.query_points(openid, user_info)

        summary.append({
            "alias": alias,
            "status": "成功" if sign_success else "签到失败",
            "name": user_info.get("name", "未知"),
            "mobile": mask_mobile(user_info.get("mobile", "")),
            "sign_points": sign_points,
            "task_count": task_success,
            "points_current": current_points or 0,
        })
        
        if sign_success:
            total_sign_success += 1
            total_sign_points += sign_points
        total_task_success += task_success
        total_points_current += (current_points or 0)

    # 生成通知内容
    print("\n" + "=" * 50)
    print("执行完成，生成汇总通知")
    print("=" * 50)

    # 构建通知文本
    notify_lines = []
    notify_lines.append(f"📱 绿地酒店签到任务完成")
    notify_lines.append(f"账号总数: {len(accounts)}")
    notify_lines.append(f"签到成功: {total_sign_success}/{len(accounts)}")
    if total_sign_points > 0:
        notify_lines.append(f"签到获得积分: {total_sign_points:.2f}")
    if total_task_success > 0:
        notify_lines.append(f"任务领取奖励: {total_task_success} 个")
    notify_lines.append("")
    notify_lines.append("📊 账号详情:")
    notify_lines.append("-" * 30)

    for acc in summary:
        if acc["status"] == "成功":
            status_icon = "✅"
            detail = f"{status_icon} {acc['alias']} | {acc['name']}({acc['mobile']}) | 当前积分: {acc['points_current']:.2f}"
            if acc['sign_points'] > 0:
                detail += f" | +{acc['sign_points']:.2f}"
        else:
            status_icon = "❌"
            detail = f"{status_icon} {acc['alias']} | {acc['status']} | {acc.get('reason', '未知原因')}"
        notify_lines.append(detail)

    notify_content = "\n".join(notify_lines)

    # 发送通知
    send_notification("绿地酒店签到", notify_content)


if __name__ == "__main__":
    main()