#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# author: a
"""
天机观小程序 - 每日任务脚本

环境变量:

  YYB_BASE_URL: YYB协议地址，默认 http://172.17.0.1:18080
  PUSH_PLUS_TOKEN: PushPlus 通知 token
  FSKEY: 飞书推送 key
"""

import os
import random
import requests
import time
from typing import Dict, List


class TianJiGuan:
    APPID = 'wx7829675630d0305e'
    BASE_URL = 'https://xcx.tianjiguan.cn/api'
    CACHE_FILE = 'tjg.txt'
    AD_DELAY = (15, 20)  # 看广告间隔秒数（随机范围）

    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token = os.getenv('PUSH_PLUS_TOKEN')
        self.fskey = os.getenv('FSKEY')
        self.accounts = self._load_accounts()

    # ------------------------------------------------------------------ #
    #  请求
    # ------------------------------------------------------------------ #
    def _headers(self, token: str = '') -> Dict:
        h = {
            'user-agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/132.0.0.0 Safari/537.36 MicroMessenger'
            ),
            'xweb_xhr': '1',
            'x-requested-with': 'XMLHttpRequest',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9',
            'referer': 'https://servicewechat.com/' + self.APPID + '/8/page-frame.html',
        }
        if token:
            h['x-access-token'] = token
        return h

    def _get(self, path: str, token: str, params: Dict = None) -> Dict:
        p = params or {}
        p['token'] = token
        try:
            r = requests.get(self.BASE_URL + path, params=p,
                             headers=self._headers(token), timeout=15)
            return r.json()
        except Exception as e:
            return {'code': -1, 'msg': str(e)}

    # ------------------------------------------------------------------ #
    #  WechatServer
    # ------------------------------------------------------------------ #
    def _yyb_post(self, endpoint: str, data: Dict) -> Dict:
        url = self.yyb_base_url + endpoint
        for retry in range(3):
            try:
                r = requests.post(url, json=data,
                                  headers={'Content-Type': 'application/json;charset=utf-8'},
                                  timeout=15)
                r.raise_for_status()
                return r.json()
            except Exception:
                if retry < 2:
                    time.sleep(2)
        return {}

    def _get_wx_code_yyb(self, wxid: str) -> str:
        resp = self._yyb_post('/wxapp/getCode',
                              {'ref': wxid, 'app_id': self.APPID})
        # YYB 格式: {"code": 0, "data": {"result": {"code": "xxx"}}}
        if resp.get('code') == 0:
            data = resp.get('data') or {}
            result = data.get('result') or {}
            code = result.get('code') or result.get('Code')
            if code:
                return str(code)
        # 兼容其他格式
        for getter in [lambda r: r.get('Data', {}).get('code'),
                       lambda r: r.get('data', {}).get('code')]:
            code = getter(resp)
            if code:
                return str(code)
        return ''

    # ------------------------------------------------------------------ #
    #  登录
    # ------------------------------------------------------------------ #
    def _login_with_code(self, code: str) -> Dict:
        """微信 code -> token"""
        url = 'https://xcx.tianjiguan.cn/api/user/autoLogin'
        try:
            r = requests.post(url, data={'code': code},
                              headers=self._headers(), timeout=15)
            result = r.json()
            if result.get('code') == 1:
                data = result.get('data', {})
                return {
                    'token': data.get('token', ''),
                    'nickname': data.get('nickname', ''),
                }
        except Exception as e:
            print('  登录请求异常: ' + str(e))
        return {}

    def _login_with_wxid(self, wxid: str) -> Dict:
        if not self.yyb_base_url:
            print('  未配置 YYB_BASE_URL，无法使用 wxid 登录')
            return {}
        
        code = self._get_wx_code_yyb(wxid)
        if not code:
            
            return {}
        
        return self._login_with_code(code)

    def _verify_token(self, token: str) -> bool:
        result = self._get('/user/userinfo', token)
        return result.get('code') == 1

    # ------------------------------------------------------------------ #
    #  缓存（格式: 备注#token#nickname）
    # ------------------------------------------------------------------ #
    def _read_cache(self) -> Dict:
        cache = {}
        try:
            if os.path.exists(self.CACHE_FILE):
                with open(self.CACHE_FILE, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and '#' in line:
                            parts = line.split('#', 2)
                            if len(parts) >= 2:
                                cache[parts[0]] = {
                                    'token': parts[1],
                                    'nickname': parts[2] if len(parts) > 2 else '',
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
                        info.get('nickname', ''),
                    ]) + '\n')
            print('缓存已更新: ' + self.CACHE_FILE)
        except Exception as e:
            print('写入缓存失败: ' + str(e))

    # ------------------------------------------------------------------ #
    #  YYB 账号获取
    # ------------------------------------------------------------------ #
    @staticmethod
    def _fetch_accounts_from_yyb(base_url: str) -> List[Dict]:
        """从 YYB 协议获取账号列表"""
        try:
            resp = requests.get(f"{base_url}/accounts", timeout=10)
            data = resp.json()
            if data.get('code') == 0:
                accounts = []
                for item in data.get('data', []):
                    wxid = item.get('openid') or item.get('wxid') or ''
                    if wxid:
                        accounts.append({
                            'name': item.get('nickname') or item.get('remark') or f'账号{len(accounts)+1}',
                            'wxid': wxid,
                            'nickname': item.get('nickname') or '',
                        })
                if accounts:
                    print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                    return accounts
        except Exception as e:
            print(f"❌ 从 YYB 获取账号失败: {e}")
        return []

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
    def _load_accounts(self) -> List[Dict]:
        tjg_env = os.getenv('TJG', '').strip()
        
        # 先尝试从 YYB 获取账号
        yyb_accounts = self._fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            return yyb_accounts
        
        # 回退到环境变量
        if not tjg_env:
            print('未找到环境变量 TJG，且 YYB 未返回账号')
            return []

        original_cache = self._read_cache()
        cache = dict(original_cache)
        accounts = []

        lines = tjg_env.split('&') if '&' in tjg_env else tjg_env.split('\n')
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            parts = raw.split('#', 1)
            if len(parts) != 2:
                print('格式错误，跳过: ' + raw)
                continue

            name, second = parts[0].strip(), parts[1].strip()

            # token 格式（UUID，含 -）
            if '-' in second and len(second) > 30:
                print('账号 ' + name + ': 直接使用 token')
                accounts.append({'name': name, 'token': second, 'nickname': ''})
                continue

            # 否则视为 wxid
            wxid = second
            if name in cache:
                print('账号 ' + name + ': 验证缓存 token...')
                if self._verify_token(cache[name]['token']):
                    print('  缓存有效')
                    accounts.append({'name': name, **cache[name]})
                    continue
                

            print('账号 ' + name + ': 通过 wxid 登录')
            info = self._login_with_wxid(wxid)
            if not info.get('token'):
                print('  登录失败，跳过')
                continue
            info['name'] = name
            cache[name] = {'token': info['token'], 'nickname': info.get('nickname', '')}
            accounts.append(info)

        if cache != original_cache:
            self._write_cache(cache)

        return accounts

    # ------------------------------------------------------------------ #
    #  业务接口
    # ------------------------------------------------------------------ #
    def _userinfo(self, token: str) -> Dict:
        result = self._get('/user/userinfo', token)
        if result.get('code') == 1:
            return result['data']
        return {}

    def _sign_in(self, token: str):
        result = self._get('/user/sign', token)
        if result.get('code') == 1:
            print('  [签到] 成功！')
            return True
        else:
            print('  [签到] ' + result.get('msg', '失败或已签到'))
            return False

    def _tasklist(self, token: str) -> List[Dict]:
        result = self._get('/user/tasklist', token)
        if result.get('code') == 1:
            return result.get('data', [])
        return []

    def _do_share(self, token: str, limit: int):
        done = 0
        retry = 0
        while done < limit:
            result = self._get('/user/share', token)
            if result.get('code') == 1:
                done += 1
                retry = 0
                print(f'  [分享] {done}/{limit}')
                if done < limit:
                    time.sleep(random.uniform(3, 6))
            else:
                retry += 1
                msg = result.get('msg', '')
                if retry >= 3:
                    print(f'  [分享] 连续失败3次({msg})，停止')
                    break
                time.sleep(10 * retry)
                print(f'  [分享] 失败({msg})，重试...')

    def _watch_ads(self, token: str, limit: int):
        earned = 0
        done = 0
        retry = 0
        while done < limit:
            result = self._get('/user/seeAd', token)
            if result.get('code') == 1:
                done += 1
                retry = 0
                print(f'  [广告] {done}/{limit} +30')
                earned += 30
                if done < limit:
                    time.sleep(random.uniform(*self.AD_DELAY))
            else:
                retry += 1
                msg = result.get('msg', '')
                if retry >= 3:
                    print(f'  [广告] 连续失败3次({msg})，停止')
                    break
                wait = 60 * retry
                print(f'  [广告] 失败({msg})，等待 {wait}s 后重试...')
                time.sleep(wait)
        print(f'  [广告] 共获得积分: {earned}')
        return earned

    # ------------------------------------------------------------------ #
    #  单账号执行
    # ------------------------------------------------------------------ #
    def _run_account(self, account: Dict) -> Dict:
        token = account.get('token', '')
        wxid = account.get('wxid', '')
        label = account.get('nickname') or account.get('name') or '未知账号'
        lines = []

        # 如果没有 token 但有 wxid，自动登录
        if not token and wxid:
            print(f'  账号 {label}: 未配置 token，尝试自动登录...')
            info = self._login_with_wxid(wxid)
            if info.get('token'):
                token = info['token']
                account['token'] = token
                if info.get('nickname'):
                    account['nickname'] = info['nickname']
                    label = info['nickname']
            else:
                lines.append('自动登录失败')
                return {'label': label, 'lines': lines}

        if not token:
            lines.append('Token 无效')
            return {'label': label, 'lines': lines}

        # 初始积分
        u = self._userinfo(token)
        if not u:
            lines.append('Token 无效')
            return {'label': label, 'lines': lines}
        score_before = u.get('score', 0)
        print(f'  用户: {u.get("nickname", label)}  积分: {score_before}')

        # 签到
        self._sign_in(token)

        # 任务列表
        tasks = self._tasklist(token)
        ad_limit = 50
        share_limit = 10
        for t in tasks:
            if t.get('task_type') == 'watch_adv':
                ad_limit = int(t.get('daily_limit', 50))
            elif t.get('task_type') == 'share_product':
                share_limit = int(t.get('daily_limit', 10))
            print(f'  任务: {t.get("task","?")}  limit={t.get("daily_limit")}  done={t.get("now")}')

        # 分享商品
        print(f'  [分享] 共 {share_limit} 次')
        self._do_share(token, share_limit)

        # 看广告
        print(f'  [广告] 共 {ad_limit} 次，间隔 {self.AD_DELAY}s')
        self._watch_ads(token, ad_limit)

        # 最终积分
        u2 = self._userinfo(token)
        score_after = u2.get('score', 0) if u2 else score_before
        gained = score_after - score_before
        lines.append(f'签到完成，积分 {score_before} → {score_after}（+{gained}）')
        print(f'  积分变化: {score_before} → {score_after}（+{gained}）')
        return {'label': label, 'lines': lines}

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
            print('PushPlus: ' + ('成功' if code == 200 else '失败 ' + str(code)))
        except Exception as e:
            print('PushPlus 异常: ' + str(e))

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
            print('飞书: ' + ('成功' if code == 0 else '失败 ' + str(code)))
        except Exception as e:
            print('飞书异常: ' + str(e))

    # ------------------------------------------------------------------ #
    #  主流程
    # ------------------------------------------------------------------ #
    def run(self):
        print('=' * 40)
        print('天机观小程序任务脚本')
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

        # 推送通知
        title = '天机观任务通知'
        lines = [f'共 {len(all_results)} 个账号']
        html_parts = ['<h3>天机观任务完成</h3>']
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
    TianJiGuan().run()
