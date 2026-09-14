#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
脚本名称: 飞鹤北纬47度好物 - 完整版
【功能说明】
飞鹤|北纬47度好物小程序 每日签到、自动完成任务
支持 YYB 协议自动登录 + Token文件缓存
支持青龙内置通知

【环境变量】
  YYB_BASE_URL: YYB协议地址，默认 http://172.17.0.1:18080
  xmtoken: (回退)预存 token，格式 token1&token2&...
  
【Token缓存】
  首次运行自动登录并缓存 token 到 token_cache.json
  后续运行优先使用缓存，Token失效时自动重新获取
"""

import os
import sys
import time
import random
import asyncio
import requests
import hashlib
import json
import string
from datetime import datetime
from typing import List, Dict, Optional

try:
    from notify import send as ql_notify
except ImportError:
    ql_notify = None

# ====================== 常量 ======================
APP_NAME = "飞鹤北纬47度好物"
CK_NAME = "xmtoken"
APP_ID = "xmyx"
APP_KEY = "TwUQ01lKS1Km5zlV2f7amsZc5EQYkTbv"
HOST = "https://www.feihevip.com/api"
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
TOKEN_CACHE_FILE = "token_cache.json"
TOKEN_EXPIRE_DAYS = 180

# 可重复执行3次的任务名称
REPEAT_TASK_NAME = "星飞帆卓睿4段"
REPEAT_TIMES = 3

requests.packages.urllib3.disable_warnings()


# ====================== 青龙通知 ======================
def send_notify(title: str, content: str):
    """使用青龙内置 notify.py 发送通知"""
    if ql_notify:
        try:
            ql_notify(title, content)
            print(f"[{datetime.now().strftime('%H:%M:%S')}] 📢 通知发送成功")
        except Exception as e:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 通知发送失败: {e}")
    else:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 未找到通知模块，跳过通知")


# ====================== 日志 ======================
def log(msg: str):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


# ====================== 签名工具 ======================
def get_fh_nonce_str(length=16):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))

def get_timestamp():
    return str(int(time.time()))

def md5(md5str):
    m = hashlib.md5()
    m.update(md5str.encode('utf-8'))
    return m.hexdigest().upper()

def get_signature(data=None):
    json_str = json.dumps(data) if data else ''
    fh_nonce_str = get_fh_nonce_str(16)
    fh_timestamp = get_timestamp()
    sign_string = f"fhAppid{APP_ID}fhNonceStr{fh_nonce_str}fhTimestamp{fh_timestamp}{json_str}{APP_KEY}"
    return {"fhNonceStr": fh_nonce_str, "fhTimestamp": fh_timestamp, "fhSign": md5(sign_string)}

def get_signature2():
    fh_nonce_str = get_fh_nonce_str(16)
    fh_timestamp = get_timestamp()
    sign_string = f"fhAppidxmhfhNonceStr{fh_nonce_str}fhTimestamp{fh_timestamp}98d9fe9b613a479dbcb111ca261e3ce1"
    return {"fhNonceStr": fh_nonce_str, "fhTimestamp": fh_timestamp, "fhSign": md5(sign_string)}


# ====================== Token 缓存 ======================
def load_token_cache() -> Dict:
    """加载缓存的token"""
    if os.path.exists(TOKEN_CACHE_FILE):
        try:
            with open(TOKEN_CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return {}
    return {}

def save_token_cache(cache: Dict):
    """保存token缓存"""
    try:
        with open(TOKEN_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, ensure_ascii=False)
    except Exception as e:
        log(f"保存Token缓存失败: {e}")

def get_cached_token(openid: str) -> Optional[str]:
    """获取缓存的token"""
    cache = load_token_cache()
    openid_cache = cache.get(openid, {})
    token = openid_cache.get("token", "")
    return token if token else None

def save_token_to_cache(openid: str, token: str):
    """保存token到缓存"""
    cache = load_token_cache()
    cache[openid] = {
        "token": token,
        "expire_time": int(time.time()) + TOKEN_EXPIRE_DAYS * 86400,
        "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    save_token_cache(cache)

def clear_token_cache(openid: str):
    """清除指定账号的缓存Token"""
    cache = load_token_cache()
    if openid in cache:
        del cache[openid]
        save_token_cache(cache)
        log(f"  Token缓存已清除")


# ====================== YYB 协议 ======================
def fetch_accounts_from_yyb() -> List[Dict]:
    """从 YYB 协议获取账号列表"""
    if not YYB_BASE_URL:
        return []
    try:
        resp = requests.get(f"{YYB_BASE_URL}/accounts", timeout=10)
        data = resp.json()
        if data.get("code") == 0:
            accounts = []
            for item in data.get("data", []):
                openid = item.get("openid") or ""
                nickname = item.get("nickname") or item.get("alias") or openid
                if openid:
                    accounts.append({"name": nickname, "openid": openid})
            return accounts
    except Exception as e:
        log(f"从 YYB 获取账号失败: {e}")
    return []

def get_yyb_wx_code(openid: str) -> Optional[str]:
    """通过 YYB 协议获取小程序 code"""
    if not YYB_BASE_URL:
        return None
    for i in range(3):
        try:
            r = requests.post(
                f"{YYB_BASE_URL}/wxapp/getCode",
                json={"ref": openid, "app_id": "wx4205ec55b793245e"},
                headers={"Content-Type": "application/json"},
                timeout=15,
            )
            resp = r.json()
            if resp.get("code") == 0:
                result = resp.get("data", {}).get("result") or {}
                code = result.get("code", "")
                if code:
                    return code
            else:
                if i < 2:
                    time.sleep(2)
        except Exception as e:
            if i < 2:
                time.sleep(2)
    return None

def login_with_code(code: str) -> Optional[str]:
    """用 wx code 登录飞鹤，返回 token"""
    try:
        headers = {
            "fhAppid": APP_ID,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15"
        }
        r = requests.get(
            "https://www.feihevip.com/api/starMember/getUserToken",
            params={"code": code, "appId": APP_ID},
            headers=headers,
            timeout=15,
        )
        resp = r.json()
        token = resp.get("data", {}).get("token", "") if isinstance(resp.get("data"), dict) else ""
        if not token:
            token = resp.get("token", "")
        return token if token else None
    except Exception as e:
        return None


# ====================== 用户类 ======================
class UserInfo:
    def __init__(self, openid: str, nickname: str, index: int):
        self.openid = openid
        self.nickname = nickname
        self.index = index
        self.token = ""
        self.user_name = nickname
        self.mobile = ""
        self.ck_status = True
        self.final_score = 0
        self.earned_points = 0
        self.sign_success = False
        
        self.headers = {}
        self.session = requests.Session()

    def set_token(self, token: str):
        self.token = token
        self.headers = {
            "Host": "www.feihevip.com",
            "token": token,
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.48(0x1800302b) NetType/4G Language/zh_CN",
            "Referer": "https://servicewechat.com/wx4205ec55b793245e/366/page-frame.html",
            "fhAppid": APP_ID,
            "source": "1",
        }

    async def request(self, url, method="GET", params=None, data=None, headers=None, allow_fail=False):
        if url.startswith("/"):
            url = f"{HOST}{url}"
        req_headers = {**self.headers, **(headers or {})}
        try:
            if method == "GET":
                response = await asyncio.to_thread(self.session.get, url, params=params, headers=req_headers, timeout=10)
            else:
                response = await asyncio.to_thread(self.session.post, url, json=data, params=params, headers=req_headers, timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            if not allow_fail:
                self.ck_status = False
                log(f"  ⛔️ 请求失败: {e}")
            return None

    async def test_token(self):
        """测试Token是否有效"""
        try:
            signature = get_signature({})
            headers = {**self.headers, **signature}
            res = await self.request("/starMember/getMemberInfo", "POST", headers=headers, allow_fail=True)
            if res and res.get("code") == "200" and res.get("data"):
                return True
            return False
        except Exception:
            return False

    async def login(self):
        """登录获取token（优先缓存，失效时自动重新获取）"""
        # 1. 尝试从缓存获取
        cached_token = get_cached_token(self.openid)
        if cached_token:
            self.set_token(cached_token)
            # 测试Token是否有效
            if await self.test_token():
                return True
            else:
                # log removed
                clear_token_cache(self.openid)
        
        # 2. 缓存无效或失效，重新登录
        # log removed
        code = get_yyb_wx_code(self.openid)
        if not code:
            log(f"  ❌ 获取code失败")
            self.ck_status = False
            return False
        token = login_with_code(code)
        if not token:
            log(f"  ❌ 登录失败")
            self.ck_status = False
            return False
        
        # 3. 保存到缓存
        save_token_to_cache(self.openid, token)
        self.set_token(token)
        # log removed
        return True

    async def get_sign_info(self):
        try:
            signature = get_signature()
            headers = {**self.headers, **signature}
            res = await self.request("/member/signin/getSignInfo", headers=headers)
            if res and res.get("data"):
                sign_status = res["data"].get("signStatus")
                if sign_status == 1:
                    log(f"  ✅ 今日已签到")
                    self.sign_success = True
                elif sign_status == 2:
                    await self.signin()
            else:
                log(f"  ⚠️ 签到信息获取失败")
        except Exception as e:
            self.ck_status = False
            log(f"  ⛔️ 签到异常: {e}")

    async def signin(self):
        try:
            signature = get_signature()
            headers = {**self.headers, **signature}
            res = await self.request("/member/signin/sign", "POST", headers=headers)
            if res and res.get("code") == "200":
                log(f"  ✅ 签到成功")
                self.sign_success = True
                self.earned_points += 2
            else:
                log(f"  ⚠️ 签到失败：{res.get('msg', '未知错误') if res else '无响应'}")
        except Exception as e:
            self.ck_status = False
            log(f"  ⛔️ 签到异常: {e}")

    async def get_task_list(self):
        try:
            signature = get_signature()
            headers = {**self.headers, **signature}
            res = await self.request("/member/signin/getTaskList", headers=headers)
            if res and res.get("code") == "200" and res.get("data"):
                return res["data"]
        except Exception as e:
            pass
        return []

    async def tofinish(self, task_name, task_type):
        try:
            signature = get_signature()
            headers = {**self.headers, **signature}
            res = await self.request("/member/signin/tofinish", params={"taskType": task_type}, headers=headers)
            if res and res.get("code") == "200":
                log(f"  🚀 {task_name}")
            else:
                log(f"  ⚠️ {task_name} 开始失败: {res.get('msg', '') if res else ''}")
        except Exception as e:
            log(f"  ⛔️ {task_name} 开始异常: {e}")

    async def complete_task(self, task_name, task_type):
        """完成任务（完整版，带积分累加）"""
        try:
            signature = get_signature()
            headers = {**self.headers, **signature}
            res = await self.request("/member/signin/completeTask", params={"taskType": task_type}, headers=headers)
            
            if res and res.get("code") == "200":
                if res.get("data"):
                    point_data = res["data"].get("awardSendPoints", 0)
                    if isinstance(point_data, str):
                        point = int(point_data) if point_data.isdigit() else 0
                    else:
                        point = int(point_data) if point_data else 0
                    
                    if point > 0:
                        log(f"  ✅ {task_name} +{point}积分")
                        self.earned_points += point
                    else:
                        log(f"  ℹ️ {task_name} 已完成（无积分）")
                else:
                    log(f"  ℹ️ {task_name} 已完成")
            else:
                msg = res.get('msg', '未知错误') if res else '无响应'
                log(f"  ⛔️ {task_name} 失败: {msg}")
        except Exception as e:
            self.ck_status = False
            log(f"  ⛔️ {task_name} 异常: {e}")

    async def get_user_info(self):
        try:
            signature = get_signature({})
            headers = {**self.headers, **signature}
            res = await self.request("/starMember/getMemberInfo", "POST", headers=headers)
            if res and res.get("code") == "200" and res.get("data"):
                score = res["data"].get("memberPoints", {}).get("scoreValue", 0)
                user_name = res["data"].get("baseInfo", {}).get("nickName", "")
                # 手机号
                mobile = ""
                possible_fields = [
                    res["data"].get("baseInfo", {}).get("mobile"),
                    res["data"].get("baseInfo", {}).get("fullName"),
                    res["data"].get("mobile")
                ]
                for field in possible_fields:
                    if field and isinstance(field, str) and len(field) == 11 and field.isdigit() and field.startswith("1"):
                        mobile = field
                        break
                if not mobile:
                    mobile = res["data"].get("baseInfo", {}).get("fullName", "") or res["data"].get("crmId", "")
                
                return {"score": score, "userName": user_name, "mobile": mobile}
            else:
                # 如果返回非200，可能是Token失效
                return None
        except Exception as e:
            return None

    async def refresh_token(self):
        """刷新token并更新缓存"""
        try:
            signature = get_signature2()
            headers = {
                "Host": "mom.feihe.com",
                "token": self.token,
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15",
                "Referer": "https://servicewechat.com/wx4205ec55b793245e/366/page-frame.html",
                "fhAppid": "xmh",
                "source": "1",
                **signature
            }
            refresh_session = requests.Session()
            res = await asyncio.to_thread(
                refresh_session.get, "https://mom.feihe.com/program/token/refreshToken", headers=headers, timeout=10
            )
            res.raise_for_status()
            refresh_data = res.json()
            if refresh_data and refresh_data.get("data"):
                new_token = refresh_data["data"]
                self.token = new_token
                self.headers["token"] = new_token
                # 更新缓存
                save_token_to_cache(self.openid, new_token)
                # log removed
            else:
                log(f"  ⚠️ Token刷新返回为空")
        except Exception as e:
            log(f"  ⛔️ Token刷新失败: {e}")


# ====================== 解析账号 ======================
def parse_accounts() -> List[UserInfo]:
    """解析账号：优先YYB，回退环境变量"""
    user_list = []
    
    # 优先从 YYB 协议获取
    yyb_accounts = fetch_accounts_from_yyb()
    if yyb_accounts:
        log(f"从 YYB 获取到 {len(yyb_accounts)} 个账号")
        for i, acc in enumerate(yyb_accounts, 1):
            user = UserInfo(acc["openid"], acc["name"], i)
            user_list.append(user)
        return user_list
    
    # 回退：从环境变量读取 token（兼容旧版）
    env_value = os.environ.get(CK_NAME, "")
    if env_value:
        separators = ["\n", "&", "@"]
        separator = None
        for sep in separators:
            if sep in env_value:
                separator = sep
                break
        tokens = [t.strip() for t in env_value.split(separator) if t.strip()] if separator else [env_value.strip()] if env_value.strip() else []
        for i, token in enumerate(tokens, 1):
            user = UserInfo(f"env_{i}", f"账号{i}", i)
            user.set_token(token)
            user_list.append(user)
        log(f"从环境变量读取到 {len(user_list)} 个账号")
        return user_list
    
    log("❌ 未检测到有效账号来源（YYB协议或环境变量均无数据）")
    return user_list


# ====================== 主函数 ======================
async def main():
    log("\n" + "=" * 50)
    log("🎯 飞鹤北纬47度好物 - 完整版")
    log("=" * 50 + "\n")

    # 获取账号
    user_list = parse_accounts()
    if not user_list:
        log("❌ 未找到有效账号")
        return

    # 对YYB来源的账号进行登录（自动检测Token有效性）
    yyb_accounts = fetch_accounts_from_yyb()
    if yyb_accounts:
        log(f"正在登录 {len(user_list)} 个账号...")
        for user in user_list:
            success = await user.login()
            if not success:
                log(f"  ❌ 账号 {user.index} 登录失败，跳过")
                user.ck_status = False
        log(f"✅ 登录完成\n")

    # 获取任务列表（从第一个有效账号）
    task_list = []
    for user in user_list:
        if user.ck_status and user.token:
            task_list = await user.get_task_list()
            if task_list:
                break
    
    if task_list:
        log(f"📋 获取到 {len(task_list)} 个任务\n")
    else:
        # 如果第一个账号获取任务失败，尝试从其他账号获取
        for user in user_list[1:]:
            if user.ck_status and user.token:
                task_list = await user.get_task_list()
                if task_list:
                    log(f"📋 获取到 {len(task_list)} 个任务\n")
                    break

    # 执行任务
    notify_list = []
    for user in user_list:
        if not user.ck_status or not user.token:
            log(f"\n[{user.index}] {user.nickname} ❌ 跳过（无效账号）")
            notify_list.append({
                "index": user.index,
                "name": user.nickname,
                "status": "失败（账号无效）",
                "final_score": 0,
                "earned": 0,
                "mobile": ""
            })
            continue

        log(f"\n[{user.index}] {user.nickname}")

        # 获取初始积分
        info_before = await user.get_user_info()
        if info_before:
            user.user_name = info_before["userName"] or user.nickname
            user.mobile = info_before.get("mobile", "")
            log(f"  积分: {info_before['score']}")
        else:
            # 获取用户信息失败，尝试重新登录
            log(f"  ⚠️ 获取用户信息失败，尝试重新登录...")
            clear_token_cache(user.openid)
            success = await user.login()
            if success:
                info_before = await user.get_user_info()
                if info_before:
                    user.user_name = info_before["userName"] or user.nickname
                    user.mobile = info_before.get("mobile", "")
                    log(f"  积分: {info_before['score']}")
                else:
                    log(f"  ❌ 重新登录后仍获取用户信息失败，跳过")
                    notify_list.append({
                        "index": user.index,
                        "name": user.nickname,
                        "status": "失败",
                        "final_score": 0,
                        "earned": 0,
                        "mobile": ""
                    })
                    continue
            else:
                log(f"  ❌ 重新登录失败，跳过")
                notify_list.append({
                    "index": user.index,
                    "name": user.nickname,
                    "status": "失败",
                    "final_score": 0,
                    "earned": 0,
                    "mobile": ""
                })
                continue

        # 签到
        await user.get_sign_info()
        await asyncio.sleep(1)

        # 执行任务
        if user.ck_status and task_list:
            for task in task_list:
                task_name = task.get("taskName")
                task_type = task.get("taskType")
                
                # 判断是否需要重复执行
                repeat_count = REPEAT_TIMES if REPEAT_TASK_NAME in task_name else 1
                
                for i in range(repeat_count):
                    await user.tofinish(task_name, task_type)
                    await asyncio.sleep(3)
                    await user.complete_task(task_name, task_type)
                    await asyncio.sleep(random.uniform(1, 3))

        # 获取最终积分
        if user.ck_status:
            info_after = await user.get_user_info()
            if info_after:
                # 用差值修正累加值
                earned_by_diff = info_after["score"] - info_before["score"] if info_before else 0
                if user.earned_points != earned_by_diff and earned_by_diff > 0:
                    user.earned_points = earned_by_diff
                user.final_score = info_after["score"]
                
                log(f"  最终积分: {info_after['score']} (+{user.earned_points})")
                
                # 刷新token
                await user.refresh_token()
                
                notify_list.append({
                    "index": user.index,
                    "name": user.user_name or user.nickname,
                    "status": "成功",
                    "final_score": user.final_score,
                    "earned": user.earned_points,
                    "mobile": user.mobile
                })
            else:
                notify_list.append({
                    "index": user.index,
                    "name": user.nickname,
                    "status": "部分成功",
                    "final_score": 0,
                    "earned": user.earned_points,
                    "mobile": ""
                })
        else:
            notify_list.append({
                "index": user.index,
                "name": user.nickname,
                "status": "失败",
                "final_score": 0,
                "earned": 0,
                "mobile": ""
            })

    # ====================== 发送通知 ======================
    if notify_list:
        # 构建通知内容
        lines = ["=" * 30]
        total_earned = 0
        success_count = 0
        
        for acc in notify_list:
            if acc["status"] == "成功":
                icon = "✅"
                success_count += 1
            elif acc["status"] == "部分成功":
                icon = "⚠️"
            else:
                icon = "❌"
            
            name_display = acc["name"]
            if acc["mobile"] and len(acc["mobile"]) >= 4:
                name_display = f"{acc['name']}({acc['mobile'][-4:]})"
            
            if acc["earned"] > 0:
                score_text = f"{acc['final_score']} (+{acc['earned']})"
                total_earned += acc["earned"]
            else:
                score_text = str(acc["final_score"]) if acc["final_score"] > 0 else acc["status"]
            
            lines.append(f"{icon} {name_display} | {score_text}")
        
        lines.append("=" * 30)
        lines.append(f"📊 统计: {success_count}/{len(notify_list)} 成功 | 总计 +{total_earned}分")
        
        content = "\n".join(lines)
        
        # 发送青龙通知
        try:
            send_notify(f"{APP_NAME} 执行完成", content)
        except Exception as e:
            log(f"通知发送异常: {e}")
        
        # 同时打印到控制台
        print("\n" + content)

    log("\n🎉 所有任务执行完成")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("\n❌ 脚本被手动中断")
    except Exception as e:
        log(f"\n❌ 脚本执行出错: {str(e)}")
        import traceback
        traceback.print_exc()