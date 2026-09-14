#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 低碳惠生活每日任务脚本 (app.cdtanpuhui.cn)

import os, sys, json, time, requests, ssl
from typing import Tuple
from requests.adapters import HTTPAdapter

sys.stdout.reconfigure(encoding='utf-8')
requests.packages.urllib3.disable_warnings()

class _TLSAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.set_ciphers('ALL:@SECLEVEL=0')
        if hasattr(ssl, 'OP_IGNORE_UNEXPECTED_EOF'):
            ctx.options |= ssl.OP_IGNORE_UNEXPECTED_EOF
        kwargs['ssl_context'] = ctx
        super().init_poolmanager(*args, **kwargs)

_S = requests.Session()
_S.mount('https://', _TLSAdapter())

APP_ID   = 'wx64eee021ce09d87e'
BASE_URL = 'https://app.cdtanpuhui.cn'

MUSEUMS = [
    ('jinsha',         '1'),
    ('chuancai',       '2'),
    ('chengdu',        '3'),
    ('dufucaotang',    '4'),
    ('wuhouci',        '5'),
    ('wenshuSquare',   '7'),
    ('jinli',          '8'),
    ('alley',          '9'),
    ('shiyuanhui',     '10'),
    ('gxtiyuzhongxin', '11'),
    ('cdlibrary',      '12'),
    ('haibincheng',    '13'),
    ('daxiongmao',     '14'),
]

def _post(token: str, path: str, payload: dict = None) -> dict:
    headers = {
        'content-type':    'application/json;charset=UTF-8',
        'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B)',
        'xweb_xhr':        '1',
        'referer':         f'https://servicewechat.com/{APP_ID}/165/page-frame.html',
        'accept':          '*/*',
        'accept-language': 'zh-CN,zh;q=0.9',
    }
    if token:
        headers['x-authorization'] = f'Bearer {token}'
    try:
        r = _S.post(f'{BASE_URL}{path}', json=payload or {}, headers=headers, timeout=15, verify=False)
        return r.json()
    except Exception as e:
        return {'success': False, 'message': str(e)}

def fetch_accounts(server):
    try:
        r = _S.get(f'{server}/accounts', timeout=15, verify=False)
        data = r.json()
        accs = data.get('data', [])
        print(f'共获取到 {len(accs)} 个账号')
        for i, a in enumerate(accs, 1):
            print(f'   {i}. {a.get("nickname") or a.get("name", "未知")} (openid: {a.get("openid", "")})')
        return accs
    except Exception as e:
        print(f'获取账号失败: {e}')
        return []

def bridge_get_code(server, openid):
    try:
        r = _S.post(f'{server}/wxapp/getCode',
                    json={'app_id': APP_ID, 'ref': openid},
                    headers={'Content-Type': 'application/json'}, timeout=15, verify=False)
        result = r.json()
        if result.get('code') == 0:
            return result.get('data', {}).get('result', {}).get('code', '')
    except Exception as e:
        print(f'  bridge_get_code 异常: {e}')
    return ''

def _get_wx_code(server: str, wxid: str) -> str:
    # try bridge first
    code = bridge_get_code(server, wxid)
    if code:
        return code
    try:
        r = _S.post(f'{server}/api/v1/wx/app/get/code',
                    json={'wxid': wxid, 'appid': APP_ID},
                    timeout=30, verify=False)
        resp = r.json()
        if resp.get('Code') == 0:
            return resp.get('Data', {}).get('code', '')
        if resp.get('Success'):
            return resp.get('Data', {}).get('Code', '')
        if resp.get('code') == 200:
            return resp.get('data', {}).get('code', '')
        print(f'  获取code失败: {resp}')
        return ''
    except Exception as e:
        print(f'  获取code失败: {e}')
        return ''

