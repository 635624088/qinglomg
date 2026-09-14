
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ============================================================
# 脚本名称: 元宝AI多账户打卡脚本
# 功能描述: 支持多账户自动登录打卡 + 元宝自动回收
# 作者: 柏油马路
# 版本: v5.0
# 日期: 2026-09-010
# 定时任务: cron: 0 8 * * *
#
# 环境变量:
#   LOGIN_ACCOUNTS    - 账号#密码&账号#密码
#   PAY_PASSWORD      - 账号#支付密码(可空，配置后自动回收)#VIP回收数量（可空）&账号#支付密码#VIP回收数量
#
# 项目地址 https://www.ybai168.com/#/pages/register/register?invite=HSG54
# ============================================================

import os
import json
import time
import random
import string
import hashlib
import requests
import urllib3
from datetime import datetime
from typing import Optional, Dict, List, Tuple

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# ==================== 配置区 ====================
BASE_URL = 'https://admin.yllwh.com'
ENV_ACCOUNTS = 'LOGIN_ACCOUNTS'
ENV_PAY_PASSWORD = 'PAY_PASSWORD'

DATA_DIR = os.getenv('DATA_DIR', os.getenv('QL_DATA_DIR', '/ql/data/'))
TOKEN_DIR = os.path.join(DATA_DIR, 'tokens')
CHECKIN_LOG_FILE = os.path.join(DATA_DIR, 'multi_checkin_log.json')

MAX_WAIT_TIME = 1800         # 最长等待时间（秒）
RETRY_DELAY = 3              # 初始重试间隔（秒，指数退避后逐步增大）
RETRY_MAX_DELAY = 10         # 最大重试间隔（秒）
RECYCLE_QTY = 1              # 普通回收数量（写死1个）
MAX_RECYCLE_CHECKS = 30      # 普通回收状态轮询次数
RECYCLE_START_HOUR = 18      # 普通回收开始小时
RECYCLE_START_MINUTE = 50    # 普通回收开始分钟

USER_AGENTS = [
    'Mozilla/5.0 (Linux; Android 15; 25053RT47C Build/AQ3A.250107.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36 (Immersed/40.615383) Html5Plus/1.0',
    'Mozilla/5.0 (Linux; Android 14; 23127PN0CG Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/132.0.6834.164 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Build/AP4A.250205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/134.0.6998.39 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S928B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.86 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Mi 13 Build/TKQ1.220829.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.99 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; V2324A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 15; OnePlus 13 Build/AP4A.250205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/134.0.6998.39 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; 2304FPN6DC Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/133.0.6943.121 Mobile Safari/537.36',
]
# ==============================================


class Logger:
    """统一日志输出，带 emoji 和缩进"""
    @staticmethod
    def banner(text):
        print(f'\n{"="*50}')
        print(f'📱 {text}')
        print(f'{"="*50}')

    @staticmethod
    def info(text):
        print(f'  ℹ️ {text}')

    @staticmethod
    def success(text):
        print(f'  ✅ {text}')

    @staticmethod
    def error(text):
        print(f'  ❌ {text}')

    @staticmethod
    def skip(text):
        print(f'  ⏭️ {text}')


def get_random_user_agent() -> str:
    return random.choice(USER_AGENTS)


def generate_device_id() -> str:
    """生成随机设备 ID"""
    return ''.join(random.choices(string.hexdigits.upper(), k=32))


def get_account_md5(account: str) -> str:
    return hashlib.md5(account.encode()).hexdigest()[:16]


def get_token_path(account: str) -> str:
    """获取 token 缓存路径"""
    os.makedirs(TOKEN_DIR, exist_ok=True)
    return os.path.join(TOKEN_DIR, f'{get_account_md5(account)}.json')


def build_headers(token: str = None, device_id: str = None, is_form: bool = True) -> Dict:
    """统一构建请求头（每次使用随机 UA 避免被识别）"""
    headers = {
        'User-Agent': get_random_user_agent(),
        'Host': 'admin.yllwh.com',
        'Connection': 'Keep-Alive',
        'Accept-Encoding': 'gzip',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Origin': 'https://admin.yllwh.com',
        'Referer': 'https://admin.yllwh.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Aibot-Client': 'app-plus',
        'X-Aibot-Capabilities': 'hot-update-v1',
    }
    if token:
        headers['token'] = token
    if is_form:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if device_id:
        headers['Device-Id'] = device_id
    return headers


