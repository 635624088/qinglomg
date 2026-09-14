#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 金鹰购物中心小程序 每日签到
# 环境变量:
#   YYB_BASE_URL:   YYB协议地址，默认 http://172.17.0.1:18080
#   PUSH_PLUS_TOKEN: PushPlus 通知 token
#   FSKEY:           飞书推送 key

import os
import time
import requests
from datetime import datetime
from typing import Dict, List, Tuple

requests.packages.urllib3.disable_warnings()

APP_ID = 'wx219f21500e7d59ab'
BASE   = 'https://go.jinying.com'

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
    'content-type': 'application/x-www-form-urlencoded',
    'accept': '*/*',
    'referer': f'https://servicewechat.com/{APP_ID}/217/page-frame.html',
    'accept-language': 'zh-CN,zh;q=0.9',
}

class JinYingSignIn:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token    = os.getenv('PUSH_PLUS_TOKEN', '')
        self.fskey         = os.getenv('FSKEY', '')
        self.accounts      = self._parse_accounts()

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
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
        
        raw = os.getenv('jyqd', '')
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

    # ------------------------------------------------------------------ #
    #  WechatServer → wx code
    # ------------------------------------------------------------------ #
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

    # ------------------------------------------------------------------ #
    #  wx code → GEIPSID (session cookie)
    # ------------------------------------------------------------------ #
    def _get_session(self, code: str) -> str:
        """先尝试 bind_login，再尝试 bind，返回 GEIPSID 值"""
        # 第一步：bind_login
        url = (f'{BASE}/ajax/park/get_user_mobile'
               f'?do=bind_login&appid={APP_ID}&secret=%20'
               f'&code={code}&grant_type=authorization_code')
        try:
            r = requests.get(url, headers=BASE_HEADERS, timeout=30)
            geipsid = r.cookies.get('GEIPSID', '')
            resp = r.json()
            if geipsid and resp.get('code') == 1000:
                return geipsid
            # code=3000 说明需要走 bind 流程
        except Exception as e:
            print(f'  bind_login 异常: {e}')
            return ''

        # 第二步：bind（不传 encryptedData/iv）
        bind_url = (
            f'{BASE}/ajax/park/get_user_mobile'
            f'?do=bind&appid={APP_ID}&secret=%20'
            f'&code={code}&grant_type=grant_type'
            f'&encryptedData=&iv='
            f'&tj_id=-1&src=applet_jyg'
            f'&page_url=%2Fpages%2Fpersonal%2Fpersonal%2Fpersonal'
            f'&userinfo=%7B%22nickName%22%3A%22%E5%BE%AE%E4%BF%A1%E7%94%A8%E6%88%B7%22%7D'
        )
        try:
            r = requests.get(bind_url, headers=BASE_HEADERS, timeout=30)
            geipsid = r.cookies.get('GEIPSID', '')
            resp = r.json()
            if resp.get('code') == 1000:
                return geipsid
            print(f'  bind 登录失败: {resp}')
        except Exception as e:
            print(f'  bind 异常: {e}')
        return ''

    # ------------------------------------------------------------------ #
    #  签到
    # ------------------------------------------------------------------ #
    def _do_checkin(self, geipsid: str) -> Tuple[bool, str]:
        headers = {**BASE_HEADERS, 'cookie': f'GEIPSID={geipsid}'}
        try:
            r = requests.get(
                f'{BASE}/ajax_session/activity/check_in?do=check',
                headers=headers, timeout=15,
            )
            resp = r.json()
            if resp.get('code') == 1000:
                content = resp.get('content', '')
                num = resp.get('num', '')
                msg = content
                if num:
                    msg += f'，连续签到 {num} 天'
                return True, msg
            return False, f'code={resp.get("code")}，{resp.get("desc", "")}'
        except Exception as e:
            return False, f'请求异常: {e}'

    # ------------------------------------------------------------------ #
    #  单账号流程
    # ------------------------------------------------------------------ #
    def sign_in(self, account: Dict) -> Tuple[bool, str]:
        if not self.yyb_base_url:
            return False, 'YYB_BASE_URL 未配置'
        wxid = account['wxid']
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 wx code 失败'
        print('  登录获取 session...')
        geipsid = self._get_session(code)
        if not geipsid:
            return False, '获取 session 失败'
        print(f'  GEIPSID={geipsid[:16]}...')

        return self._do_checkin(geipsid)

    # ------------------------------------------------------------------ #
    #  通知
    # ------------------------------------------------------------------ #
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

    # ------------------------------------------------------------------ #
    #  主流程
    # ------------------------------------------------------------------ #
    def run(self):
        if not self.accounts:

            return

        print(f'=== 金鹰签到 {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ===')
        print(f'共 {len(self.accounts)} 个账号')

        results = []
        for i, acc in enumerate(self.accounts, 1):
            print(f'\n[{i}] {acc["name"]}')
            ok, msg = self.sign_in(acc)
            status = '✅' if ok else '❌'
            print(f'  {status} {msg}')
            results.append({'label': acc['name'], 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(2)

        title = '金鹰签到通知'
        lines = [f'{r["status"]} {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>金鹰签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: {r["status"]} {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')

if __name__ == '__main__':
    JinYingSignIn().run()
