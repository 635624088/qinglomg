#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 奥利奥小程序 每日签到
# Author: a
# 环境变量:
#   YYB_BASE_URL:  YYB 协议地址 (用于获取 wx code)
#   PUSH_PLUS_TOKEN: *** 通知 token
#   FSKEY:         *** key

import os
import time
import base64
import json
import secrets
import requests
from datetime import datetime
from typing import Dict, List, Tuple
from Crypto.Cipher import AES

requests.packages.urllib3.disable_warnings()

# ------------------------------------------------------------------ #
#  YYB 协议账号获取
# ------------------------------------------------------------------ #
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

# AES key from decompiled mini-program
AES_KEY = base64.b64decode('i5s4D2/i5zWeYx1pNjwMDfBmXuUCuLfghAzcpt1j7h0=')

APP_ID = 'wx94b544638bc6bc0b'
BASE   = 'https://api-scrm2.emdlz.com.cn'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) XWEB/19027'
)

BASE_HEADERS = {
    'user-agent': UA,
    'xweb_xhr': '1',
    'content-type': 'application/json',
    'accept': '*/*',
    'referer': f'https://servicewechat.com/{APP_ID}/release/page-frame.html',
    'accept-language': 'zh-CN,zh;q=0.9',
}

DEFAULT_AVATAR = 'https://scrm2-prod.oss-accelerate.aliyuncs.com/assets/personal/moren_avatar.png'
DEFAULT_NICKNAME = '微信用户'
APP_SCENE_SIGN_NOTIFY = 'SIGN_NOTIFY'


