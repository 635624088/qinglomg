#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三养食品 一体化脚本 (签到 + 会员中心抽奖) - YYB 登录版
合并自: samyang_sign.py(数云签到) + samyang_lottery.py(会员中心抽奖)

用法:
  python3 samyang_all.py        # 签到 + 抽奖 (默认)
  python3 samyang_all.py sign   # 仅签到
  python3 samyang_all.py draw   # 仅抽奖

定时(青龙):
  ID=252  每天 08:07  ->  python3 samyang_all.py         (签到+抽奖)
  ID=253  每天 10:05  ->  python3 samyang_all.py draw    (每日10点次数刷新后再抽一次)

流程:
  [签到] YYB getCode(wx44e7e6fa31a013a5) -> 数云 /wmc-interact-c/1.3/index 登录
         -> POST /activity/access 签到 -> 奖励明细 + 累计天数 + 排名
  [抽奖] YYB getCode(wx8bf2da45c0cdee27 会员中心小程序) -> POST wechat/v2/login (JWT 在响应头 TOKEN_REFRESH)
         -> CMS pageCode=SY 自动发现进行中活动 -> lucky-draw join/drawing 抽完

【重要 - 关于会员中心注册(入会)】
  会员中心注册必须在小程序内点「手机号授权」弹窗完成, 服务端无注册接口, 脚本无法代注册。
  未入会的账号脚本会自动跳过抽奖。

环境变量:
  YYB_BASE_URL        YYB 网关 (默认 http://172.17.0.1:18080)
  YYB_REF             指定账号 id, 空=遍历所有存活账号
  SY_PUSHPLUS_TOKEN   PushPlus 推送 token (可选)
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
YYB_REF = os.environ.get("YYB_REF", "")            # 指定账号 id, 空=遍历所有存活账号

SIGN_APPID = "wx44e7e6fa31a013a5"                  # 三养互动小程序(数云签到)
SIGN_BASE = "https://ual.shuyun.com/wmc-interact-c/1.3"
SIGN_ACTIVITY_ID = "11895"                         # 累计签100天活动

MC_APPID = "wx8bf2da45c0cdee27"                    # 三养会员中心小程序
MC_BASE = "https://member.samyangfoods.net"
TENANT = "samyang"

PUSHPLUS_TOKEN = os.environ.get("SY_PUSHPLUS_TOKEN", "")
MAX_DRAW_PER_ACT = 10                              # 单活动单次运行最大抽数(安全阀)

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1 "
      "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.78")
SIGN_HEADERS = {
    "User-Agent": UA,
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Referer": f"https://servicewechat.com/{SIGN_APPID}/1/page-frame.html",
    "Accept-Language": "zh-CN,zh;q=0.9",
}
MC_HEADERS = {
    "appId": MC_APPID,
    "tenantId": TENANT,
    "content-type": "application/json",
    "Referer": f"https://servicewechat.com/{MC_APPID}/28/page-frame.html",
    "User-Agent": UA,
}


# ======================== 通用 ========================

def pushplus_push(title, content):
    if not PUSHPLUS_TOKEN:
        return
    try:
        requests.post("https://www.pushplus.plus/send", timeout=15,
                      json={"token": PUSHPLUS_TOKEN, "title": title,
                            "content": content, "template": "txt"})
    except Exception as e:
        print(f"[PushPlus推送失败] {e}")


def yyb_accounts():
    try:
        r = requests.get(f"{YYB_BASE_URL}/accounts", timeout=15)
        d = r.json()
        if d.get("code") == 0:
            return d.get("data", [])
    except Exception as e:
        print(f"❌ 获取 YYB 账号列表失败: {e}")
    return []


def yyb_get_code(app_id, ref):
    """YYB 取小程序一次性登录 code"""
    try:
        r = requests.post(f"{YYB_BASE_URL}/wxapp/getCode", timeout=60,
                          json={"app_id": app_id, "ref": str(ref)})
        d = r.json()
        if d.get("code") == 0:
            return ((d.get("data") or {}).get("result") or {}).get("code")
        print(f"  ❌ YYB 取码失败: {str(d.get('msg'))[:80]}")
    except Exception as e:
        print(f"  ❌ YYB 取码异常: {str(e)[:80]}")
    return None


# ======================== 第一部分: 数云签到 ========================

