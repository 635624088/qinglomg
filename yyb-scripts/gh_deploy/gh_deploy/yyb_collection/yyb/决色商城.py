#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#小程序://决色商城/3t87ZuIulNa5Hwt
# 已迁移到 YYB 协议
import json
import os
import random
import string
import time
from typing import Dict, List, Tuple

import requests

requests.packages.urllib3.disable_warnings()

APP_ID = 'wxc80848eb835b2661'
KDT_ID = '139827364'
CHECKIN_ID = '4806300'

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
    'referer': f'https://servicewechat.com/{APP_ID}/164/page-frame.html',
    'accept-language': 'zh-CN,zh;q=0.9',
}

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

def _gen_uuid(length: int = 24) -> str:
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))

class JueSeMallSignIn:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token = os.getenv('PUSH_PLUS_TOKEN', '')
        self.fskey = os.getenv('FSKEY', '')
        self.accounts = self._parse_accounts()

    def _parse_accounts(self) -> List[Dict]:
        # 优先从 YYB 协议获取账号
        yyb_accounts = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
            return [{'name': nickname, 'wxid': wxid} for nickname, wxid in yyb_accounts]
        
        # 回退到环境变量
        raw = os.getenv('juese', '') or os.getenv('JUESE', '')
        if not raw:
            print('未找到环境变量 juese/JUESE，且 YYB 协议无账号')
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

    def _request_json(self, method: str, url: str, **kwargs):
        try:
            r = requests.request(method, url, timeout=kwargs.pop('timeout', 30), verify=False, **kwargs)
            return True, r.json()
        except Exception as e:
            return False, {'_error': str(e)}

    def _get_wx_code(self, wxid: str) -> str:
        url = f"{self.yyb_base_url}/wxapp/getCode"
        for i in range(3):
            ok, resp = self._request_json(
                'POST',
                url,
                json={'ref': wxid, 'app_id': APP_ID},
                headers={'Content-Type': 'application/json', 'User-Agent': UA},
                timeout=60,
            )
            if ok:
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
            print(f'  YYB 协议请求失败({i+1}/3): {resp.get("_error")}')
            if i < 2:
                time.sleep(2)
        return 

    def _get_access_token(self, code: str) -> Tuple[str, str]:
        payload = {
            'appId': APP_ID,
            'code': code,
            'platformName': 'weapp',
            'signature': 'windows',
            'clientBiz': 'weapp_wsc',
            'inWsc': True,
            'kdtId': KDT_ID,
            'extraBizData': {
                'enterOptions': {
                    'extKdtId': int(KDT_ID),
                    'path': 'packages/shop/ump/sign-in/index',
                    'query': {},
                    'scene': 1005,
                    'referrerInfo': {},
                    'apiCategory': 'default',
                },
                'guideBizDataMap': {'from_params': ''},
                'sceneData': {},
            },
        }
        ok, resp = self._request_json(
            'POST',
            f'https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}',
            headers=BASE_HEADERS,
            json=payload,
            timeout=30,
        )
        if ok and resp.get('code') == 0:
            d = resp.get('data', {})
            return d.get('accessToken', ''), d.get('sessionId', '')
        print(f'  获取 access_token 失败: {resp}')
        return '', ''

    def _get_checkin_info(self, access_token: str):
        ok, resp = self._request_json(
            'GET',
            'https://h5.youzan.com/wscump/checkin/get_activity_by_yzuid_v2.json',
            headers=BASE_HEADERS,
            params={
                'checkinId': CHECKIN_ID,
                'app_id': APP_ID,
                'kdt_id': KDT_ID,
                'access_token': access_token,
            },
            timeout=20,
        )
        return ok, resp

    def _get_month_record(self, access_token: str):
        now = time.localtime()
        ok, resp = self._request_json(
            'GET',
            'https://h5.youzan.com/wscump/checkin/find_checkin_info_by_month.json',
            headers=BASE_HEADERS,
            params={
                'checkin_id': CHECKIN_ID,
                'year': now.tm_year,
                'month': now.tm_mon,
                'app_id': APP_ID,
                'kdt_id': KDT_ID,
                'access_token': access_token,
            },
            timeout=20,
        )
        return ok, resp

    def _do_sign(self, access_token: str, session_id: str = '') -> Tuple[bool, str]:
        ftime = int(time.time() * 1000)
        extra_data = {
            'is_weapp': 1,
            'sid': session_id or _gen_uuid(32),
            'version': '2.238.3',
            'client': 'weapp',
            'bizEnv': 'wsc',
            'uuid': _gen_uuid(15) + str(ftime),
            'ftime': ftime,
        }
        headers = {
            **BASE_HEADERS,
            'extra-data': json.dumps(extra_data, separators=(',', ':')),
        }
        ok, resp = self._request_json(
            'GET',
            'https://h5.youzan.com/wscump/checkin/checkinV2.json',
            headers=headers,
            params={
                'checkinId': CHECKIN_ID,
                'app_id': APP_ID,
                'kdt_id': KDT_ID,
                'access_token': access_token,
            },
            timeout=20,
        )
        if not ok:
            return False, f'签到请求异常: {resp.get("_error")}'
        if resp.get('code') == 0:
            data = resp.get('data', {})
            if data.get('success'):
                days = data.get('times', data.get('days', '?'))
                rewards = ', '.join(item.get('infos', {}).get('title', '') for item in data.get('list', []))
                msg = f'签到成功！第 {days} 天'
                if rewards:
                    msg += f'，奖励: {rewards}'
                return True, msg
            return True, '今日已签到'
        return False, f"签到失败: {resp.get('msg', resp)}"

    def _push_plus(self, title: str, content: str):
        if not self.push_token:
            return
        try:
            r = requests.post('https://www.pushplus.plus/send', json={
                'token': self.push_token,
                'title': title,
                'content': content,
                'template': 'html',
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
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 wx code 失败'
        
        access_token, session_id = self._get_access_token(code)
        if not access_token:
            return False, '获取 access_token 失败'
        ok_info, info_resp = self._get_checkin_info(access_token)
        ok_month, month_resp = self._get_month_record(access_token)
        status_parts = []
        if ok_info and info_resp.get('code') == 0:
            data = info_resp.get('data', {})
            if isinstance(data, dict):
                if data.get('isChecked'):
                    status_parts.append('今日已签到')
                days = data.get('times') or data.get('days') or data.get('continuousDays')
                if days is not None:
                    status_parts.append(f'连续{days}天')
        if ok_month and month_resp.get('code') == 0:
            data = month_resp.get('data', {})
            if isinstance(data, dict):
                recs = data.get('list') or data.get('records') or []
                if isinstance(recs, list):
                    status_parts.append(f'本月记录{len(recs)}条')

        sign_ok, sign_msg = self._do_sign(access_token, session_id)
        if status_parts:
            sign_msg = f"{sign_msg} | {' | '.join(status_parts)}"
        return sign_ok, sign_msg

    def run(self):
        if not self.accounts:

            return

        print(f'决色商城签到 共 {len(self.accounts)} 个账号')
        results = []
        for i, acc in enumerate(self.accounts, 1):
            print(f'\n[{i}] {acc["name"]}')
            ok, msg = self.sign_in(acc)
            status = 'OK' if ok else 'FAIL'
            print(f'  [{status}] {msg}')
            results.append({'label': acc['name'], 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(2)

        title = '决色商城签到通知'
        lines = [f'[{r["status"]}] {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>决色商城签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: [{r["status"]}] {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')

if __name__ == '__main__':
    JueSeMallSignIn().run()
