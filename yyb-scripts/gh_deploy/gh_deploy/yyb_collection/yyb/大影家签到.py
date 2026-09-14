#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 大影家 每日签到脚本 (支持 wxid 自动登录)
# 环境变量:
#   YYB_BASE_URL: YYB 协议地址 (用于获取 wx code 和手机号)

import os
import io
import json
import time
import random
import sys
import traceback

import requests
import urllib3

try:
    from notify import send as ql_notify
except ImportError:
    ql_notify = None

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for stream in self.streams:
            stream.write(data)
        return len(data)

    def flush(self):
        for stream in self.streams:
            stream.flush()


def summarize_notification(title: str, text: str) -> str:
    import re
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    account_data = {}
    order = []
    for line in lines:
        m = re.match(r'^\[(?:INFO|WARN|ERROR)\] \[(.+?)\] (.+)$', line)
        if not m:
            if line.startswith('未配置账号'):
                order.append(line)
            continue
        name, msg = m.groups()
        if name not in account_data:
            account_data[name] = []
            order.append(name)
        if any(key in msg for key in ('登录失败', '重新登录失败', '今日已签到', '签到成功', '签到失败', '当前积分', '完成')):
            account_data[name].append(msg)
    summary = []
    for item in order:
        if item in account_data:
            msgs = []
            for msg in account_data[item]:
                if msg not in msgs and not msg.startswith('开始处理'):
                    msgs.append(msg)
            if msgs:
                summary.append(f'{item}: ' + ' | '.join(msgs[-3:]))
        else:
            summary.append(item)
    if not summary:
        summary = lines[-20:]
    return '\n'.join(([title] + summary[-25:]))[-12000:]


def run_with_notify(title: str, runner):
    buffer = io.StringIO()
    stdout, stderr = sys.stdout, sys.stderr
    tee = Tee(stdout, buffer)
    sys.stdout = sys.stderr = tee
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
    finally:
        sys.stdout, sys.stderr = stdout, stderr
        if ql_notify:
            try:
                content = summarize_notification(title, buffer.getvalue())
                ql_notify(title, content)
                print('📢 青龙通知已发送')
            except Exception as notify_error:
                print(f'⚠️ 青龙通知发送失败: {notify_error}')
    if exit_code:
        raise SystemExit(exit_code)

ENV_NAME = 'code_token'
YYB_BASE_URL_ENV = 'YYB_BASE_URL'
APP_ID = 'wxbc1dc88eace39ede'
CACHE_FILE = 'dyj_cache.txt'
BUILTIN_ACCOUNTS: list[dict] = [
    # {'name': '备注', 'wxid': 'wxid_xxx'}
    # {'name': '备注', 'token': 'eyJxxx...'}
]

BASE_URL = 'https://api.wdbox.com.cn'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
)


def log(label: str | None, msg: str, level: str = 'INFO') -> None:
    prefix = f'[{label}] ' if label else ''
    print(f'[{level}] {prefix}{msg}')


def make_headers(jwt: str = '') -> dict:
    h = {
        'user-agent': UA,
        'accept': 'application/vnd.dyjapi.v1+json',
        'xweb_xhr': '1',
        'content-type': 'application/json',
        'referer': f'https://servicewechat.com/{APP_ID}/552/page-frame.html',
    }
    if jwt:
        h['authorization'] = f'Bearer {jwt}'
    return h


# ------------------------------------------------------------------ #
#  YYB 协议账号获取
# ------------------------------------------------------------------ #
def fetch_accounts_from_yyb(yyb_base_url: str) -> list:
    """从 YYB 协议获取账号列表，返回 [(nickname, openid), ...]"""
    try:
        url = f"{yyb_base_url}/accounts"
        resp = requests.get(url, timeout=15)
        data = resp.json()
        if data.get("code") == 0 and data.get("data"):
            accounts = []
            for acc in data["data"]:
                openid = acc.get("openid", "")
                nickname = acc.get("nickname", "") or acc.get("alias", "") or openid
                if openid:
                    accounts.append((nickname, openid))
            return accounts
    except Exception as e:
        print(f"从 YYB 协议获取账号失败: {e}")
    return []


# ------------------------------------------------------------------ #
#  YYB 协议调用
# ------------------------------------------------------------------ #
def _yyb_get_code(yyb_base_url: str, wxid: str) -> str:
    """YYB 协议获取小程序 code"""
    url = f"{yyb_base_url}/wxapp/getCode"
    for retry in range(3):
        try:
            resp = requests.post(
                url,
                json={"ref": wxid, "app_id": APP_ID},
                headers={"Content-Type": "application/json", "User-Agent": UA},
                timeout=60,
            )
            data = resp.json()
            if data.get("code") == 0:
                nested = data.get("data", {}).get("result") or data.get("data", {})
                code = nested.get("code", "")
                if code:
                    return code
            log(None, f'YYB 获取 code 失败: {data}', 'ERROR')
            return ''
        except Exception as ex:
            log(None, f'YYB 请求失败 ({retry+1}/3): {ex}', 'ERROR')
            time.sleep(2)
    return ''


