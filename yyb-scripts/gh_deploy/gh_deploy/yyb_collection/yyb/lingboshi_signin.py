#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 凌博士签到脚本 (有赞小程序)
# 环境变量:
#   PUSH_PLUS_TOKEN: PushPlus通知token
#   FSKEY: 飞书推送key
#   YYB_BASE_URL: YYB协议地址

import os
import json
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

APP_ID  = 'wxa341f7633b89074c'
KDT_ID  = '44553296'
CHECKIN_ID = '1939021'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
      'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
      'MiniProgramEnv/Windows WindowsWechat/WMPF '
      'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/19027')

class LingBoshiSignIn:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token    = os.getenv('PUSH_PLUS_TOKEN', '')
        self.fskey         = os.getenv('FSKEY', '')
        self.accounts      = self._parse_accounts()

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
    def _parse_accounts(self) -> List[Dict]:
        # 优先从 YYB 协议获取账号
        yyb_accounts = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
            return [{'name': nickname, 'wxid': wxid} for nickname, wxid in yyb_accounts]
        
        # 回退到环境变量
        raw = os.getenv('LINGBOSHI', '')
        if not raw:
            print('未找到环境变量 LINGBOSHI，且 YYB 协议无账号')
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

    # ------------------------------------------------------------------ #
    #  WechatServer
    # ------------------------------------------------------------------ #
    def _wechat_request(self, endpoint: str, data: Dict, retries: int = 3) -> Dict:
        url = f"{self.yyb_base_url}{endpoint}"
        headers = {'Content-Type': 'application/json;charset=utf-8', 'User-Agent': UA}
        for i in range(retries):
            try:
                r = requests.post(url, json=data, headers=headers, timeout=60)
                r.raise_for_status()
                return r.json()
            except Exception as e:
                print(f'  YYB 请求失败({i+1}/{retries}): {e}')
                if i < retries - 1:
                    time.sleep(2)
        return {}

    def _get_wx_code(self, wxid: str) -> str:
        resp = self._wechat_request('/wxapp/getCode', {'ref': wxid, 'app_id': APP_ID})
        if not resp:
            return ''
        # 优先 YYB 嵌套格式：data.result.code
        data = resp.get('data') or {}
        if isinstance(data, dict):
            result = data.get('result')
            if isinstance(result, dict):
                code = result.get('code')
                if code:
                    return str(code)
        # 兼容旧格式
        for key in ['Code', 'Success', 'code']:
            if key == 'Success' and resp.get('Success') is not True:
                continue
            if key in ('Code', 'code') and resp.get(key) not in (0, '0', 200, '200'):
                continue
            d = resp.get('Data') or resp.get('data') or {}
            if isinstance(d, dict):
                c = d.get('code') or d.get('Code')
                if c:
                    return str(c)
        print(f'  获取 code 失败: {resp}')
        return ''
    # ------------------------------------------------------------------ #
    #  有赞认证 → access_token
    # ------------------------------------------------------------------ #
    def _get_access_token(self, code: str) -> str:
        url = f'https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}'
        uuid = f'LingBoshi{int(time.time()*1000)}'
        headers = {
            'User-Agent': UA,
            'Content-Type': 'application/json',
            'xweb_xhr': '1',
            'app-mode': 'default',
            'page-path': 'pages/home/dashboard/index',
            'extra-data': json.dumps({
                'sid': '', 'version': '2.231.2.101',
                'clientType': 'weapp-miniprogram', 'client': 'weapp',
                'bizEnv': '', 'uuid': uuid, 'ftime': int(time.time()*1000)
            }),
            'Referer': f'https://servicewechat.com/{APP_ID}/83/page-frame.html',
            'Accept': '*/*',
        }
        body = {
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
                    'path': 'pages/home/dashboard/index',
                    'query': {}, 'referrerInfo': {}, 'apiCategory': 'default'
                },
                'guideBizDataMap': {'from_params': ''},
                'sceneData': {}
            }
        }
        try:
            r = requests.post(url, json=body, headers=headers, timeout=30)
            resp = r.json()
            if resp.get('code') == 0:
                d = resp['data']
                return d['accessToken'], d.get('sessionId', '')
            print(f'  auth 失败: {resp.get("msg")}')
        except Exception as e:
            print(f'  auth 请求异常: {e}')
        return '', ''

    # ------------------------------------------------------------------ #
    #  签到
    # ------------------------------------------------------------------ #
    def _do_checkin(self, access_token: str, session_id: str = '') -> Tuple[bool, str]:
        url = (f'https://h5.youzan.com/wscump/checkin/checkinV2.json'
               f'?checkinId={CHECKIN_ID}&app_id={APP_ID}&kdt_id={KDT_ID}&access_token={access_token}')
        headers = {
            'User-Agent': UA,
            'xweb_xhr': '1',
            'content-type': 'application/json',
            'extra-data': json.dumps({
                'is_weapp': 1, 'sid': session_id, 'version': '2.231.2.101',
                'client': 'weapp', 'bizEnv': '', 'clientType': 'weapp-miniprogram'
            }),
            'Accept': '*/*',
            'Referer': f'https://servicewechat.com/{APP_ID}/83/page-frame.html',
        }
        try:
            r = requests.get(url, headers=headers, timeout=30)
            resp = r.json()
            if resp.get('code') == 0:
                data = resp.get('data', {})
                if data.get('success'):
                    awards = []
                    for item in data.get('list', []):
                        title = item.get('infos', {}).get('title', '')
                        if title:
                            awards.append(title)
                    desc = data.get('desc', '签到成功')
                    award_str = ('，获得: ' + '、'.join(awards)) if awards else ''
                    return True, f'{desc}{award_str}'
                return False, data.get('desc', '签到失败')
            return False, f'接口错误: {resp.get("msg")}'
        except Exception as e:
            return False, f'请求异常: {e}'

    # ------------------------------------------------------------------ #
    #  单账号流程
    # ------------------------------------------------------------------ #
    def sign_in(self, account: Dict) -> Tuple[bool, str]:
        wxid = account['wxid']
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 wx code 失败'

        print("  ✅ 登录成功")
        token, session_id = self._get_access_token(code)
        if not token:
            return False, '获取 access_token 失败'

        print('  执行签到...')
        return self._do_checkin(token, session_id)

    # ------------------------------------------------------------------ #
    #  通知
    # ------------------------------------------------------------------ #
    def _push_plus(self, title: str, content: str):
        if not self.push_token:
            return
        try:
            r = requests.post('https://www.pushplus.plus/send', json={
                'token': self.push_token, 'title': title,
                'content': content, 'template': 'html'
            }, timeout=15)
            if r.json().get('code') == 200:
                print('PushPlus 通知成功')
            else:
                print(f'PushPlus 通知失败: {r.json().get("msg")}')
        except Exception as e:
            print(f'PushPlus 异常: {e}')

    def _feishu(self, title: str, content: str):
        if not self.fskey:
            return
        try:
            r = requests.post(f'https://open.feishu.cn/open-apis/bot/v2/hook/{self.fskey}', json={
                'msg_type': 'text',
                'content': {'text': f'{title}\n{content}'}
            }, timeout=15)
            if r.json().get('code') == 0:
                print('飞书通知成功')
            else:
                print(f'飞书通知失败: {r.json().get("msg")}')
        except Exception as e:
            print(f'飞书通知异常: {e}')

    # ------------------------------------------------------------------ #
    #  主流程
    # ------------------------------------------------------------------ #
    def run(self):
        if not self.accounts:

            return

        print(f'共 {len(self.accounts)} 个账号')
        results = []

        for i, acc in enumerate(self.accounts, 1):
            label = acc['name']
            print(f'\n[{i}] {label}')
            ok, msg = self.sign_in(acc)
            status = '✅' if ok else '❌'
            print(f'  签到: {msg}')
            results.append({'label': label, 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(2)

        # 汇总通知
        title = '凌博士签到通知'
        lines = [f'{r["status"]} {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html_summary = '<h3>凌博士签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: {r["status"]} {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html_summary)
        self._feishu(title, summary)

        print('\n所有任务完成！')

if __name__ == '__main__':
    LingBoshiSignIn().run()
