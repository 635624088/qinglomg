#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
麦富迪小程序 - 每日签到脚本

环境变量:
  MFD: 账号信息，格式: 备注#memberId (多账号用 & 或换行分隔)
  YYB_BASE_URL: YYB 协议地址（用于获取微信 code）
  PUSH_PLUS_TOKEN: PushPlus 通知 token
  FSKEY: 飞书推送 key
"""

import os
import time
import requests
from typing import Dict, List

SUCCESS_FLAGS = {0, 1, '0', '1'}


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


def _yyb_post(url: str, payload: dict) -> dict:
    """调用 YYB 协议接口"""
    for retry in range(3):
        try:
            r = requests.post(
                url,
                json=payload,
                headers={'Content-Type': 'application/json;charset=utf-8'},
                timeout=60,
            )
            r.raise_for_status()
            return r.json() or {}
        except Exception:
            if retry < 2:
                time.sleep(2)
    return {}


class MaiFuDi:
    APPID = 'wx278a2ed79c5182f8'
    BASE_URL = 'https://cdp.myfoodiepet.com/tnew/myfoodiepet-member'
    CACHE_FILE = 'mfd.txt'

    APP_ID_HEADER = '6259662812989361028'
    TENANT_ID = '00ae459e842642f78b9ab0d8e7c027b4'

    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', '').rstrip('/')
        self.push_token = os.getenv('PUSH_PLUS_TOKEN')
        self.fskey = os.getenv('FSKEY')
        self.accounts = self._load_accounts()

    # ------------------------------------------------------------------ #
    #  请求
    # ------------------------------------------------------------------ #
    def _headers(self, member_id: int = 0) -> Dict:
        h = {
            'Host': 'cdp.myfoodiepet.com',
            'Connection': 'keep-alive',
            'appId': self.APP_ID_HEADER,
            'tenantId': self.TENANT_ID,
            'groupId': '',
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
                'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
                'MiniProgramEnv/Windows WindowsWechat/WMPF '
                'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            ),
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json;charset=UTF-8',
            'xweb_xhr': '1',
            'Referer': f'https://servicewechat.com/{self.APPID}/358/page-frame.html',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        }
        if member_id:
            h['userId'] = str(member_id)
        return h

    def _post(self, path: str, member_id: int, body: Dict) -> Dict:
        ts = int(time.time() * 1000)
        try:
            r = requests.post(
                self.BASE_URL + path,
                params={'_': ts},
                headers=self._headers(member_id),
                json=body,
                timeout=15,
            )
            return r.json()
        except Exception as e:
            return {'code': -1, 'msg': str(e)}

    def _get(self, path: str, member_id: int, params: Dict = None) -> Dict:
        ts = int(time.time() * 1000)
        p = params or {}
        p['_'] = ts
        try:
            r = requests.get(
                self.BASE_URL + path,
                params=p,
                headers=self._headers(member_id),
                timeout=15,
            )
            return r.json()
        except Exception as e:
            return {'code': -1, 'msg': str(e)}

    # ------------------------------------------------------------------ #
    #  YYB 协议 - 获取微信 code
    # ------------------------------------------------------------------ #
    def _get_wx_code(self, openid: str) -> str:
        """通过 YYB 协议获取微信小程序 code"""
        url = f"{self.yyb_base_url}/wxapp/getCode"
        resp = _yyb_post(url, {'ref': openid, 'app_id': self.APPID})
        if resp.get('code') == 0:
            data = resp.get('data', {})
            result = data.get('result') or data
            code = result.get('code', '')
            return code
        return ''

    # ------------------------------------------------------------------ #
    #  登录（openid -> code -> memberId）
    # ------------------------------------------------------------------ #
    def _login_with_openid(self, openid: str) -> int:
        if not self.yyb_base_url:
            print('  未配置 YYB_BASE_URL，无法登录')
            return 0
        code = self._get_wx_code(openid)
        if not code:
            print('  获取微信 code 失败')
            return 0
        ts = int(time.time() * 1000)
        try:
            r = requests.get(
                self.BASE_URL + '/v1/wechat/applet/authorizeV2',
                params={'_': ts, 'code': code},
                headers=self._headers(),
                timeout=15,
            )
            result = r.json()
        except Exception as e:
            print(f'  登录请求异常: {e}')
            return 0

        if result.get('code') != 0:
            print(f'  登录失败: {result.get("msg", "未知错误")}')
            return 0

        member_id = result.get('data', {}).get('memberId')
        if not member_id:
            print('  登录成功但 memberId 为空（账号未绑定手机？）')
            return 0
        return int(member_id)

    # ------------------------------------------------------------------ #
    #  缓存（格式: 备注#memberId）
    # ------------------------------------------------------------------ #
    def _read_cache(self) -> Dict:
        cache = {}
        try:
            if os.path.exists(self.CACHE_FILE):
                with open(self.CACHE_FILE, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and '#' in line:
                            name, mid = line.split('#', 1)
                            if mid.isdigit():
                                cache[name] = int(mid)
        except Exception as e:
            print(f'读取缓存失败: {e}')
        return cache

    def _write_cache(self, cache: Dict):
        try:
            with open(self.CACHE_FILE, 'w', encoding='utf-8') as f:
                for name, mid in cache.items():
                    f.write(f'{name}#{mid}\n')
            print(f'缓存已更新: {self.CACHE_FILE}')
        except Exception as e:
            print(f'写入缓存失败: {e}')

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
    def _load_accounts(self) -> List[Dict]:
        # 构建 openid -> nickname 映射
        yyb_account_map = {}
        yyb_raw = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_raw:
            yyb_account_map = {openid: nickname for nickname, openid in yyb_raw}

        mfd_env = os.getenv('MFD', '').strip()

        # 优先使用环境变量 MFD
        if mfd_env:
            return self._load_from_env(mfd_env, yyb_account_map)

        # 回退：从 YYB 协议取账号并逐个登录
        if yyb_raw:
            return self._load_from_yyb(yyb_raw)

        print('未找到有效账号来源（环境变量 MFD / YYB 协议均无数据）')
        return []

    def _load_from_env(self, mfd_env: str, yyb_account_map: dict) -> List[Dict]:
        original_cache = self._read_cache()
        cache = dict(original_cache)
        accounts = []

        lines = mfd_env.split('&') if '&' in mfd_env else mfd_env.split('\n')
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            parts = raw.split('#', 1)
            if len(parts) != 2:
                print(f'格式错误，跳过: {raw}')
                continue

            name, second = parts[0].strip(), parts[1].strip()

            # 纯数字视为 memberId
            if second.isdigit():
                print(f'账号 {name}: 直接使用 memberId {second}')
                accounts.append({'name': name, 'member_id': int(second)})
                continue

            # 否则视为 openid/wxid
            openid = second
            if name in cache:
                print(f'账号 {name}: 使用缓存 memberId {cache[name]}')
                accounts.append({'name': name, 'member_id': cache[name]})
                continue

            print(f'账号 {name}: 通过 wxid 登录')
            member_id = self._login_with_openid(openid)
            if not member_id:
                print('  登录失败，跳过')
                continue
            cache[name] = member_id
            accounts.append({'name': name, 'member_id': member_id})

        if cache != original_cache:
            self._write_cache(cache)

        return accounts

    def _load_from_yyb(self, yyb_raw: list) -> List[Dict]:
        """从 YYB 协议账号列表逐个登录获取 member_id"""
        return self._login_yyb_accounts(yyb_raw)

    def _login_yyb_accounts(self, yyb_accounts: list) -> List[Dict]:
        """对 YYB 账号逐个登录，有缓存的优先使用缓存"""
        original_cache = self._read_cache()
        cache = dict(original_cache)
        accounts = []

        for nickname, openid in yyb_accounts:
            member_id = 0
            name = nickname or openid

            # 用 openid 做缓存 key
            if openid in cache:
                member_id = cache[openid]
                print(f'账号 {name}: 使用缓存 memberId {member_id}')
            else:
                print(f'账号 {name}: 正在登录获取 memberId...')
                member_id = self._login_with_openid(openid)
                if member_id:
                    cache[openid] = member_id
                    print(f'  登录成功，memberId={member_id}')
                else:
                    print(f'  登录失败，跳过')
                    continue

            accounts.append({'name': name, 'member_id': member_id})

        if cache != original_cache:
            self._write_cache(cache)

        return accounts

    # ------------------------------------------------------------------ #
    #  业务接口
    # ------------------------------------------------------------------ #
    def _sign(self, member_id: int) -> bool:
        result = self._post('/v1/member/sign', member_id, {'memberId': member_id})
        code = result.get('code')
        if code in SUCCESS_FLAGS:
            print('  签到成功')
            return True
        else:
            msg = result.get('msg', '失败')
            print(f'  签到结果: {msg}')
            return False

    def _continuous_days(self, member_id: int) -> Dict:
        result = self._get(f'/v1/member/continuous-days/{member_id}', member_id)
        return result.get('data', {})

    # ------------------------------------------------------------------ #
    #  单账号执行
    # ------------------------------------------------------------------ #
    def _run_account(self, account: Dict) -> Dict:
        member_id = account['member_id']
        name = account['name']

        if not member_id:
            print(f'  memberId 无效，跳过')
            return {'label': name, 'lines': ['memberId 无效，跳过']}

        self._sign(member_id)

        info = self._continuous_days(member_id)
        days = info.get('continuousDays', '?')
        msg = f'连续签到 {days} 天'
        print(f'  {msg}')
        return {'label': name, 'lines': [msg]}

    # ------------------------------------------------------------------ #
    #  通知
    # ------------------------------------------------------------------ #
    def send_pushplus(self, title: str, content: str):
        if not self.push_token:
            return
        try:
            r = requests.post('http://www.pushplus.plus/send', json={
                'token': self.push_token,
                'title': title,
                'content': content,
                'template': 'html',
            }, timeout=10)
            code = r.json().get('code')
            print('PushPlus: ' + ('成功' if code == 200 else f'失败 {code}'))
        except Exception as e:
            print(f'PushPlus 异常: {e}')

    def send_feishu(self, title: str, content: str):
        if not self.fskey:
            return
        url = 'https://open.feishu.cn/open-apis/bot/v2/hook/' + self.fskey
        try:
            r = requests.post(url, json={
                'msg_type': 'text',
                'content': {'text': title + '\n' + content},
            }, timeout=10)
            code = r.json().get('code')
            print('飞书: ' + ('成功' if code == 0 else f'失败 {code}'))
        except Exception as e:
            print(f'飞书异常: {e}')

    # ------------------------------------------------------------------ #
    #  主流程
    # ------------------------------------------------------------------ #
    def run(self):
        print('=' * 40)
        print('麦富迪签到脚本')
        print('=' * 40)

        if not self.accounts:
            print('未找到有效账号')
            return

        print(f'共 {len(self.accounts)} 个账号\n')
        all_results = []

        for i, account in enumerate(self.accounts, 1):
            print(f'[{i}] 账号: {account["name"]}')
            result = self._run_account(account)
            all_results.append(result)
            print()

        title = '麦富迪签到通知'
        lines = [f'共 {len(all_results)} 个账号']
        html_parts = ['<h3>麦富迪签到完成</h3>']
        for r in all_results:
            lines.append(r['label'] + ':')
            lines += ['  ' + l for l in r['lines']]
            html_parts.append('<p><b>' + r['label'] + '</b><br>' +
                              '<br>'.join(r['lines']) + '</p>')
        self.send_pushplus(title, ''.join(html_parts))
        self.send_feishu(title, '\n'.join(lines))

        print('=' * 40)
        print('所有任务完成！')


if __name__ == '__main__':
    MaiFuDi().run()
