#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# cron: 0 0 6,15 * * *
# new Env('快乐会签到抽奖')
# 脚本名称：快乐会 签到 + 抽奖（有赞平台）
# 作者：a
# 青龙环境变量：

#   YYB_BASE_URL  YYB协议地址，默认 http://172.17.0.1:18080
#   KLH_LOTTERY    抽奖开关，默认 1；设为 0 可关闭抽奖
# 执行流程：wxid → wx.login(code) → passport/general/auth → 签到 → 抽奖

import os
import sys
import json
import time
from datetime import datetime, timezone, timedelta
import requests

DEFAULT_YYB_BASE_URL = "http://172.17.0.1:18080"

requests.packages.urllib3.disable_warnings()

# ── 抓包固定参数 ──────────────────────────────────────────────
APP_ID    = 'wx2ffe954c1d2e5369'
KDT_ID    = '182494514'
EXT_KDT   = '151343902'
CLIENT_ID = '4d65249d377b2c3ed8'
LOTTERY_ALIAS = '9ggq8AYAlK0i'
CHECKIN_ID    = '5543694'          # 签到活动 ID

VERSION   = '3.183.6.207'
UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
)

AUTH_URL   = f'https://retail-uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}'
BASE       = 'https://retail-h5.youzan.com'

AUTHOR     = 'a'
ENABLE_LOTTERY = os.environ.get('KLH_LOTTERY', '1') != '0'

def fetch_accounts_from_yyb():
    """从 YYB 协议获取 [(nickname, openid), ...]"""
    base = os.environ.get('YYB_BASE_URL', DEFAULT_YYB_BASE_URL).rstrip('/')
    try:
        r = requests.get(f'{base}/accounts', timeout=10)
        data = r.json()
        if data.get('code') == 0:
            accounts = []
            for item in data.get('data', []):
                nickname = item.get('nickname', '')
                openid = item.get('openid', '')
                if openid:
                    accounts.append((nickname or f'账号{len(accounts)+1}', openid))
            if accounts:
                print(f'✅ 从 YYB 协议获取到 {len(accounts)} 个账号')
                return accounts
    except Exception as e:
        print(f'❌ 从 YYB 获取账号失败: {e}')
    return []

def get_accounts():
    """返回 [(备注, wxid), ...] 列表，优先从 YYB 获取"""
    yyb_accounts = fetch_accounts_from_yyb()
    if yyb_accounts:
        return yyb_accounts
    
    raw = os.environ.get('klh_accounts', '').strip()
    if not raw:
        return []
    accounts = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split('#', 1)
        if len(parts) == 2:
            accounts.append((parts[0].strip(), parts[1].strip()))
        else:
            accounts.append((line, line))
    return accounts

YYB_BASE_URL = os.environ.get('YYB_BASE_URL', DEFAULT_YYB_BASE_URL).rstrip('/')

def get_wx_code(wxid: str) -> str:
    """通过 YYB 协议获取小程序登录 code"""
    url = f'{YYB_BASE_URL}/wxapp/getCode'
    for i in range(3):
        try:
            r = requests.post(
                url,
                json={"ref": wxid, "app_id": APP_ID},
                headers={"Content-Type": "application/json", "User-Agent": UA},
                timeout=60,
                verify=False,
            )
            resp = r.json()
            code = None
            if resp.get("code") == 0:
                data = resp.get("data") or {}
                if isinstance(data, dict):
                    result = data.get("result")
                    if isinstance(result, dict):
                        code = result.get("code") or result.get("Code")
                    if not code:
                        code = data.get("code") or data.get("Code")
            if not code and resp.get("Success") is True:
                data = resp.get("Data") or resp.get("data") or {}
                if isinstance(data, dict):
                    code = data.get("Code") or data.get("code")
            if code:
                return str(code)
            print(f"  获取 code 失败({i+1}/3): {resp}")
        except Exception as e:
            print(f"  获取 code 异常({i+1}/3): {e}")
        time.sleep(1)
    raise RuntimeError("获取 wx code 失败，请检查 YYB_BASE_URL 配置")

def get_access_token(code: str, uuid: str = '') -> dict:
    """返回包含 accessToken / sessionId 的 data 字典"""
    ts = int(time.time() * 1000)
    if not uuid:
        uuid = f'auto{ts}'
    headers = {
        'user-agent': UA,
        'xweb_xhr': '1',
        'content-type': 'application/json',
        'app-mode': 'default',
        'page-path': 'pages/home/dashboard/index',
        'extra-data': json.dumps({
            'sid': '', 'version': VERSION,
            'clientType': 'weapp-miniprogram', 'client': 'weapp',
            'bizEnv': '', 'uuid': uuid, 'ftime': ts,
        }, separators=(',', ':')),
        'referer': f'https://servicewechat.com/{APP_ID}/1018/page-frame.html',
    }
    body = {
        'appId': APP_ID,
        'code': code,
        'platformName': 'weapp',
        'signature': 'windows',
        'clientId': CLIENT_ID,
        'grantType': 'yz_union',
        'inWsc': True,
        'kdtId': KDT_ID,
        'extraBizData': {
            'enterOptions': {
                'extKdtId': int(EXT_KDT),
                'path': 'pages/home/dashboard/index',
                'query': {
                    'kdt_id': KDT_ID,
                    'shopAutoEnter': '1',
                },
                'scene': 1007,
                'referrerInfo': {},
                'apiCategory': 'default',
            },
        },
    }
    resp = requests.post(AUTH_URL, json=body, headers=headers, timeout=20, verify=False)
    data = resp.json()
    if data.get('code') != 0:
        raise RuntimeError(f'授权失败: {data}')
    return data['data']

