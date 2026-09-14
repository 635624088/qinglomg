#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
脚本名称: 飞鹤星妈会 - YYB版
【功能说明】
飞鹤星妈会小程序 每日签到、自动完成任务、连连看游戏
支持 YYB 协议自动登录 + Token缓存(180天)

【环境变量】
  YYB_BASE_URL: YYB协议地址，默认 http://172.17.0.1:18080

【Token缓存】
  首次运行自动登录并缓存 token 到 星妈会缓存.txt
  后续运行优先使用缓存，有效期180天
"""

import os
import sys
import time
import random
import json
import re
import requests
import urllib3
from datetime import datetime
from typing import Any, Optional, List, Dict
from io import StringIO
import traceback

try:
    from notify import send as ql_notify
except ImportError:
    ql_notify = None

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ====================== 常量 ======================
APP_NAME = "飞鹤星妈会"
APP_ID = "wxc83b55d61c7fc51d"
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip("/")
TOKEN_CACHE_FILE = "星妈会缓存.txt"
TOKEN_EXPIRE_DAYS = 180

# ====================== UA ======================
UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541022) XWEB/16467'
)


# ====================== 日志工具 ======================
def log(user_label: Optional[str], message: str, level: str = 'INFO') -> None:
    if user_label:
        print(f'[{level}] [{user_label}] {message}')
    else:
        print(f'[{level}] {message}')


def mask_phone(phone: str | None) -> str:
    if not phone or len(phone) < 7:
        return phone or ''
    return f'{phone[:3]}****{phone[-4:]}'


def print_banner(title: str) -> None:
    print(f'\n{"=" * 50}')
    print(title)
    print(f'{"=" * 50}')


def print_account_banner(index: int, label: str) -> None:
    print(f'\n{"-" * 50}')
    print(f'  开始第 {index} 个账号: {label}')
    print(f'{"-" * 50}')


# ====================== 通知工具 ======================
def summarize_notification(title: str, text: str) -> str:
    """智能汇总通知内容"""
    lines = text.splitlines()
    results = []
    account_data = {}
    current_account = None
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        
        if '开始第' in line and '账号' in line:
            match = re.search(r'账号[:\s]+(.+?)(?:\s|$)', line)
            if match:
                current_account = match.group(1).strip()
                account_data[current_account] = {'sign': '', 'tasks': '', 'points': ''}
        
        if current_account and current_account in account_data:
            if ('登录成功' in line or 'SUCCESS' in line):
                if '已签到' in line or '签到成功' in line:
                    match = re.search(r'(\+\d+积分)', line)
                    if match:
                        account_data[current_account]['sign'] = match.group(1)
            elif '任务完成' in line or '完成任务' in line:
                match = re.search(r'完成.*?(\d+)个', line)
                if match:
                    account_data[current_account]['tasks'] = match.group(1)
            elif '积分变化' in line:
                match = re.search(r'\+(\d+)', line)
                if match:
                    account_data[current_account]['points'] = f'+{match.group(1)}分'
    
    for name, info in account_data.items():
        parts = []
        if info.get('sign'):
            parts.append(f"✅{info['sign']}")
        if info.get('tasks'):
            parts.append(f"任务{info['tasks']}个")
        if info.get('points'):
            parts.append(info['points'])
        if parts:
            results.append(f"{name} {' '.join(parts)}")
    
    if not results:
        for line in lines:
            if '成功:' in line or '失败:' in line or '总收益' in line:
                results.append(line.strip())
    
    return '\n'.join([title] + results[-20:])


def send_notify(title: str, content: str) -> None:
    """发送青龙通知"""
    if ql_notify:
        try:
            summarized = summarize_notification(title, content)
            ql_notify(title, summarized)
            print('📢 青龙通知已发送')
        except Exception as e:
            print(f'⚠️ 青龙通知发送失败: {e}')
    else:
        print('⚠️ 未找到青龙通知模块')


def run_with_notify(title: str, runner) -> None:
    """带通知的执行包装器（实时输出日志）"""
    exit_code = 0
    try:
        runner()
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
    except KeyboardInterrupt:
        print('\n⚠️ 脚本被手动终止')
        exit_code = 130
    except Exception:
        traceback.print_exc()
        exit_code = 1
    
    if ql_notify:
        try:
            ql_notify(title, "脚本执行完成，请查看青龙任务日志获取详情")
            print('📢 青龙通知已发送')
        except Exception as e:
            print(f'⚠️ 青龙通知发送失败: {e}')
    
    if exit_code:
        raise SystemExit(exit_code)


# ====================== Token 缓存 ======================
def load_token_cache() -> Dict:
    """加载缓存的token"""
    if os.path.exists(TOKEN_CACHE_FILE):
        try:
            with open(TOKEN_CACHE_FILE, 'r', encoding='utf-8') as f:
                cache = {}
                for line in f:
                    line = line.strip()
                    if not line or '#' not in line:
                        continue
                    parts = line.split('#')
                    if len(parts) >= 2:
                        key = parts[0]
                        token = parts[1]
                        expire = int(parts[2]) if len(parts) >= 3 else 0
                        cache[key] = {'token': token, 'expire_time': expire}
                return cache
        except Exception as e:
            log(None, f'读取缓存失败: {e}', 'WARNING')
    return {}


def save_token_cache(cache: Dict) -> None:
    """保存token缓存"""
    try:
        with open(TOKEN_CACHE_FILE, 'w', encoding='utf-8') as f:
            for key, data in cache.items():
                f.write(f"{key}#{data['token']}#{data['expire_time']}\n")
    except Exception as e:
        log(None, f'写入缓存失败: {e}', 'WARNING')


def get_cached_token(key: str) -> Optional[str]:
    """获取缓存的token"""
    cache = load_token_cache()
    data = cache.get(key, {})
    token = data.get('token', '')
    return token if token else None


def save_token_to_cache(key: str, token: str) -> None:
    """保存token到缓存（180天有效期）"""
    cache = load_token_cache()
    cache[key] = {
        'token': token,
        'expire_time': int(time.time()) + TOKEN_EXPIRE_DAYS * 86400
    }
    save_token_cache(cache)


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
        log(None, f'从 YYB 获取账号失败: {e}', 'ERROR')
    return []


def get_yyb_wx_code(openid: str) -> Optional[str]:
    """通过 YYB 协议获取小程序 code"""
    if not YYB_BASE_URL:
        return None
    for i in range(3):
        try:
            r = requests.post(
                f"{YYB_BASE_URL}/wxapp/getCode",
                json={"ref": openid, "app_id": APP_ID},
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


def login_with_yyb_code(code: str) -> Optional[str]:
    """用 wx code 登录星妈会，返回 accessToken"""
    base_headers = {
        'User-Agent': UA,
        'content-type': 'application/json',
        'locale': 'zh_CN',
        'authorization': '',
        'referer': f'https://servicewechat.com/{APP_ID}/92/page-frame.html',
    }
    try:
        r = requests.post(
            'https://momclub.feihe.com/capis/social/ma',
            json=code,
            headers=base_headers,
            timeout=30,
            verify=False,
        )
        resp = r.json()
        if not resp.get('success'):
            return None
        data = resp.get('data', {})
        token_info = data.get('tokenInfo')
        if token_info and token_info.get('accessToken'):
            return token_info['accessToken']
        temp_uid = data.get('tempUid', '')
        if not temp_uid:
            return None
        r2 = requests.post(
            'https://momclub.feihe.com/capis/ma/login',
            json={'code': code, 'tempUid': temp_uid},
            headers=base_headers,
            timeout=30,
            verify=False,
        )
        resp2 = r2.json()
        if not resp2.get('success'):
            return None
        return resp2.get('data', {}).get('accessToken', '')
    except Exception as e:
        return None


# ====================== 核心类 ======================
class MomClubAuto:
    def __init__(self, auth_token: str, user_label: str = '未登录'):
        self.auth = auth_token
        self.phone: str | None = None
        self.nickname: str | None = None
        self.member_id: str | None = None
        self.user_label = user_label
        self.points_before = 0

    def _update_user_label(self) -> None:
        self.user_label = mask_phone(self.phone) or self.nickname or self.user_label

    def _headers(self) -> Dict[str, str]:
        return {
            'User-Agent': UA,
            'authorization': self.auth,
            'content-type': 'application/json',
            'locale': 'zh_CN',
            'referer': f'https://servicewechat.com/{APP_ID}/92/page-frame.html',
        }

    def get_member_info(self) -> Optional[Dict[str, Any]]:
        try:
            response = requests.get(
                url='https://momclub.feihe.com/capis/c/user/memberInfo',
                headers=self._headers(),
                timeout=(5, 30),
                verify=False,
            )
            result = response.json()
            data = result.get('data')
            if not result.get('success') or not data:
                log(self.user_label, f"获取会员信息失败: {result.get('msg', '')}", 'ERROR')
                return None
            self.phone = data.get('mobile')
            self.nickname = data.get('nickname')
            self.member_id = data.get('memberId')
            self._update_user_label()
            return data
        except Exception as exc:
            log(self.user_label, f'获取会员信息异常: {exc}', 'ERROR')
            return None

    def get_todo_list(self) -> Optional[Dict[str, Any]]:
        try:
            mock_time = int(time.time() * 1000)
            response = requests.get(
                url=f'https://momclub.feihe.com/capis/c/activity/todo/list?mockTime={mock_time}',
                headers=self._headers(),
                timeout=(5, 30),
                verify=False,
            )
            result = response.json()
            data = result.get('data')
            if not result.get('success') or not data:
                log(self.user_label, f"获取任务列表失败: {result.get('message', '')}", 'ERROR')
                return None
            return data
        except Exception as exc:
            log(self.user_label, f'获取任务列表异常: {exc}', 'ERROR')
            return None

    def checkin(self, checkin_data: Dict[str, Any]) -> bool:
        try:
            activity_id = checkin_data.get('id')
            extra = checkin_data.get('checkInExtra', {})
            join_record = extra.get('joinRecord', [])
            today_record = next((record for record in join_record if record.get('today')), None)

            if today_record and today_record.get('joined'):
                credits = today_record.get('credits', 0)
                log(self.user_label, f'今日已签到 (+{credits}积分)', 'INFO')
                return True

            payload = {'activityId': activity_id, 'mockTime': int(time.time() * 1000)}
            response = requests.post(
                url='https://momclub.feihe.com/capis/c/activity/todo/checkIn',
                headers=self._headers(),
                json=payload,
                timeout=(5, 30),
                verify=False,
            )
            result = response.json()
            if result.get('success'):
                credits = result.get('data', {}).get('credits', 0)
                log(self.user_label, f'签到成功 (+{credits}积分)', 'SUCCESS')
                return True
            log(self.user_label, f"签到失败: {result.get('message', '')}", 'ERROR')
            return False
        except Exception as exc:
            log(self.user_label, f'签到异常: {exc}', 'ERROR')
            return False

    def _receive_task(self, activity_id: int) -> bool:
        try:
            response = requests.post(
                url='https://momclub.feihe.com/capis/c/activity/todo/receive',
                headers=self._headers(),
                json={'activityId': activity_id, 'mockTime': int(time.time() * 1000)},
                timeout=(5, 30),
                verify=False,
            )
            result = response.json()
            return result.get('success', False)
        except Exception:
            return False

    def complete_task(self, task: Dict[str, Any]) -> bool:
        try:
            activity_id = task.get('id')
            task_name = task.get('name', '')
            self._receive_task(activity_id)
            time.sleep(random.randint(1, 2))
            payload = {'activityId': activity_id, 'mockTime': int(time.time() * 1000)}
            response = requests.post(
                url='https://momclub.feihe.com/capis/c/activity/todo/complete',
                headers=self._headers(),
                json=payload,
                timeout=(5, 30),
                verify=False,
            )
            result = response.json()
            if result.get('success'):
                credits = result.get('data', {}).get('credits', 0)
                log(self.user_label, f'任务完成: {task_name} (+{credits}积分)', 'SUCCESS')
                return True
            msg = result.get('message') or result.get('msg') or str(result)
            log(self.user_label, f"任务失败: {task_name} - {msg}", 'ERROR')
            return False
        except Exception as exc:
            log(self.user_label, f'任务异常: {task_name} - {exc}', 'ERROR')
            return False

    def complete_game_task(self, task: Dict[str, Any]) -> bool:
        """完成连连看小游戏任务"""
        task_name = task.get('name', '')
        activity_id = task.get('id')
        if not self.member_id:
            log(self.user_label, f'游戏任务跳过 (无memberId): {task_name}', 'WARNING')
            return False
        try:
            from urllib.parse import quote
            # Step 1: game auth login
            auth_resp = requests.post(
                url=f'https://momclub.feihe.com/pmall/v1/api/auth/login?openid={self.member_id}&nickname={quote(self.nickname or "")}',
                headers={
                    'User-Agent': UA,
                    'authorization': '',
                    'content-length': '0',
                    'origin': 'https://momclub.feihe.com',
                    'referer': f'https://momclub.feihe.com/h5/game/?wxNickName={quote(self.nickname or "")}&crmId={self.member_id}&memberid={self.member_id}&programLogin=1',
                },
                timeout=(5, 30),
                verify=False,
            )
            auth_data = auth_resp.json()
            if auth_data.get('code') != 10000:
                log(self.user_label, f'游戏登录失败: {task_name} - {auth_data}', 'ERROR')
                return False
            game_token = auth_data['data']['accessToken']
            game_headers = {
                'User-Agent': UA,
                'authorization': game_token,
                'content-type': 'application/json',
                'referer': f'https://momclub.feihe.com/h5/game/?wxNickName={self.nickname or ""}&crmId={self.member_id}&memberid={self.member_id}&programLogin=1',
            }
            
            # Step 2: receive task
            self._receive_task(activity_id)
            time.sleep(1)
            
            # Step 3: play 3 levels
            for level in range(1, 4):
                start_resp = requests.post(
                    url=f'https://momclub.feihe.com/pmall/v1/api/game/level/startLevel?level={level}',
                    headers=game_headers,
                    timeout=(5, 30),
                    verify=False,
                )
                if start_resp.json().get('code') != 10000:
                    break
                time.sleep(random.randint(3, 6))
                complete_resp = requests.post(
                    url=f'https://momclub.feihe.com/pmall/v1/api/game/level/complete?levelId={level}',
                    headers=game_headers,
                    timeout=(5, 30),
                    verify=False,
                )
                cr = complete_resp.json()
                if cr.get('code') != 10000:
                    log(self.user_label, f'游戏第{level}关失败: {cr}', 'WARNING')
                    break
                log(self.user_label, f'游戏第{level}关完成', 'INFO')
                time.sleep(random.randint(2, 4))
            
            # Step 4: complete task
            payload = {'activityId': activity_id, 'mockTime': int(time.time() * 1000)}
            result = requests.post(
                url='https://momclub.feihe.com/capis/c/activity/todo/complete',
                headers=self._headers(),
                json=payload,
                timeout=(5, 30),
                verify=False,
            ).json()
            if result.get('success'):
                credits = result.get('data', {}).get('credits', 0)
                log(self.user_label, f'游戏任务完成: {task_name} (+{credits}积分)', 'SUCCESS')
                return True
            msg = result.get('message') or result.get('msg') or str(result)
            log(self.user_label, f'游戏任务失败: {task_name} - {msg}', 'ERROR')
            return False
        except Exception as exc:
            log(self.user_label, f'游戏任务异常: {task_name} - {exc}', 'ERROR')
            return False

    def run_all_tasks(self) -> int:
        completed = 0
        todo_data = self.get_todo_list()
        if not todo_data:
            return 0

        checkin_data = todo_data.get('checkInTodo')
        if checkin_data and self.checkin(checkin_data):
            completed += 1
        if checkin_data:
            time.sleep(random.randint(1, 3))

        skip_types = {'Perfect', 'AddQw', 'FirstOrder'}
        game_keywords = ('游戏', '连连看', '玩一')
        task_list = todo_data.get('taskTodo', [])

        for task in task_list:
            extra = task.get('taskTodoExtra', {})
            task_type = extra.get('type', '')
            task_name = task.get('name', '')
            status = extra.get('status', '')
            complete_count = extra.get('completeCount', 0)
            complete_limit = extra.get('completeLimit', 1)

            if task_type in skip_types:
                log(self.user_label, f'跳过任务: {task_name} (type={task_type}, 需手动完成)', 'WARNING')
                continue

            if status == '3' or complete_count >= complete_limit:
                log(self.user_label, f'任务已完成: {task_name}', 'INFO')
                continue

            is_game = any(kw in task_name for kw in game_keywords)
            if is_game:
                if self.complete_game_task(task):
                    completed += 1
            else:
                if self.complete_task(task):
                    completed += 1
            time.sleep(random.randint(2, 4))

        return completed


# ====================== 执行账号 ======================
def run_account(acc: Dict, index: int) -> tuple[bool, int, float]:
    start_time = time.time()
    name = acc.get('name', '') or f'账号{index}'
    openid = acc.get('openid')
    
    print_account_banner(index, name)
    
    if not openid:
        log(name, '缺少openid', 'ERROR')
        return False, 0, 0.0
    
    # 尝试从缓存获取 token
    cache_key = f"yyb_{openid}"
    cached_token = get_cached_token(cache_key)
    
    if cached_token:
        log(name, '使用缓存的token', 'INFO')
        token = cached_token
    else:
        log(name, '正在通过 YYB 登录...', 'INFO')
        code = get_yyb_wx_code(openid)
        if not code:
            log(name, '获取 YYB code 失败', 'ERROR')
            return False, 0, 0.0
        token = login_with_yyb_code(code)
        if token:
            save_token_to_cache(cache_key, token)
            log(name, 'YYB 登录成功', 'SUCCESS')
        else:
            log(name, 'YYB 登录失败', 'ERROR')
            return False, 0, 0.0
    
    if not token:
        log(name, '获取 token 失败', 'ERROR')
        return False, 0, 0.0
    
    # 执行任务
    client = MomClubAuto(token, name)
    member_info = client.get_member_info()
    if not member_info:
        if cached_token:
            log(name, '缓存token已失效，重新通过 YYB 获取...', 'WARNING')
            code = get_yyb_wx_code(openid)
            if code:
                token = login_with_yyb_code(code)
                if token:
                    save_token_to_cache(cache_key, token)
                    log(name, 'YYB 重新登录成功', 'SUCCESS')
                    client = MomClubAuto(token, name)
                    member_info = client.get_member_info()
        if not member_info:
            log(name, 'authorization 无效或已过期', 'ERROR')
            return False, 0, 0.0
    
    phone = mask_phone(client.phone) or client.nickname or name
    grade_name = member_info.get('gradeName', '')
    points_before = member_info.get('points', 0)
    log(phone, f'用户等级: {grade_name}', 'INFO')
    log(phone, f'当前积分: {points_before}', 'INFO')
    
    task_completed = client.run_all_tasks()
    time.sleep(2)
    
    member_info_after = client.get_member_info()
    points_after = member_info_after.get('points', 0) if member_info_after else points_before
    earned = max(0, points_after - points_before)
    elapsed = time.time() - start_time
    
    log(phone, f'账号执行完成 | 完成任务 {task_completed} 个', 'INFO')
    log(phone, f'积分变化: {points_before} -> {points_after} (+{earned})', 'SUCCESS')
    log(phone, f'耗时: {elapsed:.1f} 秒', 'INFO')
    return True, earned, elapsed


# ====================== 主函数 ======================
def main() -> None:
    print_banner('============🔔脚本[星妈会自动签到]执行开始============')
    
    if not YYB_BASE_URL:
        log(None, '❌ 未配置 YYB_BASE_URL 环境变量', 'ERROR')
        print_banner('============🔔脚本[星妈会自动签到]执行结束============')
        return
    
    log(None, f'YYB 协议地址: {YYB_BASE_URL}', 'INFO')
    
    accounts = fetch_accounts_from_yyb()
    if not accounts:
        log(None, '❌ 从 YYB 获取账号失败，请检查 YYB 服务是否正常', 'ERROR')
        print_banner('============🔔脚本[星妈会自动签到]执行结束============')
        return
    
    log(None, f'共获取到 {len(accounts)} 个账号', 'INFO')
    total_start = time.time()
    success_count = 0
    fail_count = 0
    total_earned = 0
    
    for index, acc in enumerate(accounts, 1):
        try:
            success, earned, _ = run_account(acc, index)
            if success:
                success_count += 1
                total_earned += earned
            else:
                fail_count += 1
        except Exception as exc:
            log(f'账号{index}', f'执行异常: {exc}', 'ERROR')
            fail_count += 1
        
        if index < len(accounts):
            interval = random.randint(3, 8)
            log(None, f'等待 {interval} 秒后执行下一个账号', 'INFO')
            time.sleep(interval)
    
    total_elapsed = time.time() - total_start
    print_banner('============🔔脚本[星妈会自动签到]执行结束============')
    log(None, f'成功: {success_count} 个账号', 'SUCCESS')
    log(None, f'失败: {fail_count} 个账号', 'ERROR' if fail_count else 'INFO')
    log(None, f'总收益: {total_earned} 积分', 'SUCCESS')
    log(None, f'总耗时: {total_elapsed:.1f} 秒', 'INFO')


# ====================== 入口 ======================
if __name__ == '__main__':
    run_with_notify('星妈会签到', main)