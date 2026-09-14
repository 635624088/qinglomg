#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# author: a
"""
快包旧衣服小程序 - 每日签到脚本（含自动提现）

环境变量:
  YYB_BASE_URL: YYB 协议地址，wxid 登录时必须配置
  PUSH_PLUS_TOKEN: PushPlus 通知 token
  FSKEY: 飞书推送 key
  ENABLE_AUTO_WITHDRAW: 是否自动提现，默认 true
  MIN_WITHDRAW_AMOUNT: 最低提现金额，默认 0.3
"""

import os
import requests
import time
from typing import Dict, List, Tuple
from decimal import Decimal, InvalidOperation, ROUND_DOWN

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

class KuaiBaoQianDao:
    APPID = 'wxbe2f25800165b6f8'
    CHANNEL_ID = '5658'
    BASE_URL = 'https://vues.dd1x.cn'
    CACHE_FILE = 'kby.txt'
    
    # API 端点
    ACCOUNT_DETAIL_URL = '/api/h/get_account_detailed'
    WITHDRAW_LIST_URL = '/api/h/get_withdrawal_trade_list'
    WITHDRAW_URL = '/api/h/withdrawal'

    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token = os.getenv('PUSH_PLUS_TOKEN')
        self.fskey = os.getenv('FSKEY')
        # 重命名变量避免与方法名冲突
        self.enable_auto_withdraw = os.getenv('ENABLE_AUTO_WITHDRAW', 'true').lower() == 'true'
        self.min_withdraw_amount = Decimal(os.getenv('MIN_WITHDRAW_AMOUNT', '0.3'))
        self.accounts = self._load_accounts()

    # ------------------------------------------------------------------ #
    #  通用请求头
    # ------------------------------------------------------------------ #
    def _headers(self, token: str = '') -> Dict:
        h = {
            'user-agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/132.0.0.0 Safari/537.36 '
                'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
                'MiniProgramEnv/Windows WindowsWechat/WMPF '
                'WindowsWechat(0x63090a13) '
                'UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            ),
            'xweb_xhr': '1',
            'content-type': 'application/json',
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9',
            'referer': 'https://servicewechat.com/' + self.APPID + '/24/page-frame.html',
        }
        if token:
            h['token'] = token
        return h

    # ------------------------------------------------------------------ #
    #  辅助方法
    # ------------------------------------------------------------------ #
    def _to_decimal(self, value, default="0") -> Decimal:
        """安全转换为 Decimal"""
        try:
            return Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError):
            return Decimal(default)

    # ------------------------------------------------------------------ #
    #  WechatServer 工具方法
    # ------------------------------------------------------------------ #
    def _wechat_post(self, endpoint: str, data: Dict, max_retries: int = 3) -> Dict:
        url = f"{self.yyb_base_url}{endpoint}"
        headers = {'Content-Type': 'application/json;charset=utf-8'}
        for retry in range(max_retries):
            try:
                resp = requests.post(url, json=data, headers=headers, timeout=60)
                resp.raise_for_status()
                return resp.json()
            except Exception:
                if retry < max_retries - 1:
                    time.sleep(2)
        return {}

    def _get_wx_code(self, wxid: str) -> str:
        resp = self._wechat_post('/wxapp/getCode', {'ref': wxid, 'app_id': self.APPID})
        if not resp:
            return ''
        # 兼容 YYB 格式：code=0, data.result.code
        if isinstance(resp, dict):
            data = resp.get('data') or {}
            if isinstance(data, dict):
                result = data.get('result')
                if isinstance(result, dict):
                    code = result.get('code')
                    if code:
                        return code
            if resp.get('Code') == 0:
                return resp.get('Data', {}).get('code', '')
            if resp.get('code') == 200:
                return resp.get('data', {}).get('code', '')
        return ''

    # ------------------------------------------------------------------ #
    #  登录
    # ------------------------------------------------------------------ #
    def _login_with_code(self, code: str) -> Dict:
        """用 wx_code 换取 token"""
        url = self.BASE_URL + '/api/kuaibao/login/wx_login'
        params = {'code': code, 'channelId': self.CHANNEL_ID}
        try:
            resp = requests.get(url, headers=self._headers(), params=params, timeout=10)
            result = resp.json()
            if result.get('code') == 0:
                data = result.get('data', {})
                return {
                    'token': data.get('token', ''),
                    'phone': data.get('tel', ''),
                    'mid': data.get('mid', ''),
                }
        except Exception as e:
            print('  登录请求异常: ' + str(e))
        return {}

    def _login_with_wxid(self, wxid: str) -> Dict:
        """wxid -> code -> token"""
        
        code = self._get_wx_code(wxid)
        if not code:
            
            return {}
        
        return self._login_with_code(code)

    def _verify_token(self, token: str) -> bool:
        """验证 token 是否仍有效"""
        url = self.BASE_URL + '/api/v2/get_sign_list'
        try:
            resp = requests.get(url, headers=self._headers(token), timeout=10)
            return resp.json().get('code') == 0
        except Exception:
            return False

    # ------------------------------------------------------------------ #
    #  缓存
    # ------------------------------------------------------------------ #
    def _read_cache(self) -> Dict:
        cache = {}
        try:
            if os.path.exists(self.CACHE_FILE):
                with open(self.CACHE_FILE, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and '#' in line:
                            parts = line.split('#', 3)
                            if len(parts) >= 2:
                                cache[parts[0]] = {
                                    'token': parts[1],
                                    'phone': parts[2] if len(parts) > 2 else '',
                                    'mid':   parts[3] if len(parts) > 3 else '',
                                }
        except Exception as e:
            print('读取缓存失败: ' + str(e))
        return cache

    def _write_cache(self, cache: Dict):
        try:
            with open(self.CACHE_FILE, 'w', encoding='utf-8') as f:
                for name, info in cache.items():
                    f.write('#'.join([
                        name,
                        info.get('token', ''),
                        info.get('phone', ''),
                        info.get('mid', ''),
                    ]) + '\n')
            print('缓存已更新: ' + self.CACHE_FILE)
        except Exception as e:
            print('写入缓存失败: ' + str(e))

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
    def _load_accounts(self) -> List[Dict]:
        # 优先从 YYB 协议获取账号
        yyb_accounts = fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
            accounts = []
            for nickname, wxid in yyb_accounts:
                accounts.append({'name': nickname, 'wxid': wxid, 'token': '', 'phone': '', 'mid': ''})
            return accounts
        
        # 回退到环境变量
        kby_env = os.getenv('KBY', '').strip()
        if not kby_env:
            print('未找到环境变量 KBY，且 YYB 协议无账号')
            return []

        original_cache = self._read_cache()
        cache = dict(original_cache)
        accounts = []

        lines = kby_env.split('&') if '&' in kby_env else kby_env.split('\n')
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            parts = raw.split('#', 1)
            if len(parts) != 2:
                print('格式错误，跳过: ' + raw)
                continue

            name, second = parts[0].strip(), parts[1].strip()

            if second.startswith('eyJ'):
                print('账号 ' + name + ': 直接使用 token')
                accounts.append({'name': name, 'token': second, 'phone': '', 'mid': ''})
                continue

            wxid = second
            if name in cache:
                print('账号 ' + name + ': 验证缓存 token...')
                if self._verify_token(cache[name]['token']):
                    print('  缓存有效')
                    accounts.append({'name': name, **cache[name]})
                    continue
                print('  缓存已过期，重新登录')

            print('账号 ' + name + ': 通过 wxid 登录')
            info = self._login_with_wxid(wxid)
            if not info.get('token'):
                print('  登录失败，跳过')
                continue
            info['name'] = name
            cache[name] = {'token': info['token'], 'phone': info.get('phone', ''), 'mid': info.get('mid', '')}
            accounts.append(info)

        if cache != original_cache:
            self._write_cache(cache)

        return accounts

    # ------------------------------------------------------------------ #
    #  签到
    # ------------------------------------------------------------------ #
    def sign_in(self, account: Dict) -> Tuple[bool, str]:
        url = self.BASE_URL + '/api/v2/sign_join'
        try:
            resp = requests.get(url, headers=self._headers(account['token']), timeout=10)
            result = resp.json()
            if result.get('code') == 0:
                data = result.get('data', {})
                name = data.get('name', '')
                msg = '签到成功'
                if name:
                    msg += '，获得奖励: ' + name
                return True, msg
            # 如果已经签过到
            if result.get('msg') == '今天已经签到过':
                return True, '今天已经签到过'
            return False, result.get('msg', '签到失败')
        except Exception as e:
            return False, '请求异常: ' + str(e)

    # ------------------------------------------------------------------ #
    #  提现相关功能（根据抓包数据修正）
    # ------------------------------------------------------------------ #
    def get_balance(self, token: str) -> Tuple[bool, str]:
        """查询账户余额 - 使用 total 字段"""
        url = self.BASE_URL + self.ACCOUNT_DETAIL_URL
        try:
            resp = requests.get(url, headers=self._headers(token), timeout=10)
            result = resp.json()
            
            if result.get('code') == 0:
                data = result.get('data', {})
                # 优先使用 total（可提现余额）
                balance = data.get('total')
                if balance is not None and balance != '':
                    return True, str(balance)
                # 备用：red_envelope
                balance = data.get('red_envelope')
                if balance is not None and balance != '':
                    return True, str(balance)
                # 最后：recovery_amount
                balance = data.get('recovery_amount')
                if balance is not None and balance != '':
                    return True, str(balance)
            
            return False, '0'
        except Exception as e:
            return False, f'查询失败: {str(e)}'

    def get_withdrawable_list(self, token: str) -> Tuple[bool, List[Dict], str]:
        """获取可提现账单列表"""
        url = self.BASE_URL + self.WITHDRAW_LIST_URL
        try:
            resp = requests.get(url, headers=self._headers(token), timeout=10)
            result = resp.json()
            
            # 注意：这个接口 code=0 表示成功
            if result.get('code') != 0:
                return False, [], result.get('msg', '获取提现列表失败')
            
            data = result.get('data', [])
            if not isinstance(data, list):
                data = []
            
            valid_items = []
            for item in data:
                if not isinstance(item, dict):
                    continue
                
                money = self._to_decimal(item.get('money'), '0')
                if money <= 0:
                    continue
                
                # 完整构造提现所需的参数（参照抓包数据）
                valid_items.append({
                    'title': item.get('title', '活动红包'),
                    'money': float(money),
                    'orderSn': item.get('orderSn'),
                    'logTime': item.get('logTime'),
                    'withdrawalType': item.get('withdrawalType', 3),
                    'tradeSnList': item.get('tradeSnList', []),
                    'whetherEvaluate': item.get('whetherEvaluate'),
                    'disabled': False,      # 抓包显示需要这些字段
                    'isShow': True
                })
            
            return True, valid_items, ''
        except Exception as e:
            return False, [], f'请求异常: {str(e)}'

    def do_withdraw(self, token: str, total_money: float, detail_list: List[Dict]) -> Tuple[bool, str]:
        """执行提现操作"""
        url = self.BASE_URL + self.WITHDRAW_URL
        payload = {
            'totalMoney': f"{total_money:.2f}",  # 字符串格式
            'type': 4,                            # 提现类型是 4
            'withdrawalDetailPojoList': detail_list
        }
        
        try:
            resp = requests.post(url, json=payload, headers=self._headers(token), timeout=15)
            result = resp.json()
            
            # 注意：这个接口 code=1 表示成功
            code = result.get('code')
            msg = result.get('msg', '')
            
            if code == 1:  # 成功是 1
                return True, msg or '提现申请提交成功'
            return False, msg or f'提现失败，code: {code}'
        except Exception as e:
            return False, f'请求异常: {str(e)}'

    def process_auto_withdraw(self, token: str, account_name: str = '') -> str:
        """
        自动提现主流程（重命名避免与变量冲突）
        返回提现结果描述
        """
        if not self.enable_auto_withdraw:
            return '自动提现已禁用'
        
        # 1. 查询余额
        ok, balance_str = self.get_balance(token)
        if not ok:
            return f'查询余额失败: {balance_str}'
        
        balance = self._to_decimal(balance_str, '0')
        if balance < self.min_withdraw_amount:
            return f'余额 {balance:.2f} < {self.min_withdraw_amount:.1f}，跳过自动提现'
        
        # 2. 获取可提现列表
        ok, items, err_msg = self.get_withdrawable_list(token)
        if not ok:
            return f'获取提现列表失败: {err_msg}'
        
        if not items:
            return '暂无可用提现账单'
        
        # 3. 计算总提现金额
        total_money = sum(item['money'] for item in items)
        if total_money < float(self.min_withdraw_amount):
            return f'可提现金额 {total_money:.2f} < {self.min_withdraw_amount:.1f}，跳过自动提现'
        
        # 4. 执行提现
        ok, result_msg = self.do_withdraw(token, total_money, items)
        if ok:
            return f'✅ 自动提现成功: 提现 {total_money:.2f} 元'
        else:
            return f'❌ 自动提现失败: {result_msg}'

    # ------------------------------------------------------------------ #
    #  通知
    # ------------------------------------------------------------------ #
    def send_pushplus(self, title: str, content: str):
        if not self.push_token:
            return
        try:
            resp = requests.post('http://www.pushplus.plus/send', json={
                'token': self.push_token,
                'title': title,
                'content': content,
                'template': 'html',
            }, timeout=10)
            result = resp.json()
            if result.get('code') == 200:
                print('PushPlus 通知发送成功')
            else:
                print('PushPlus 通知失败: ' + str(result.get('msg')))
        except Exception as e:
            print('PushPlus 异常: ' + str(e))

    def send_feishu(self, title: str, content: str):
        if not self.fskey:
            return
        url = 'https://open.feishu.cn/open-apis/bot/v2/hook/' + self.fskey
        try:
            resp = requests.post(url, json={
                'msg_type': 'text',
                'content': {'text': title + '\n' + content},
            }, timeout=10)
            result = resp.json()
            if result.get('code') == 0:
                print('飞书通知发送成功')
            else:
                print('飞书通知失败: ' + str(result.get('msg')))
        except Exception as e:
            print('飞书通知异常: ' + str(e))

    # ------------------------------------------------------------------ #
    #  主流程
    # ------------------------------------------------------------------ #
    def run(self):
        print('快包旧衣服小程序（含自动提现）')
        print('作者: a')
        print(f'自动提现: {"开启" if self.enable_auto_withdraw else "关闭"}')
        if self.enable_auto_withdraw:
            print(f'最低提现金额: {self.min_withdraw_amount} 元')
        print()
        
        if not self.accounts:
            print('未找到有效账号')
            return

        print('共 ' + str(len(self.accounts)) + ' 个账号\n')
        sign_results = []
        withdraw_results = []

        for i, account in enumerate(self.accounts, 1):
            label = account.get('phone') or account.get('name', '账号' + str(i))
            token = account.get('token', '')
            
            print('=' * 50)
            print('[' + str(i) + '] ' + label)
            print('-' * 30)
            
            # 签到
            print('【签到】')
            ok, msg = self.sign_in(account)
            sign_status = '✓' if ok else '✗'
            print(f'{sign_status} {msg}')
            sign_results.append({'label': label, 'ok': ok, 'msg': msg})
            
            # 查询余额
            print('\n【查询余额】')
            balance_ok, balance = self.get_balance(token)
            if balance_ok:
                print(f'当前余额: {balance} 元')
            else:
                print(f'查询余额失败: {balance}')
                balance = '0'
            
            # 自动提现
            print('\n【自动提现】')
            withdraw_msg = self.process_auto_withdraw(token, label)
            print(withdraw_msg)
            withdraw_results.append({'label': label, 'msg': withdraw_msg})
            
            print('=' * 50 + '\n')

        # 推送通知
        ok_cnt = sum(1 for r in sign_results if r['ok'])
        title = '快包旧衣服签到通知'
        
        lines = [f"共 {len(sign_results)} 个账号，签到成功 {ok_cnt} 个"]
        lines.append("")
        lines.append("【签到结果】")
        for r in sign_results:
            lines.append(f"{r['label']}: {r['msg']}")
        
        lines.append("")
        lines.append("【提现结果】")
        withdraw_success = []
        for r in withdraw_results:
            lines.append(f"{r['label']}: {r['msg']}")
            if '成功' in r['msg']:
                withdraw_success.append(r['label'])
        
        if withdraw_success:
            lines.insert(0, f"🎉 提现成功: {len(withdraw_success)} 个账号")
        
        content_text = '\n'.join(lines)
        
        content_html = '<h3>快包旧衣服签到完成</h3>'
        content_html += '<h4>签到结果</h4>'
        for r in sign_results:
            color = 'green' if r['ok'] else 'red'
            content_html += f'<p><b>{r["label"]}</b>: <span style="color:{color}">{r["msg"]}</span></p>'
        content_html += '<h4>提现结果</h4>'
        for r in withdraw_results:
            color = 'green' if '成功' in r['msg'] else 'gray'
            content_html += f'<p><b>{r["label"]}</b>: <span style="color:{color}">{r["msg"]}</span></p>'
        
        self.send_pushplus(title, content_html)
        self.send_feishu(title, content_text)

        print('所有任务完成！')

if __name__ == '__main__':
    KuaiBaoQianDao().run()