def _yyb_get_phone_data(yyb_base_url: str, wxid: str) -> dict:
    """YYB 协议获取手机号加密数据"""
    url = f"{yyb_base_url}/wxapp/getPhoneNumber"
    try:
        resp = requests.post(
            url,
            json={"ref": wxid, "app_id": APP_ID},
            headers={"Content-Type": "application/json", "User-Agent": UA},
            timeout=60,
        )
        data = resp.json()
        if data.get("code") == 0:
            nested = data.get("data", {}).get("result") or data.get("data", {})
            iv = nested.get("iv", "")
            data_enc = nested.get("data_enc", "") or nested.get("encryptedData", "")
            if iv and data_enc:
                return {"iv": iv, "data_enc": data_enc}
        log(None, f'YYB 获取手机号失败: {data}', 'ERROR')
    except Exception as ex:
        log(None, f'YYB 获取手机号异常: {ex}', 'ERROR')
    return {}


# ------------------------------------------------------------------ #
#  登录
# ------------------------------------------------------------------ #

def _extract_jwt(data: dict) -> str:
    if not data:
        return ''
    # 常见字段名
    for key in ('jwt', 'access_token', 'token'):
        v = data.get(key)
        if v:
            return v
    # 嵌套在 data 里
    inner = data.get('data') or {}
    if isinstance(inner, dict):
        for key in ('jwt', 'access_token', 'token'):
            v = inner.get(key)
            if v:
                return v
    return ''


def login_with_wxid(wxid: str, label: str, yyb_base_url: str) -> str:
    if not yyb_base_url:
        log(label, f'未配置 {YYB_BASE_URL_ENV}，无法使用 wxid 登录', 'ERROR')
        return ''

    js_code = _yyb_get_code(yyb_base_url, wxid)
    if not js_code:
        log(label, '获取微信 code 失败', 'ERROR')
        return ''

    phone_data = _yyb_get_phone_data(yyb_base_url, wxid)
    if not phone_data:
        log(label, 'YYB 无法获取手机号加密数据，请确认接口支持', 'ERROR')
        return ''

    iv = phone_data['iv']
    data_enc = phone_data['data_enc']

    # 先尝试 memberlogin，失败再 memberregister
    for endpoint in ('/api/auth/jwt/memberlogin', '/api/auth/jwt/memberregister'):
        try:
            resp = requests.post(
                f'{BASE_URL}{endpoint}',
                json={'js_code': js_code, 'iv': iv, 'data_enc': data_enc},
                headers=make_headers(),
                timeout=15,
                verify=False,
            )
            data = resp.json()
            token = _extract_jwt(data)
            if token:
                log(label, '登录成功')
                return token
            # code=8 表示未注册，继续尝试 register
            if data.get('code') == 8 and 'login' in endpoint:
                continue
            log(label, f'登录失败: {data}', 'ERROR')
            break
        except Exception as e:
            log(label, f'登录请求失败: {e}', 'ERROR')
            break
    return ''


# ------------------------------------------------------------------ #
#  缓存
# ------------------------------------------------------------------ #

def read_cache() -> dict:
    cache = {}
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and '#' in line:
                        name, token = line.split('#', 1)
                        cache[name] = token
    except Exception:
        pass
    return cache


def write_cache(cache: dict) -> None:
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            for name, token in cache.items():
                f.write(f'{name}#{token}\n')
    except Exception:
        pass


def get_token(account: dict, cache: dict, yyb_base_url: str) -> str:
    name = account.get('name', '')

    # 直接提供 token
    if account.get('token'):
        return account['token']

    # 缓存
    cached = cache.get(name)
    if cached:
        log(name, '使用缓存 token')
        return cached

    # wxid 登录
    wxid = account.get('wxid', '')
    if not wxid:
        log(name, '未提供 wxid 或 token', 'ERROR')
        return ''

    token = login_with_wxid(wxid, name, yyb_base_url)
    if token:
        cache[name] = token
        write_cache(cache)
    return token


# ------------------------------------------------------------------ #
#  签到
# ------------------------------------------------------------------ #

def _is_expired(resp_data) -> bool:
    if isinstance(resp_data, dict):
        if resp_data.get('statusCode') == 401:
            return True
        msg = str(resp_data.get('message', '') or resp_data.get('msg', '')).lower()
        if 'credentials' in msg or 'unauthenticated' in msg or 'token' in msg:
            return True
    return False


