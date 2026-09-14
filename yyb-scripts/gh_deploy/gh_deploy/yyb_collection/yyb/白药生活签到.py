#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 白药生活 每日签到脚本
# 环境变量:
#   YYB_BASE_URL: YYB 协议地址 (用于 wxid 登录)
#   PUSH_PLUS_TOKEN: PushPlus 通知 token
#   FSKEY: 飞书推送 key

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

APP_ID       = 'wxffe680a300a29912'
PLATFORM_NUM = '153286'
STORE_ID     = '8888'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) '
    f'XWEB/19027 miniProgram/{APP_ID}'
)

class BaiyaoSignIn:
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
        raw = os.getenv('BAIYAO', '')
        if not raw:
            print('未找到环境变量 BAIYAO，且 YYB 协议无账号')
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
        url = f"{self.yyb_base_url}/wxapp/getCode"
        for i in range(3):
            try:
                r = requests.post(url, json={'ref': wxid, 'app_id': APP_ID},
                                  headers={'Content-Type': 'application/json', 'User-Agent': UA},
                                  timeout=60)
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

    # ------------------------------------------------------------------ #
    #  wx code → skey + uid
    # ------------------------------------------------------------------ #
    def _get_skey(self, code: str) -> Tuple[str, str]:
        headers = {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': f'https://servicewechat.com/{APP_ID}/release/page-frame.html',
        }
        base_params = {
            '_platform_num': PLATFORM_NUM,
            'code': code,
            'appid': APP_ID,
            'storeid': STORE_ID,
            'belongstore': STORE_ID,
        }
        # 已注册用户用 Login 接口
        try:
            r = requests.get(
                'https://miniapi-hy.baiyaodajiankang.com/user4wechat/user4wechat/LoginbyWechatApplet',
                params=base_params, headers=headers, timeout=30)
            resp = r.json()
            if resp.get('errno') == 0:
                d = resp['data']
                if d.get('skey'):
                    return str(d['uid']), d['skey']
            print(f'  Login 返回: {resp}')
        except Exception as e:
            print(f'  Login 请求异常: {e}')
        return '', ''

    # ------------------------------------------------------------------ #
    #  签到
    # ------------------------------------------------------------------ #
    def _do_sign(self, uid: str, skey: str) -> Tuple[bool, str]:
        url = 'https://minih5-hy.baiyaodajiankang.com/common/signin/api/v1/cloud/sign_in/do'
        params = {
            '_platform_num': PLATFORM_NUM,
            'uid': uid,
            'skey': skey,
            'sign_in_type': '1',
        }
        headers = {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': f'https://minih5-hy.baiyaodajiankang.com/common/m/module/marketing-tools-c/sign?_platform_num={PLATFORM_NUM}&uid={uid}&skey={skey}',
        }
        cookies = {
            'uid': uid, 'skey': skey,
            '_platform_num': PLATFORM_NUM,
            'entityid': STORE_ID, 'Application': '01', 'scene': '1005',
        }
        try:
            r = requests.get(url, params=params, headers=headers, cookies=cookies, timeout=15)
            data = r.json()
            if data.get('code') == 0:
                d = data.get('data', {})
                msg = f'签到成功！连续 {d.get("consecutive_days", "?")} 天'
                rewards = d.get('reward_config', [])
                if rewards:
                    pts = '、'.join(f'{rw.get("reward_value","")}积分' for rw in rewards if rw.get('reward_value'))
                    if pts:
                        msg += f'，获得 {pts}'
                return True, msg
            return False, f'签到失败（code={data.get("code")}）'
        except Exception as e:
            return False, f'请求异常: {e}'

    # ------------------------------------------------------------------ #
    #  单账号流程
    # ------------------------------------------------------------------ #
    def sign_in(self, account: Dict) -> Tuple[bool, str]:
        if not self.yyb_base_url:
            return False, 'YYB_BASE_URL 未配置'
        wxid = account['wxid']
        name = account['name']
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 wx code 失败'
        print(f'[{name}] 登录获取 skey...')
        uid, skey = self._get_skey(code)
        if not uid:
            return False, '登录失败'
        print(f'[{name}] uid={uid}  skey={skey}')
        return self._do_sign(uid, skey)

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
            print('PushPlus:', '成功' if r.json().get('code') == 200 else r.json().get('msg'))
        except Exception as e:
            print(f'PushPlus 异常: {e}')

    def _feishu(self, title: str, content: str):
        if not self.fskey:
            return
        try:
            r = requests.post(f'https://open.feishu.cn/open-apis/bot/v2/hook/{self.fskey}', json={
                'msg_type': 'text', 'content': {'text': f'{title}\n{content}'}
            }, timeout=15)
            print('飞书:', '成功' if r.json().get('code') == 0 else r.json().get('msg'))
        except Exception as e:
            print(f'飞书异常: {e}')

    # ------------------------------------------------------------------ #
    #  主流程
    # ------------------------------------------------------------------ #
    def run(self):
        if not self.accounts:

            return

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

        title = '白药生活签到通知'
        lines = [f'{r["status"]} {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>白药生活签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: {r["status"]} {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')

if __name__ == '__main__':
    BaiyaoSignIn().run()
