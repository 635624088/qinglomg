#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
骆驼签到 - 微信小程序自动签到
使用 YYB (172.17.0.1:18080) 获取 wx code，通过微盟完成签到

连续签到奖励:
  连续签到 10 天 → 赠送 1 张 5 元无门槛优惠券
  连续签到 15 天 → 额外赠送 1 张 10 元无门槛优惠券
  连续签到 25 天 → 额外赠送 1 张骆驼斜跨包兑换券

Env:
  YYB_BASE_URL  (可选，默认 http://172.17.0.1:18080)
  YYB_REF       (可选，指定账号 ref，默认遍历所有账号)
  FSKEY         (可选，飞书机器人 webhook key)
Cron: 30 8 * * *
"""

import requests
import json
import os
import time
import uuid
import random
import string

# ── 配置 ──────────────────────────────────────────────
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080")

WEIMOB_APP_ID = "wx3d2bdbf67041d80e"
WEIMOB_BASE = "https://xapi.weimob.com"
REFERER = f"https://servicewechat.com/{WEIMOB_APP_ID}/91/page-frame.html"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36 "
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
    "MiniProgramEnv/Windows WindowsWechat/WMPF "
    "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541a35) XWEB/19977"
)

# 从 JS 脚本提取的接口参数
PROFILE_BASIC_INFO = {
    "vid": 6017386969601,
    "vidType": 10,
    "bosId": 4021451615601,
    "productId": 1,
    "productInstanceId": 7133332601,
    "productVersionId": "30044",
    "merchantId": 2000170906601,
    "tcode": "weimob",
    "cid": 420878601,
}

SIGN_BASIC_INFO = {
    "vid": 6017386969601,
    "vidType": 10,
    "bosId": 4021451615601,
    "productId": 146,
    "productInstanceId": 7133098601,
    "productVersionId": "14026",
    "merchantId": 2000170906601,
    "tcode": "weimob",
    "cid": 420878601,
}

PROFILE_EXTEND_INFO = {
    "wxTemplateId": 8186,
    "analysis": [],
    "bosTemplateId": 1000002235,
    "childTemplateIds": [
        {"customId": 90004, "version": "crm@0.1.94"},
        {"customId": 90002, "version": "ec@86.3"},
        {"customId": 90006, "version": "hudong@0.0.253"},
        {"customId": 90008, "version": "cms@0.0.532"},
        {"customId": 90070, "version": "v1.0.27-20260528"},
    ],
    "quickdeliver": {"enable": False},
    "youshu": {"enable": False},
    "source": 1,
    "channelsource": 5,
    "refer": "cms-design",
    "mpScene": 1008,
}

SIGN_EXTEND_INFO = {
    "wxTemplateId": 8186,
    "analysis": [],
    "bosTemplateId": 1000002235,
    "childTemplateIds": [
        {"customId": 90004, "version": "crm@0.1.94"},
        {"customId": 90002, "version": "ec@86.3"},
        {"customId": 90006, "version": "hudong@0.0.253"},
        {"customId": 90008, "version": "cms@0.0.532"},
        {"customId": 90070, "version": "v1.0.27-20260528"},
    ],
    "quickdeliver": {"enable": False},
    "youshu": {"enable": False},
    "source": 1,
    "channelsource": 5,
    "refer": "onecrm-signgift",
    "mpScene": 1008,
}

COMMON_CONTEXT = {
    "appid": WEIMOB_APP_ID,
    "queryParameter": None,
    "i18n": {"language": "zh", "timezone": "8"},
    "pid": "",
    "storeId": "",
}


# ── 工具函数 ──────────────────────────────────────────
def random_hex(n):
    return "".join(random.choices("0123456789abcdef", k=n * 2))


def random_uuid():
    return str(uuid.uuid4())


def build_vid_ticket():
    now = int(time.time() * 1000)
    seconds = int(now / 1000)
    left = str(random.randint(10000, 99999))
    mid = str(random.randint(100, 999))
    node = str(random.randint(1000, 9999))
    tail = str(random.randint(10000000000, 99999999999))
    return f"{left}-{seconds}.{mid}-saas-w1-{node}-{tail}"


def build_rpc_id():
    return random_hex(8)


def infer_req_from(path):
    return "onecrm" if "/onecrm/" in path else "cms_extension_package"


def infer_component(path):
    if "/onecrm/" in path:
        return "onecrm/signgift"
    return "cms_extension_package/RAW/userAgreement/index"


def infer_page_route(path):
    return "onecrm/signgift" if "/onecrm/" in path else "cms_design/design"


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
    resp = yyb_post("/wxapp/getCode", {"ref": str(ref), "app_id": WEIMOB_APP_ID})
    data = resp.get("data", {})
    result = data.get("result", {})
    code = result.get("code", "")
    if not code:
        raise RuntimeError(f"YYB getCode failed: {resp}")
    return code


# ── 微盟 HTTP 客户端 ─────────────────────────────────
class WeimobClient:
    def __init__(self):
        self.session = requests.Session()
        self.conversation_id = random_uuid()
        self.parent_page_id = random_uuid()
        self.cuid = f"{str(int(time.time() * 1000))[-11:]}{random_hex(5)}"

    def build_headers(self, path, token, payload, attempt=0):
        basic_info = payload.get("basicInfo", {})
        bos_id = str(basic_info.get("bosId", ""))
        vid = basic_info.get("vid")
        product_id = basic_info.get("productId")

        headers = {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            "referer": REFERER,
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9",
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "xweb_xhr": "1",
            "weimob-pid": "N/A",
            "wos-x-channel": "0:TITAN",
            "x-wmsdk-close-store": "v2",
        }

        if token:
            headers["x-wx-token"] = token

        if not path.startswith("/fe/mapi/user/"):
            headers["x-apm-page-id"] = random_uuid()
            headers["x-apm-conversation-id"] = self.conversation_id
            headers["x-cmssdk-vidticket"] = build_vid_ticket()
            headers["parentrpcid"] = build_rpc_id()
            headers["x-cms-sdk-request"] = "1.5.143"
            headers["cookie"] = f"rprm_cuid={self.cuid}"
            headers["x-req-from"] = infer_req_from(path)
            headers["x-component-is"] = infer_component(path)
            headers["x-page-route"] = infer_page_route(path)
            if attempt > 0 or "/onecrm/" in path:
                headers["x-apm-parent-page-id"] = self.parent_page_id
            if product_id is not None:
                headers["x-biz-id"] = str(product_id)
            if vid is not None:
                headers["x-wmsdk-vid"] = str(vid)
            headers["x-wmsdk-bc"] = f"1 {int(time.time() * 1000)}"
            if bos_id:
                headers["weimob-bosid"] = bos_id

        return headers

    def post_json(self, path, token, payload, extra_headers=None, attempt=0):
        headers = self.build_headers(path, token, payload, attempt)
        if extra_headers:
            headers.update(extra_headers)

        url = f"{WEIMOB_BASE}{path}"
        r = self.session.post(url, json=payload, headers=headers, timeout=20)

        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")

        data = r.json()
        if str(data.get("errcode", "")) != "0":
            raise RuntimeError(f"API error: {data.get('errmsg', data)}")
        return data


# ── 微盟登录流程 ──────────────────────────────────────
def build_wx_login_payload(code):
    return {
        "appid": WEIMOB_APP_ID,
        "basicInfo": {
            "bosId": str(PROFILE_BASIC_INFO["bosId"]),
            "cid": str(PROFILE_BASIC_INFO["cid"]),
            "tcode": PROFILE_BASIC_INFO["tcode"],
            "vid": str(PROFILE_BASIC_INFO["vid"]),
        },
        "env": "production",
        "extendInfo": {"source": 1},
        "is_pre_fetch_open": True,
        "parentVid": 0,
        "pid": "",
        "storeId": "",
        "code": code,
        "queryAuthConfig": True,
    }


def build_profile_payload():
    return {
        **COMMON_CONTEXT,
        "basicInfo": dict(PROFILE_BASIC_INFO),
        "extendInfo": dict(PROFILE_EXTEND_INFO),
        "bosId": str(PROFILE_BASIC_INFO["bosId"]),
    }


def build_sign_payload(wid):
    return {
        **COMMON_CONTEXT,
        "basicInfo": dict(SIGN_BASIC_INFO),
        "extendInfo": dict(SIGN_EXTEND_INFO),
        "customInfo": {
            "source": 0,
            "wid": int(wid),
        },
    }


def weimob_login(client, code):
    """用 wx code 登录微盟，获取 token / openid / wid"""
    payload = build_wx_login_payload(code)
    result = client.post_json("/fe/mapi/user/loginX", "", payload)
    data = result.get("data", {})
    token = str(data.get("token", "")).strip()
    openid = str(data.get("openId", "") or data.get("openid", "")).strip()
    wid = int(data.get("wid", 0))
    if not token or not wid:
        raise RuntimeError(f"登录返回不完整: token={bool(token)}, wid={wid}")
    return {"token": token, "openid": openid, "wid": wid}


def query_profile(client, token):
    """查询用户资料（nickname / phone / wid）"""
    result = client.post_json("/api3/user/info/web/queryNicknameAndPhone", token, build_profile_payload())
    data = result.get("data", {})
    profile = data.get("nicknamePhoneAvatarInfoVo", {})
    return {
        "wid": data.get("wid"),
        "nickname": profile.get("nickname", ""),
        "phone": profile.get("phone", ""),
    }


def query_sign_info(client, token, wid):
    """查询签到状态"""
    result = client.post_json(
        "/api3/onecrm/mactivity/sign/misc/sign/activity/c/signMainInfo",
        token,
        build_sign_payload(wid),
    )
    return result.get("data", {})


def do_sign(client, token, wid):
    """执行签到"""
    result = client.post_json(
        "/api3/onecrm/mactivity/sign/misc/sign/activity/core/c/sign",
        token,
        build_sign_payload(wid),
    )
    return result.get("data", {})


# ── 签到结果格式化 ────────────────────────────────────
def summarize_sign_state(info):
    signed = "已签到" if info.get("hasSign") else "未签到"
    keep_days = info.get("activityCumulativeSignDays", 0)
    year = info.get("year", "-")
    month = info.get("month", "-")
    date = info.get("date", "-")
    msg = f"{year}-{month}-{date} {signed}"
    if keep_days > 0:
        msg += f"，累计 {keep_days} 天"
    return msg


# ── 飞书推送 ──────────────────────────────────────────
def send_feishu(text):
    fskey = os.environ.get("FSKEY", "")
    if not fskey:
        return
    try:
        r = requests.post(
            f"https://open.feishu.cn/open-apis/bot/v2/hook/{fskey}",
            json={
                "msg_type": "text",
                "content": {"text": f"🐫 骆驼签到通知\n\n{text}"},
            },
            timeout=10,
        )
        print(f"  飞书推送: {r.status_code}")
    except Exception as e:
        print(f"  飞书推送失败: {e}")


# ── 主流程 ────────────────────────────────────────────
def process_account(ref, nickname="Unknown"):
    """处理单个账号的签到"""
    print(f"\n--- 账号: {nickname} (ref={ref}) ---")

    # Step 1: 获取 wx code
    print("  [1] 获取 wx code...")
    code = yyb_get_wx_code(ref)
    print(f"  [✓] code: {code[:20]}...")

    # Step 2: 微盟登录
    print("  [2] 微盟登录...")
    client = WeimobClient()
    auth = weimob_login(client, code)
    print(f"  [✓] token: {auth['token'][:20]}... wid={auth['wid']}")

    # Step 3: 查询用户资料
    print("  [3] 查询用户资料...")
    profile = query_profile(client, auth["token"])
    wid = int(auth["wid"] or profile.get("wid", 0))
    if not wid:
        raise RuntimeError("未获取到 wid")
    display_name = profile.get("nickname") or nickname
    phone = profile.get("phone", "")
    print(f"  [✓] 用户={display_name}, wid={wid}" + (f", 手机={phone}" if phone else ""))

    # Step 4: 查询签到状态
    print("  [4] 查询签到状态...")
    info = query_sign_info(client, auth["token"], wid)

    if info.get("hasSign"):
        msg = f"今日已签到，{summarize_sign_state(info)}"
        print(f"  [✓] {msg}")
        return {"ok": True, "label": display_name, "message": f"签到: {msg}"}

    # Step 5: 执行签到
    print("  [5] 执行签到...")
    sign_result = do_sign(client, auth["token"], wid)
    rewards = []
    fixed = sign_result.get("fixedReward", {})
    if int(fixed.get("points", 0)) > 0:
        rewards.append(f"积分+{fixed['points']}")
    if int(fixed.get("growth", 0)) > 0:
        rewards.append(f"成长值+{fixed['growth']}")
    if int(fixed.get("amount", 0)) > 0:
        rewards.append(f"余额+{fixed['amount']}")

    # Step 6: 确认签到结果
    print("  [6] 确认签到结果...")
    info_after = query_sign_info(client, auth["token"], wid)
    reward_text = f"，奖励 {', '.join(rewards)}" if rewards else ""
    msg = f"成功{reward_text}，{summarize_sign_state(info_after)}"
    print(f"  [✓] 签到{msg}")
    return {"ok": True, "label": display_name, "message": f"签到: {msg}"}


def main():
    print("=" * 50)
    print("  骆驼签到 - 微盟小程序自动签到")
    print("=" * 50)

    ref = os.environ.get("YYB_REF")

    if ref:
        accounts = [{"ref": ref, "nickname": os.environ.get("YYB_NICK", ref)}]
    else:
        raw = yyb_list_accounts()
        accounts = []
        for acc in raw:
            accounts.append({
                "ref": str(acc.get("id", "")),
                "nickname": acc.get("nickname") or acc.get("alias") or "Unknown",
            })
        if not accounts:
            print("ERROR: 未找到 YYB 账号")
            return
        print(f"找到 {len(accounts)} 个 YYB 账号")

    results = []
    for i, acc in enumerate(accounts):
        ref = acc["ref"]
        nick = acc.get("nickname", ref)
        try:
            res = process_account(ref, nick)
            results.append(res)
        except Exception as e:
            print(f"  [✗] 错误: {e}")
            results.append({"ok": False, "label": nick, "message": str(e)})
        finally:
            if i < len(accounts) - 1:
                time.sleep(1.2)

    # 汇总
    print(f"\n{'='*50}")
    print("结果汇总:")
    summary_lines = []
    for r in results:
        status = "OK" if r["ok"] else "FAIL"
        line = f"- [{status}] {r['label']}: {r['message']}"
        print(f"  {line}")
        summary_lines.append(line)

    ok_count = sum(1 for r in results if r["ok"])
    fail_count = len(results) - ok_count
    print(f"\n完成: 成功 {ok_count} / 失败 {fail_count} / 共 {len(results)}")
    print(f"{'='*50}")

    # 飞书推送
    send_feishu("\n".join(summary_lines))


if __name__ == "__main__":
    main()
