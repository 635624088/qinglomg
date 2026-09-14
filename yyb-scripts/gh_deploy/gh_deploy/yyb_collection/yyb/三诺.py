#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三诺健康 iCan 小程序 - 每日签到脚本

环境变量:
  YYB_BASE_URL: YYB协议地址，默认 http://172.17.0.1:18080
  PUSH_PLUS_TOKEN: PushPlus 通知 token (可选)
  FSKEY: 飞书推送 key (可选)
"""

import os
import time
import requests
from typing import Dict, List, Optional

class Sinocare:
    APPID = 'wxe92e6f360119272a'
    BASE_URL = 'https://ican.sinocare.com/api'
    CLIENT_ID = 'miniapp-snjk'
    BASIC_AUTH = 'Basic bWluaWFwcC1zbmprOmFjNjc0NTljN2QzYjZlYjc1MjIzMDl1bWE3NjZyMDBh'
    UA = (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 '
        'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
        'MiniProgramEnv/Windows WindowsWechat/WMPF '
        'WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
    )

    def __init__(self):
        self.yyb_base_url = os.getenv('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
        self.push_token = os.getenv('PUSH_PLUS_TOKEN')
        self.fskey = os.getenv('FSKEY')
        self.session = requests.Session()
        self.accounts = self._load_accounts()

    # ------------------------------------------------------------------ #
    #  请求
    # ------------------------------------------------------------------ #
    def _headers(self, token: str = '') -> Dict:
        h = {
            'user-agent': self.UA,
            'xweb_xhr': '1',
            'content-type': 'application/json;charset=UTF-8',
            'accept': '*/*',
            'referer': f'https://servicewechat.com/{self.APPID}/255/page-frame.html',
            'accept-encoding': 'gzip, deflate',
            'accept-language': 'zh-CN,zh;q=0.9',
        }
        if token:
            h['sino-auth'] = token
        return h

    def _get(self, path: str, token: str, params: Dict = None) -> Dict:
        try:
            r = self.session.get(
                self.BASE_URL + path,
                params=params or {},
                headers=self._headers(token),
                timeout=15,
            )
            return r.json()
        except Exception as e:
            return {'code': -1, 'msg': str(e)}

    def _post(self, path: str, token: str, body: Dict, params: Dict = None) -> Dict:
        try:
            r = self.session.post(
                self.BASE_URL + path,
                params=params or {},
                headers=self._headers(token),
                json=body,
                timeout=15,
            )
            return r.json()
        except Exception as e:
            return {'code': -1, 'msg': str(e)}

    # ------------------------------------------------------------------ #
    #  WechatServer
    # ------------------------------------------------------------------ #
    def _get_wx_code(self, wxid: str) -> str:
        """从 YYB 协议获取微信 code"""
        url = self.yyb_base_url + '/wxapp/getCode'
        for retry in range(3):
            try:
                r = requests.post(
                    url,
                    json={'ref': wxid, 'app_id': self.APPID},
                    headers={'Content-Type': 'application/json;charset=utf-8'},
                    timeout=15,
                )
                r.raise_for_status()
                resp = r.json()
                # YYB 格式: {"code": 0, "data": {"result": {"code": "xxx"}}}
                if resp.get('code') == 0:
                    result = resp.get('data', {}).get('result') or {}
                    code = result.get('code') or result.get('Code')
                    if code:
                        return str(code)
                # 兼容其他格式
                code = (resp.get('Data') or resp.get('data') or {}).get('code')
                if code:
                    return str(code)
            except Exception:
                if retry < 2:
                    time.sleep(2)
        return ''

    # ------------------------------------------------------------------ #
    #  登录 wxid -> code -> union_id/open_id -> JWT token
    # ------------------------------------------------------------------ #
    def _login_with_wxid(self, wxid: str) -> str:
        if not self.yyb_base_url:
            print('  未配置 YYB_BASE_URL，无法使用 wxid 登录')
            return ''

        
        code = self._get_wx_code(wxid)
        if not code:
            print('  获取微信 code 失败')
            return ''

        
        resp = self._post(
            '/sino-public/wxma/decode2',
            token='',
            body={'code': code, 'clientId': self.CLIENT_ID},
        )
        if resp.get('code') != 200:
            print(f'  decode2 失败: {resp.get("msg")}')
            return ''
        wx_data = resp.get('data', {})
        union_id = wx_data.get('unionid', '')
        open_id = wx_data.get('openid', '')
        if not union_id or not open_id:
            print('  decode2 返回数据异常')
            return ''

        print('  获取 token...')
        try:
            r = self.session.post(
                self.BASE_URL + '/sino-auth/oauth/token',
                params={
                    'tenantId': '000000',
                    'grant_type': 'wechat',
                    'scope': 'all',
                    'type': 'account',
                    'union_id': union_id,
                    'open_id': open_id,
                },
                headers={
                    **self._headers(),
                    'authorization': self.BASIC_AUTH,
                    'sino-auth': self.BASIC_AUTH,
                    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                },
                data={},
                timeout=15,
            )
            token_resp = r.json()
        except Exception as e:
            print(f'  oauth/token 异常: {e}')
            return ''

        # oauth/token 直接返回 OAuth 对象，无 code 包装
        token = token_resp.get('access_token', '') or (token_resp.get('data') or {}).get('access_token', '')
        if not token:
            print('  登录成功但 token 为空')
            return ''
        return token

    # ------------------------------------------------------------------ #
    #  账号解析
    # ------------------------------------------------------------------ #
    @staticmethod
    def _fetch_accounts_from_yyb(yyb_base_url: str) -> List[Dict]:
        """从 YYB 协议获取账号列表"""
        try:
            resp = requests.get(f"{yyb_base_url}/accounts", timeout=10)
            data = resp.json()
            if data.get('code') == 0:
                accounts = []
                for item in data.get('data', []):
                    wxid = item.get('openid') or item.get('wxid') or ''
                    if wxid:
                        remark = item.get('nickname') or item.get('remark') or f"账号{len(accounts)+1}"
                        accounts.append({'name': remark, 'wxid': wxid})
                if accounts:
                    print(f"✅ 从 YYB 协议获取到 {len(accounts)} 个账号")
                    return accounts
        except Exception as e:
            print(f"❌ 从 YYB 获取账号失败: {e}")
        return []

    def _load_accounts(self) -> List[Dict]:
        # 优先从 YYB 获取账号
        yyb_accounts = self._fetch_accounts_from_yyb(self.yyb_base_url)
        if yyb_accounts:
            return yyb_accounts
        
        env = os.getenv('SINOCARE', '').strip()
        if not env:
            print('未找到环境变量 SINOCARE，且 YYB 未返回账号')
            return []

        accounts = []
        lines = env.split('&') if '&' in env else env.split('\n')
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            parts = raw.split('#', 1)
            if len(parts) != 2:
                print(f'格式错误，跳过: {raw}')
                continue
            name, value = parts[0].strip(), parts[1].strip()

            # 以 eyJ 开头视为 JWT token，直接使用
            if value.startswith('eyJ'):
                print(f'账号 {name}: 使用已有 token')
                accounts.append({'name': name, 'token': value})
                continue

            # 否则视为 wxid，通过 WechatServer 登录
            
            token = self._login_with_wxid(value)
            if not token:
                
                continue
            
            accounts.append({'name': name, 'token': token})

        return accounts

    # ------------------------------------------------------------------ #
    #  业务接口
    # ------------------------------------------------------------------ #
    def _sign_in(self, token: str) -> str:
        resp = self._get('/sino-member/signRecord/sign', token)
        if resp.get('code') == 200:
            pts = resp.get('data', '')
            msg = f'[签到] 成功 +{pts} 积分'
        else:
            msg = f'[签到] {resp.get("msg", "失败或已签到")} (code={resp.get("code")})'
        print(f'  {msg}')
        return msg

    def _complete_sign_task(self, token: str) -> str:
        resp = self._post('/sino-member/tasktemplate/mytask/signTask', token, {})
        code = resp.get('code')
        if code == 200:
            d = resp.get('data', {})
            name = d.get('name', '签到任务')
            status = d.get('taskStatus', 0)
            pts = d.get('integralNum', 0)
            max_pts = d.get('maxIntegralNum', 0)
            msg = f'[任务] {name}: {"已完成" if status else "进行中"} ({pts}/{max_pts} 积分)'
        else:
            msg = f'[任务] signTask 失败: {resp.get("msg")} (code={code})'
        print(f'  {msg}')
        return msg

    def _get_task_list(self, token: str) -> List[Dict]:
        resp = self._post('/sino-member/tasktemplate/mytask/list201215', token, {})
        if resp.get('code') == 200:
            return resp.get('data', [])
        return []

    # ------------------------------------------------------------------ #
    #  任务完成方法
    # ------------------------------------------------------------------ #
    def _record_blood_sugar(self, token: str) -> str:
        import datetime
        now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        resp = self._post('/sino-health/v1/detection-data/add', token, {
            'detectionWay': 1,
            'detectionTime': now,
            'remark': '',
            'messageContent': '',
            'image': '',
            'isSocial': 0,
            'detectionWayType': 0,
            'detectionWaySource': 0,
            'result': [{
                'value': '5.6',
                'unit': 'mmol/L',
                'indicator': 'glucose',
                'timeCode': '6',
                'timeCodeName': '睡前'
            }],
            'detectionChannel': '1',
            'detectionIndicatorId': '1',
            'isIgnoreRepeat': 1,
        })
        ok = resp.get('code') == 200
        msg = f'[记录血糖] {"成功" if ok else resp.get("msg", "失败")}'
        print(f'  {msg}')
        return msg

    def _record_diet(self, token: str) -> str:
        import datetime
        now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        resp = self._post('/sino-health/v1/diet-record/save-or-update', token, {
            'uploadType': '4',
            'platformType': 1,
            'dietTypeName': '晚餐',
            'dietTime': now,
            'dietType': 5,
            'image': '',
            'dataSource': 1,
            'remark': '',
            'isSocial': 0,
            'messageContent': '',
            'energyIntake': 0,
            'carbohydrate': 0,
            'fat': 0,
            'protein': 0,
            'detailReqList': [],
        })
        ok = resp.get('code') == 200
        msg = f'[记录饮食] {"成功" if ok else resp.get("msg", "失败")}'
        print(f'  {msg}')
        return msg

    def _browse_article(self, token: str) -> str:
        """获取文章列表并浏览第一篇，完成阅读任务"""
        list_resp = self._post('/sino-social/article_information/getRecommendTheArticleList', token,
                               {'current': 1, 'size': 4, 'messageType': 1})
        records = (list_resp.get('data') or {}).get('records', [])
        if not records:
            msg = '[浏览文章] 获取文章列表失败'
            print(f'  {msg}')
            return msg
        article_id = records[0].get('id', '')
        resp = self._get('/sino-social/article_information/detail', token,
                         params={'id': article_id})
        ok = resp.get('code') == 200
        msg = f'[浏览文章] {"成功" if ok else resp.get("msg", "失败")}'
        print(f'  {msg}')
        return msg

    def _share_article(self, token: str) -> str:
        """分享文章2次，完成分享任务"""
        list_resp = self._post('/sino-social/article_information/getRecommendTheArticleList', token,
                               {'current': 1, 'size': 4, 'messageType': 1})
        records = (list_resp.get('data') or {}).get('records', [])
        if not records:
            msg = '[分享文章] 获取文章列表失败'
            print(f'  {msg}')
            return msg
        results = []
        for article in records[:2]:
            article_id = article.get('id', '')
            resp = self._post('/sino-social/sharerecord/addForArticle', token,
                              {'messageContentId': article_id, 'shareType': 1})
            results.append('成功' if resp.get('code') == 200 else resp.get('msg', '失败'))
            time.sleep(1)
        msg = f'[分享文章] {", ".join(results)}'
        print(f'  {msg}')
        return msg

    def _get_integral(self, token: str) -> str:
        resp = self._post('/sino-member/integral/detail', token, {})
        d = resp.get('data') or {}
        now = d.get('nowIntegral', 0)
        total = d.get('sumIntegral', 0)
        msg = f'[积分] 当前 {now} / 累计 {total}'
        print(f'  {msg}')
        return msg

    def _do_tasks(self, token: str, tasks: List[Dict]) -> List[str]:
        """根据任务列表中未完成的任务执行对应操作"""
        lines = []
        task_map = {t.get('name', ''): t for t in tasks}

        def pending(name_fragment: str) -> bool:
            for name, t in task_map.items():
                if name_fragment in name and not t.get('taskStatus'):
                    return True
            return False

        if pending('血糖') or pending('指标'):
            lines.append(self._record_blood_sugar(token))
            time.sleep(1)

        if pending('饮食') or pending('记录饮食'):
            lines.append(self._record_diet(token))
            time.sleep(1)

        if pending('发现') or pending('文章') or pending('阅读'):
            lines.append(self._browse_article(token))
            time.sleep(1)

        if pending('分享'):
            lines.append(self._share_article(token))

        return lines

    # ------------------------------------------------------------------ #
    #  单账号执行
    # ------------------------------------------------------------------ #
    def _run_account(self, account: Dict) -> Dict:
        name = account['name']
        token = account.get('token', '')
        wxid = account.get('wxid', '')
        lines = []

        # 如果没有 token 但有 wxid，自动登录
        if not token and wxid:
            
            token = self._login_with_wxid(wxid)
            if not token:
                
                return {'label': name, 'lines': lines}
            

        if not token:
            lines.append(f'{name} ❌ 未配置 token 或 wxid')
            return {'label': name, 'lines': lines}

        lines.append(self._sign_in(token))
        lines.append(self._complete_sign_task(token))
        self._post('/sino-member/taskSignReport/save', token, {'type': 2})
        lines.append(self._get_integral(token))

        tasks = self._get_task_list(token)

        # 自动完成未完成的任务
        if tasks:
            lines.extend(self._do_tasks(token, tasks))

        # 重新获取任务列表，显示最新状态
        tasks = self._get_task_list(token)
        if tasks:
            print('  --- 今日任务 ---')
            for t in tasks:
                status = t.get('taskStatus', 0)
                t_name = t.get('name', '')
                pts = t.get('integralNum', 0)
                max_pts = t.get('maxIntegralNum', 0)
                flag = '✓' if status else '○'
                line = f'{flag} {t_name} ({pts}/{max_pts} 积分)'
                print(f'    {line}')
                lines.append(line)

        return {'label': name, 'lines': lines}

    # ------------------------------------------------------------------ #
    #  通知
    # ------------------------------------------------------------------ #
    def _send_pushplus(self, title: str, content: str):
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

    def _send_feishu(self, title: str, content: str):
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
            print(f'飞书推送异常: {e}')

    # ------------------------------------------------------------------ #
    #  主入口
    # ------------------------------------------------------------------ #
    def run(self):
        if not self.accounts:
            print('没有可用账号，退出')
            return

        all_results = []
        for account in self.accounts:
            print(f'\n>>> 账号: {account["name"]}')
            result = self._run_account(account)
            all_results.append(result)

        # 推送通知
        lines = []
        for r in all_results:
            lines.append(f'【{r["label"]}】')
            lines.extend(r['lines'])
        content = '\n'.join(lines)
        title = '三诺健康每日任务'
        self._send_pushplus(title, content.replace('\n', '<br>'))
        self._send_feishu(title, content)

def main():
    Sinocare().run()

if __name__ == '__main__':
    main()