def safe_request(method: str, url: str, **kwargs) -> Optional[Dict]:
    """安全的 HTTP 请求，异常统一返回 None 触发重试"""
    kwargs.setdefault('timeout', 30)
    kwargs.setdefault('verify', False)
    try:
        resp = requests.request(method, url, **kwargs)
        # 202=请求已进队列（异步处理），也是成功响应，必须返回 json 而不是 None
        if resp.status_code in (200, 201, 202):
            return resp.json()
        return None
    except Exception:
        return None


def retry_loop(action_name: str, action_fn, max_wait: int = MAX_WAIT_TIME, retry_delay: int = RETRY_DELAY) -> Tuple[bool, any]:
    """通用重试循环：指数退避，成功或超时才输出结果"""
    start = time.time()
    attempt = 0

    while True:
        result = action_fn()
        if result is not None:
            Logger.success(f'{action_name}成功')
            return True, result

        if time.time() - start > max_wait:
            Logger.error(f'{action_name}超时')
            return False, None

        # 指数退避：3s → 6s → 12s → 30s（封顶）
        delay = min(retry_delay * (2 ** attempt), RETRY_MAX_DELAY)
        attempt += 1
        time.sleep(delay)


# ==================== 核心 API ====================

def login(account: str, password: str) -> Optional[str]:
    """登录，返回 token"""
    Logger.info('登录中...')
    headers = build_headers(device_id=generate_device_id())
    data = {'account': account, 'password': password, 'turnstile_token': ''}

    result = safe_request('POST', f'{BASE_URL}/api/account/login', data=data, headers=headers)
    if result and result.get('code') == 1 and result.get('data'):
        Logger.success('登录成功')
        return result['data']['token']

    msg = result.get('msg', '登录失败') if result else '无响应'
    Logger.error(msg)
    return None


def do_checkin(token: str) -> Dict:
    """执行打卡"""
    headers = build_headers(token, is_form=False)
    result = safe_request('POST', f'{BASE_URL}/api/checkin/doCheckin', headers=headers)
    return result or {'code': -1, 'msg': '无响应'}


def get_recycle_ticket(token: str) -> Optional[str]:
    """获取回收凭证"""
    headers = build_headers(token, device_id=generate_device_id(), is_form=False)
    result = safe_request('GET', f'{BASE_URL}/api/yuanbao/bootstrap', headers=headers)
    if result and result.get('code') == 1:
        return result.get('data', {}).get('info', {}).get('recycle_ticket')
    return None


def recycle_submit(token: str, pay_password: str, recycle_ticket: str) -> Optional[Dict]:
    """提交普通回收请求
    返回: 成功=dict(request_id) / 业务失败=dict(code!=1,msg) / 网络错误=None
    """
    request_id = ''.join(random.choices(string.ascii_uppercase + string.digits, k=20))
    headers = build_headers(token, device_id=generate_device_id())
    data = {'qty': str(RECYCLE_QTY), 'pay_password': pay_password, 'recycle_ticket': recycle_ticket, 'request_id': request_id}

    result = safe_request('POST', f'{BASE_URL}/api/yuanbao/recycleSubmit', data=data, headers=headers)
    if result is None:
        return None  # 网络错误 -> 重试
    if result.get('code') == 1:
        return {'data': result.get('data', {}), 'request_id': request_id}
    # 业务失败(code!=1) -> 不重试，交给上层判断
    return {'code': result.get('code'), 'msg': result.get('msg', '回收失败'), 'request_id': request_id}


def recycle_check_status(token: str, request_id: str) -> Dict:
    """查询普通回收状态"""
    headers = build_headers(token, is_form=False)
    result = safe_request('GET', f'{BASE_URL}/api/yuanbao/recycleRequestStatus', params={'request_id': request_id}, headers=headers)
    return result or {'code': -1}


