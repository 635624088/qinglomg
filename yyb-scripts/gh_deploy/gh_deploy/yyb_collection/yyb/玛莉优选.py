#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 玛莉优选 每日签到 - 完整版 v4.0
# 
# 环境变量:
#   YYB_BASE_URL: YYB 协议地址
#   PUSH_PLUS_TOKEN: (可选) PushPlus 通知 token
#   MARLI_DEBUG: 设为 1 开启调试

import os
import time
import random
import string
import json
from typing import Dict, List, Tuple, Optional

import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


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

# ========== 配置 ==========
APP_ID = 'wx9c084a5756ee1490'
KDT_ID = '97697061'

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/132.0.0.0 Safari/537.36 '
    'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
    'MiniProgramEnv/Windows WindowsWechat/WMPF '
    'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
)


def gen_uuid(length: int = 24) -> str:
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))


def log(msg, debug=False):
    if debug:
        print(f"  [调试] {msg}")


class MaliuCheckin:
    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token = os.getenv('PUSH_PLUS_TOKEN', '')
        self.debug = os.getenv('MARLI_DEBUG', '0').lower() in ('1', 'true', 'yes')
        self.accounts = self._parse_accounts()
    
    def _parse_accounts(self) -> List[Dict]:
        # 优先从 YYB 协议获取账号
        yyb_accounts = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
            return [{'name': nickname, 'wxid': wxid} for nickname, wxid in yyb_accounts]
        
        # 回退到环境变量
        raw = os.getenv('MARLI_YX', os.getenv('maliuxuanxuan', os.getenv('yzjx', '')))
        if not raw:
            print('未找到环境变量 MARLI_YX，且 YYB 协议无账号')
            return []
        accounts = []
        seen = set()
        for item in raw.replace('\n', '&').split('&'):
            item = item.strip()
            if not item:
                continue
            if '#' in item:
                name, wxid = item.split('#', 1)
            else:
                name, wxid = item, item
            wxid = wxid.strip()
            name = name.strip() or wxid
            if wxid and wxid not in seen:
                seen.add(wxid)
                accounts.append({'name': name, 'wxid': wxid})
        return accounts
    
    def _get_wx_code(self, wxid: str) -> str:
        """获取微信小程序 code"""
        url = f"{self.yyb_base_url}/wxapp/getCode"
        for attempt in range(3):
            try:
                resp = requests.post(
                    url,
                    json={'ref': wxid, 'app_id': APP_ID},
                    headers={'Content-Type': 'application/json', 'User-Agent': UA},
                    timeout=30,
                )
                result = resp.json()
                # 兼容 YYB 格式：code=0, data.result.code
                if isinstance(result, dict):
                    data = result.get('data') or {}
                    if isinstance(data, dict):
                        res = data.get('result')
                        if isinstance(res, dict):
                            code = res.get('code')
                            if code:
                                return str(code)
                    if result.get('Code') == 0:
                        return str(result.get('Data', {}).get('code', ''))
                    if result.get('code') == 200:
                        return str(result.get('data', {}).get('code', ''))
            except Exception as e:
                log(f"获取 code 失败: {e}", self.debug)
                if attempt < 2:
                    time.sleep(2)
        return ''
    
    def _get_youzan_token(self, code: str) -> Tuple[str, str, int, dict]:
        """获取有赞 token 和用户信息"""
        try:
            resp = requests.post(
                f'https://uic.youzan.com/passport/general/auth.json?kdt_id={KDT_ID}&app_id={APP_ID}',
                headers={'Content-Type': 'application/json', 'User-Agent': UA},
                json={
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
                            'path': 'pages/index/index',
                            'query': {},
                            'scene': 1000,
                            'referrerInfo': {},
                            'apiCategory': 'default',
                        },
                        'guideBizDataMap': {'from_params': ''},
                        'sceneData': {},
                    },
                },
                timeout=30,
            )
            result = resp.json()
            log(f"auth 响应: {json.dumps(result, ensure_ascii=False)[:500]}", self.debug)
            
            if result.get('code') == 0:
                data = result.get('data', {})
                return (
                    data.get('accessToken', ''),
                    data.get('sessionId', ''),
                    data.get('userId', 0),
                    data
                )
            return '', '', 0, {}
        except Exception as e:
            log(f"获取 token 异常: {e}", self.debug)
            return '', '', 0, {}
    
    def _check_mobile_auth(self, access_token: str, session_id: str, user_id: int) -> Tuple[bool, str]:
        """检查手机号是否已授权"""
        ftime = int(time.time() * 1000)
        extra_data = {
            "is_weapp": 1,
            "sid": session_id,
            "version": "3.166.6.101",
            "client": "weapp",
            "bizEnv": "retail",
            "uuid": gen_uuid(),
            "ftime": ftime
        }
        
        headers = {
            'User-Agent': UA,
            'xweb_xhr': '1',
            'content-type': 'application/json',
            'extra-data': json.dumps(extra_data, separators=(',', ':')),
            'referer': f'https://servicewechat.com/{APP_ID}/25/page-frame.html',
        }
        
        # 方式1: 从 auth 响应中判断
        # 注意：这里需要根据实际情况调整，可能需要调用其他接口
        
        # 简单返回 True，让签到接口自己判断
        return True, "待验证"
    
    def _get_checkin_id(self, access_token: str, session_id: str) -> Tuple[bool, str, Optional[int]]:
        """获取签到活动 ID"""
        ftime = int(time.time() * 1000)
        extra_data = {
            "is_weapp": 1,
            "sid": session_id,
            "version": "3.166.6.101",
            "client": "weapp",
            "bizEnv": "retail",
            "uuid": gen_uuid(),
            "ftime": ftime
        }
        
        headers = {
            'User-Agent': UA,
            'xweb_xhr': '1',
            'content-type': 'application/json',
            'extra-data': json.dumps(extra_data, separators=(',', ':')),
            'referer': f'https://servicewechat.com/{APP_ID}/25/page-frame.html',
        }
        
        params = {
            'app_id': APP_ID,
            'kdt_id': KDT_ID,
            'access_token': access_token,
        }
        
        try:
            resp = requests.get(
                'https://h5.youzan.com/wscump/checkin/check-in-info.json',
                params=params,
                headers=headers,
                timeout=15,
            )
            result = resp.json()
            log(f"check-in-info 响应: {json.dumps(result, ensure_ascii=False)}", self.debug)
            
            if result.get('code') == 0:
                checkin_id = result.get('data', {}).get('checkInId')
                if checkin_id:
                    return True, '获取成功', checkin_id
                return False, '未找到签到活动ID', None
            return False, result.get('msg', '获取失败'), None
        except Exception as e:
            return False, f'请求异常: {e}', None
    
    def _do_checkin(self, access_token: str, session_id: str, checkin_id: int) -> Tuple[bool, str]:
        """执行签到"""
        ftime = int(time.time() * 1000)
        extra_data = {
            "is_weapp": 1,
            "sid": session_id,
            "version": "3.166.6.101",
            "client": "weapp",
            "bizEnv": "retail",
            "uuid": gen_uuid(),
            "ftime": ftime
        }
        
        headers = {
            'User-Agent': UA,
            'xweb_xhr': '1',
            'content-type': 'application/json',
            'extra-data': json.dumps(extra_data, separators=(',', ':')),
            'referer': f'https://servicewechat.com/{APP_ID}/25/page-frame.html',
        }
        
        params = {
            'checkinId': checkin_id,
            'app_id': APP_ID,
            'kdt_id': KDT_ID,
            'access_token': access_token,
        }
        
        log(f"签到请求参数: {params}", self.debug)
        
        try:
            resp = requests.get(
                'https://h5.youzan.com/wscump/checkin/checkinV2.json',
                params=params,
                headers=headers,
                timeout=15,
            )
            result = resp.json()
            log(f"签到响应: {json.dumps(result, ensure_ascii=False)}", self.debug)
            
            code = result.get('code')
            
            # 签到成功
            if code == 0:
                data = result.get('data', {})
                if data.get('success'):
                    awards = data.get('awards', [])
                    if awards:
                        award = awards[0]
                        times = data.get('times', 0)
                        return True, f'✅ 签到成功！第 {times} 天，获得 {award.get("num", 0)}{award.get("desc", "")}'
                    return True, '✅ 签到成功！'
                if data.get('checked'):
                    return True, '📅 今日已签到'
                return False, '签到失败'
            
            # 手机号未授权
            if code == 1000030102:
                return False, '❌ 手机号未授权，请先在微信小程序中授权手机号'
            
            # 风控
            if code == 1000030068:
                return False, '⚠️ 活动火爆，请稍后再试'
            
            # 其他错误
            return False, f'❌ {result.get("msg", "签到失败")}'
            
        except Exception as e:
            return False, f'请求异常: {e}'
    
    def sign_one(self, account: Dict) -> Tuple[bool, str]:
        """单个账号完整签到流程"""
        wxid = account['wxid']
        name = account['name']
        
        if not self.yyb_base_url:
            return False, 'YYB_BASE_URL 未配置'
        
        # 步骤1: 获取 code
        print(f"  [{name}] 🔑 获取登录凭证...")
        code = self._get_wx_code(wxid)
        if not code:
            return False, '获取 code 失败'
        
        # 步骤2: 获取 token
        print(f"  [{name}] 🎫 获取访问令牌...")
        access_token, session_id, user_id, user_info = self._get_youzan_token(code)
        if not access_token:
            return False, '获取 access_token 失败'
        
        # 步骤3: 获取签到活动ID
        print(f"  [{name}] 📍 获取签到活动...")
        ok, msg, checkin_id = self._get_checkin_id(access_token, session_id)
        if not ok:
            return False, msg
        
        # 步骤4: 执行签到
        print(f"  [{name}] ✨ 执行签到...")
        ok, msg = self._do_checkin(access_token, session_id, checkin_id)
        return ok, msg
    
    def _push_plus(self, title: str, content: str):
        if not self.push_token:
            return
        try:
            resp = requests.post(
                'https://www.pushplus.plus/send',
                json={'token': self.push_token, 'title': title, 'content': content, 'template': 'html'},
                timeout=15,
            )
            if resp.json().get('code') == 200:
                print('📧 PushPlus 发送成功')
        except Exception as e:
            print(f'PushPlus 异常: {e}')
    
    def run(self):
        print("=" * 60)
        print("🍃 玛莉优选签到助手 v4.0")
        print("=" * 60)
        print(f"服务器: {self.yyb_base_url}")
        print(f"账号数: {len(self.accounts)}")
        print("-" * 60)
        
        if not self.accounts:
            print('❌ 未找到账号，请设置环境变量 MARLI_YX')
            return
        
        if not self.yyb_base_url:
            print('❌ YYB_BASE_URL 未配置')
            return
        
        results = []
        
        for i, acc in enumerate(self.accounts, 1):
            print(f"\n[{i}/{len(self.accounts)}] 👤 {acc['name']}")
            print(f"   wxid: {acc['wxid']}")
            
            ok, msg = self.sign_one(acc)
            status = '✅' if ok else '❌'
            print(f"   {status} {msg}")
            
            results.append({
                'name': acc['name'],
                'ok': ok,
                'msg': msg,
            })
            
            if i < len(self.accounts):
                delay = random.randint(3, 8)
                print(f"   ⏰ 等待 {delay} 秒...")
                time.sleep(delay)
        
        # 汇总
        print("\n" + "=" * 60)
        print("📊 执行汇总")
        print("=" * 60)
        
        success = sum(1 for r in results if r['ok'] and '今日已签到' not in r['msg'])
        already = sum(1 for r in results if '今日已签到' in r['msg'])
        failed = len(results) - success - already
        
        print(f"签到成功: {success}")
        print(f"今日已签: {already}")
        print(f"签到失败: {failed}")
        print("-" * 60)
        
        for r in results:
            icon = '✅' if r['ok'] else '❌'
            print(f"{icon} {r['name']}: {r['msg']}")
        
        # 推送
        if self.push_token and results:
            html = '<h3>🍃 玛莉优选签到</h3>'
            for r in results:
                color = 'green' if r['ok'] else 'red'
                html += f'<p><b>{r["name"]}</b>: <span style="color:{color}">{r["msg"]}</span></p>'
            self._push_plus('玛莉优选签到', html)
        
        print("\n✨ 执行完成！")


if __name__ == '__main__':
    MaliuCheckin().run()