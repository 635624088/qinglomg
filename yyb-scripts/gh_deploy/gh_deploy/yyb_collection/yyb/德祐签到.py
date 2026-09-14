#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 德祐生活 每日签到脚本
# 环境变量:
#   DEYOU: 账号信息, 格式: 备注#openid (多账号用 & 或换行分隔)
#   YYB_BASE_URL: YYB 协议地址 (默认 http://172.17.0.1:18080)
#   PUSH_PLUS_TOKEN: PushPlus 通知 token
#   FSKEY: 飞书推送 key

import os
import time
import requests
from datetime import date
from typing import Dict, List, Tuple

APP_ID = 'wxbcb530a4b66d3d3b'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/19027'
)

BASE_HEADERS = {
    'user-agent': UA,
    'xweb_xhr': '1',
    'form-type': 'routine',
    'content-type': 'application/json',
    'accept': '*/*',
    'referer': f'https://servicewechat.com/{APP_ID}/78/page-frame.html',
    'accept-language': 'zh-CN,zh;q=0.9',
}


def fetch_accounts_from_yyb(yyb_base_url: str) -> List[Tuple[str, str]]:
    """从 YYB 协议获取账号列表"""
    try:
        r = requests.get(f"{yyb_base_url}/accounts", timeout=10)
        resp = r.json()
        if resp.get("code") == 0:
            accounts = resp.get("data", [])
            result = []
            for acct in accounts:
                nickname = acct.get("nickname") or acct.get("alias") or acct.get("openid", "")
                openid = acct.get("openid", "")
                if openid:
                    result.append((nickname, openid))
            return result
    except Exception as e:
        print(f"  从 YYB 获取账号列表失败: {e}")
    return []


class DeyouSignIn:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token    = os.getenv('PUSH_PLUS_TOKEN', '')
        self.fskey         = os.getenv('FSKEY', '')
        self.accounts      = self._parse_accounts()

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
    def _parse_accounts(self) -> List[Dict]:
        """优先从 YYB 获取账号列表，回退到环境变量"""
        yyb_accts = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accts:
            return [{'name': nickname, 'openid': openid} for nickname, openid in yyb_accts]

        raw = os.getenv('DEYOU', '')
        accounts = []
        for item in raw.replace('\n', '&').split('&'):
            item = item.strip()
            if not item:
                continue
            if '#' in item:
                name, openid = item.split('#', 1)
            else:
                name, openid = item, item
            accounts.append({'name': name.strip(), 'openid': openid.strip()})
        return accounts

    # ------------------------------------------------------------------ #
    #  YYB 协议 → wx code
    # ------------------------------------------------------------------ #
    def _get_wx_code(self, openid: str) -> str:
        url = self.yyb_base_url + '/wxapp/getCode'
        for i in range(3):
            try:
                r = requests.post(
                    url,
                    json={'ref': openid, 'app_id': APP_ID},
                    headers={'Content-Type': 'application/json', 'User-Agent': UA},
                    timeout=60,
                )
                resp = r.json()
                if resp.get('code') == 0:
                    data = resp.get('data', {})
                    result = data.get('result', {}) or data
                    code = result.get('code', '')
                    if code:
                        return code
                    code = data.get('code', '')
                    if code:
                        return code
                print(f'  code 获取失败: {resp.get("msg", "")}')
                return ''
            except Exception as e:
                print(f'  YYB 请求失败({i+1}/3): {e}')
                if i < 2:
                    time.sleep(2)
        return ''

    # ------------------------------------------------------------------ #
    #  获取手机号加密信息（YYB 自带）
    # ------------------------------------------------------------------ #
    def _get_phone_info(self, openid: str) -> Tuple[str, str]:
        url = self.yyb_base_url + '/wxapp/getPhoneNumber'
        for i in range(3):
            try:
                r = requests.post(url, json={'ref': openid, 'app_id': APP_ID}, timeout=15)
                resp = r.json()
                if resp.get('code') == 0:
                    data = resp.get('data', {})
                    result = data.get('result', {}) or data
                    edata = result.get('encryptedData', '') or result.get('encrypted_data', '')
                    iv = result.get('iv', '')
                    if edata and iv:
                        return edata, iv
                print(f'  获取手机号失败: {resp.get("msg", "")}')
            except Exception as e:
                print(f'  获取手机号异常({i+1}/3): {e}')
            time.sleep(1)
        return '', ''

    # ------------------------------------------------------------------ #
    #  wx code + phone_info → token
    # ------------------------------------------------------------------ #
    def _get_token(self, code: str, edata: str, iv: str) -> str:
        try:
            r = requests.post(
                'https://dymall.yixiang.com.cn/api/v2/routine/auth_binding_phone',
                headers=BASE_HEADERS,
                json={
                    'code': code,
                    'key': 'a385a80f7f4588878b44e61963d9f930',
                    'channel': 'mini',
                    'encryptedData': edata,
                    'iv': iv,
                },
                timeout=30,
            )
            resp = r.json()
            if resp.get('status') == 200:
                token = resp.get('data', {}).get('token', '')
                return token
            print(f'  登录失败: {resp.get("msg", "")}')
        except Exception as e:
            print(f'  登录请求异常: {e}')
        return ''

    # ------------------------------------------------------------------ #
    #  签到
    # ------------------------------------------------------------------ #
    def _do_sign(self, token: str) -> Tuple[bool, str]:
        today = date.today().strftime('%Y-%m-%d')
        headers = {**BASE_HEADERS, 'authori-zation': f'Bearer {token}'}
        try:
            r = requests.post(
                'https://dymall.yixiang.com.cn/api/user_sign/sign_general_store',
                headers=headers,
                json={'sign_date': today},
                timeout=15,
            )
            data = r.json()
            if data.get('status') == 200:
                d = data.get('data', {})
                points = d.get('base_sign_point', 0)
                days   = d.get('sign_num', '?')
                msg = f'签到成功！连续 {days} 天，获得 {points} 积分'
                return True, msg
            # 可能已签到过
            msg = data.get('msg', '') or ''
            if '已签到' in msg or '今日已签到' in msg:
                return True, f'今日已签到'
            return False, f'签到失败: {msg}'
        except Exception as e:
            return False, f'请求异常: {e}'

    # ------------------------------------------------------------------ #
    #  单账号流程
    # ------------------------------------------------------------------ #
    def sign_in(self, account: Dict) -> Tuple[bool, str]:
        if not self.yyb_base_url:
            return False, 'YYB_BASE_URL 未配置'
        openid = account['openid']
        code = self._get_wx_code(openid)
        if not code:
            return False, '获取 wx code 失败'
        edata, iv = self._get_phone_info(openid)
        token = self._get_token(code, edata, iv)
        if not token:
            return False, '登录失败'
        return self._do_sign(token)

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
            print('未找到有效账号，请设置环境变量 DEYOU')
            return

        print(f'共 {len(self.accounts)} 个账号')
        results = []
        for i, acc in enumerate(self.accounts, 1):
            print(f'[{i}/{len(self.accounts)}] {acc["name"]}')
            ok, msg = self.sign_in(acc)
            status = '✅' if ok else '❌'
            print(f'  {status} {msg}')
            results.append({'label': acc['name'], 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(2)

        title = '德祐生活签到通知'
        lines = [f'{r["status"]} {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>德祐生活签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: {r["status"]} {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')


if __name__ == '__main__':
    DeyouSignIn().run()