def sign_login(js_code):
    """微信 code 换数云会话头"""
    url = f"{SIGN_BASE}/index?platShopId={SIGN_APPID}&jsCode={js_code}"
    resp = requests.get(url, headers=SIGN_HEADERS, timeout=15)
    data = resp.json()
    if data.get("code") != "0":
        print(f"  ❌ 签到登录失败: {data.get('msg', '未知错误')}")
        return None
    d = data.get("data", {})
    headers = dict(SIGN_HEADERS)
    headers.update({
        "x-token": d["token"],
        "x-unionid": d["unionId"],
        "x-tx": str(d.get("tx", "")),
        "x-uid": d.get("uid", ""),
        "x-platshopid": d.get("platShopId", SIGN_APPID),
        "x-tenant": d.get("tenantId", ""),
    })
    return headers


def fmt_rewards(receive_list):
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
    try:
        resp = requests.get(f"{SIGN_BASE}/activityAward/record?pageSize=1&currentPage=1",
                            headers=headers, timeout=15)
        lst = ((resp.json().get("data") or {}).get("list")) or []
        if lst:
            return (lst[0].get("awardName") or lst[0].get("name") or "")
    except Exception:
        pass
    return ""


def get_points(headers):
    """查积分余额与会员等级 (数云 /member/info), 返回 (point, grade)"""
    try:
        mi = requests.get(f"{SIGN_BASE}/member/info", headers=headers, timeout=15).json()
        if str(mi.get("code")) == "0":
            d = mi.get("data") or {}
            return d.get("point"), (d.get("gradeCaption") or "")
    except Exception:
        pass
    return None, ""


def do_sign_one(label, ref):
    """单个账号签到, 返回摘要文本"""
    prefix = f"  [{label}] "
    code = yyb_get_code(SIGN_APPID, ref)
    if not code:
        return f"{label}: 取码失败(签到)"
    headers = sign_login(code)
    if not headers:
        return f"{label}: 登录失败(签到)"
    union_id = headers.get("x-unionid", "")

    # 活动信息 + 当前状态
    info = None
    try:
        info = requests.get(f"{SIGN_BASE}/activity/info/{SIGN_ACTIVITY_ID}",
                            headers=headers, timeout=15).json().get("data") or {}
    except Exception:
        pass
    status = requests.get(f"{SIGN_BASE}/cumulativeSign/{SIGN_ACTIVITY_ID}",
                          headers=headers, timeout=15).json()
    status_data = status.get("data") or {}
    status_msg = str(status.get("msg") or status_data.get("errorMessage") or "")
    if status.get("code") == "0" and status_data.get("receiveList"):
        pt, grade = get_points(headers)
        pts = f", 积分{pt}" + (f"({grade})" if grade else "") if pt is not None else ""
        print(f"{prefix}✅ 今日已签到, 跳过{pts}")
        return f"{label}: 已签到{pts}"
    if status.get("code") == "-1" and any(k in status_msg for k in ("重复", "已经", "已签", "打卡")):
        pt, grade = get_points(headers)
        pts = f", 积分{pt}" + (f"({grade})" if grade else "") if pt is not None else ""
        print(f"{prefix}✅ 今日已签到({status_msg}), 跳过{pts}")
        return f"{label}: 已签到{pts}"

    # 执行签到
    result = requests.post(f"{SIGN_BASE}/activity/access?id={SIGN_ACTIVITY_ID}",
                           headers=headers, json={}, timeout=15).json()
    if not (result.get("code") == "0" and result.get("data") is True):
        print(f"{prefix}❌ 签到失败: {json.dumps(result, ensure_ascii=False)[:120]}")
        return f"{label}: 签到失败"

    print(f"{prefix}✅ 签到成功")
    extra = []
    # 奖励明细
    new_status = requests.get(f"{SIGN_BASE}/cumulativeSign/{SIGN_ACTIVITY_ID}",
                              headers=headers, timeout=15).json()
    reward_txt = fmt_rewards((new_status.get("data") or {}).get("receiveList"))
    if not reward_txt:
        reward_txt = get_last_award(headers)
    if reward_txt:
        print(f"{prefix}🎁 获得: {reward_txt}")
        extra.append(f"得「{reward_txt}」")
    # 累计天数/排名
    try:
        rank_data = requests.get(f"{SIGN_BASE}/cumulativeSign/rank/{SIGN_ACTIVITY_ID}",
                                 headers=headers, timeout=15).json().get("data") or []
        for i, r in enumerate(rank_data, 1):
            if r.get("unionId") == union_id or r.get("uid") == headers.get("x-uid", ""):
                print(f"{prefix}排名: 第{i}名, 累计签到{r.get('clockDays', 0)}天")
                extra.append(f"累计{r.get('clockDays', 0)}天")
                break
    except Exception:
        pass
    # 积分余额
    pt, grade = get_points(headers)
    if pt is not None:
        gtxt = f"({grade})" if grade else ""
        print(f"{prefix}💰 积分: {pt}{gtxt}")
        extra.append(f"积分{pt}{gtxt}")
    tail = f" ({', '.join(extra)})" if extra else ""
    return f"{label}: 签到成功{tail}"