def vip_recycle_submit(token: str, pay_password: str, qty: int) -> Optional[Dict]:
    """VIP回收（同步，直接返回结果）
    返回: 成功=dict（code=1）/ 失败=dict（code!=1 带 msg）/ 网络错误=None
    """
    request_no = 'VIPMT' + ''.join(random.choices(string.ascii_uppercase + string.digits, k=15))
    headers = build_headers(token, device_id=generate_device_id())
    data = {'qty': str(qty), 'pay_password': pay_password, 'request_no': request_no}

    result = safe_request('POST', f'{BASE_URL}/api/yuanbao/vipRecycleSubmit', data=data, headers=headers)
    return result  # 有响应返回结果，网络错误返回 None


# ==================== 业务逻辑 ====================

def checkin_flow(token: str, account: str, results: List[Dict]) -> bool:
    """打卡流程 — 持续重试直到成功或超时"""
    Logger.info('打卡中...')

    def _try_checkin():
        result = do_checkin(token)
        if result is None:
            return None
        code = result.get('code', -1)
        if code == 1:
            data = result.get('data', {})
            return ('success', data.get('consecutive', 0), data.get('yuanbao', 0))
        if code == 0:
            return ('already', 0, 0)
        return None

    ok, outcome = retry_loop('打卡', _try_checkin)
    if not ok:
        results.append({'account': account, 'success': False, 'msg': '打卡超时', 'data': {}})
        return False

    tag, days, yuanbao = outcome
    if tag == 'success':
        Logger.success(f'打卡成功！连续 {days} 天，+{yuanbao} 元宝')
    else:
        Logger.info('今日已打卡')

    results.append({
        'account': account,
        'success': True,
        'msg': '打卡成功' if tag == 'success' else '今日已打卡',
        'data': {'consecutive': days, 'yuanbao': yuanbao}
    })
    return True


def recycle_flow(token: str, pay_password: str, account: str, results: List[Dict], vip_qty: int = 0) -> bool:
    """回收流程 — 普通回收（限时）+ VIP回收（不限时，按账号绑定）"""
    now = datetime.now()
    cutoff = now.replace(hour=RECYCLE_START_HOUR, minute=RECYCLE_START_MINUTE, second=0, microsecond=0)

    # 普通回收（18:50 后才执行）
    if now >= cutoff:
        normal_ok = _normal_recycle_flow(token, pay_password, account, results)
    else:
        Logger.skip(f'普通回收未到时间（{RECYCLE_START_HOUR}:{RECYCLE_START_MINUTE:02d} 后才可回收）')
        normal_ok = True

    # VIP回收（不限时，按账号绑定）
    if vip_qty > 0:
        _vip_recycle_flow(token, pay_password, account, results, vip_qty)

    return normal_ok


def _vip_recycle_flow(token: str, pay_password: str, account: str, results: List[Dict], qty: int) -> bool:
    """VIP回收流程 — 直接提交，无需凭证和轮询"""
    Logger.info(f'VIP回收中（数量: {qty}）...')

    ok, result = retry_loop('VIP回收', lambda: vip_recycle_submit(token, pay_password, qty))
    if not ok:
        results.append({'account': account, 'success': False, 'msg': 'VIP回收超时', 'data': {}})
        return False

    if result.get('code') == 1:
        data = result.get('data', {})
        total = data.get('total', 0)
        qty_done = data.get('qty', qty)
        Logger.success(f'VIP回收成功，{qty_done}个元宝，到账 {total} 元')
        results.append({'account': account, 'success': True, 'msg': f'VIP回收成功 {total} 元', 'data': data})
        return True
    else:
        msg = result.get('msg', 'VIP回收失败')
        Logger.info(f'VIP回收跳过: {msg}')
        results.append({'account': account, 'success': True, 'msg': f'VIP回收跳过: {msg}', 'data': {}})
        return True