def checkin(token: str, label: str) -> str:
    """返回 'ok', 'already', 'expired', 'error'"""
    try:
        r = requests.post(
            f'{BASE_URL}/api/photoer/ischeckin',
            json={},
            headers=make_headers(token),
            timeout=15,
            verify=False,
        )
        if r.status_code == 401:
            log(label, 'token 已过期', 'WARN')
            return 'expired'
        is_checkin = r.json()
        if is_checkin == 1 or is_checkin == '1' or is_checkin is True:
            log(label, '今日已签到')
            return 'already'
    except Exception as e:
        log(label, f'查询签到状态失败: {e}', 'WARN')

    try:
        r = requests.post(
            f'{BASE_URL}/api/photoer/checkin',
            json={},
            headers=make_headers(token),
            timeout=15,
            verify=False,
        )
        if r.status_code == 401:
            log(label, 'token 已过期', 'WARN')
            return 'expired'
        data = r.json()
        if _is_expired(data):
            log(label, 'token 已过期', 'WARN')
            return 'expired'
        log(label, f'签到结果: {data}')
        if isinstance(data, dict) and (data.get('code') == 0 or data.get('message') == 'ok'):
            days = data.get('days', '?')
            points = data.get('points', '?')
            log(label, f'签到成功！连续 {days} 天，获得 {points} 积分')
            return 'ok'
        log(label, f'签到失败: {data}', 'ERROR')
        return 'error'
    except Exception as e:
        log(label, f'签到请求失败: {e}', 'ERROR')
        return 'error'


def get_points(token: str, label: str) -> None:
    try:
        r = requests.post(
            f'{BASE_URL}/api/userpoint/mypoints',
            json={},
            headers=make_headers(token),
            timeout=15,
            verify=False,
        )
        log(label, f'当前积分: {r.json()}')
    except Exception as e:
        log(label, f'查询积分失败: {e}', 'WARN')


# ------------------------------------------------------------------ #
#  账号解析
# ------------------------------------------------------------------ #

def parse_accounts(yyb_base_url: str) -> list[dict]:
    # 优先从 YYB 协议获取账号
    yyb_accounts = fetch_accounts_from_yyb(yyb_base_url)
    if yyb_accounts:
        print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
        return [{'name': nickname, 'wxid': wxid} for nickname, wxid in yyb_accounts]
    
    accounts = list(BUILTIN_ACCOUNTS)
    raw = os.environ.get(ENV_NAME, '')
    for part in raw.replace('\n', '&').split('&'):
        part = part.strip()
        if not part:
            continue
        if '#' in part:
            name, value = part.split('#', 1)
            if value.startswith('eyJ'):
                accounts.append({'name': name, 'token': value})
            else:
                accounts.append({'name': name, 'wxid': value})
        else:
            accounts.append({'name': part, 'wxid': part})
    return accounts


# ------------------------------------------------------------------ #
#  主入口
# ------------------------------------------------------------------ #

def main():
    print('=' * 40)
    print('  大影家 每日签到')
    print('=' * 40)

    yyb_base_url = os.environ.get(YYB_BASE_URL_ENV, '').rstrip('/')
    if not yyb_base_url:
        log(None, f'未配置 {YYB_BASE_URL_ENV}，请设置 YYB 协议地址', 'ERROR')
        return

    accounts = parse_accounts(yyb_base_url)
    if not accounts:
        log(None, f'未配置账号，请设置环境变量 {ENV_NAME} 或在 BUILTIN_ACCOUNTS 中填写账号', 'ERROR')
        return

    cache = read_cache()

    for i, account in enumerate(accounts):
        if i > 0:
            time.sleep(random.uniform(1, 3))
        name = account.get('name', f'账号{i+1}')
        log(name, f'开始处理 ({i+1}/{len(accounts)})')

        token = get_token(account, cache, yyb_base_url)
        if not token:
            log(name, '登录失败，跳过', 'ERROR')
            continue

        result = checkin(token, name)
        if result == 'expired' and account.get('wxid'):
            log(name, 'token 过期，重新登录...')
            cache.pop(name, None)
            write_cache(cache)
            token = login_with_wxid(account['wxid'], name, yyb_base_url)
            if token:
                cache[name] = token
                write_cache(cache)
                checkin(token, name)
            else:
                log(name, '重新登录失败，跳过', 'ERROR')
                continue

        get_points(token, name)

    print('=' * 40)
    print('  完成')
    print('=' * 40)


if __name__ == '__main__':
    run_with_notify('大影家签到', main)