# ======================== 第二部分: 会员中心抽奖 ========================

def mc_post(path, sess, payload, timeout=20):
    h = dict(MC_HEADERS)
    if sess.get("jwt"):
        h["AUTHORIZATION-WITH-MEMBER-CENTER"] = sess["jwt"]
    if sess.get("uid"):
        h["mini-app-user-id"] = sess["uid"]
    try:
        r = requests.post(MC_BASE + path, headers=h, timeout=timeout, json={"data": payload})
        return r.json(), r.headers
    except Exception as e:
        return {"code": "-1", "msg": str(e)[:100]}, {}


def mc_login(code):
    """jsCode 换 JWT; 返回 sess dict 或 (None, 失败原因)"""
    h = dict(MC_HEADERS)
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


def discover_activities(sess):
    """CMS 首页配置发现进行中的 LUCKY_DRAW 活动"""
    d, _ = mc_post("/mpgateway/mpcms/api/cms/v2/published/get", sess, {"pageCode": "SY"})
    txt = json.dumps(d, ensure_ascii=False)
    acts = []
    for aid in sorted(set(re.findall(r"HD[0-9a-z]{8,}", txt))):
        d2, _ = mc_post("/mpgateway/luckydraw/api/activity/lucky-draw/v1/detail", sess,
                        {"activityId": aid})
        dd = d2.get("data") or {}
        if dd.get("name") and dd.get("type") == "LUCKY_DRAW" and dd.get("status") == "P_ING":
            acts.append(dd)
    return acts


def draw_activity(sess, act):
    """join -> 查次数 -> 抽完; 返回 (奖品列表, 备注状态)"""
    aid = act["activityId"]
    prizes = []
    d, _ = mc_post("/mpgateway/luckydraw/api/activity/lucky-draw/v1/join", sess, {"activityId": aid})
    if d.get("code") != "200":
        return prizes, f"参与失败:{str(d.get('msg'))[:40]}"
    d, _ = mc_post("/mpgateway/luckydraw/api/activity/lucky-draw/v1/account/mine", sess,
                   {"activityId": aid})
    avail = (d.get("data") or {}).get("availableNum") or 0
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


def do_draw_one(label, ref):
    """单个账号会员中心抽奖, 返回摘要文本"""
    code = yyb_get_code(MC_APPID, ref)
    if not code:
        return f"{label}: 取码失败(抽奖)"
    sess, err = mc_login(code)
    if sess is None:
        hint = ("未入会会员中心, 跳过抽奖" if "未注册" in err else err)
        return f"{label}: ⏭ {hint}"
    print(f"  [{label}] 会员中心登录成功 (uid={sess['uid'][:12]}...)")
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
        time.sleep(1)
    return f"{label}: " + " | ".join(parts)


# ======================== 主流程 ========================

def main():
    mode = "all"
    if len(sys.argv) > 1 and sys.argv[1] in ("sign", "draw"):
        mode = sys.argv[1]
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"===== 三养一体化脚本 (签到+抽奖) 模式={mode} {now} =====")

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
        ref = acc.get("id") or acc.get("openid")
        print(f"\n[{i}/{len(alive)}] 📱 {label}")
        line = label + ":"
        seg = []
        try:
            if mode in ("all", "sign"):
                seg.append(do_sign_one(label, ref).split(":", 1)[-1].strip())
            if mode in ("all", "draw"):
                seg.append(do_draw_one(label, ref).split(":", 1)[-1].strip())
        except Exception as e:
            seg.append(f"❌ 异常 {e.__class__.__name__}: {str(e)[:60]}")
        results.append(f"{label}: " + " | ".join(seg))
        if i < len(alive):
            time.sleep(2)

    print("\n===== 执行完毕 =====")
    for s in results:
        print(" ", s)
    pushplus_push("三养签到+抽奖", "\n".join(results))


if __name__ == "__main__":
    main()