def _normal_recycle_flow(token: str, pay_password: str, account: str, results: List[Dict]) -> bool:
    """普通回收流程 — 获取凭证 → 提交 → 轮询结果"""
    Logger.info('普通回收中...')

    # 1. 获取凭证
    ok, recycle_ticket = retry_loop('获取凭证', lambda: get_recycle_ticket(token))
    if not ok:
        results.append({'account': account, 'success': False, 'msg': '获取凭证超时', 'data': {}})
        return False

    # 2. 提交回收
    ok, submit_result = retry_loop('提交回收', lambda: recycle_submit(token, pay_password, recycle_ticket))
    if not ok:
        results.append({'account': account, 'success': False, 'msg': '提交回收超时', 'data': {}})
        return False

    # 业务失败判断：有 code 字段且不是 1 -> 接口正常返回但被拒，不重试直接报错
    if submit_result.get('code', 1) != 1:
        msg = submit_result.get('msg', '提交回收失败')
        Logger.error(f'提交回收失败: {msg}')
        results.append({'account': account, 'success': False, 'msg': msg, 'data': {}})
        return False
    request_id = submit_result.get('request_id', '')

    # 3. 轮询结果
    Logger.info('等待回收结果...')
    for _ in range(MAX_RECYCLE_CHECKS):
        time.sleep(2)
        status_result = recycle_check_status(token, request_id)
        if status_result.get('code') != 1:
            continue

        data = status_result.get('data', {})
        business_status = data.get('business_status', '')

        if business_status == 'done':
            total = data.get('total', 0)
            Logger.success(f'普通回收成功，到账 {total} 元')
            results.append({'account': account, 'success': True, 'msg': f'普通回收成功 {total} 元', 'data': data})
            return True

        status = data.get('status', '')
        if status in ['failed', 'cancelled']:
            msg = data.get('message', '回收失败')
            Logger.error(f'普通回收失败: {msg}')
            results.append({'account': account, 'success': False, 'msg': msg, 'data': data})
            return False

    Logger.error('回收结果查询超时')
    results.append({'account': account, 'success': False, 'msg': '查询超时', 'data': {}})
    return False


# ==================== 账户管理 ====================

def load_accounts() -> List[Dict]:
    """从环境变量加载账号列表"""
    raw = os.getenv(ENV_ACCOUNTS)
    if not raw:
        print(f'❌ 请设置环境变量 {ENV_ACCOUNTS}')
        print('📝 格式: 账号1#密码1&账号2#密码2')
        return []

    accounts = []
    for pair in raw.split('&'):
        pair = pair.strip()
        if not pair or '#' not in pair:
            continue
        acc, pwd = pair.split('#', 1)
        acc, pwd = acc.strip(), pwd.strip()
        if acc and pwd:
            accounts.append({'account': acc, 'password': pwd})

    if not accounts:
        print('❌ 未找到有效账户')
        return []

    print(f'✅ 成功加载 {len(accounts)} 个账户')
    for i, a in enumerate(accounts, 1):
        print(f'   {i}. {a["account"][:3]}****{a["account"][-4:]}')
    return accounts


def load_account_configs() -> Dict:
    """从 PAY_PASSWORD 加载支付密码和 VIP 回收数量（按账号绑定）
    格式: 账号#支付密码#vip数量&账号#支付密码
    """
    raw = os.getenv(ENV_PAY_PASSWORD, '')
    configs = {}
    if not raw:
        return configs

    for item in raw.split('&'):
        item = item.strip()
        if not item:
            continue
        parts = item.split('#')
        if len(parts) >= 2:
            acc = parts[0].strip()
            pwd = parts[1].strip()
            vip_qty = 0
            if len(parts) >= 3 and parts[2].strip():
                try:
                    vip_qty = int(parts[2].strip())
                except ValueError:
                    vip_qty = 0
            configs[acc] = {'pay_password': pwd, 'vip_qty': vip_qty}

    return configs


def load_cached_token(account: str) -> Optional[str]:
    """从本地缓存加载 token（未过期则复用）"""
    path = get_token_path(account)
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r') as f:
            data = json.load(f)
        if data.get('account') == account and data.get('expire_time', 0) - 3600 > time.time():
            return data.get('token')
    except Exception:
        pass
    return None


def save_token(account: str, token: str):
    """缓存 token 到本地"""
    path = get_token_path(account)
    with open(path, 'w') as f:
        json.dump({
            'account': account,
            'token': token,
            'expire_time': int(time.time()) + 2592000,
        }, f, ensure_ascii=False, indent=2)
    Logger.info('Token 已缓存')


