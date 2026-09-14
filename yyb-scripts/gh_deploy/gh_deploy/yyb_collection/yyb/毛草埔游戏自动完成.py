#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
毛草埔 8 个游戏自动完成脚本
使用 YYB 协议获取 wx code, 通过 mpb.jingjiu.com 完成所有活动

8 个活动:
A 类 (ccncommon 通用接口):
  1. activity_id=100000 美食配对-线上常规版 (meishi_online)
  2. activity_id=100014 夏日轻松足球赛 (shijiebei)
  3. activity_id=101030 解救草本 (jiejiucaoben)

B 类 (BlzLongcaobenActivity):
  4. qingxingUser* 春日轻醒力 activity_id=9333
  5. chunyeUser* 春野探秘 activity_id=8101

C 类 (BlzLonglActivity):
  6. daixieyanjiusuoUser* 代谢研究所 activity_id=202
  7. caobenshiyanshiUser* 毛铺草本实验室 activity_id=201
  8. shicaoxunyuanUser* 识草寻源 activity_id=200

Env:
  YYB_BASE_URL  (可选，默认 http://YYB_BASE_URL)
  YYB_REF       (可选，指定账号 ref，默认遍历所有账号)
  FSKEY         (可选，飞书机器人 webhook key)
Cron: 0 8 * * *
"""

import requests
import json
import os
import time
import hashlib
from typing import Dict, List, Optional, Tuple, Any

# ── 配置 ──────────────────────────────────────────────
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080")
APP_ID = "wxefd0fe341e06b815"  # 毛铺草本荟小程序
BASE_URL = "https://mpb.jingjiu.com"
SECRET = "DI9ynKTdfWqF"  # isource 签名密钥

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/132.0.0.0 Safari/537.36 "
                  "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI "
                  "MiniProgramEnv/Windows WindowsWechat/WMPF "
                  "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541a35) XWEB/19977",
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://servicewechat.com/wxefd0fe341e06b815/748/page-frame.html",
}

# ── 8 个活动配置 ──────────────────────────────────────
ACTIVITIES = [
    # A 类: ccncommon 通用接口
    {
        "name": "美食配对-线上常规版",
        "type": "ccncommon",
        "activity_id": 100000,
        "activity_type": "meishi_online",
    },
    {
        "name": "夏日轻松足球赛",
        "type": "ccncommon",
        "activity_id": 100014,
        "activity_type": "shijiebei",
    },
    {
        "name": "解救草本",
        "type": "ccncommon",
        "activity_id": 101030,
        "activity_type": "jiejiucaoben",
    },
    # B 类: BlzLongcaobenActivity
    {
        "name": "春日轻醒力",
        "type": "blz_caoben",
        "activity_id": 9333,
        "activity_type": "qingxing",
        "endpoint_prefix": "qingxing",
    },
    {
        "name": "春野探秘",
        "type": "blz_caoben",
        "activity_id": 8101,
        "activity_type": "chunye",
        "endpoint_prefix": "chunye",
    },
    # C 类: BlzLonglActivity
    {
        "name": "代谢研究所",
        "type": "blz_longl",
        "activity_id": 202,
        "activity_type": "daixieyanjiusuo",
        "endpoint_prefix": "daixieyanjiusuo",
    },
    {
        "name": "毛铺草本实验室",
        "type": "blz_longl",
        "activity_id": 201,
        "activity_type": "caobenshiyanshi",
        "endpoint_prefix": "caobenshiyanshi",
    },
    {
        "name": "识草寻源",
        "type": "blz_longl",
        "activity_id": 200,
        "activity_type": "shicaoxunyuan",
        "endpoint_prefix": "shicaoxunyuan",
    },
]

# ── YYB 接口 ──────────────────────────────────────────
def yyb_get(path: str, params: Optional[Dict] = None) -> Dict:
    r = requests.get(YYB_BASE_URL + path, params=params, timeout=15)
    return r.json()

def yyb_post(path: str, data: Optional[Dict] = None) -> Dict:
    r = requests.post(YYB_BASE_URL + path, json=data or {}, timeout=15)
    return r.json()

def yyb_list_accounts() -> List[Dict]:
    resp = yyb_get("/accounts")
    return resp.get("data", []) or []

def yyb_get_wx_code(ref: str) -> str:
    resp = yyb_post("/wxapp/getCode", {"ref": str(ref), "app_id": APP_ID})
    data = resp.get("data", {})
    result = data.get("result", {})
    code = result.get("code", "")
    if not code:
        raise RuntimeError(f"YYB getCode failed: {resp}")
    return code

# ── 登录流程 ──────────────────────────────────────────
def build_isource(code: str, itime: int) -> str:
    """生成 isource 签名"""
    s = hashlib.md5((code + SECRET).encode()).hexdigest()
    o = hashlib.md5((code + str(itime) + SECRET).encode()).hexdigest()
    return (s[:16] + o[-16:]).upper()

def login_auto(code: str, unionid: str = "", user_id: str = "", user_sources: str = "0") -> Tuple[str, Dict]:
    """调用 loginauto 获取 access_token 和用户信息"""
    itime = int(time.time())
    isource = build_isource(code, itime)

    # 构建 system 信息 (简化版)
    system = {
        "brand": "microsoft",
        "model": "microsoft",
        "system": "Windows Unknown x64",
        "platform": "windows",
        "benchmarkLevel": -1,
        "pixelRatio": 1,
        "screenWidth": 414,
        "screenHeight": 780,
        "windowWidth": 414,
        "windowHeight": 780,
        "statusBarHeight": 20,
        "safeArea": {
            "bottom": 780,
            "height": 780,
            "left": 0,
            "right": 414,
            "top": 0,
            "width": 414
        },
        "language": "zh_CN",
        "version": "4.1.11.24",
        "SDKVersion": "3.16.2",
        "theme": "light",
        "host": {"appId": "", "env": "WeChat"},
        "enableDebug": False,
        "bluetoothEnabled": False,
        "locationEnabled": True,
        "wifiEnabled": True,
        "albumAuthorized": True,
        "cameraAuthorized": True,
        "locationAuthorized": True,
        "microphoneAuthorized": True,
        "notificationAuthorized": True,
        "devicePixelRatio": 1
    }

    payload = {
        "code": code,
        "unionid": unionid,
        "user_id": user_id,
        "user_sources": user_sources,
        "system": system,
        "itime": itime,
        "isource": isource
    }

    r = requests.post(
        f"{BASE_URL}/proxy-he/jp/api/loginauto",
        json=payload,
        headers=HEADERS,
        timeout=15
    )
    resp = r.json()
    if resp.get("code") != 0:
        raise RuntimeError(f"loginauto failed: {resp}")

    data = resp["data"]
    access_token = data["access_token"]
    return access_token, data

def get_token_via_yyb(ref: str) -> Tuple[str, Dict]:
    """通过 YYB 获取 code 并登录"""
    code = yyb_get_wx_code(ref)
    # 注意: 这里需要 unionid, 但 YYB 只返回 code
    # 实际抓包显示第一次请求时 unionid 为空, 系统会通过 /wx_getunionid_bycode 获取
    # 我们暂时传空, 让服务端自己处理
    token, user_info = login_auto(code, unionid="")
    return token, user_info

# ── API 客户端 ────────────────────────────────────────
class MaoCaoClient:
    def __init__(self, token: str):
        self.s = requests.Session()
        self.s.headers.update(HEADERS)
        self.token = token
        self.s.headers["authorization"] = token

    def post(self, path: str, data: Optional[Dict] = None) -> Dict:
        r = self.s.post(BASE_URL + path, json=data or {}, timeout=15)
        return r.json()

    def get(self, path: str, params: Optional[Dict] = None) -> Dict:
        r = self.s.get(BASE_URL + path, params=params or {}, timeout=15)
        return r.json()

# ── 活动处理函数 ───────────────────────────────────────
def process_ccncommon(client: MaoCaoClient, activity: Dict) -> Dict:
    """处理 ccncommon 通用接口活动"""
    name = activity["name"]
    activity_id = activity["activity_id"]
    print(f"    [{name}] 开始...")

    # 1. activityDetails (可选, 用于获取活动信息)
    # resp = client.post("/proxy-he/api/opactivity/ccncommon/activityDetails", {"activity_id": activity_id})

    # 2. dateUserMains 检查今日可玩次数
    mains = client.post("/proxy-he/api/opactivity/ccncommon/dateUserMains", {
        "activity_id": activity_id,
        "latitude": "",
        "longitude": ""
    })
    data = mains.get("data", {})
    today_play_num_can = data.get("today_play_num_can", 0)

    if today_play_num_can <= 0:
        print(f"    [{name}] 今日已玩过或不可玩 (today_play_num_can={today_play_num_can})")
        return {"status": "skipped", "reason": "no_chances"}

    # 3. userStarts 开始游戏
    start_resp = client.post("/proxy-he/api/opactivity/ccncommon/userStarts", {
        "activity_id": activity_id,
        "province": "",
        "city": "",
        "district": "",
        "latitude": "",
        "longitude": ""
    })
    if start_resp.get("code") != 0:
        print(f"    [{name}] userStarts failed: {start_resp}")
        return {"status": "error", "reason": "start_failed"}

    # 4. userFinishs 完成游戏 (先发 -1 再发 1)
    finish1 = client.post("/proxy-he/api/opactivity/ccncommon/userFinishs", {
        "activity_id": str(activity_id),
        "latitude": "",
        "longitude": "",
        "province": "",
        "city": "",
        "district": "",
        "play_data_json": "",
        "play_finish_is": -1
    })
    if finish1.get("code") != 0:
        print(f"    [{name}] userFinishs(-1) failed: {finish1}")
        return {"status": "error", "reason": "finish_failed"}

    user_play_id = finish1["data"]["user_play_id"]

    # 5. userFinishs 真正完成
    finish2 = client.post("/proxy-he/api/opactivity/ccncommon/userFinishs", {
        "activity_id": str(activity_id),
        "latitude": "",
        "longitude": "",
        "province": "",
        "city": "",
        "district": "",
        "play_finish_is": 1
    })
    if finish2.get("code") != 0:
        print(f"    [{name}] userFinishs(1) failed: {finish2}")
        return {"status": "error", "reason": "finish_failed"}

    # 6. datelUserDraws 抽奖
    draw = client.post("/proxy-he/api/opactivity/ccncommon/datelUserDraws", {
        "activity_id": str(activity_id),
        "user_play_id": str(user_play_id),
        "year": "2026",
        "province": "",
        "city": "",
        "district": ""
    })

    prize = "未知"
    if draw.get("code") == 0:
        award_local = draw.get("data", {}).get("awardLocal", {})
        prize = award_local.get("title", "未知")
        jifen = award_local.get("jifen", 0)
        if jifen:
            prize = f"{prize} ({jifen}积分)"

    print(f"    [{name}] ✓ 完成, 奖品: {prize}")
    return {"status": "completed", "prize": prize, "draw_response": draw}

def process_blz_caoben(client: MaoCaoClient, activity: Dict) -> Dict:
    """处理 BlzLongcaobenActivity 活动 (有 UserStarts)"""
    name = activity["name"]
    activity_id = activity["activity_id"]
    prefix = activity["endpoint_prefix"]
    print(f"    [{name}] 开始...")

    # 1. UserMains 检查状态
    mains = client.post(f"/proxy-he/api/BlzLongcaobenActivity/{prefix}UserMains", {})
    data = mains.get("data", {})
    today_play_num_can = data.get("today_play_num_can", 0)

    if today_play_num_can <= 0:
        print(f"    [{name}] 今日已玩过或不可玩 (today_play_num_can={today_play_num_can})")
        return {"status": "skipped", "reason": "no_chances"}

    # 2. UserStarts 开始游戏
    start = client.post(f"/proxy-he/api/BlzLongcaobenActivity/{prefix}UserStarts", {
        "activity_id": activity_id
    })
    if start.get("code") != 0:
        print(f"    [{name}] UserStarts failed: {start}")
        # 检查是否是手机号未绑定错误
        if start.get("message", "").find("手机号") != -1:
            return {"status": "skipped", "reason": "need_phone_bind"}
        return {"status": "error", "reason": "start_failed"}

    # 3. UserDrawGet 获取 user_record_id
    draw_get = client.post(f"/proxy-he/api/BlzLongcaobenActivity/{prefix}UserDrawGet", {
        "activity_id": str(activity_id),
        "play_finish_is": -1
    })
    if draw_get.get("code") != 0:
        print(f"    [{name}] UserDrawGet failed: {draw_get}")
        return {"status": "error", "reason": "drawget_failed"}

    user_record_id = draw_get["data"]["user_record_id"]

    # 4. UserDraws 抽奖
    draw = client.post(f"/proxy-he/api/BlzLongcaobenActivity/{prefix}UserDraws", {
        "user_record_id": user_record_id
    })

    prize = "未知"
    if draw.get("code") == 0:
        award_local = draw.get("data", {}).get("awardLocal", {})
        prize = award_local.get("title", "未知")
        jifen = award_local.get("jifen", 0)
        if jifen:
            prize = f"{prize} ({jifen}积分)"

    print(f"    [{name}] ✓ 完成, 奖品: {prize}")
    return {"status": "completed", "prize": prize, "draw_response": draw}

def process_blz_longl(client: MaoCaoClient, activity: Dict) -> Dict:
    """处理 BlzLonglActivity 活动 (无 UserStarts)"""
    name = activity["name"]
    activity_id = activity["activity_id"]
    prefix = activity["endpoint_prefix"]
    print(f"    [{name}] 开始...")

    # 1. 先调用通用 userMains 检查所有活动状态
    generic_mains = client.post("/proxy-he/api/BlzLonglActivity/userMains", {})
    if generic_mains.get("code") == 0:
        data = generic_mains.get("data", {})
        activity_list = data.get("activity_list", {})
        today_activities = data.get("aUserTodayActivity", [])

        # 检查是否今天已玩过
        today_played = any(str(activity_id) == str(item.get("activity_id")) for item in today_activities)
        if today_played:
            print(f"    [{name}] 今日已玩过 (aUserTodayActivity)")
            return {"status": "skipped", "reason": "already_played"}

        # 检查 is_finish 状态
        act_key = activity.get("activity_type", prefix)
        act_info = activity_list.get(act_key, {})
        is_finish = act_info.get("is_finish", 0)
        # is_finish: -1=未开始, 0=进行中, 1=已完成
        if is_finish == 1:
            print(f"    [{name}] 已完成 (is_finish=1)")
            return {"status": "skipped", "reason": "already_finished"}

    # 2. UserDrawGet 开始并获取 user_record_id
    play_time_start = int(time.time())

    # 尝试两种请求体格式
    draw_get = None
    # 格式1: 带 activity_id (daixieyanjiusuo 使用)
    if prefix == "daixieyanjiusuo":
        draw_get = client.post(f"/proxy-he/api/BlzLonglActivity/{prefix}UserDrawGet", {
            "activity_id": str(activity_id),
            "play_time_start": play_time_start
        })
    else:
        # 格式2: 带 use_type (caobenshiyanshi, shicaoxunyuan 使用)
        draw_get = client.post(f"/proxy-he/api/BlzLonglActivity/{prefix}UserDrawGet", {
            "play_time_start": play_time_start,
            "use_type": "free"
        })

    if not draw_get or draw_get.get("code") != 0:
        print(f"    [{name}] UserDrawGet failed: {draw_get}")
        # 检查是否是手机号未绑定错误
        if draw_get and draw_get.get("message", "").find("手机号") != -1:
            return {"status": "skipped", "reason": "need_phone_bind"}
        return {"status": "error", "reason": "drawget_failed"}

    user_record_id = draw_get["data"]["user_record_id"]

    # 3. UserDraws 完成并抽奖
    play_time_finish = int(time.time())
    draw_payload = {
        "play_time_finish": play_time_finish,
        "user_record_id": user_record_id
    }
    # daixieyanjiusuo 还需要 activity_id
    if prefix == "daixieyanjiusuo":
        draw_payload["activity_id"] = str(activity_id)

    draw = client.post(f"/proxy-he/api/BlzLonglActivity/{prefix}UserDraws", draw_payload)

    prize = "未知"
    if draw.get("code") == 0:
        award_local = draw.get("data", {}).get("awardLocal", {})
        prize = award_local.get("title", "未知")
        jifen = award_local.get("jifen", 0)
        if jifen:
            prize = f"{prize} ({jifen}积分)"

    print(f"    [{name}] ✓ 完成, 奖品: {prize}")
    return {"status": "completed", "prize": prize, "draw_response": draw}

# ── 飞书推送 ──────────────────────────────────────────
def send_feishu(text: str):
    fskey = os.environ.get("FSKEY", "")
    if not fskey:
        return
    try:
        r = requests.post(
            f"https://open.feishu.cn/open-apis/bot/v2/hook/{fskey}",
            json={
                "msg_type": "text",
                "content": {"text": f"🌿 毛草埔游戏通知\n\n{text}"},
            },
            timeout=10,
        )
        print(f"  飞书推送: {r.status_code}")
    except Exception as e:
        print(f"  飞书推送失败: {e}")

# ── 主流程 ────────────────────────────────────────────
def process_account(ref: str, nickname: str = "Unknown") -> Dict:
    """处理单个账号的所有 8 个游戏"""
    print(f"\n--- 账号: {nickname} (ref={ref}) ---")

    # Step 1: 获取 token
    
    try:
        token, user_info = get_token_via_yyb(ref)
        mobile = user_info.get("mobile", "")
        name = user_info.get("name", nickname)
        print(f"      token: {token[:30]}...")
        print(f"  [✓] 登录成功: {name}" + (f" ({mobile})" if mobile else ""))
    except Exception as e:
        print(f"  [✗] 登录失败: {e}")
        return {"ok": False, "label": nickname, "message": f"登录失败: {e}"}

    # Step 2: 创建客户端
    client = MaoCaoClient(token)

    # Step 3: 处理所有活动
    results = []
    for act in ACTIVITIES:
        try:
            if act["type"] == "ccncommon":
                result = process_ccncommon(client, act)
            elif act["type"] == "blz_caoben":
                result = process_blz_caoben(client, act)
            elif act["type"] == "blz_longl":
                result = process_blz_longl(client, act)
            else:
                continue

            # 汇总结果
            status = result.get("status", "unknown")
            reason = result.get("reason", "")

            if status == "completed":
                results.append({
                    "name": act["name"],
                    "status": "completed",
                    "prize": result.get("prize", ""),
                })
            elif status == "skipped":
                # 区分不同类型的跳过
                if reason == "need_phone_bind":
                    results.append({
                        "name": act["name"],
                        "status": "skipped_phone",
                        "reason": "需要绑定手机号",
                    })
                else:
                    results.append({
                        "name": act["name"],
                        "status": "skipped",
                        "reason": reason,
                    })
            else:
                results.append({
                    "name": act["name"],
                    "status": "error",
                    "error": result.get("reason", "未知错误"),
                })

            # 避免请求过快
            time.sleep(0.5)

        except Exception as e:
            print(f"    [{act['name']}] 异常: {e}")
            results.append({
                "name": act["name"],
                "status": "error",
                "error": str(e),
            })

    # 汇总结果
    completed = [r for r in results if r["status"] == "completed"]
    skipped = [r for r in results if r["status"] == "skipped"]
    skipped_phone = [r for r in results if r["status"] == "skipped_phone"]
    errors = [r for r in results if r["status"] == "error"]

    summary = f"完成 {len(completed)}/{len(ACTIVITIES)} 个游戏"
    if skipped:
        summary += f", 跳过 {len(skipped)} 个"
    if skipped_phone:
        summary += f", 需绑手机 {len(skipped_phone)} 个"
    if errors:
        summary += f", 错误 {len(errors)} 个"

    # 详细结果
    details = []
    for r in results:
        if r["status"] == "completed":
            details.append(f"✓ {r['name']}: {r.get('prize', '完成')}")
        elif r["status"] == "skipped":
            details.append(f"○ {r['name']}: 已玩过/无次数")
        elif r["status"] == "skipped_phone":
            details.append(f"⚠ {r['name']}: 需绑定手机号")
        else:
            details.append(f"✗ {r['name']}: {r.get('error', '失败')}")

    full_message = f"{summary}\n" + "\n".join(details)
    print(f"\n  [汇总] {summary}")
    for line in details:
        print(f"    {line}")

    return {
        "ok": True,
        "label": name or nickname,
        "message": full_message,
        "results": results,
    }

def main():
    print("=" * 50)
    print("  毛草埔 8 个游戏自动完成")
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

    all_results = []
    for i, acc in enumerate(accounts):
        ref = acc["ref"]
        nick = acc.get("nickname", ref)
        try:
            res = process_account(ref, nick)
            all_results.append(res)
        except Exception as e:
            print(f"  [✗] 处理账号异常: {e}")
            all_results.append({"ok": False, "label": nick, "message": str(e)})
        finally:
            if i < len(accounts) - 1:
                time.sleep(2)

    # 汇总推送
    if all_results:
        success_count = sum(1 for r in all_results if r.get("ok"))
        total = len(all_results)
        push_text = f"毛草埔游戏完成: {success_count}/{total} 个账号成功\n\n"

        for res in all_results:
            label = res.get("label", "Unknown")
            if res.get("ok"):
                push_text += f"✓ {label}: 成功\n"
            else:
                push_text += f"✗ {label}: {res.get('message', '失败')}\n"

        send_feishu(push_text)
        print(f"\n推送完成: {success_count}/{total} 成功")

if __name__ == "__main__":
    main()