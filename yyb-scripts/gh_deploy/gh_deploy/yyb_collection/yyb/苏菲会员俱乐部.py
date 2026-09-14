#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
苏菲会员俱乐部签到脚本
"""

import os
import json
import time
import sys
import asyncio
import aiohttp
from aiohttp import ClientSession, ClientTimeout

sys.stdout.reconfigure(encoding='utf-8')

# 缓存配置
CACHE_FILE = "sufei.txt"  # 缓存文件路径，用于存储登录凭证

# 并发控制
MAX_CONCURRENT = 1  # 最大并发数，控制同时处理的账号数量

# 全局配置参数
APP_ID = "wx3398ff02bb96f7d8"  # 小程序APP_ID
KDT_ID = "136148929"  # 店铺ID
REFERER = "https://servicewechat.com/wx3398ff02bb96f7d8/40/page-frame.html"  # 请求来源
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18151'  # 用户代理
CHECKIN_ID = "5012108"  # 签到活动ID

# ── Bridge (本地 API 服务器) ─────────────────────────────────────
YYB_BASE_URL = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
BRIDGE_KEY = os.getenv('BRIDGE_KEY', '')

def bridge_headers() -> dict:
    h = {'Content-Type': 'application/json'}
    if BRIDGE_KEY:
        h['Authorization'] = f'Bearer {BRIDGE_KEY}'
    return h

async def fetch_accounts() -> list:
    try:
        async with ClientSession() as session:
            async with session.get(f'{YYB_BASE_URL}/accounts', headers=bridge_headers(), timeout=ClientTimeout(total=15)) as resp:
                data = await resp.json()
        accounts = data.get('data', [])
        print(f'共获取到 {len(accounts)} 个账号')
        for i, acc in enumerate(accounts, 1):
            print(f'   {i}. {(acc.get("nickname") or acc.get("name") or "未知")} (openid: {acc.get("openid", "")})')
        return accounts
    except Exception as e:
        print(f'获取账号失败: {e}')
        return []

async def bridge_get_code(appid: str, openid: str) -> str:
    payload = json.dumps({"app_id": appid, "ref": openid}).encode('utf-8')
    h = bridge_headers()
    h['Content-Type'] = 'application/json'
    async with ClientSession() as session:
        async with session.post(f'{YYB_BASE_URL}/wxapp/getCode', data=payload, headers=h, timeout=ClientTimeout(total=90)) as resp:
            data = await resp.json()
    if data.get('code') != 0:
        return ''
    return data.get('data', {}).get('result', {}).get('code', '')

# 有赞API接口
YOUZAN_CHECKIN_BASE = "https://h5.youzan.com/wscump/checkin"  # 有赞签到基础路径

def get_display_width(s):
    width = 0
    for char in s:
        if ord(char) > 127 or char in '　，。；：！？""''（）【】':
            width += 2
        else:
            width += 1
    return width

def get_separator(title):
    width = get_display_width(title)
    return '=' * max(width, 40)

# 缓存相关函数
def read_cache() -> dict:
    cache = {}
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and '#' in line:
                        try:
                            parts = line.split('#', 2)
                            if len(parts) == 3:
                                name = parts[0].strip()
                                wxid = parts[1].strip()
                                data = json.loads(parts[2].strip())
                                cache[f"{name}#{wxid}"] = data
                        except (ValueError, json.JSONDecodeError):
                            pass
    except Exception as e:
        print(f"💥 读取缓存文件失败: {str(e)}")
    return cache

def write_cache(cache: dict) -> None:
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            for key, data in cache.items():
                if '#' in key:
                    f.write(f"{key}#{json.dumps(data)}\n")
    except Exception as e:
        print(f"💥 写入缓存文件失败: {str(e)}")

async def is_token_valid(session: ClientSession, login_data: dict) -> bool:
    access_token = login_data.get('accessToken')
    session_id = login_data.get('sessionId')
    if not access_token or not session_id:
        return False
    
    try:
        # 使用活动信息接口验证，更全面
        url = YOUZAN_CHECKIN_BASE + "/get_activity_by_yzuid_v2.json"
        params = {
            "checkinId": CHECKIN_ID,
            "app_id": APP_ID,
            "kdt_id": KDT_ID,
            "access_token": access_token
        }
        headers = {
            "content-type": "application/json",
            "extra-data": '{"is_weapp":1,"sid":"' + session_id + '","version":"2.221.6.101","client":"weapp","bizEnv":"wsc","uuid":"Y7wWJZkaYj6xQJc1776522717525","ftime":1776522717522}',
            "charset": "utf-8",
            "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027',
            "referer": REFERER
        }
        async with session.get(url, params=params, headers=headers, timeout=ClientTimeout(total=10)) as response:
            if response.status == 200:
                result = await response.json()
                if result.get('code') == 0:
                    return True
                # 检查是否是session无效的错误
                error_msg = result.get('msg', '')
                if 'invalid session' in error_msg:
                    print("📋 缓存的session已过期")
            else:
                print(f"📋 验证token状态失败，状态码: {response.status}")
    except Exception as e:
        print(f"📋 验证token异常: {str(e)}")
    return False

async def get_login_params(session: ClientSession, wxid: str, name: str = "") -> dict:
    cache = read_cache()
    cache_key = f"{name}#{wxid}"
    if cache_key in cache:
        token_valid = await is_token_valid(session, cache[cache_key]['data'])
        if token_valid:
            print("📋 使用缓存的登录凭证")
            return cache[cache_key]['data']
        else:
            print("📋 缓存的登录凭证已过期")
    
    try:
        print("📱 正在获取微信登录码...")
        code = await bridge_get_code(APP_ID, wxid)
        if not code:
            print("❌ 获取微信登录码失败")
            return {}
        
        print("🔑 正在获取登录凭证...")
        login_url = "https://uic.youzan.com/passport/general/auth.json" + f"?kdt_id={KDT_ID}&app_id={APP_ID}"
        login_data = {
            "appId": APP_ID,
            "code": code,
            "platformName": "weapp",
            "signature": "ios",
            "clientId": "4d65249d377b2c3ed8",
            "grantType": "yz_union",
            "inWsc": True,
            "kdtId": KDT_ID,
            "extraBizData": {
                "enterOptions": {
                    "extKdtId": int(KDT_ID),
                    "path": "pages/home/dashboard/index",
                    "query": {},
                    "scene": 1005,
                    "referrerInfo": {},
                    "mode": "default",
                    "apiCategory": "default"
                },
                "guideBizDataMap": {
                    "from_params": ""
                },
                "sceneData": {}
            }
        }
        headers = {
            "content-type": "application/json",
            "app-mode": "default",
            "page-path": "pages/home/dashboard/index",
            "Extra-Data": '{"sid":"","version":"2.221.6.101","clientType":"weapp-miniprogram","client":"weapp","bizEnv":"","uuid":"0VDKhBw9mHZnf3A1775189500622","ftime":1775189500620}',
            "user-agent": USER_AGENT,
            "referer": REFERER
        }
        async with session.post(login_url, json=login_data, headers=headers, timeout=ClientTimeout(total=10)) as response:
            if response.status == 200:
                result = await response.json()
                if result.get('code') == 0:
                    print("😊 请求成功")
                    print("🎉 成功获取登录凭证")
                    data = result.get('data', {})
                    cache[cache_key] = {
                        'data': data
                    }
                    write_cache(cache)
                    return data
                else:
                    print(f"❌ 获取登录凭证失败: {result.get('message')}")
            else:
                print(f"❌ 请求失败，状态码: {response.status}")
    except Exception as e:
        print(f"💥 获取登录凭证异常: {str(e)}")
    return {}

async def get_points(session: ClientSession, login_data: dict) -> int:
    """获取用户积分"""
    try:
        access_token = login_data.get('accessToken')
        if not access_token:
            return 0
        
        url = "https://h5.youzan.com/wscuser/membercenter/init-data.json"
        params = {
            "kdt_id": KDT_ID,
            "app_id": APP_ID,
            "access_token": access_token,
            "version": "2.221.6.101",
            "kdtId": KDT_ID,
            "onlineKdtId": KDT_ID,
            "currentKdtId": KDT_ID,
            "needConsumptionAboveCoupon": 1
        }
        headers = {
            "content-type": "application/json",
            "extra-data": '{"is_weapp":1,"sid":"' + login_data.get('sessionId', '') + '","version":"2.221.6.101","client":"weapp","bizEnv":"wsc","uuid":"Y7wWJZkaYj6xQJc1776522717525","ftime":1776522717522}',
            "charset": "utf-8",
            "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027',
            "referer": REFERER
        }
        
        async with session.get(url, params=params, headers=headers, timeout=ClientTimeout(total=10)) as response:
            if response.status == 200:
                result = await response.json()
                if result.get('code') == 0:
                    data = result.get('data', {})
                    member = data.get('member', {})
                    stats = member.get('stats', {})
                    points = stats.get('points', 0)
                    return points
    except Exception:
        pass
    return 0

async def sign_in(session: ClientSession, login_data: dict) -> bool:
    try:
        access_token = login_data.get('accessToken')
        if not access_token:
            print("❌ 缺少访问令牌")
            return False
        
        # 获取活动信息接口
        activity_url = YOUZAN_CHECKIN_BASE + "/get_activity_by_yzuid_v2.json"
        params = {
            "checkinId": CHECKIN_ID,
            "app_id": APP_ID,
            "kdt_id": KDT_ID,
            "access_token": access_token
        }
        headers = {
            "content-type": "application/json",
            "extra-data": '{"is_weapp":1,"sid":"' + login_data.get('sessionId', '') + '","version":"2.221.6.101","client":"weapp","bizEnv":"wsc","uuid":"Y7wWJZkaYj6xQJc1776522717525","ftime":1776522717522}',
            "charset": "utf-8",
            "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027',
            "referer": REFERER
        }
        
        async with session.get(activity_url, params=params, headers=headers, timeout=ClientTimeout(total=10)) as response:
            if response.status == 200:
                result = await response.json()
                if result.get('code') == 0:
                    data = result.get('data', {})
                    is_checkin = data.get('isCheckin', False)
                    if is_checkin:
                        print("📋 今日已签到，无需重复操作")
                        # 打印签到信息
                        print(f"📅 连续签到: {data.get('continuesDay', 0)} 天")
                        if 'dailyRewards' in data:
                            for reward in data['dailyRewards']:
                                print(f"🎁 今日奖励: {reward.get('desc', '')}")
                        return True
                    else:
                        # 执行签到
                        checkin_url = YOUZAN_CHECKIN_BASE + "/checkinV2.json"
                        async with session.get(checkin_url, params=params, headers=headers, timeout=ClientTimeout(total=10)) as checkin_response:
                            if checkin_response.status == 200:
                                checkin_result = await checkin_response.json()
                                if checkin_result.get('code') == 0:
                                    print("🎉 签到成功！")
                                    # 打印签到奖励
                                    if 'data' in checkin_result:
                                        checkin_data = checkin_result['data']
                                        if 'list' in checkin_data:
                                            for item in checkin_data['list']:
                                                if 'infos' in item:
                                                    print(f"🎁 获得奖励: {item['infos'].get('title', '')}")
                                    return True
                                else:
                                    error_msg = checkin_result.get('msg', checkin_result.get('message', '未知错误'))
                                    print(f"❌ 签到失败: {error_msg}")
                            else:
                                print(f"❌ 签到请求失败，状态码: {checkin_response.status}")
                else:
                    error_msg = result.get('msg', result.get('message', '未知错误'))
                    print(f"❌ 获取活动信息失败: {error_msg}")
            else:
                print(f"❌ 获取活动信息请求失败，状态码: {response.status}")
    except Exception as e:
        print(f"💥 签到异常: {str(e)}")
    return False

async def process_account(account: tuple) -> bool:
    name, wxid = account
    title = f"=== 账号: {name} ==="
    separator = get_separator(title)
    print(f"\n{separator}")
    print(title)
    print(f"📱 wxid: {wxid}")
    print("🔑 开始获取登录凭证...")
    
    async with ClientSession() as session:
        login_data = await get_login_params(session, wxid, name)
        if not login_data:
            return False
        
        print("🚀 开始执行签到...")
        success = await sign_in(session, login_data)
        if success:
            print("📋 正在查询积分...")
            points = await get_points(session, login_data)
            if points > 0:
                print(f"💰 当前积分: {points}")
        return success

async def main():
    title = "🚀 脚本开始执行"
    separator = get_separator(title)
    print(separator)
    print(title)
    print(separator)
    
    accounts = []
    sufei_env = os.getenv('sufei')
    if sufei_env:
        lines = [line.strip() for line in sufei_env.strip().split('\n') if line.strip()]
        for line in lines:
            if '#' in line:
                parts = line.split('#', 1)
                if len(parts) == 2:
                    name = parts[0].strip()
                    wxid = parts[1].strip()
                    accounts.append((name, wxid))
    else:
        bridge_accounts = await fetch_accounts()
        for acc in bridge_accounts:
            openid = (acc.get('openid') or '').strip()
            name = (acc.get('nickname') or acc.get('name') or '账号').strip()
            if openid:
                accounts.append((name, openid))
    
    if not accounts:

        return
    
    print(f"📋 共发现 {len(accounts)} 个账号")
    
    results = []
    for i, account in enumerate(accounts):
        result = await process_account(account)
        results.append(result)
        if i < len(accounts) - 1:
            print("⏰ 等待3秒后处理下一个账号...")
            await asyncio.sleep(3)
    
    total = len(results)
    success = sum(results)
    failure = total - success
    
    title = "📊 执行结果汇总"
    separator = get_separator(title)
    print(f"\n{separator}")
    print(title)
    print(separator)
    print(f"🎯 总数: {total}")
    print(f"✅ 成功: {success}")
    print(f"❌ 失败: {failure}")
    print(f"💥 异常: 0")
    
    title = "🎉 脚本执行完成"
    separator = get_separator(title)
    print(f"\n{separator}")
    print(title)
    print(separator)

if __name__ == "__main__":
    asyncio.run(main())
