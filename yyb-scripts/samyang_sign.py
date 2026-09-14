#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三养食品 - 累计签到脚本 (YYB 登录版)
签到活动: 累计签100天原味火鸡面*1+奶油味火鸡面5连包*1   (活动ID: 11895)

登录方式:
  1. YYB 模式(默认): 通过 YYB Go 服务取小程序 code 自动登录, 支持账号池多账号
     - YYB_BASE_URL   YYB 服务地址 (默认 http://172.17.0.1:18080)
     - YYB_REF        指定账号 id/openid (可选, 默认遍历所有存活账号)
  2. manual 模式: 填写下方 TOKEN / UNION_ID, 走单个账号(从抓包获取, 过期需重抓)

登录链路(YYB 模式):
  POST /wxapp/getCode {app_id, ref}        -> 一次性微信登录 code
  GET  /wmc-interact-c/1.3/index?jsCode=.. -> 换取 token/unionId/uid/tx/tenantId
  后续请求带 x-token/x-unionid/x-tx/x-uid/x-platshopid/x-tenant 完整会话头
"""

import requests
import json
import time
import os
import sys
from datetime import datetime

# ======================== 配置区 ========================

# 登录方式: 'yyb' 或 'manual' (可通过环境变量 SANYANG_LOGIN_MODE 覆盖)
LOGIN_MODE = os.environ.get("SANYANG_LOGIN_MODE", "yyb")

# --- YYB 配置 (LOGIN_MODE=yyb 时生效) ---
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080")  # YYB Go 服务地址
YYB_REF = os.environ.get("YYB_REF", "")  # 指定账号 id/openid, 空 = 遍历所有存活账号
SANYANG_APPID = "wx44e7e6fa31a013a5"  # 三养互动小程序 appid (同时是 platShopId)

# --- manual 模式配置 (LOGIN_MODE=manual 时生效, 从抓包获取, 有效期未知) ---
TOKEN = "02bc48ae47ba924cede63a3d44134e5f60b6502ddb66d195e219ff8497d998a5"
UNION_ID = "ojvQe69o7Q9y-cZViiICzKVECAZU"

# 活动ID
ACTIVITY_ID = "11895"

# 推送配置 - PushPlus
PUSHPLUS_TOKEN = ""  # 填写你的PushPlus Token
# 或 AppToken（青龙面板）
APP_TOKEN = ""

# ======================== 以下不需要修改 ========================

BASE_URL = "https://ual.shuyun.com/wmc-interact-c/1.3"

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B)",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Referer": "https://servicewechat.com/wx44e7e6fa31a013a5/1/page-frame.html",
    "Accept-Language": "zh-CN,zh;q=0.9",
}


def pushplus_push(title, content, token=None):
    """PushPlus 推送"""
    t = token or PUSHPLUS_TOKEN
    if not t:
        return False
    try:
        resp = requests.post(
            "https://www.pushplus.plus/send",
            json={"token": t, "title": title, "content": content, "template": "txt"}
        )
        return resp.ok
    except Exception as e:
        print(f"[PushPlus推送失败] {e}")
        return False


def app_push(title, content, token=None):
    """AppToken 推送（青龙）"""
    t = token or APP_TOKEN
    if not t:
        return False
    try:
        resp = requests.post(
            f"https://api.apptoken.ru/api/v1/message?token={t}",
            json={"title": title, "content": content}
        )
        return resp.ok
    except Exception as e:
        print(f"[AppToken推送失败] {e}")
        return False


def send_notify(title, content):
    """组合推送"""
    results = []
    if PUSHPLUS_TOKEN:
        results.append(("PushPlus", pushplus_push(title, content)))
    if APP_TOKEN:
        results.append(("AppToken", app_push(title, content)))
    return results


# ======================== YYB 登录 ========================

def yyb_get_accounts():
    """获取 YYB 账号池列表: [{id, openid, nickname, status, ...}]"""
    resp = requests.get(f"{YYB_BASE_URL}/accounts", timeout=15)
    data = resp.json()
    if data.get("code") == 0:
        return data.get("data", [])
    print(f"  ❌ 获取 YYB 账号列表失败: {data.get('msg', '未知错误')}")
    return []


def yyb_get_code(ref):
    """YYB 取小程序一次性登录 code: ref 为账号 id 或 openid"""
    resp = requests.post(
        f"{YYB_BASE_URL}/wxapp/getCode",
        json={"app_id": SANYANG_APPID, "ref": str(ref)},
        timeout=30,
    )
    data = resp.json()
    if data.get("code") != 0:
        print(f"  ❌ YYB 取码失败: {data.get('msg', '未知错误')}")
        return None
    result = data.get("data", {}).get("result", {})
    code = result.get("code")
    if not code:
        print("  ❌ YYB 取码失败: 响应中无 code")
        return None
    return code


def samyang_login(js_code):
    """用微信登录 code 换取三养 shuyun 平台完整会话, 返回请求头 dict 或 None"""
    url = f"{BASE_URL}/index?platShopId={SANYANG_APPID}&jsCode={js_code}"
    resp = requests.get(url, headers=BASE_HEADERS, timeout=15)
    data = resp.json()
    if data.get("code") != "0":
        print(f"  ❌ 登录失败: {data.get('msg', '未知错误')}")
        return None
    d = data.get("data", {})
    headers = dict(BASE_HEADERS)
    headers.update({
        "x-token": d["token"],
        "x-unionid": d["unionId"],
        "x-tx": str(d.get("tx", "")),
        "x-uid": d.get("uid", ""),
        "x-platshopid": d.get("platShopId", SANYANG_APPID),
        "x-tenant": d.get("tenantId", ""),
    })
    return headers


def manual_headers():
    """manual 模式: 直接用抓包的 TOKEN / UNION_ID"""
    headers = dict(BASE_HEADERS)
    headers.update({"x-token": TOKEN, "x-unionid": UNION_ID})
    return headers


# ======================== 签到接口 ========================

def get_activity_info(headers):
    """获取活动信息"""
    url = f"{BASE_URL}/activity/info/{ACTIVITY_ID}"
    resp = requests.get(url, headers=headers, timeout=15)
    data = resp.json()
    if data.get("code") == "0":
        return data.get("data", {})
    return None


def get_sign_status(headers):
    """获取当前签到状态"""
    url = f"{BASE_URL}/cumulativeSign/{ACTIVITY_ID}"
    resp = requests.get(url, headers=headers, timeout=15)
    data = resp.json()
    return data


def get_sign_rank(headers):
    """获取签到排名"""
    url = f"{BASE_URL}/cumulativeSign/rank/{ACTIVITY_ID}"
    resp = requests.get(url, headers=headers, timeout=15)
    data = resp.json()
    if data.get("code") == "0":
        return data.get("data", [])
    return []


def do_sign(headers):
    """执行签到"""
    url = f"{BASE_URL}/activity/access?id={ACTIVITY_ID}"
    resp = requests.post(url, headers=headers, json={}, timeout=15)
    data = resp.json()
    return data


def fmt_rewards(receive_list):
    """把服务端 receiveList 奖励列表格式化为可读文本"""
    parts = []
    for r in receive_list or []:
        if not isinstance(r, dict):
            parts.append(str(r))
            continue
        name = (r.get("awardName") or r.get("name") or r.get("prizeName")
                or r.get("award_name") or "")
        qty = r.get("quantity") or r.get("num") or r.get("count") or 1
        if not name and r.get("score") is not None:
            name = f"{r.get('score')}积分"
            qty = 1
        if name:
            parts.append(name if qty in (1, "1") else f"{name}×{qty}")
        else:
            parts.append(json.dumps(r, ensure_ascii=False)[:80])
    return "、".join(parts)


def get_last_award(headers):
    """回退: 从奖励记录接口取最近一条奖励名"""
    try:
        resp = requests.get(f"{BASE_URL}/activityAward/record?pageSize=1&currentPage=1",
                            headers=headers, timeout=15)
        lst = ((resp.json().get("data") or {}).get("list")) or []
        if lst:
            item = lst[0]
            return (item.get("awardName") or item.get("name") or ""), item.get("createTime", "")
    except Exception:
        pass
    return "", ""


def sign_one_account(headers, label="", union_id=""):
    """单个账号完整签到流程, 返回结果 dict"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    prefix = f"  [{label}] " if label else "  "

    # 1. 获取活动信息
    print(f"{prefix}获取活动信息...")
    info = get_activity_info(headers)
    if info:
        print(f"    活动: {info.get('activityName', '未知')}")
    else:
        print(f"{prefix}❌ 获取活动信息失败")

    # 2. 查询当前签到状态
    print(f"{prefix}查询当前签到状态...")
    status = get_sign_status(headers)
    status_data = status.get("data") or {}
    # 服务端提示可能在 msg(如"请勿重复打卡")或 data.errorMessage(如"没有任何奖励数据")
    status_msg = str(status.get("msg") or status_data.get("errorMessage") or "未知")

    # 判断是否已签到: receiveList 非空 或 服务端明确提示重复打卡
    already = False
    if status.get("code") == "0" and status_data.get("receiveList"):
        already = True
    if status.get("code") == "-1" and any(
        k in status_msg for k in ("重复", "已经", "已签", "打卡")
    ):
        already = True
        print(f"{prefix}ℹ️ 服务端提示: {status_msg}")
        return {"already": True, "info": info, "msg": status_msg}

    if already:
        print(f"{prefix}✅ 今日已签到, 跳过")
        send_notify("三养签到 - 已签到", f"{label or UNION_ID} 今日已签到")
        return {"already": True, "info": info}

    # 3. 执行签到
    print(f"{prefix}执行签到...")
    result = do_sign(headers)
    if result.get("code") == "0" and result.get("data") is True:
        print(f"{prefix}✅ 签到成功！")
        # 4. 签到后查询新状态, 展示所获奖励
        print(f"{prefix}查询签到后状态...")
        new_status = get_sign_status(headers)
        new_data = new_status.get("data") or {}
        reward_txt = fmt_rewards(new_data.get("receiveList"))
        if reward_txt:
            print(f"    🎁 本次获得: {reward_txt}")
        else:
            # receiveList 为空时从奖励记录回退查一次
            award_name, _ = get_last_award(headers)
            if award_name:
                reward_txt = award_name
                print(f"    🎁 本次获得(来自奖励记录): {reward_txt}")
            else:
                print(f"    状态: {new_data.get('errorMessage', '签到成功(服务端未返回奖励明细)')}")

        # 累计签到天数(活动 typeInfo)
        cum_days = ""
        try:
            ti = (info or {}).get("typeInfo") or {}
            if ti.get("cumulativeDays") is not None:
                cum_days = f"累计签到{ti.get('cumulativeDays')}天"
                print(f"    {cum_days}")
        except Exception:
            pass

        # 5. 排名
        rank_data = get_sign_rank(headers)
        my_rank = None
        if rank_data:
            uid = headers.get("x-uid", "")
            for i, r in enumerate(rank_data, 1):
                if r.get("unionId") == union_id or r.get("uid") == uid:
                    my_rank = (i, r.get("clockDays", 0))
                    break
            if my_rank:
                print(f"{prefix}当前排名: 第{my_rank[0]}名, 累计签到{my_rank[1]}天")
            else:
                top3 = ", ".join(
                    f"{r.get('rank', i)}名({r.get('clockDays', 0)}天)"
                    for i, r in enumerate(rank_data[:3], 1)
                )
                print(f"{prefix}前3名: {top3}")

        title = "三养签到成功 ✅"
        rank_txt = f"\n排名: 第{my_rank[0]}名, 累计{my_rank[1]}天" if my_rank else ""
        reward_push = f"\n🎁 获得: {reward_txt}" if reward_txt else ""
        cum_push = f"\n{cum_days}" if cum_days and not my_rank else ""
        content = (f"签到时间: {now}\n活动: {info.get('activityName', '未知') if info else '未知'}"
                   f"{reward_push}{rank_txt}{cum_push}")
        print(f"{prefix}推送内容: {content}")
        send_notify(title, content)
        return {"success": True, "rank": my_rank, "info": info, "reward": reward_txt}
    else:
        print(f"{prefix}❌ 签到失败: {result}")
        title = "三养签到失败 ❌"
        content = f"签到时间: {now}\n返回: {json.dumps(result, ensure_ascii=False)}"
        send_notify(title, content)
        return {"error": True, "result": result}


def main():
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"===== 三养签到脚本 (YYB版) {now} =====")
    print(f"登录方式: {LOGIN_MODE}")

    if LOGIN_MODE == "yyb":
        # ---- YYB 模式: 遍历账号池 ----
        print("\n[1] 获取 YYB 账号列表...")
        accounts = yyb_get_accounts()
        if not accounts:
            print("❌ 无可用账号")
            return

        ref = YYB_REF.strip()
        if ref:
            filtered = [a for a in accounts if str(a.get("id")) == ref or a.get("openid") == ref]
            if not filtered:
                print(f"❌ 未找到 ref={ref} 的账号")
                return
            print(f"✅ 指定账号: {filtered[0].get('nickname', ref)}")
        else:
            filtered = [a for a in accounts if a.get("status") != "expired"]
            print(f"✅ 共 {len(filtered)} 个存活账号")

        results = []
        for i, acc in enumerate(filtered, 1):
            label = acc.get("nickname") or acc.get("alias") or f"id={acc.get('id')}"
            print(f"\n[{i}/{len(filtered)}] 📱 账号: {label}")
            code = yyb_get_code(acc.get("id") or acc.get("openid"))
            if not code:
                results.append({"label": label, "error": "取码失败"})
                continue
            headers = samyang_login(code)
            if not headers:
                results.append({"label": label, "error": "登录失败"})
                continue
            r = sign_one_account(headers, label=label, union_id=headers.get("x-unionid", ""))
            r["label"] = label
            results.append(r)
            if i < len(filtered):
                time.sleep(2)  # 账号间间隔, 避免风控

        # 汇总
        print("\n===== 执行完毕 =====")
        for r in results:
            if r.get("error"):
                print(f"  {r['label']}: 失败 {r['error']}")
            elif r.get("already"):
                print(f"  {r['label']}: 已签到, 跳过")
            elif r.get("success"):
                rw = f" 获得「{r['reward']}」" if r.get("reward") else ""
                print(f"  {r['label']}: 签到成功{rw}")
            else:
                print(f"  {r['label']}: 异常")

    else:
        # ---- manual 模式: 单账号 ----
        print("\n[manual] 使用抓包 TOKEN/UNION_ID")
        headers = manual_headers()
        sign_one_account(headers, label=UNION_ID, union_id=UNION_ID)
        print("\n===== 执行完毕 =====")


if __name__ == "__main__":
    main()