class OreoSignIn:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token    = os.getenv('PUSH_PLUS_TOKEN', '')
        self.fskey         = os.getenv('FSKEY', '')
        self.accounts      = self._parse_accounts()

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
    @staticmethod
    def _normalize_env_value(raw: str) -> str:
        """Normalize env value."""
        if not raw:
            return ''

        text = raw.strip().replace('，', '&')

        # 支持直接粘贴: export oreo='a#b&c#d' # 注释
        if text.startswith('export '):
            text = text[len('export '):].strip()
            if '=' in text:
                _, text = text.split('=', 1)
                text = text.strip()

        # 先去掉行尾注释，再处理包裹引号，避免残留
        if ' #' in text:
            text = text.split(' #', 1)[0].strip()

        # 去掉成对引号
        if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
            text = text[1:-1].strip()

        # 兼容仅残留单侧引号
        text = text.strip("'\"").strip()

        return text

    def _parse_accounts(self) -> List[Dict]:
        # 优先从 YYB 协议获取账号
        yyb_accounts = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
            return [{'name': nickname, 'wxid': wxid} for nickname, wxid in yyb_accounts]
        
        raw = os.getenv('oreo', '') or os.getenv('OREO', '')
        raw = self._normalize_env_value(raw)
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
    #  YYB 协议 -> wx code
    # ------------------------------------------------------------------ #
    def _get_wx_code(self, wxid: str) -> str:
        url = self.yyb_base_url + '/wxapp/getCode'
        for i in range(3):
            try:
                r = requests.post(
                    url,
                    json={'ref': wxid, 'app_id': APP_ID},
                    headers={'Content-Type': 'application/json', 'User-Agent': UA},
                    timeout=60,
                )
                resp = r.json()
                # YYB 协议响应格式: code=0 成功，code 在 data.result.code
                if resp.get('code') == 0:
                    nested = resp.get('data', {}).get('result') or resp.get('data', {})
                    code = nested.get('code', '')
                    if code:
                        return code
                print(f'  获取 code 失败: {resp}')
                return ''
            except Exception as e:
                print(f'  YYB 协议请求失败({i+1}/3): {e}')
                if i < 2:
                    time.sleep(2)
        return ''

    # ------------------------------------------------------------------ #
    #  AES 加密
    # ------------------------------------------------------------------ #
    @staticmethod
    def _pkcs7_pad(data: bytes, block_size: int = 16) -> bytes:
        pad_len = block_size - (len(data) % block_size)
        return data + bytes([pad_len]) * pad_len

    @staticmethod
    def _pkcs7_unpad(data: bytes, block_size: int = 16) -> bytes:
        if not data:
            raise ValueError('empty data')
        pad_len = data[-1]
        if pad_len < 1 or pad_len > block_size:
            raise ValueError('invalid padding')
        if data[-pad_len:] != bytes([pad_len]) * pad_len:
            raise ValueError('invalid padding bytes')
        return data[:-pad_len]

    def _aes_encrypt(self, data: dict) -> str:
        raw = json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        iv = secrets.token_bytes(16)
        cipher = AES.new(AES_KEY, AES.MODE_CBC, iv)
        encrypted = cipher.encrypt(self._pkcs7_pad(raw))
        return base64.b64encode(iv + encrypted).decode('ascii')

    def _aes_decrypt_json(self, encrypted_text: str) -> Dict:
        raw = base64.b64decode(encrypted_text)
        iv = raw[:16]
        ciphertext = raw[16:]
        cipher = AES.new(AES_KEY, AES.MODE_CBC, iv)
        plain = cipher.decrypt(ciphertext)
        plain = self._pkcs7_unpad(plain)
        return json.loads(plain.decode('utf-8'))

    # ------------------------------------------------------------------ #
    #  wx code → Bearer token
    # ------------------------------------------------------------------ #
    def _get_token(self, code: str) -> str:
        payload = {
            'type': 1,
            'code': code,
            'nickName': DEFAULT_NICKNAME,
            'avatar': DEFAULT_AVATAR,
        }
        try:
            encrypted_data = self._aes_encrypt(payload)
            headers = {**BASE_HEADERS, 'content-type': 'text/plain'}
            r = requests.post(
                f'{BASE}/s-wechat/open/mnp/{APP_ID}/user-login',
                headers=headers,
                data=encrypted_data,
                timeout=30,
            )
            resp = r.json()
            if resp.get('code') == 200:
                data = resp.get('data')
                if isinstance(data, str):
                    data = self._aes_decrypt_json(data)
                if isinstance(data, dict):
                    return data.get('accessToken', '')
                print(f'  获取 token 失败: 返回 data 类型异常 {type(data)}')
                return ''
            print(f'  获取 token 失败: {resp}')
        except Exception as e:
            print(f'  获取 token 异常: {e}')
        return ''

    def _subscribe_sign_notify(self, headers: Dict) -> None:
        try:
            r = requests.post(
                f'{BASE}/s-mall/api/subscribe/subscribe',
                headers=headers,
                json={'appId': APP_ID, 'scene': [APP_SCENE_SIGN_NOTIFY]},
                timeout=15,
            )
            resp = r.json()
            if resp.get('code') == 200:
                print('  签到订阅登记成功')
            else:
                print(f'  签到订阅登记失败: {resp}')
        except Exception as e:
            print(f'  签到订阅登记异常: {e}')

    # ------------------------------------------------------------------ #
    #  签到 & 查询
    # ------------------------------------------------------------------ #
    def _check_status(self, headers: Dict) -> Tuple[bool, str]:
        month = datetime.now().strftime('%Y-%m')
        r = requests.get(
            f'{BASE}/s-marketing/api/member-sign/stats?month={month}',
            headers=headers, timeout=15,
        )
        resp = r.json()
        if resp.get('code') == 200:
            d = resp['data']
            return d['hasSignedInToday'], f'连续 {d["consecutiveDays"]} 天，累计 {d["totalDays"]} 天'
        return False, f'查询失败: {resp}'

    def _do_sign(self, headers: Dict) -> Tuple[bool, str]:
        r = requests.get(
            f'{BASE}/s-marketing/api/member-sign/sign',
            headers=headers, timeout=15,
        )
        resp = r.json()
        if resp.get('code') == 200:
            return True, f'签到成功，获得积分 {resp["data"]}'
        return False, f'签到失败: {resp}'

    def _claim_reward(self, headers: Dict):
        r = requests.post(
            f'{BASE}/s-marketing/api/task/reward',
            headers=headers, json={}, timeout=15,
        )
        resp = r.json()
        if resp.get('code') == 200:
            print('  任务奖励领取成功')
        else:
            print(f'  领取奖励失败: {resp}')

    def _get_tasks(self, headers: Dict) -> List[Dict]:
        r = requests.get(
            f'{BASE}/s-marketing/api/task/list',
            headers=headers, timeout=15,
        )
        resp = r.json()
        if resp.get('code') == 200:
            return resp.get('data') or []
        return []

    def _format_tasks(self, tasks: List[Dict]) -> str:
        lines = []
        for t in tasks:
            status = '已完成' if t.get('completed') else '未完成'
            lines.append(f'  [{status}] {t.get("name", "")}')
        return '\n'.join(lines)

    # ------------------------------------------------------------------ #
    #  单账号流程
    # ------------------------------------------------------------------ #
    def sign_in(self, account: Dict) -> Tuple[bool, str]:
        wxid = account['wxid']
        name = account['name']

        print(f'  [{name}] 获取 wx code...')
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 wx code 失败'
        print(f'  [{name}] code={code[:16]}...')

        print(f'  [{name}] 获取 access token...')
        token = self._get_token(code)
        if not token:
            return False, '获取 access token 失败'
        print(f'  [{name}] token=***')

        headers = {**BASE_HEADERS, 'Authorization': f'Bearer {token}'}
        self._subscribe_sign_notify(headers)

        signed, stat_msg = self._check_status(headers)
        if signed:
            tasks = self._get_tasks(headers)
            if any(t.get('completed') for t in tasks):
                self._claim_reward(headers)
                tasks = self._get_tasks(headers)
            msg = f'今日已签到 | {stat_msg}'
            if tasks:
                print(self._format_tasks(tasks))
            return True, msg

        ok, msg = self._do_sign(headers)
        if ok:
            self._claim_reward(headers)
            _, stat_msg = self._check_status(headers)
            msg += f' | {stat_msg}'
            tasks = self._get_tasks(headers)
            if tasks:
                print(self._format_tasks(tasks))
        return ok, msg

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
            print('未找到有效账号，请设置环境变量 oreo 或 YYB_BASE_URL')
            print('格式: 备注#wxid  (多账号用 & 或换行分隔)')
            return

        print(f'=== 奥利奥签到 {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} ===')
        print('作者: a')
        print(f'共 {len(self.accounts)} 个账号')

        results = []
        for i, acc in enumerate(self.accounts, 1):
            print(f'\n[{i}] {acc["name"]}')
            ok, msg = self.sign_in(acc)
            status = '✅' if ok else '❌'
            print(f'  {status} {msg}')
            results.append({'label': acc['name'], 'ok': ok, 'msg': msg, 'status': status})
            if i < len(self.accounts):
                time.sleep(15)

        title = '奥利奥签到通知'
        lines = [f'{r["status"]} {r["label"]}: {r["msg"]}' for r in results]
        summary = '\n'.join(lines)
        html = '<h3>奥利奥签到完成</h3>' + ''.join(
            f'<p><b>{r["label"]}</b>: {r["status"]} {r["msg"]}</p>' for r in results
        )
        self._push_plus(title, html)
        self._feishu(title, summary)
        print('\n所有任务完成！')


if __name__ == '__main__':
    OreoSignIn().run()
