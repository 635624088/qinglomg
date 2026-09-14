#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三养食品会员中心 - 自动抽奖 (YYB 登录版)
覆盖活动(自动从 CMS 首页配置发现, 无需写死 ID):
  1. 周一到周五每日 10 点「限时福利抽取积分」(每日 1 次, 当日有效)
  2. 「入会福利抽大奖」(月度活动)
  3. 邀友入会任务进度查询(每邀 1 位新用户注册+1 次抽奖机会, 上限 40; 需真实新用户, 无法代抽)

【登录链路】(2026-09-10 抓包实证)
  YYB /wxapp/getCode (app_id=wx8bf2da45c0cdee27 会员中心小程序) -> jsCode
  POST member.samyangfoods.net/mpgateway/mpmember/api/wechat/v2/login {jsCode}
    -> 响应头 TOKEN_REFRESH = JWT; 响应体 data.id = 会员ID(空=未注册会员中心, 跳过)
  后续请求头: AUTHORIZATION-WITH-MEMBER-CENTER: <JWT> + mini-app-user-id + appId + tenantId: samyang
  抽奖流程: CMS(pageCode=SY)发现活动ID -> lucky-draw/detail -> /join -> /account/mine
            -> /drawing(循环抽完 availableNum) -> prizes/records
  注: 仅"注册过三养会员中心"的微信号可抽; 未注册号自动跳过