# ==================== 通知 ====================

def send_notification(results: List[Dict]):
    """发送青龙通知"""
    total = len(results)
    success = sum(1 for r in results if r['success'])
    failed = total - success

    now_str = datetime.now().strftime('%Y-%m-%d %H:%M')
    content = [f'📊 {now_str}  打卡完成']
    content.append(f'总账户: {total}  ✅成功: {success}  ❌失败: {failed}')
    content.append('')
    for i, r in enumerate(results, 1):
        icon = '✅' if r['success'] else '❌'
        acc = f'{r["account"][:3]}****{r["account"][-4:]}'
        yuanbao = f' (+{r["data"].get("yuanbao", 0)}元宝)' if r['success'] and r['data'].get('yuanbao') else ''
        content.append(f'  {i}. {icon} {acc}{yuanbao} - {r["msg"]}')

    output = '\n'.join(content)
    print(f'\n📢 通知内容:\n{output}')

    try:
        import notify
        sender = getattr(notify, 'send', None) or getattr(notify, 'sendNotify', None)
        if not callable(sender):
            raise AttributeError('notify 模块未提供 send 或 sendNotify 接口')
        sender('元宝AI打卡', output)
    except Exception as exc:
        print(f'  ⚠️ 通知发送失败（不影响打卡结果）: {exc}')


# ==================== 主流程 ====================

def process_account(account: str, password: str, results: List[Dict], account_configs: Dict) -> bool:
    """处理单个账号：登录 → 打卡 → 回收"""
    Logger.banner(f'{account[:3]}****{account[-4:]}')

    token = load_cached_token(account)
    if token:
        Logger.info('Token 有效，直接使用')
    else:
        token = login(account, password)
        if not token:
            results.append({'account': account, 'success': False, 'msg': '登录失败', 'data': {}})
            return False
        save_token(account, token)

    # 打卡
    if not checkin_flow(token, account, results):
        return False

    # 回收（可选）
    config = account_configs.get(account, {})
    pay_password = config.get('pay_password', '')
    if pay_password:
        recycle_flow(token, pay_password, account, results, config.get('vip_qty', 0))
    else:
        Logger.skip('未配置 PAY_PASSWORD，跳过回收')

    return True


def save_summary_log(results: List[Dict]):
    """保存打卡日志"""
    os.makedirs(DATA_DIR, exist_ok=True)
    logs = []
    if os.path.exists(CHECKIN_LOG_FILE):
        try:
            with open(CHECKIN_LOG_FILE, 'r') as f:
                logs = json.load(f)
        except Exception:
            pass

    logs.append({
        'date': datetime.now().isoformat(),
        'total': len(results),
        'success': sum(1 for r in results if r['success']),
        'failed': sum(1 for r in results if not r['success']),
        'details': results
    })

    with open(CHECKIN_LOG_FILE, 'w') as f:
        json.dump(logs[-30:], f, ensure_ascii=False, indent=2)
    Logger.info('日志已保存')


def main():
    print('=' * 60)
    print('  元宝AI 多账户打卡脚本 v5.0')
    print('  作者: 柏油马路')
    print('  功能: 自动打卡 + 元宝回收')
    print(f'  时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print('=' * 60)

    accounts = load_accounts()
    if not accounts:
        return

    account_configs = load_account_configs()

    print(f'\n🔄 开始处理 {len(accounts)} 个账户...')
    results = []

    for acc in accounts:
        try:
            process_account(acc['account'], acc['password'], results, account_configs)
        except Exception as e:
            Logger.error(f'异常: {e}')
            results.append({'account': acc['account'], 'success': False, 'msg': f'异常: {e}', 'data': {}})

    save_summary_log(results)
    send_notification(results)

    success = sum(1 for r in results if r['success'])
    total = len(results)
    print(f'\n{"="*60}')
    print(f'📊 完成: ✅ {success} 成功, ❌ {total - success} 失败')
    print('=' * 60)


if __name__ == '__main__':
    main()
