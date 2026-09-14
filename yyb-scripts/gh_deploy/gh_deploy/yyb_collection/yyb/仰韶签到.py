#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 仰韶会员俱乐部 每日签到
# 环境变量:
#   YYB_BASE_URL:  YYB协议地址，默认 http://172.17.0.1:18080
#   PUSH_PLUS_TOKEN: PushPlus 通知 token
#   FSKEY:          飞书推送 key
# 执行流程: wxid → wx code → accessToken → 签到

import os
import time
import json
import requests
from typing import Dict, List, Tuple

requests.packages.urllib3.disable_warnings()

APP_ID = 'wx5ed5e20c00e05ba9'
BASE_URL = 'https://hy.51pt.top/app/ys'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
)

BASE_HEADERS = {
    'User-Agent':      UA,
    'xweb_xhr':        '1',
    'Content-Type':    'application/json',
    'Accept':          '*/*',
    'Referer':         f'https://servicewechat.com/{APP_ID}/194/page-frame.html',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}

class YanShaoSignIn:
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
        
        raw = os.getenv('yanshao', '')
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

    def _get_access_token(self, code: str) -> str:
        try:
            r = requests.post(
                f'{BASE_URL}/wx/login',
                headers=BASE_HEADERS,
                json={
                    'appId':         APP_ID,
                    'code':          code,
                    'encryptedData': '',
                    'iv':            '',
                    'openId':        '',
                },
                timeout=30,
            )
            resp = r.json()
            if resp.get('code') == '200':
                token = resp['data']['accessToken']
                member = resp['data'].get('member', {})
                name = member.get('accountName', '')
                score = member.get('score', '')
                print(f'  账号: {name}  积分: {score}')
                return token
            print(f'  获取 accessToken 失败: {resp.get("msg", resp)}')
        except Exception as e:
            print(f'  获取 accessToken 异常: {e}')
        return ''

    def _do_sign_in(self, token: str, code: str) -> Tuple[bool, str]:
        headers = {**BASE_HEADERS, 'Authorization': token}
        try:
            # 先查今日是否已签
            r = requests.get(
                f'{BASE_URL}/signIn/getSignInWeek',
                headers=headers,
                timeout=10,
            )
            status_resp = r.json()
            if status_resp.get('code') == '200':
                if status_resp['data'].get('signInStatus') == 1:
                    return True, '今日已签到'

            # 执行签到，需同时传 code 和 appId
            r = requests.post(
                f'{BASE_URL}/signIn/save',
                headers=headers,
                json={'code': code, 'appId': APP_ID},
                timeout=15,
            )
            resp = r.json()
            if resp.get('code') == '200':
                return True, f'签到成功！{resp.get("data", "")}'
            return False, f'签到失败: {resp.get("msg", str(resp))}'
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
        
        token = self._get_access_token(code)
        if not token:
            return False, '获取 accessToken 失败'
        # signIn/save 需要单独的新 code，login 用的 code 已失效
        sign_code = self._get_wx_code(wxid)
        if not sign_code:
            return False, '获取签到 code 失败'
        return self._do_sign_in(token, sign_code)

    def run(self):
        if not self.accounts:

            return

        print(f'仰韶会员俱乐部签到  共 {len(self.accounts)} 个账号')
        results = []
        for i, acc in enumerate(self.accounts, 1):
            print(f'\n[{i}] {acc["name"]}')
            ok, msg = self.sign_in(acc)
            status = 'OK' if ok else 'FAIL'
            print(f'  [{status}] {msg}')
            results.append({'label': acc['name'], 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(2)

        title = '仰韶会员俱乐部签到通知'
        lines = [f'[{r["status"]}] {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>仰韶会员俱乐部签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: [{r["status"]}] {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')

if __name__ == '__main__':
    YanShaoSignIn().run()