def login(server: str, wxid: str) -> Tuple[str, str, dict]:
    code = _get_wx_code(server, wxid)
    if not code:
        return '', '', {}
    r = _post('', '/api/consumer/anon/auto/loginAndRegister', {
        'data': {'code': code, 'tag': 'SMALL_PROCED', 'sourcePage': 'home', 'source': 'SMALL_PROCED'}
    })
    if not r.get('success'):
        print(f'  登录失败: {r.get("message")}')
        return '', '', {}
    d = r['data']
    return d.get('token', ''), d.get('id', ''), d

def do_sign(token: str) -> str:
    r = _post(token, '/api/reRecords/sign', {})
    if r.get('success'):
        idx = r.get('data', {}).get('signAwardVo', {}).get('index', 0)
        return f'签到成功 (第{idx + 1}天)'
    return f'签到: {r.get("message", "失败")}'

def do_answer(token: str, cid: str) -> str:
    r = _post(token, '/api/answer/screenN2', {'consumerId': cid})
    if not r.get('success') or not r.get('data'):
        return f'答题获题失败: {r.get("message", "")}'
    d    = r['data']
    qid  = d.get('id', '')
    right = d.get('rightKey', '')
    if not qid:
        return '答题: 无题目'
    r2 = _post(token, '/api/answer/compareN2', {
        'data': {'answer': right, 'id': qid, 'consumerId': cid}
    })
    if r2.get('success'):
        correct = r2.get('data', {}).get('rightOrWrong', False)
        return f'答题: {"答对" if correct else "答错"} (答案:{right})'
    return f'答题提交失败: {r2.get("message", "")}'

def do_garbage(token: str) -> str:
    r = _post(token, '/api/garbage/index', {})
    if not r.get('success'):
        return f'垃圾分类获题失败: {r.get("message", "")}'
    d = r.get('data', {})
    if d.get('answered'):
        return '垃圾分类: 今日已答'
    questions = d.get('questions', [])
    if not questions:
        return '垃圾分类: 无题目'
    count = min(len(questions), 2)
    r2 = _post(token, '/api/garbage/submit', {'data': {'count': count}})
    if r2.get('success'):
        return f'垃圾分类: 提交{count}题成功'
    return f'垃圾分类提交失败: {r2.get("message", "")}'

def do_drug(token: str) -> str:
    r = _post(token, '/api/drug/index', {})
    if not r.get('success'):
        return f'药品答题失败: {r.get("message", "")}'
    d = r.get('data', {})
    if d.get('surplusPlayTime', 0) <= 0:
        return '药品答题: 今日已完成'
    questions = d.get('questions', [])
    if not questions:
        return '药品答题: 无题目'
    r2 = _post(token, '/api/drug/submit', {'data': {'questionIds': [questions[0].get('id')]}})
    if r2.get('success'):
        return f'药品答题: 成功 +{r2.get("data", {}).get("integral", 0)}积分'
    return f'药品答题提交失败: {r2.get("message", "")}'

def do_museums(token: str) -> str:
    results = []
    for code, mid in MUSEUMS:
        r = _post(token, '/api/museum/indexInfo', {'data': {'code': code}})
        if not r.get('success'):
            continue
        d      = r.get('data', {})
        cur    = d.get('currentAnswer', {})
        periods = cur.get('periods')
        q_type  = cur.get('questionType')
        if not periods or not q_type:
            continue
        _post(token, '/api/museum/exchangePlayTimes', {'data': {'code': str(q_type)}})
        r2 = _post(token, '/api/museum/submitAnswer', {
            'data': {'museumId': mid, 'periods': periods, 'questionIds': []}
        })
        if r2.get('success'):
            integral = r2.get('data', {}).get('integral', 0)
            if integral > 0:
                results.append(f'{code}+{integral}')
        time.sleep(0.5)
    return f'博物馆答题: {", ".join(results) if results else "已全部完成或无积分"}'

def do_widget(token: str) -> str:
    r = _post(token, '/api/widget/takeRegWidget', {})
    return '小组件: 领取成功' if r.get('success') else f'小组件: {r.get("message", "已领取")}'