def make_headers(session_id: str) -> dict:
    ts = int(time.time() * 1000)
    return {
        'user-agent': UA,
        'xweb_xhr': '1',
        'content-type': 'application/json',
        'extra-data': json.dumps({
            'is_weapp': 1,
            'sid': session_id,
            'version': VERSION,
            'client': 'weapp',
            'bizEnv': 'retail',
            'uuid': f'auto{ts}',
            'ftime': ts,
        }, separators=(',', ':')),
        'referer': f'https://servicewechat.com/{APP_ID}/1018/page-frame.html',
    }

def common_params(access_token: str) -> dict:
    return {
        'app_id': APP_ID,
        'kdt_id': KDT_ID,
        'access_token': access_token,
    }

def checkin(access_token: str, session_id: str):
    headers = make_headers(session_id)
    params  = common_params(access_token)

    info_url = f'{BASE}/wscump/checkin/check-in-info.json'
    r = requests.get(info_url, params=params, headers=headers, timeout=15, verify=False)
    info = r.json()
    if info.get('code') != 0:
        print(f'  获取签到信息失败: {info}')
        return

    checkin_id = info['data'].get('checkInId') or CHECKIN_ID
    signed     = info['data'].get('todayIsSignIn', False)
    if signed:
        print('  今日已签到，跳过')
        return

    sign_url = f'{BASE}/wscump/checkin/checkinV2.json'
    p = {**params, 'checkinId': checkin_id}
    r = requests.get(sign_url, params=p, headers=headers, timeout=15, verify=False)
    result = r.json()
    if result.get('code') == 0:
        rewards = result['data'].get('list', [])
        for rw in rewards:
            title = rw.get('infos', {}).get('title', '')
            print(f'  签到奖励: {title}')
        if not rewards:
            print('  签到成功（无奖励详情）')
    else:
        print(f'  签到失败: {result}')

def lottery(access_token: str, session_id: str):
    headers = make_headers(session_id)
    params  = common_params(access_token)

    status_url = f'{BASE}/wscump/casino/check-status.json'
    p = {**params, 'alias': LOTTERY_ALIAS, 'kdtId': KDT_ID}
    r = requests.get(status_url, params=p, headers=headers, timeout=15, verify=False)
    status = r.json()
    if status.get('code') != 0:
        print(f'  获取抽奖状态失败: {status}')
        return

    surplus = status['data'].get('joinTimeSurplus', 0)
    print(f'  剩余抽奖次数: {surplus}')
    if surplus <= 0:
        print('  无抽奖次数')
        return

    join_url = f'{BASE}/wscump/casino/join-lottery.json'
    for i in range(surplus):
        r = requests.post(
            join_url,
            json={'alias': LOTTERY_ALIAS, **{k: v for k, v in p.items()}},
            headers=headers, timeout=15, verify=False,
        )
        res = r.json()
        if res.get('code') == 0:
            awards = res['data'].get('awardList', [])
            if awards:
                for a in awards:
                    print(f'  [第{i+1}次] 中奖: {a.get("awardName","?")} - {a.get("prizeDesc","")}')
            else:
                print(f'  [第{i+1}次] 未中奖')
        else:
            print(f'  [第{i+1}次] 抽奖失败: {res}')
        if i < surplus - 1:
            time.sleep(1.5)

def run_account(name: str, wxid: str):
    print('\n' + '=' * 40)
    print(f'账号: {name}  wxid: {wxid[:8]}...')
    try:
        print('  获取登录 code...')
        code = get_wx_code(wxid)
        print(f'  code: {code[:10]}...')

        print('  授权获取 access_token...')
        auth = get_access_token(code)
        access_token = auth['accessToken']
        session_id   = auth['sessionId']
        print(f'  access_token: ...{access_token[-8:]}')

        print('  执行签到...')
        checkin(access_token, session_id)

        if ENABLE_LOTTERY:
            print('  执行抽奖...')
            lottery(access_token, session_id)
        else:
            print('  已关闭抽奖')

    except Exception as e:
        print(f'  账号 {name} 出错: {e}')

def send_notify(title: str, content: str):
    try:
        from notify import send
        send(title, content)
    except Exception:
        pass

if __name__ == '__main__':
    tz = timezone(timedelta(hours=8))
    print(f'脚本：快乐会 签到+抽奖  作者：{AUTHOR}')
    print(f'时间：{datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S")}')
    print(f'抽奖开关：{"开" if ENABLE_LOTTERY else "关"}')
    print()

    accounts = get_accounts()
    if not accounts or not accounts[0][1]:
        print('未找到账号，请检查 YYB_BASE_URL 配置或设置 klh_accounts 环境变量')
        sys.exit(1)

    notify_lines = [f'快乐会 签到+抽奖  作者：{AUTHOR}']
    for name, wxid in accounts:
        run_account(name, wxid)
        notify_lines.append(f'账号：{name} 已执行')
        time.sleep(2)

    print(f'\n完成! {datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S")}')
    send_notify('快乐会 签到+抽奖', '\n'.join(notify_lines))
