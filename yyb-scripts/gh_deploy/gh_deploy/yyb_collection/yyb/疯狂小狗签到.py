#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 疯狂小狗 每日签到（有赞平台）
# 环境变量:

#   YYB_BASE_URL: YYB协议地址，默认 http://172.17.0.1:18080
#   PUSH_PLUS_TOKEN: PushPlus 通知 token
#   FSKEY:         飞书推送 key
# 执行流程: wxid → wx code → 有赞 access_token → 签到

import os
import time
import random
import string
import json
import requests
from typing import Dict, List, Tuple

requests.packages.urllib3.disable_warnings()

APP_ID     = 'wxad121efa5c60efdf'
KDT_ID     = '143705339'
CHECKIN_ID = '5595508'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
)

BASE_HEADERS = {
    'user-agent':      UA,
    'xweb_xhr':        '1',
    'content-type':    'application/json',
    'accept':          '*/*',
    'referer':         f'https://servicewechat.com/{APP_ID}/164/page-frame.html',
    'accept-language': 'zh-CN,zh;q=0.9',
}

def _gen_uuid(length: int = 24) -> str:
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))

class FengKuangXiaoGouSignIn:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token    = os.getenv('PUSH_PLUS_TOKEN', '')
        self.fskey         = os.getenv('FSKEY', '')
        self.accounts      = self._parse_accounts()

    @staticmethod
    def _fetch_accounts_from_yyb(yyb_base_url: str) -> List[Dict]:
        """从 YYB 协议获取账号列表"""
        if not yyb_base_url:
            return []
        try:
            resp = requests.get(f"{yyb_base_url}/accounts", timeout=10)
            data = resp.json()
            if data.get("code") == 0:
                accounts = []
                for item in data.get("data", []):
                    wxid = item.get("openid") or item.get("wxid") or ""
                    if wxid:
                        remark = item.get("nickname") or item.get("remark") or f"账号{len(accounts)+1}"
                        accounts.append({'name': remark, 'wxid': wxid})
                if accounts:
                    print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                    return accounts
        except Exception as e:
            print(f"❌ 从 YYB 获取账号失败: {e}")
        return []

    def _parse_accounts(self) -> List[Dict]:
        # 优先从 YYB 获取账号
        yyb_accounts = self._fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            return yyb_accounts
        
        raw = os.getenv('fkxg', '')
        if not raw and not yyb_accounts:
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
        # 优先使用 YYB 协议
        if self.yyb_base_url:
            url = self.yyb_base_url + '/wxapp/getCode'
            for i in range(3):
                try:
                    r = requests.post(
                        url,
                        json={'ref': wxid, 'app_id': APP_ID},
                        headers={'Content-Type': 'application/json', 'User-Agent': UA},
                        timeout=15,
                    )
                    resp = r.json()
                    if resp.get('code') == 0:
                        result = resp.get('data', {}).get('result') or {}
                        code = result.get('code') or result.get('Code')
                        if code:
                            return str(code)
                    if resp.get('Code') == 0:
                        return resp['Data']['code']
                    if resp.get('Success'):
                        return resp['Data']['Code']
                    if resp.get('code') == 200:
                        return resp['data']['code']
                    print(f'  YYB 获取 code 失败: {resp}')
                except Exception as e:
                    print(f'  YYB 请求失败({i+1}/3): {e}')
                    if i < 2:
                        time.sleep(2)
        
        # 回退到 WechatServer
        if not self.yyb_base_url:
            return ''
        url = f'{self.yyb_base_url}/wxapp/getCode'
        for i in range(3):
            try:
                r = requests.post(
                    url,
                    json={'wxid': wxid, 'appid': APP_ID},
                    headers={'Content-Type': 'application/json', 'User-Agent': UA},
                    timeout=60,
                )
                resp = r.json()
                if resp.get('Code') == 0:
                    return resp['Data']['code']
                if resp.get('Success'):
                    return resp['Data']['Code']
                if resp.get('code') == 200:
                    return resp['data']['code']
                print(f'  获取 code 失败: {resp}')
                return ''
            except Exception as e:
                
                if i < 2:
                    time.sleep(2)
        return ''

    def _get_access_token(self, code: str) -> Tuple[str, str]:
        try:
            r = requests.post(
                f'https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}',
                headers=BASE_HEADERS,
                json={
                    'appId':        APP_ID,
                    'code':         code,
                    'platformName': 'weapp',
                    'signature':    'windows',
                    'clientBiz':    'weapp_wsc',
                    'inWsc':        True,
                    'kdtId':        KDT_ID,
                    'extraBizData': {
                        'enterOptions': {
                            'extKdtId':     int(KDT_ID),
                            'path':         'pages/home/dashboard/index',
                            'query':        {},
                            'scene':        1005,
                            'referrerInfo': {},
                            'apiCategory':  'default',
                        },
                        'guideBizDataMap': {'from_params': ''},
                        'sceneData': {},
                    },
                },
                timeout=30,
            )
            resp = r.json()
            if resp.get('code') == 0:
                d = resp.get('data', {})
                return d.get('accessToken', ''), d.get('sessionId', '')
            print(f'  获取 access_token 失败: {resp}')
        except Exception as e:
            print(f'  获取 access_token 异常: {e}')
        return '', ''

    def _do_sign(self, access_token: str, session_id: str = '') -> Tuple[bool, str]:
        ftime = int(time.time() * 1000)
        extra_data = {
            'is_weapp': 1,
            'sid':      session_id or _gen_uuid(32),
            'version':  '2.234.5',
            'client':   'weapp',
            'bizEnv':   'wsc',
            'uuid':     _gen_uuid(15) + str(ftime),
            'ftime':    ftime,
        }
        headers = {
            **BASE_HEADERS,
            'extra-data': json.dumps(extra_data, separators=(',', ':')),
        }
        try:
            r = requests.get(
                'https://h5.youzan.com/wscump/checkin/checkinV2.json',
                headers=headers,
                params={
                    'checkinId':    CHECKIN_ID,
                    'app_id':       APP_ID,
                    'kdt_id':       KDT_ID,
                    'access_token': access_token,
                },
                timeout=15,
            )
            resp = r.json()
            if resp.get('code') == 0:
                data = resp.get('data', {})
                if data.get('success'):
                    days = data.get('times', data.get('days', '?'))
                    rewards = ', '.join(
                        item.get('infos', {}).get('title', '') for item in data.get('list', [])
                    )
                    msg = f'签到成功！第 {days} 天'
                    if rewards:
                        msg += f'，奖励: {rewards}'
                    return True, msg
                return True, '今日已签到'
            msg = resp.get('msg', str(resp))
            if resp.get('code') in (401, 40101, 10004, 1000030071):
                return False, f'access_token 已过期: {msg}'
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
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 wx code 失败'
        
        access_token, session_id = self._get_access_token(code)
        if not access_token:
            return False, '获取 access_token 失败'
        return self._do_sign(access_token, session_id)

    def run(self):
        if not self.accounts:

            return

        print(f'疯狂小狗签到 共 {len(self.accounts)} 个账号')
        results = []
        for i, acc in enumerate(self.accounts, 1):
            print(f'\n[{i}] {acc["name"]}')
            ok, msg = self.sign_in(acc)
            status = 'OK' if ok else 'FAIL'
            print(f'  [{status}] {msg}')
            results.append({'label': acc['name'], 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(2)

        title = '疯狂小狗签到通知'
        lines = [f'[{r["status"]}] {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>疯狂小狗签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: [{r["status"]}] {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')

if __name__ == '__main__':
    FengKuangXiaoGouSignIn().run()