"""
import json
import os
import re
import sys
import time
from datetime import datetime

import requests

# ======================== 配置区 ========================
YYB_BASE_URL = os.environ.get("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
YYB_REF = os.environ.get("YYB_REF", "")          # 指定账号 id, 空=遍历所有存活账号
MC_APPID = "wx8bf2da45c0cdee27"                   # 三养会员中心小程序
MC_BASE = "https://member.samyangfoods.net"
TENANT = "samyang"
PUSHPLUS_TOKEN = os.environ.get("SY_PUSHPLUS_TOKEN", "")  # 可选推送

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.78")
MAX_DRAW_PER_ACT = 10  # 单活动单次运行最大抽数(安全阀)


def pushplus_push(title, content):
    if not PUSHPLUS_TOKEN:
        return
    try:
        requests.post("https://www.pushplus.plus/send", timeout=15,
                      json={"token": PUSHPLUS_TOKEN, "title": title, "content": content, "template": "txt"})
    except Exception as e:
        print(f"[PushPlus推送失败] {e}")


# ======================== 基础请求 ========================

def mc_post(path, sess, payload, timeout=20):
    """会员中心 POST, 自动带鉴权头; 返回 (dict响应, headers)"""
    h = {
        "appId": MC_APPID,
        "tenantId": TENANT,
        "content-type": "application/json",
        "Referer": f"https://servicewechat.com/{MC_APPID}/28/page-frame.html",
        "User-Agent": UA,
    }
    if sess.get("jwt"):
        h["AUTHORIZATION-WITH-MEMBER-CENTER"] = sess["jwt"]
    if sess.get("uid"):
        h["mini-app-user-id"] = sess["uid"]
    try:
        r = requests.post(MC_BASE + path, headers=h, timeout=timeout,
                          json={"data": payload})
        return r.json(), r.headers
    except Exception as e:
        return {"code": "-1", "msg": str(e)[:100]}, {}


def yyb_get_code(ref):
    try:
        r = requests.post(f"{YYB_BASE_URL}/wxapp/getCode", timeout=60,
                          json={"app_id": MC_APPID, "ref": str(ref)})
        d = r.json()
        if d.get("code") == 0:
            return ((d.get("data") or {}).get("result") or {}).get("code")
        print(f"  ❌ YYB 取码失败: {str(d.get('msg'))[:80]}")
    except Exception as e:
        print(f"  ❌ YYB 取码异常: {str(e)[:80]}")
    return None


def yyb_accounts():
    try:
        r = requests.get(f"{YYB_BASE_URL}/accounts", timeout=15)
        d = r.json()
        if d.get("code") == 0:
            return d.get("data", [])
    except Exception as e:
        print(f"❌ 获取账号列表失败: {e}")
    return []


# ======================== 登录 ========================

def mc_login(code):
    """jsCode 换 JWT; 返回 sess dict 或 (None, 失败原因)"""
    h = {"appId": MC_APPID, "tenantId": TENANT, "content-type": "application/json",
         "Referer": f"https://servicewechat.com/{MC_APPID}/28/page-frame.html", "User-Agent": UA}
    try:
        r = requests.post(f"{MC_BASE}/mpgateway/mpmember/api/wechat/v2/login", headers=h,
                          timeout=20, json={"data": {"jsCode": code}, "eventChannel": {}})
    except Exception as e:
        return None, f"登录请求异常 {str(e)[:60]}"
    jwt = r.headers.get("TOKEN_REFRESH") or ""
    try:
        d = (r.json().get("data") or {})
    except Exception:
        return None, "登录响应解析失败"
    state = d.get("state") or ""
    uid = d.get("id") or ""
    if not jwt or (not uid and state != "logged_in"):
        return None, f"未注册会员中心({state or '无会话'})"
    return {"jwt": jwt, "uid": uid, "nick": d.get("nickName") or ""}, None


# ======================== 活动发现与抽奖 ========================

def discover_activities(sess):
    """从 CMS 首页配置发现所有进行中的 LUCKY_DRAW 活动"""
    d, _ = mc_post("/mpgateway/mpcms/api/cms/v2/published/get", sess, {"pageCode": "SY"})
    txt = json.dumps(d, ensure_ascii=False)
    ids = sorted(set(re.findall(r"HD[0-9a-z]{8,}", txt)))
    acts = []
    for aid in ids:
        d2, _ = mc_post("/mpgateway/luckydraw/api/activity/lucky-draw/v1/detail", sess,
                        {"activityId": aid})
        dd = d2.get("data") or {}
        if dd.get("name") and dd.get("type") == "LUCKY_DRAW" and dd.get("status") == "P_ING":
            acts.append(dd)
    return acts


def draw_activity(sess, act):
    """join -> 查次数 -> 抽完; 返回 (奖品列表, 备注状态)"""
    aid = act["activityId"]
    name = act.get("name") or aid
    prizes = []
    d, _ = mc_post("/mpgateway/luckydraw/api/activity/lucky-draw/v1/join", sess, {"activityId": aid})
    if d.get("code") != "200":
        return prizes, f"参与失败:{str(d.get('msg'))[:40]}"
    d, _ = mc_post("/mpgateway/luckydraw/api/activity/lucky-draw/v1/account/mine", sess,
                   {"activityId": aid})
    ad = d.get("data") or {}
    avail = ad.get("availableNum") or 0
    if not isinstance(avail, int) or avail <= 0:
        return prizes, "无可用次数"
    n = 0
    while n < min(avail, MAX_DRAW_PER_ACT):
        d, _ = mc_post("/mpgateway/luckydraw/api/activity/lucky-draw/v1/drawing", sess,
                       {"activityId": aid})
        dd = d.get("data") or {}
        if d.get("code") != "200":
            prizes.append(f"抽奖失败:{str(d.get('msg'))[:30]}")
            break
        if dd.get("hasWon"):
            prizes.append(dd.get("prizeName") or "未知奖品")
        else:
            prizes.append("未中奖")
            break
        n += 1
        time.sleep(1)
    return prizes, f"抽了{n}次"


def invite_progress(sess, aid):
    """邀友入会任务进度"""
    d, _ = mc_post("/mpgateway/luckydraw/api/campaign/task/v1/list/mine", sess, {"activityId": aid})
    for tk in (d.get("data") or []):
        if tk.get("actionId") == "member_invite_member":
            return f"{tk.get('quantityGet', 0)}/{tk.get('quantityMax', 0)} 位"
    return None


# ======================== 主流程 ========================

def run_one(ref, label):
    """单个账号: 登录+抽全部进行中活动; 返回结果文本"""
    code = yyb_get_code(ref)
    if not code:
        return f"{label}: ⏭ 取码失败(账号会话待刷新)"
    sess, err = mc_login(code)
    if sess is None:
        return f"{label}: ⏭ {err}"
    print(f"  [{label}] 登录成功 (uid={sess['uid'][:12]}...)")
    acts = discover_activities(sess)
    if not acts:
        return f"{label}: 无进行中的抽奖活动"
    parts = []
    for act in acts:
        aname = act.get("name") or act["activityId"]
        prizes, note = draw_activity(sess, act)
        if prizes:
            parts.append(f"{aname}: {'、'.join(prizes)}")
            print(f"  [{label}] 🎰 {aname} -> {'、'.join(prizes)}")
        else:
            parts.append(f"{aname}: {note}")
            print(f"  [{label}] {aname} -> {note}")
        # 邀请进度(只在入会福利活动查)
        if "入会" in aname:
            inv = invite_progress(sess, act["activityId"])
            if inv:
                parts.append(f"邀友进度 {inv}")
        time.sleep(1)
    return f"{label}: " + " | ".join(parts)


def main():
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"===== 三养会员中心 自动抽奖 (YYB版) {now} =====")
    accounts = yyb_accounts()
    if YYB_REF.strip():
        ref = YYB_REF.strip()
        accounts = [a for a in accounts if str(a.get("id")) == ref or a.get("openid") == ref]
        if not accounts:
            print(f"❌ 未找到 ref={ref}")
            return
    alive = [a for a in accounts if a.get("status") != "expired"]
    print(f"✅ 共 {len(alive)} 个存活账号")

    results = []
    for i, acc in enumerate(alive, 1):
        label = (acc.get("nickname") or acc.get("alias") or f"id={acc.get('id')}").strip()
        print(f"\n[{i}/{len(alive)}] 📱 {label}")
        try:
            results.append(run_one(acc.get("id") or acc.get("openid"), label))
        except Exception as e:
            results.append(f"{label}: ❌ 异常 {e.__class__.__name__}: {str(e)[:60]}")
        if i < len(alive):
            time.sleep(2)

    print("\n===== 执行完毕 =====")
    for s in results:
        print(" ", s)
    pushplus_push("三养抽奖", "\n".join(results))


if __name__ == "__main__":
    main()
