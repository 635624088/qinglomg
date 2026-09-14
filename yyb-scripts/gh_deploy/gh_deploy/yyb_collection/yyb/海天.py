#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
希客美美 (xkmm.cn) 小程序每日签到脚本
登录失败自动跳过，执行下一个账号
"""

import os
import json
import random
import requests
import time
from datetime import datetime
from typing import Dict, List, Tuple, Optional

APPID = 'wx7a890ea13f50d7b6'
BASE_URL = 'https://cmallapi.xkmm.cn'
WAP_URL = 'https://cmallwap.xkmm.cn'
ACTIVITY_CODE = '202607'
LUCKY_CODE = 'jfcj202607'
CACHE_FILE = 'xkmm.txt'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
      'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
      'MiniProgramEnv/Windows WindowsWechat/WMPF '
      'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027')

# ── Bridge (本地 API 服务器) ─────────────────────────────────────
YYB_BASE_URL = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
BRIDGE_KEY = os.getenv('BRIDGE_KEY', '')

def bridge_headers() -> dict:
    h = {'Content-Type': 'application/json'}
    if BRIDGE_KEY:
        h['Authorization'] = f'Bearer {BRIDGE_KEY}'
    return h

def fetch_accounts() -> list:
    try:
        r = requests.get(f'{YYB_BASE_URL}/accounts', headers=bridge_headers(), timeout=15)
        data = r.json()
        accounts = data.get('data', [])
        print(f'共获取到 {len(accounts)} 个账号')
        for i, acc in enumerate(accounts, 1):
            nickname = acc.get('nickname') or acc.get('alias') or acc.get('name', '未知')
            print(f'   {i}. {nickname} (openid: {acc.get("openid", "")})')
        return accounts
    except Exception as e:
        print(f'获取账号失败: {e}')
        return []

def bridge_get_code(appid: str, openid: str) -> Optional[str]:
    r = requests.post(f'{YYB_BASE_URL}/wxapp/getCode',
                      json={'app_id': appid, 'ref': openid},
                      headers=bridge_headers(), timeout=90)
    if r.status_code != 200:
        return None
    data = r.json()
    if data.get('code') != 0:
        return None
    code = data.get('data', {}).get('result', {}).get('code', '')
    return code or None

def bridge_get_phone(appid: str, openid: str) -> dict:
    r = requests.post(f'{YYB_BASE_URL}/wxapp/getPhoneNumber',
                      json={'app_id': appid, 'ref': openid},
                      headers=bridge_headers(), timeout=90)
    if r.status_code != 200:
        return {}
    data = r.json()
    if data.get('code') != 0:
        return {}
    result = data.get('data', {}).get('result', {})
    return {'edata': result.get('encryptedData', ''), 'iv': result.get('iv', '')}

# ── xkmm API ───────────────────────────────────────────────────

def _make_headers(authorization: str, haday_token: str, uuid: str) -> dict:
    return {
        'Host': 'cmallapi.xkmm.cn',
        'Authorization': authorization,
        'X-Haday-Token': haday_token,
        'uuid': uuid,
        'envVersion': 'release',
        'User-Agent': UA,
        'xweb_xhr': '1',
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Referer': f'https://servicewechat.com/{APPID}/765/page-frame.html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    }

def login_with_code(code: str, edata: str, iv: str, uuid: str) -> Optional[str]:
    params = {
        'code': code,
        'edata': edata,
        'iv': iv,
        'uuid': uuid,
        'article_ids': '232,230',
        'app_versions': '28.0.8',
    }
    headers = {
        'Host': 'cmallapi.xkmm.cn',
        'envVersion': 'release',
        'User-Agent': UA,
        'xweb_xhr': '1',
        'Content-Type': 'application/x-www-form-urlencoded',
        'uuid': uuid,
        'Accept': '*/*',
        'Referer': f'https://servicewechat.com/{APPID}/765/page-frame.html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    }
    try:
        r = requests.post(f'{BASE_URL}/buyer-api/wechat/mini/phoneNew/login',
                          params=params, json={}, headers=headers, timeout=15)
        data = r.json()
        return data.get('access_token')
    except Exception:
        return None

def get_haday_token(access_token: str) -> Optional[str]:
    try:
        r = requests.post(f'{WAP_URL}/haday/wx/auth/loginByToken',
                          json={'access_token': access_token},
                          headers={'Content-Type': 'application/json', 'User-Agent': UA},
                          timeout=15)
        return r.json().get('data')
    except Exception:
        return None

def check_token_valid(authorization: str, uuid: str) -> bool:
    headers = {'Authorization': authorization, 'uuid': uuid,
               'User-Agent': UA, 'envVersion': 'release'}
    try:
        r = requests.get(f'{BASE_URL}/buyer-api/members', headers=headers, timeout=10)
        return r.json().get('member_id') is not None or r.status_code == 200
    except Exception:
        return False

def get_sign_info(headers: dict) -> dict:
    url = f'{BASE_URL}/buyer-api/sign/activity/member/info?activityCode={ACTIVITY_CODE}'
    r = requests.get(url, headers=headers, timeout=15)
    return r.json()

def do_sign(headers: dict) -> dict:
    url = f'{BASE_URL}/buyer-api/sign/activity/sign'
    r = requests.post(url, headers=headers,
                      json={'activity_code': ACTIVITY_CODE, 'fill_date': ''}, timeout=15)
    return r.json()

def get_points(headers: dict) -> dict:
    url = f'{BASE_URL}/buyer-api/members/points/current'
    r = requests.get(url, headers=headers, timeout=15)
    return r.json()

def get_point_tasks(headers: dict) -> dict:
    r = requests.get(f'{BASE_URL}/buyer-api/members/pointTask', headers=headers, timeout=15)
    return r.json()

def do_login_task(headers: dict):
    requests.get(f'{BASE_URL}/buyer-api/members/active/action?type=LOG',
                 headers=headers, timeout=15)
    requests.post(f'{BASE_URL}/buyer-api/members/statistics/addBehavior?behavior_type=LOG',
                  headers=headers, json={}, timeout=15)

def do_browse_page(headers: dict) -> bool:
    h = dict(headers)
    h['Content-Type'] = 'application/x-www-form-urlencoded'
    r = requests.post(f'{BASE_URL}/buyer-api/members/browsePage',
                      headers=h, data='{}', timeout=15)
    resp = r.json()
    return resp.get('code') == '200'

def do_community_browse(headers: dict) -> bool:
    r = requests.post(
        f'{BASE_URL}/buyer-api/members/commnity/brosing/duration/add?seconds=15',
        headers=headers, json={}, timeout=15)
    return r.text.strip() == 'success'

def do_visit_identification(headers: dict, code: str) -> bool:
    try:
        r = requests.get(
            f'{BASE_URL}/buyer-api/members/identification/visit?code={code}',
            headers=headers, timeout=10)
        return r.status_code == 200
    except Exception:
        return False

def do_article_view(headers: dict, version: str = '28.0.40') -> bool:
    try:
        r = requests.post(
            f'{BASE_URL}/buyer-api/members/article_view/add/{version}',
            headers=headers, json={}, timeout=10)
        return r.status_code == 200
    except Exception:
        return False

def do_sign_action(headers: dict, action_type: str) -> bool:
    try:
        r = requests.get(
            f'{BASE_URL}/buyer-api/members/active/action?type={action_type}',
            headers=headers, timeout=10)
        return r.status_code == 200
    except Exception:
        return False

def add_router_stat(headers: dict) -> bool:
    try:
        r = requests.post(
            f'{BASE_URL}/buyer-api/members/statistics/addRouter',
            headers=headers, json={}, timeout=10)
        return r.status_code == 200
    except Exception:
        return False

# ── 抽奖 ───────────────────────────────────────────────────────

def get_lucky_opportunity(headers: dict) -> dict:
    r = requests.get(
        f'{BASE_URL}/buyer-api/lucky/activity/opporturnity?activityCode={LUCKY_CODE}',
        headers=headers, timeout=15)
    return r.json()

def get_lucky_tasks(headers: dict) -> dict:
    r = requests.get(
        f'{BASE_URL}/buyer-api/lucky/task/package/{LUCKY_CODE}',
        headers=headers, timeout=15)
    return r.json()

def do_lucky_browse_page(headers: dict, page_url: str) -> bool:
    base = f'{BASE_URL}/buyer-api/lucky/task/browse/page'
    encoded = requests.utils.quote(page_url, safe='')
    requests.get(f'{base}/start/{LUCKY_CODE}?pageUrl={encoded}',
                 headers=headers, timeout=15)
    time.sleep(22)
    requests.get(f'{base}/end/{LUCKY_CODE}?pageUrl={encoded}',
                 headers=headers, timeout=15)
    return True

def do_lucky_login_opportunity(headers: dict) -> bool:
    r = requests.put(
        f'{BASE_URL}/buyer-api/lucky/task/getLoginOpporturnity/{LUCKY_CODE}',
        headers=headers, json={}, timeout=15)
    return r.status_code == 200

def do_lucky_redeem(headers: dict) -> bool:
    r = requests.get(
        f'{BASE_URL}/buyer-api/lucky/activity/redeem?activityCode={LUCKY_CODE}',
        headers=headers, timeout=15)
    return r.status_code == 200

def do_lucky_draw(headers: dict) -> dict:
    r = requests.get(
        f'{BASE_URL}/buyer-api/lucky/activity/extract?activityCode={LUCKY_CODE}',
        headers=headers, timeout=15)
    try:
        return r.json()
    except Exception:
        return {}

def run_lucky(headers: dict) -> list:
    logs = []
    try:
        tasks_data = get_lucky_tasks(headers)
        task_list = tasks_data.get('task_list', [])

        login_task = next((t for t in task_list if t.get('task_key') == 'LOGIN'), None)
        if login_task and login_task.get('today_obtained_task_number', 0) == 0:
            if do_lucky_login_opportunity(headers):
                logs.append('抽奖登录机会: 已领取')
            else:
                logs.append('抽奖登录机会: 领取失败')
        else:
            logs.append('抽奖登录机会: 已做过')

        browse_done = 0
        for t in task_list:
            if t.get('task_key') == 'BROWSE_PAGE_TASK':
                today_avail = t.get('today_available_task_number', 0)
                today_done = t.get('today_obtained_task_number', 0)
                if today_avail > 0 and today_done < today_avail:
                    page_url = t.get('link', '')
                    if page_url:
                        do_lucky_browse_page(headers, page_url)
                        browse_done += 1
        if browse_done:
            logs.append(f'抽奖浏览页面: 完成{browse_done}个')
        else:
            logs.append('抽奖浏览页面: 已做过')

        redeem_task = next((t for t in task_list if t.get('task_key') == 'POINT_EXCHANGE'), None)
        if redeem_task:
            today_avail = redeem_task.get('today_available_task_number', 0)
            today_done = redeem_task.get('today_obtained_task_number', 0)
            redeem_count = 0
            for _ in range(today_avail - today_done):
                if do_lucky_redeem(headers):
                    redeem_count += 1
                    time.sleep(1)
            if redeem_count:
                logs.append(f'积分兑换抽奖机会: {redeem_count}次')
            else:
                logs.append('积分兑换: 已做过或积分不足')

        opp = get_lucky_opportunity(headers)
        can_use = opp.get('can_use', 0)
        if can_use <= 0:
            logs.append('抽奖: 无可用次数')
            return logs

        prizes = []
        for _ in range(can_use):
            result = do_lucky_draw(headers)
            if isinstance(result, dict):
                record = result.get('lucky_record_vo')
                if record is None:
                    break
                prize_name = record.get('prize_name') or f'prize_id={record.get("prize_id","?")}'
            elif isinstance(result, str):
                prize_name = result
            else:
                prize_name = str(result)
            prizes.append(prize_name)
            time.sleep(random.uniform(1, 10))
        if prizes:
            logs.append(f'抽奖{len(prizes)}次: {chr(10).join(prizes)}')
        else:
            logs.append('抽奖: 无结果')

    except Exception as e:
        logs.append(f'抽奖异常: {e}')
    return logs

# ── 缓存 ───────────────────────────────────────────────────────

def read_cache() -> dict:
    cache = {}
    if not os.path.exists(CACHE_FILE):
        return cache
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parts = line.split('#')
                if len(parts) == 4:
                    name, auth, haday, uuid = parts
                    cache[name] = {'authorization': auth, 'haday_token': haday, 'uuid': uuid}
    except Exception as e:
        print(f'读取缓存失败: {e}')
    return cache

def write_cache(cache: dict):
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            for name, info in cache.items():
                f.write(f"{name}#{info['authorization']}#{info['haday_token']}#{info['uuid']}\n")
    except Exception as e:
        print(f'写入缓存失败: {e}')

# ── 账号解析 ────────────────────────────────────────────────────
def get_accounts() -> List[dict]:
    accounts = fetch_accounts()
    if not accounts:
        return []

    original_cache = read_cache()
    cache = original_cache.copy()
    result = []

    UUID = 'u1wv1d81pEcOwCNHkJvZ'

    for acc in accounts:
        name = acc.get('nickname') or acc.get('alias') or acc.get('name', '账号')
        openid = acc.get('openid', '')
        if not openid:
            print(f'[{name}] 无 openid，跳过')
            continue
        try:
            cache_key = f'{name}'

            if cache_key in cache:
                info = cache[cache_key]
                
                if check_token_valid(info['authorization'], info['uuid']):
                    print(f'[{name}] 缓存有效')
                    result.append({'name': cache_key, **info})
                    continue

            code = bridge_get_code(APPID, openid)
            if not code:
                print(f'[{cache_key}] [X] 获取code失败，跳过\n')
                continue

            print(f'[{name}] 获取手机数据...')
            phone_data = bridge_get_phone(APPID, openid)
            edata = phone_data.get('edata', '')
            iv = phone_data.get('iv', '')
            if not edata or not iv:
                print(f'[{cache_key}] [X] 获取手机数据失败，跳过\n')
                continue

            
            access_token = login_with_code(code, edata, iv, UUID)
            if not access_token:
                
                continue

            haday_token = get_haday_token(access_token)
            if not haday_token:
                print(f'[{cache_key}] [X] 获取haday token失败，跳过\n')
                continue

            info = {'authorization': access_token, 'haday_token': haday_token, 'uuid': UUID}
            cache[cache_key] = info
            result.append({'name': cache_key, **info})
            
        except Exception as e:
            print(f'[{name}] [X] 账号异常：{e}，跳过\n')
            continue

    if cache != original_cache:
        write_cache(cache)

    return result

# ── 通知 ────────────────────────────────────────────────────────
def send_notification(title: str, content: str):
    token = os.getenv('PUSH_PLUS_TOKEN', '')
    if not token:
        return
    try:
        r = requests.post('http://www.pushplus.plus/send', json={
            'token': token, 'title': title, 'content': content, 'template': 'html'
        }, timeout=10)
        if r.json().get('code') == 200:
            print('通知发送成功')
    except Exception:
        pass

# ── 主流程 ──────────────────────────────────────────────────────
def process_account(account: dict) -> dict:
    name = account['name']
    headers = _make_headers(account['authorization'], account['haday_token'], account['uuid'])
    result = {'name': name, 'sign': '', 'tasks': [], 'points': ''}

    try:
        info = get_sign_info(headers)
        if info.get('is_sign'):
            result['sign'] = f'已签到（累计{info.get("sign_day_num", 0)}天）'
        else:
            sign_result = do_sign(headers)
            if sign_result.get('is_sign'):
                days = sign_result.get('sign_day_num', 0)
                prizes = sign_result.get('sign_pize_list', [])
                prize_str = f'，奖励: {prizes}' if prizes else ''
                result['sign'] = f'签到成功（累计{days}天{prize_str}）'
            else:
                result['sign'] = f'签到失败: {sign_result}'
        do_sign_action(headers, 'SIG')
        do_article_view(headers)
        do_visit_identification(headers, 'gbqdhl')
        do_visit_identification(headers, 'qdhan')
    except Exception as e:
        result['sign'] = f'异常: {e}'

    try:
        tasks = get_point_tasks(headers)
        full_msg = tasks.get('full_msg', [])
        if len(full_msg) >= 2 and full_msg[1] == 0:
            do_login_task(headers)
            result['tasks'].append('登录积分: 已完成')
        else:
            result['tasks'].append('登录积分: 已做过')

        browse = tasks.get('browse_page', [])
        if len(browse) >= 2 and browse[1] == 0:
            ok = do_browse_page(headers)
            result['tasks'].append(f'浏览页面: {"成功" if ok else "失败"}')
        else:
            result['tasks'].append('浏览页面: 已做过')

        comm = tasks.get('community_browse', [])
        if len(comm) >= 2 and comm[1] == 0:
            ok = do_community_browse(headers)
            result['tasks'].append(f'社区浏览: {"成功" if ok else "失败"}')
        else:
            result['tasks'].append('社区浏览: 已做过')

        add_router_stat(headers)
        do_visit_identification(headers, 'cjqdtc')
        do_sign_action(headers, 'PAG')
        do_sign_action(headers, 'ACT')
        result['tasks'].append('附加任务: 已完成')

    except Exception as e:
        result['tasks'].append(f'任务执行异常: {e}')

    lucky_logs = run_lucky(headers)
    result['tasks'].extend(lucky_logs)

    try:
        pts = get_points(headers)
        consum = pts.get('consum_point', 0)
        grade = pts.get('grade_point', 0)
        result['points'] = f'消费积分{consum} / 成长积分{grade}'
    except Exception as e:
        result['points'] = f'查询失败: {e}'

    return result

def main():
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'[{now}] 希客美美签到开始')

    accounts = get_accounts()
    if not accounts:
        print('无有效账号')
        return

    print(f'共 {len(accounts)} 个有效账号\n')
    results = []

    for account in accounts:
        try:
            print(f'--- {account["name"]} ---')
            r = process_account(account)
            print(f'  签到: {r["sign"]}')
            for t in r['tasks']:
                print(f'  {t}')
            print(f'  积分: {r["points"]}\n')
            results.append(r)
        except Exception as e:
            print(f'[X] {account["name"]} 执行异常：{e}，跳过\n')
            continue

    content = f'<h3>希客美美签到 {now}</h3>'
    for r in results:
        tasks_html = '<br/>'.join(r['tasks'])
        content += f'''
<div style="border:1px solid #ddd;padding:10px;margin:8px 0">
  <b>{r["name"]}</b><br/>
  签到: {r["sign"]}<br/>
  {tasks_html}<br/>
  积分: {r["points"]}
</div>'''
    send_notification('希客美美签到通知', content)
    print('全部完成.')

if __name__ == '__main__':
    main()