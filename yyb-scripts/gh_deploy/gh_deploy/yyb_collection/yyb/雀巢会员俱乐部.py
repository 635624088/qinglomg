#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
雀巢会员俱乐部自动任务脚本
脚本奖励：雀币、抽奖实物
"""

import os
import sys
import asyncio
import time
from datetime import datetime
from typing import List, Dict, Any, Optional

# 自动参与积分抽奖开关设置（每次抽奖扣8积分）
# True表示自动参与抽奖，False表示不参与抽奖
JoinDraw = True

# 多账号循环开关设置
# True表示循环执行，False表示只执行一次
LoopAccounts = False
# 任务最大重试次数配置
MaxRetries = 5

# 任务重试延迟配置（单位：秒，支持小数，如0.5表示500毫秒）
RetryDelay = 1.5

# 短期抽奖活动ID，请勿修改（活动时间25.09.19-25.09.25）
DrawActivity = "SCH7TFRF0MPI"

# 领取抽奖次数的GUID，请勿修改
UPDATE_DRAW_COUNT_GUIDS = {"451BF17A8B3846DBB1D27F0E47F0B2D7", "51BF214377C74E908236D29E0DD58ABB"}

# 需要跳过的日常积分任务ID，都是无法直接完成的任务，不要修改
SKIP_TASK_GUIDS = {"38C8BBDA3DAE4CD685B270D939E5063D", "36EFECD2AD8C44278317ED567EB24DD9"}

# 雀巢会员俱乐部小程序AppID
NESTLE_APPID = "wxc5db704249c9bb31"

try:
    import httpx
except ImportError:
    print("❌ 未安装httpx[http2]库，请运行以下命令安装：")
    print("pip install httpx[http2]")
    sys.exit(1)

async def fetch_accounts():
    try:
        YYB_BASE_URL = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{YYB_BASE_URL}/accounts")
            data = r.json()
            accs = data.get("data", [])
            print(f"共获取到 {len(accs)} 个账号")
            for i, a in enumerate(accs, 1):
                print(f"   {i}. {a.get('nickname') or a.get('name', '未知')} (openid: {a.get('openid', '')})")
            return accs
    except Exception as e:
        print(f"获取账号失败: {e}")
        return []

async def bridge_get_code(openid: str, appid: str) -> Optional[str]:
    YYB_BASE_URL = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(f"{YYB_BASE_URL}/wxapp/getCode",
                                  json={"app_id": appid, "ref": openid},
                                  headers={"Content-Type": "application/json"})
            result = r.json()
            if result.get("code") == 0:
                return result.get("data", {}).get("result", {}).get("code")
    except Exception as e:
        print(f"  bridge_get_code 异常: {e}")
    return None

async def get_wxcode(wxid: str, appid: str) -> Optional[str]:
    """通过wechat-server获取微信code，优先使用bridge"""
    code = await bridge_get_code(wxid, appid)
    if code:
        return code
    YYB_BASE_URL = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
    url = f"{YYB_BASE_URL}/api/v1/wx/app/get/code"
    headers = {"Content-Type": "application/json"}
    payload = {"wxid": wxid, "appid": appid}
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, json=payload, headers=headers)
            data = response.json()
            if data.get("Code") == 0:
                return data.get("Data", {}).get("code")
            else:
                print(f"💀 获取wxcode失败: {data.get('Message', '未知错误')}")
                return None
    except Exception as e:
        print(f"💀 请求wxcode异常: {e}")
        return None

async def verify_token(token: str) -> bool:
    """验证token是否有效"""
    url = "https://crm.nestlechinese.com/openapi/pointsservice/api/Points/getuserbalance"
    headers = {
        "host": "crm.nestlechinese.com",
        "displayversion": "0",
        "authorization": f"Bearer {token}",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541022) XWEB/16467",
        "content-type": "application/json",
        "accept": "*/*",
        "referer": "https://servicewechat.com/wxc5db704249c9bb31/460/page-frame.html",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "zh-CN,zh;q=0.9"
    }
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, content="{}", headers=headers)
            result = response.json()
            return result.get("errcode") == 200
    except Exception:
        return False

# 缓存文件路径
CACHE_FILE = "qchyjlb.txt"

def read_cached_tokens(file_path: str = CACHE_FILE) -> dict:
    """读取缓存的tokens"""
    tokens = {}
    try:
        if os.path.exists(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and '#' in line:
                        try:
                            wxid, token = line.split('#', 1)
                            tokens[wxid.strip()] = token.strip()
                        except ValueError:
                            pass
    except Exception as e:
        print(f"💀 读取缓存失败: {e}")
    return tokens

def write_cached_tokens(tokens: dict, file_path: str = CACHE_FILE) -> None:
    """写入tokens到缓存文件"""
    try:
        if tokens:
            with open(file_path, 'w', encoding='utf-8') as f:
                for wxid, token in tokens.items():
                    if wxid and token:
                        f.write(f"{wxid}#{token}\n")
    except Exception as e:
        print(f"💀 保存缓存失败: {e}")

async def get_auth_by_wxid(wxid: str, cached_tokens: dict) -> Optional[str]:
    """通过wxid自动获取Authorization，支持缓存机制"""
    # 检查缓存中是否有有效token
    if wxid in cached_tokens:
        token = cached_tokens[wxid]
        if await verify_token(token):
            return token
    
    # 重新获取token
    print(f"🔑 正在获取Authorization...")
    auth_code = await get_wxcode(wxid, NESTLE_APPID)
    if not auth_code:
        print(f"❌ 获取wxcode失败")
        return None
    
    url = "https://crm.nestlechinese.com/openapi/identityservice/connect/token"
    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c23) NetType/WIFI Language/zh_CN",
        "Accept-Encoding": "gzip,compress,br,deflate",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": f"https://servicewechat.com/{NESTLE_APPID}/486/page-frame.html"
    }
    data = {
        "client_id": "wechatMini",
        "client_secret": "secret",
        "grant_type": "wechat_auth_code",
        "auth_code": auth_code
    }
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, data=data, headers=headers)
            result = response.json()
            access_token = result.get("access_token")
            
            if access_token:
                # 保存到缓存
                cached_tokens[wxid] = access_token
                write_cached_tokens(cached_tokens)
                print(f"✅ 获取成功")
                return access_token
            else:
                print(f"❌ 换取Authorization失败")
                return None
    except Exception as e:
        print(f"❌ 请求token异常: {e}")
        return None

class QueChaoBot:
    def __init__(self, jwt_token: str):
        self.jwt_token = jwt_token
        self.base_url = "https://crm.nestlechinese.com"
        self.headers = {
            "host": "crm.nestlechinese.com",
            "displayversion": "0",
            "authorization": f"Bearer {jwt_token}",
            "user-agent": "Mozilla/5.0 (Linux; Android 16; 2211133C Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160289 MMWEBSDK/20260201 MMWEBID/5202 MicroMessenger/8.0.69.3022(0x28004542) WeChat/arm64 Weixin GPVersion/1 NetType/5G Language/zh_CN ABI/arm64 MiniProgramEnv/android",
            "content-type": "application/json",
            "accept": "*/*",
            "referer": "https://servicewechat.com/wxc5db704249c9bb31/489/page-frame.html",
            "accept-encoding": "gzip, deflate, br",
            "accept-language": "zh-CN,zh;q=0.9"
        }
        self.client = None

    async def __aenter__(self):
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=self.headers,
            http2=True,
            timeout=30.0
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.client:
            await self.client.aclose()

    def check_response(self, response_data: Dict[str, Any]) -> bool:
        """检查API响应是否成功"""
        if not response_data:
            print("❌ 响应数据为空")
            return False
            
        errcode = response_data.get("errcode", -1)
        errmsg = response_data.get("errmsg", "未知错误")
        
        # 处理空错误信息
        if errmsg is None or errmsg == "None":
            errmsg = "未知错误"
        
        # 特殊情况处理：errcode不是200但errmsg是"成功"
        if errcode in [200, 201] and (errmsg == "成功" or errmsg == "请求成功"):
            print(f"✅ 请求成功: {errmsg}")
            return True
            
        if errcode != 200:
            # 过滤掉虚假的首次关注和订阅任务的失败信息
            if "首次关注雀巢中国公众号" not in errmsg and "首次订阅小程序活动通知" not in errmsg:
                print(f"❌ 请求失败: {errmsg}")
            return False
        return True

    async def get_user_balance(self) -> Optional[int]:
        """获取用户积分余额"""
        try:
            payload = "{}"
            headers = self.headers.copy()
            headers["content-length"] = str(len(payload))
            
            response = await self.client.post(
                "/openapi/pointsservice/api/Points/getuserbalance",
                content=payload,
                headers=headers
            )
            response_data = response.json()
            
            if self.check_response(response_data):
                return response_data.get("data")
            return None
        except Exception as e:
            print(f"❌ 获取用户积分失败: {e}")
            return None

    async def daily_sign(self) -> bool:
        """每日签到"""
        try:
            payload = '{"rule_id":1,"goods_rule_id":1}'
            headers = self.headers.copy()
            headers["content-length"] = str(len(payload))
            
            response = await self.client.post(
                "/openapi/activityservice/api/sign2025/sign",
                content=payload,
                headers=headers
            )
            
            # 检查响应状态
            if response.status_code != 200:
                print(f"❌ 签到请求失败，状态码: {response.status_code}")
                return False
            
            # 尝试解析响应
            try:
                response_data = response.json()
            except Exception as e:
                print(f"❌ 签到响应解析失败: {e}")
                return False
            
            if response_data.get("errcode") == 201:
                print(f"⚠️ 签到错误: {response_data.get('errmsg', '未知错误')}")
                return False
                
            if response_data.get("errcode") == 200:
                data = response_data.get("data", {})
                sign_day = data.get("sign_day", 0)
                sign_points = data.get("sign_points", 0)
                print(f"✅ 签到成功，已签到{sign_day}天，获得{sign_points}积分")
                return True
            elif self.check_response(response_data):
                data = response_data.get("data", {})
                sign_day = data.get("sign_day", 0)
                sign_points = data.get("sign_points", 0)
                print(f"✅ 签到成功，已签到{sign_day}天，获得{sign_points}积分")
                return True
                
        except Exception as e:
            print(f"❌ 签到失败: {e}")
            return False
        
        print("❌ 签到失败，继续执行后续任务")
        return False

    async def get_task_list(self) -> List[Dict[str, Any]]:
        """获取日常积分任务列表"""
        try:
            payload = "{}"
            headers = self.headers.copy()
            headers["content-length"] = str(len(payload))
            headers["charset"] = "utf-8"
            headers["displayversion"] = "1"
            
            response = await self.client.post(
                "/openapi/activityservice/api/task/getlist",
                content=payload,
                headers=headers
            )
            response_data = response.json()
            
            if self.check_response(response_data):
                tasks = response_data.get("data", [])
                uncompleted_tasks = [
                    task for task in tasks 
                    if task.get("task_status") == 0 
                    and task.get("task_guid") not in SKIP_TASK_GUIDS
                ]
                print(f"📋 未完成任务个数: {len(uncompleted_tasks)}")
                return uncompleted_tasks
            return []
        except Exception as e:
            print(f"❌ 获取任务列表失败: {e}")
            return []

    async def complete_task(self, task_guid: str, task_desc: str, max_retries: int = MaxRetries) -> bool:
        """完成任务"""
        if task_guid in SKIP_TASK_GUIDS:
            print(f"⏭️ 跳过任务【{task_desc}】")
            return False
            
        # 处理空任务描述
        if not task_desc or task_desc == "None":
            task_desc = "未知任务"
            
        for attempt in range(max_retries):
            try:
                # 检查任务是否需要progress_rule_id参数
                if task_desc and ("浏览" in task_desc or "大字版" in task_desc or "小程序" in task_desc or "官网" in task_desc):
                    payload = f'{{"task_guid":"{task_guid}","progress_rule_id":1}}'
                else:
                    payload = f'{{"task_guid":"{task_guid}"}}'
                
                headers = self.headers.copy()
                headers["content-length"] = str(len(payload))
                headers["charset"] = "utf-8"
                
                response = await self.client.post(
                    "/openapi/activityservice/api/task/add",
                    content=payload,
                    headers=headers
                )
                response_data = response.json()
                
                if self.check_response(response_data):
                    # 检查任务是否真的完成
                    task_status = response_data.get("data", {})
                    
                    # 过滤掉虚假的首次关注和订阅任务
                    if "首次关注雀巢中国公众号" in task_desc or "首次订阅小程序活动通知" in task_desc:
                        print(f"⏭️ 跳过任务，请手动完成！【{task_desc}】")
                        return False
                    
                    # 特殊处理：有些任务返回0表示成功
                    if task_status == 0 or task_status == 1:
                        print(f"✅ 成功完成任务【{task_desc}】")
                        return True
                    elif isinstance(task_status, dict) and task_status.get("task_status") == 1:
                        print(f"✅ 成功完成任务【{task_desc}】")
                        return True
                    else:
                        print(f"⚠️ 任务状态异常: {response_data.get('errmsg', '未知状态')}")
                        return False
                else:
                    if attempt < max_retries - 1:
                        print(f"⏳ 任务提交失败，{RetryDelay}秒后重试 ({attempt + 1}/{max_retries})")
                        await asyncio.sleep(RetryDelay)
                    
            except Exception as e:
                print(f"❌ 完成任务失败: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(RetryDelay)
        
        print(f"❌ 任务【{task_desc}】完成失败，已达到最大重试次数")
        return False

    async def get_draw_activity_info(self) -> Optional[Dict[str, Any]]:
        """获取抽奖活动信息"""
        try:
            response = await self.client.get(f"/openapi/activityservice/api/LuckyDraw/{DrawActivity}")
            response_data = response.json()
            
            if self.check_response(response_data):
                data = response_data.get("data", {})
                title = data.get("title", "")
                end_time = data.get("end_time", "")
                print(f"🎯 【{title}】活动截止日期{end_time}")
                
                if end_time:
                    try:
                        end_datetime = datetime.fromisoformat(end_time.replace('T', ' '))
                        if datetime.now() > end_datetime:
                            print("⏰ 活动已结束，跳过抽奖")
                            return None
                    except:
                        pass
                
                return data
            return None
        except Exception as e:
            print(f"❌ 获取抽奖活动信息失败: {e}")
            return None

    async def get_draw_tasks(self) -> List[Dict[str, Any]]:
        """获取抽奖任务列表"""
        all_draw_tasks = []
        
        try:
            payload = f'{{"show_channel":"{DrawActivity}","task_type":1,"gift_count":0}}'
            headers = self.headers.copy()
            headers["content-length"] = str(len(payload))
            
            response = await self.client.post(
                "/openapi/activityservice/api/task/getlistbyshowchanneltype",
                content=payload,
                headers=headers
            )
            response_data = response.json()
            
            if self.check_response(response_data):
                tasks = response_data.get("data", [])
                uncompleted_tasks = [
                    task for task in tasks 
                    if task.get("task_status") == 0 
                    and task.get("task_guid") not in SKIP_TASK_GUIDS
                ]
                all_draw_tasks.extend(uncompleted_tasks)
                print(f"📋 获取到{len(uncompleted_tasks)}个未完成的抽奖任务（type=1）")
            
            payload = f'{{"show_channel":"{DrawActivity}","task_type":0,"gift_count":1}}'
            headers["content-length"] = str(len(payload))
            
            response = await self.client.post(
                "/openapi/activityservice/api/task/getlistbyshowchanneltype",
                content=payload,
                headers=headers
            )
            response_data = response.json()
            
            if self.check_response(response_data):
                tasks = response_data.get("data", [])
                uncompleted_single_tasks = [
                    task for task in tasks 
                    if task.get("task_status") == 0 
                    and task.get("task_guid") not in SKIP_TASK_GUIDS
                ]
                all_draw_tasks.extend(uncompleted_single_tasks)
                print(f"📋 获取到{len(uncompleted_single_tasks)}个未完成的单次任务（type=0）")
            
            print(f"📋 总共获取到{len(all_draw_tasks)}个未完成的抽奖相关任务")
            return all_draw_tasks
            
        except Exception as e:
            print(f"❌ 获取抽奖任务列表失败: {e}")
            return []

    async def update_draw_count(self) -> bool:
        """更新抽奖次数"""
        success_count = 0
        
        for task_guid in UPDATE_DRAW_COUNT_GUIDS:
            try:
                payload = f'{{"task_guid":"{task_guid}"}}'
                headers = self.headers.copy()
                headers["content-length"] = str(len(payload))
                
                response = await self.client.post(
                    "/openapi/activityservice/api/task/add",
                    content=payload,
                    headers=headers
                )
                response_data = response.json()
                
                errcode = response_data.get("errcode")
                if errcode in [200, 201]:
                    print(f"✅ 领取抽奖次数提交成功{task_guid}")
                    success_count += 1
                else:
                    print(f"❌ 领取抽奖次数提交失败 (task_guid: {task_guid}): {response_data.get('errmsg', '未知错误')}")
                    
                await asyncio.sleep(1)
                    
            except Exception as e:
                print(f"❌ 更新抽奖次数异常 (task_guid: {task_guid}): {e}")
        
        return success_count > 0

    async def get_draw_count(self) -> int:
        """获取抽奖次数"""
        try:
            response = await self.client.get(f"/openapi/activityservice/api/LuckyDraw/{DrawActivity}")
            response_data = response.json()
            
            if self.check_response(response_data):
                data = response_data.get("data", {})
                count = data.get("count", 0)
                print(f"🎲 当前可抽奖{count}次")
                return count
            return 0
        except Exception as e:
            print(f"❌ 获取抽奖次数失败: {e}")
            return 0

    async def draw_lottery(self, draw_count: int) -> None:
        """进行抽奖"""
        if not JoinDraw:
            print("🚫 JoinDraw设置为False，跳过自动抽奖")
            return
        
        for i in range(draw_count):
            try:
                response = await self.client.get(
                    f"/openapi/activityservice/api/LuckyDraw/LuckyDrawByPoints/{DrawActivity}"
                )
                response_data = response.json()
                
                if self.check_response(response_data):
                    data = response_data.get("data", {})
                    title = data.get("title", "未知奖品")
                    print(f"🎉 第{i + 1}次抽奖，获得{title}")
                else:
                    print(f"❌ 第{i + 1}次抽奖失败")
                    
                if i < draw_count - 1:
                    await asyncio.sleep(1)
                    
            except Exception as e:
                print(f"❌ 第{i + 1}次抽奖异常: {e}")

    async def get_xiaoxiaole_code(self) -> None:
        """获取消消乐礼包"""
        try:
            payload = '{"rule_id":1}'
            headers = self.headers.copy()
            headers["content-length"] = str(len(payload))
            
            response = await self.client.post(
                "/openapi/activityservice/api/xiaoxiaolegame/getcode",
                content=payload,
                headers=headers
            )
            response_data = response.json()
            
            if response_data.get("errcode") == 200:
                data = response_data.get("data", {})
                print(f"✅ 获取消消乐礼包成功: {data}")
            else:
                print(f"❌ 获取消消乐礼包失败: {response_data.get('errmsg', '未知错误')}")
                
        except Exception as e:
            print(f"❌ 获取消消乐礼包异常: {e}")

    async def run(self, account_index: int) -> None:
        """运行主流程"""
        print(f"\n{'='*50}")
        print(f"开始处理账号{account_index + 1}")
        print(f"{'='*50}")
        
        # 1. 获取初始积分
        initial_balance = await self.get_user_balance()
        if initial_balance is None:
            print(f"❌ 账号{account_index + 1}Token无效")
            return
        
        print(f"✅ 账号{account_index + 1}Token有效")
        print(f"💰 今日初始积分: {initial_balance}")
        
        # 2. 每日签到
        await self.daily_sign()
        
        # 3. 获取并完成日常任务
        tasks = await self.get_task_list()
        for task in tasks:
            task_guid = task.get("task_guid", "")
            task_desc = task.get("task_sub_desc", "") or task.get("task_title", "未知任务")
            if task_guid:
                # 先检查任务是否已经完成
                if task.get("task_status") == 1:
                    print(f"✅ 任务【{task_desc}】已完成，跳过")
                    continue
                await self.complete_task(task_guid, task_desc)
                await asyncio.sleep(1)
        
        # 抽奖相关任务
        try:
            draw_info = await self.get_draw_activity_info()
            if draw_info:
                draw_tasks = await self.get_draw_tasks()
                for task in draw_tasks:
                    task_guid = task.get("task_guid", "")
                    task_title = task.get("task_title", "") or task.get("task_sub_desc", "未知抽奖任务")
                    if task_guid:
                        # 先检查任务是否已经完成
                        if task.get("task_status") == 1:
                            print(f"✅ 抽奖任务【{task_title}】已完成，跳过")
                            continue
                        await self.complete_task(task_guid, f"抽奖任务-{task_title}")
                        await asyncio.sleep(1)
                
                # 完成抽奖任务后，更新抽奖次数
                if draw_tasks:
                    print("🔄 更新抽奖次数...")
                    await self.update_draw_count()
                
                # 获取抽奖次数并抽奖
                draw_count = await self.get_draw_count()
                if draw_count > 0:
                    await self.draw_lottery(draw_count)
                    # 抽奖操作完成后获取消消乐礼包（每天限量100份，领取不到也没事，只有游戏道具，没啥用）
                    await self.get_xiaoxiaole_code()
        except Exception as e:
            print(f"⚠️ 抽奖活动可能已结束: {e}")
        
        # 5. 获取最终积分并计算差值
        final_balance = await self.get_user_balance()
        if final_balance is not None:
            gained_points = final_balance - initial_balance
            print(f"📊 今日共获得{gained_points}积分，当前积分{final_balance}")
        
        print(f"✅ 账号{account_index + 1}处理完成")
        return gained_points, final_balance

def validate_jwt(jwt_token: str) -> bool:
    """验证Token格式"""
    return jwt_token.startswith('ey')

def parse_accounts_data(accounts_str: str) -> list:
    """解析账号数据"""
    accounts = []
    
    # 按行分割账号
    lines = [line.strip() for line in accounts_str.strip().split('\n') if line.strip()]
    
    for line in lines:
        if '#' in line:
            # 找到第一个#的位置
            first_hash_index = line.find('#')
            name = line[:first_hash_index].strip()
            rest = line[first_hash_index + 1:].strip()
            
            # 判断是否为直接提供的token格式
            if rest.startswith('ey'):
                accounts.append({
                    'name': name,
                    'wxid': '',
                    'token': rest
                })
            else:
                # wxid格式
                accounts.append({
                    'name': name,
                    'wxid': rest,
                    'token': None
                })
        else:
            # 单独的token或wxid
            if line.startswith('ey'):
                accounts.append({
                    'name': '账号',
                    'wxid': '',
                    'token': line
                })
            else:
                accounts.append({
                    'name': '账号',
                    'wxid': line,
                    'token': None
                })
    
    return accounts

# ===================== 推送模块 =====================
try:
    from notify import send as notify_send
    NOTIFY_AVAILABLE = True
except ImportError:
    NOTIFY_AVAILABLE = False
    def notify_send(title, content):
        print(f"📢 {title}\n{content}")

def notify(title, message):
    try:
        notify_send(title, message)
        print(f"✅ 推送成功: {title}")
    except ImportError:
        try:
            import sys
            # 先尝试当前目录
            paths_to_try = ['.']
            # 从环境变量读取自定义路径
            custom_path = os.environ.get('NOTIFY_PATH', '')
            if custom_path:
                paths_to_try.extend(custom_path.split(os.pathsep))
            # 最后尝试青龙容器默认路径
            paths_to_try.extend(['/ql/scripts', '/ql/scripts/lib'])
            
            for path in paths_to_try:
                if os.path.exists(os.path.join(path, 'notify.py')):
                    sys.path.append(path)
                    from notify import send
                    send(title, message)
                    print(f"✅ 推送成功: {title}")
                    return
            print(f"📢 {title}: {message}")
        except Exception as e:
            print(f"❌ 推送失败: {str(e)}")
    except Exception as e:
        print(f"❌ 推送失败: {str(e)}")

async def main():
    quechao_env = os.getenv('quechao')
    
    accounts = []
    if quechao_env:
        accounts = parse_accounts_data(quechao_env)
        print(f"从环境变量获取 {len(accounts)} 个账号")
    else:
        bridge_accs = await fetch_accounts()
        for a in bridge_accs:
            openid = a.get('openid', '').strip()
            name = a.get('nickname') or a.get('name', '') or openid[:8]
            if openid:
                accounts.append({'name': name, 'wxid': openid, 'token': None})
        print(f"从 bridge 加载 {len(accounts)} 个账号")
    
    if not accounts:
        print("❌ 环境变量'quechao'为空或格式错误")
        return
    
    print(f"🔍 检测到{len(accounts)}个账号配置")
    
    # 检查是否有传统wxid格式的账号
    has_traditional_accounts = any(not account.get('token') for account in accounts)
    
    # 只有当有传统wxid格式账号时，才读取缓存的tokens
    cached_tokens = read_cached_tokens() if has_traditional_accounts else {}
    new_cached_count = 0  # 记录新缓存的token数量
    
    # 边获取token边执行任务
    account_results = []
    for i, account in enumerate(accounts):
        name = account['name']
        wxid = account['wxid']
        token = account['token']
        
        # 获取token
        auth_token = None
        if token:
            # 直接使用提供的token
            if validate_jwt(token):
                auth_token = token
            else:
                print(f"❌ [{name}] Token格式错误")
                continue
        elif wxid:
            # 通过wxid获取token
            had_cached = wxid in cached_tokens
            auth_token = await get_auth_by_wxid(wxid, cached_tokens)
            if auth_token and not had_cached:
                new_cached_count += 1
        
        if not auth_token:
            print(f"❌ [{name}] 获取凭证失败，跳过")
            continue
        
        # 执行任务
        print(f"\n=== 账号 {i+1}/{len(accounts)}: {name} ===")
        try:
            async with QueChaoBot(auth_token) as bot:
                gained_points, final_balance = await bot.run(i)
                # 保存账号结果
                account_results.append({
                    'name': name,
                    'gained_points': gained_points,
                    'final_balance': final_balance
                })
        except Exception as e:
            print(f"❌ [{name}] 执行异常: {e}")
        
        # 等待3秒后处理下一个账号
        if i < len(accounts) - 1:
            print(f"\n⏳ 等待3秒后处理下一个账号...")
            await asyncio.sleep(3)
    
    # 输出缓存更新信息
    if has_traditional_accounts and new_cached_count > 0:
        print(f"\n💾 Token缓存更新: 新增 {new_cached_count} 个")
    
    # 统一推送所有账号结果
    if account_results:
        # 过滤掉没有获得积分的账号
        filtered_results = [result for result in account_results if result['gained_points'] > 0]
        if filtered_results:
            title = "🎉 雀巢会员俱乐部今日战果"
            content = "\n".join([f"🎁 账号{result['name']}: 今日薅到{result['gained_points']}积分，当前库存{result['final_balance']}" for result in filtered_results])
            notify(title, content)
    
    print(f"\n🎉 所有账号处理完成！")

if __name__ == "__main__":
    print("☕️ 雀巢自动化脚本启动")
    print(f"📅 当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"🎯 抽奖活动ID: {DrawActivity}")
    print(f"🎲 自动抽奖开关: {'开启' if JoinDraw else '关闭'}")
    print(f"🔄 多账号循环开关: {'开启' if LoopAccounts else '关闭'}")
    print(f"🔁 任务最大重试次数: {MaxRetries}")
    print(f"⏱️ 任务重试延迟: {RetryDelay}秒 ({int(RetryDelay * 1000)}毫秒)")
    # print(f"🔄 更新抽奖次数任务ID: {', '.join(UPDATE_DRAW_COUNT_GUIDS)}")
    
    try:
        if LoopAccounts:
            # 循环执行模式
            while True:
                asyncio.run(main())
                print(f"\n🔄 所有账号处理完成，等待5秒后开始下一轮循环...")
                time.sleep(5)
        else:
            # 单次执行模式
            asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ 用户中断，脚本退出")
    except Exception as e:
        print(f"\n❌ 程序异常: {e}")