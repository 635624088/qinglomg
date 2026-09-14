#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 永璞小岛 每日签到
# 环境变量:
#   YYB_BASE_URL: YYB 协议地址 (用于 wxid 登录)
#   PUSH_PLUS_TOKEN: PushPlus 通知 token
#   FSKEY:         飞书推送 key
# 执行流程: wxid → wx code → token → 签到

import os
import time
import requests
from typing import Dict, List, Tuple

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

requests.packages.urllib3.disable_warnings()

APP_ID = 'wxcb29cf290c6fa0ce'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
)

BASE_HEADERS = {
    'user-agent': UA,
    'xweb_xhr': '1',
    'content-type': 'application/json',
    'accept': '*/*',
    'referer': f'https://servicewechat.com/{APP_ID}/247/page-frame.html',
    'accept-language': 'zh-CN,zh;q=0.9',
    'paramid': '',
    'token': '',
}

BASE_URL = 'https://coffee.yongpu.cn'

class YongPuSignIn:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token    = os.getenv('PUSH_PLUS_TOKEN', '')
        self.fskey         = os.getenv('FSKEY', '')
        self.accounts      = self._parse_accounts()

    def _parse_accounts(self) -> List[Dict]:
        # 优先从 YYB 协议获取账号
        yyb_accounts = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
            return [{'name': nickname, 'wxid': wxid} for nickname, wxid in yyb_accounts]
        
        # 回退到环境变量
        raw = os.getenv('yongpu', '')
        if not raw:
            print('未找到环境变量 yongpu，且 YYB 协议无账号')
            return []
        accounts = []
        for item in raw.replace('\n', '&').split('&'):
            item = item.strip()
            if not item:
                continue
            if '#' in item:
                name, wxid = item.split('#', 1)
            else:
                name, wxid = item, item
            accounts.append({'name': name.strip(), 'wxid': wxid.strip()})
        return accounts

    def _get_wx_code(self, wxid: str) -> str:
        url = f"{self.yyb_base_url}/wxapp/getCode"
        for i in range(3):
            try:
                r = requests.post(
                    url,
                    json={'ref': wxid, 'app_id': APP_ID},
                    headers={'Content-Type': 'application/json', 'User-Agent': UA},
                    timeout=60,
                )
                resp = r.json()
                # 兼容 YYB 格式：code=0, data.result.code
                if isinstance(resp, dict):
                    data = resp.get('data') or {}
                    if isinstance(data, dict):
                        result = data.get('result')
                        if isinstance(result, dict):
                            code = result.get('code')
                            if code:
                                return str(code)
                    if resp.get('Code') == 0:
                        return str(resp.get('Data', {}).get('code', ''))
                    if resp.get('code') == 200:
                        return str(resp.get('data', {}).get('code', ''))
                print(f'  获取 code 失败: {resp}')
                return ''
            except Exception as e:
                print(f'  YYB 协议请求失败({i+1}/3): {e}')
                if i < 2:
                    time.sleep(2)
        return ''

    def _login(self, code: str) -> str:
        try:
            r = requests.post(
                f'{BASE_URL}/auth/v2/wxLogin',
                headers=BASE_HEADERS,
                json={'code': code, 'appType': 0},
                timeout=30,
            )
            resp = r.json()
            if resp.get('code') == 200:
                token = resp.get('data', {}).get('token', '')
                if token:
                    return token
                
            else:
                print(f'  登录失败: {resp}')
        except Exception as e:
            print(f'  登录异常: {e}')
        return ''

    def _request(self, method: str, path: str, token: str, **kwargs) -> dict:
        headers = {**BASE_HEADERS, 'token': token}
        r = requests.request(
            method,
            BASE_URL + path,
            headers=headers,
            timeout=15,
            **kwargs,
        )
        return r.json()

    def _do_sign(self, token: str) -> Tuple[bool, str]:
        try:
            # 检查今日是否已签到
            cal = self._request('GET', '/calendar/config', token)
            if cal.get('code') == 200:
                calendar = cal.get('data', {}).get('calendar', [])
                today_signed = any(
                    d.get('signStatus') == 1
                    for d in calendar
                    if d.get('timestamp', 0) // 1000 // 86400 == int(time.time()) // 86400
                )
                if today_signed:
                    return True, '今日已签到'
        except Exception:
            pass

        # 执行签到
        try:
            resp = self._request('POST', '/sign', token, json={})
            if resp.get('code') == 200:
                # 领取积分
                try:
                    self._request('POST', '/user/getPoint', token, json={})
                except Exception:
                    pass
                # 尝试领取全勤奖励
                try:
                    self._request('POST', '/fullSign/getReward', token, json={})
                except Exception:
                    pass
                # 查询积分
                try:
                    info = self._request('GET', '/userinfo', token)
                    integral = info.get('data', {}).get('integral', '?')
                    grade_name = info.get('data', {}).get('gradeName', '')
                    return True, f'签到成功！当前积分: {integral}，等级: {grade_name}'
                except Exception:
                    return True, '签到成功！'
            msg = resp.get('msg', str(resp))
            return False, f'签到失败: {msg}'
        except Exception as e:
            return False, f'请求异常: {e}'

    def _push_plus(self, title: str, content: str):
        if not self.push_token:
            return
        try:
            r = requests.post('https://www.pushplus.plus/send', json={
                'token': self.push_token, 'title': title,
                'content': content, 'template': 'html',
            }, timeout=15)
            print('PushPlus:', '成功' if r.json().get('code') == 200 else r.json().get('msg'))
        except Exception as e:
            print(f'PushPlus 异常: {e}')

    def _feishu(self, title: str, content: str):
        if not self.fskey:
            return
        try:
            r = requests.post(
                f'https://open.feishu.cn/open-apis/bot/v2/hook/{self.fskey}',
                json={'msg_type': 'text', 'content': {'text': f'{title}\n{content}'}},
                timeout=15,
            )
            print('飞书:', '成功' if r.json().get('code') == 0 else r.json().get('msg'))
        except Exception as e:
            print(f'飞书异常: {e}')

    def sign_in(self, account: Dict) -> Tuple[bool, str]:
        if not self.yyb_base_url:
            return False, 'YYB_BASE_URL 未配置'
        wxid = account['wxid']
        name = account['name']
        
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 wx code 失败'
        
        token = self._login(code)
        if not token:
            return False, '登录失败'
        return self._do_sign(token)

    def run(self):
        if not self.accounts:

            return

        print(f'共 {len(self.accounts)} 个账号')
        results = []
        for i, acc in enumerate(self.accounts, 1):
            print(f'\n[{i}] {acc["name"]}')
            ok, msg = self.sign_in(acc)
            status = 'OK' if ok else 'FAIL'
            print(f'  [{status}] {msg}')
            results.append({'label': acc['name'], 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(2)

        title = '永璞小岛签到通知'
        lines = [f'[{r["status"]}] {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>永璞小岛签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: [{r["status"]}] {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')

if __name__ == '__main__':
    YongPuSignIn().run()