def do_map_card(token: str) -> str:
    r = _post(token, '/api/card/takeMapCard', {})
    return '地图卡片: 领取成功' if r.get('success') else f'地图卡片: {r.get("message", "已领取")}'

def do_daily_gifts(token: str) -> str:
    task_gift = [(2, 2), (4, 6), (10, 1), (14, 7)]
    ok = []
    for tid, gid in task_gift:
        r = _post(token, '/api/dailytask/drawGift',
                  {'data': {'giftId': gid, 'taskId': tid, 'group': 'DAILY'}})
        if r.get('success'):
            ok.append(str(tid))
        time.sleep(0.3)
    return f'日常奖励: 已领任务[{",".join(ok)}]' if ok else '日常奖励: 已全部领取或任务未完成'

def push_plus(token: str, title: str, content: str):
    if not token:
        return
    try:
        _S.post('https://www.pushplus.plus/send',
                json={'token': token, 'title': title, 'content': content, 'template': 'html'},
                timeout=10)
    except Exception:
        pass

def feishu(key: str, title: str, content: str):
    if not key:
        return
    try:
        _S.post(f'https://open.feishu.cn/open-apis/bot/v2/hook/{key}',
                json={'msg_type': 'text', 'content': {'text': f'{title}\n{content}'}},
                timeout=10)
    except Exception:
        pass

def run_account(remark: str, wxid: str, server: str) -> str:
    print(f'\n【{remark}】登录中...')
    token, cid, info = login(server, wxid)
    if not token:
        return f'【{remark}】登录失败'

    integral = info.get('surplusIntegral', '?')
    lines = [f'【{remark}】积分:{integral}']
    steps = [
        ('签到',       lambda: do_sign(token)),
        ('小组件',     lambda: do_widget(token)),
        ('地图卡片',   lambda: do_map_card(token)),
        ('答题',       lambda: do_answer(token, cid)),
        ('垃圾分类',   lambda: do_garbage(token)),
        ('药品答题',   lambda: do_drug(token)),
        ('博物馆',     lambda: do_museums(token)),
        ('日常奖励',   lambda: do_daily_gifts(token)),
    ]
    for name, fn in steps:
        try:
            msg = fn()
            print(f'  {msg}')
            lines.append(msg)
        except Exception as e:
            msg = f'{name}异常: {e}'
            print(f'  {msg}')
            lines.append(msg)
        time.sleep(0.8)
    return '\n'.join(lines)

def main():
    raw          = os.environ.get('DITANHUI', '')
    server       = os.environ.get('YYB_BASE_URL', 'http://172.17.0.1:18080').rstrip('/')
    push_token   = os.environ.get('PUSH_PLUS_TOKEN', '')
    fskey        = os.environ.get('FSKEY', '')

    accounts = []
    if raw:
        for seg in raw.replace('&', '\n').splitlines():
            seg = seg.strip()
            if not seg:
                continue
            parts = seg.split('#', 1)
            if len(parts) == 2:
                accounts.append((parts[0].strip(), parts[1].strip()))
            else:
                accounts.append(('账号', seg.strip()))
        print(f'从环境变量加载 {len(accounts)} 个账号')
    else:
        bridge_accs = fetch_accounts(server)
        for a in bridge_accs:
            openid = a.get('openid', '').strip()
            name = a.get('nickname') or a.get('name', '') or openid[:8]
            if openid:
                accounts.append((name, openid))
        print(f'从 bridge 加载 {len(accounts)} 个账号')

    if not accounts:
        print('未找到有效账号')
        return

    all_lines = []
    for remark, wxid in accounts:
        result = run_account(remark, wxid, server)
        all_lines.append(result)

    summary = '\n\n'.join(all_lines)
    html    = ''.join(f'<p>{l}</p>' for l in summary.splitlines())
    print('\n' + summary)
    push_plus(push_token, '低碳惠生活签到通知', html)
    feishu(fskey, '低碳惠生活签到通知', summary)
    print('\n所有账号执行完毕！')

if __name__ == '__main__':
    main()