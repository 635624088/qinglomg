#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
认养一头牛小程序Token获取工具
作者：wenrouhao
版本：1.0.0
创建日期：2026-01-24
"""

import os
import sys
import time
import logging
import argparse
import hashlib
import uuid
import warnings
from typing import Dict, List, Optional, Any
import requests

# 禁用SSL证书验证警告
warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# 默认的小程序APPID，根据需要修改
DEFAULT_APPID = "wxb1b491182dee21a8"

# 认养一头牛应用相关配置
RENYANG_API_HOST = "mall-mobile-v6.vecrp.com"
RENYANG_API_BASE = f"https://{RENYANG_API_HOST}"
RENYANG_WXAPP_LOGIN = f"{RENYANG_API_BASE}/mobile/wxAppLogin"
RENYANG_GET_SHOP_CUSTOMER = f"{RENYANG_API_BASE}/mobile/getShopCustomer"

# 通知开关，1=启用通知，0=不启用通知，默认为0
ENABLE_NOTIFY = 0

# 通知收集的消息
notify_messages = []

# 设置全局变量用于控制日志输出
PRINT_ONLY_TOKEN = True

# 青龙API配置 - 可直接修改以下变量
QL_HOST = os.environ.get('WRH_QL_HOST', "http://192.168.22.214:5703")  # 青龙面板地址，格式为http://IP:PORT
QL_CLIENT_ID = os.environ.get('WRH_QL_CLIENT_ID', "Ho8y6s6w_i7j")  # 青龙API的client_id
QL_CLIENT_SECRET = os.environ.get('WRH_QL_CLIENT_SECRET', "7kFWIa8FHXyO-LzEtfXlpEV6")  # 青龙API的client_secret
RY_YTN_VAR_NAME = os.environ.get('RY_YTN_VAR_NAME', 'ryytn')  # 要更新的环境变量名称





def send_notify(title: str, content: str) -> bool:
    # 如果通知功能关闭，直接返回
    if not ENABLE_NOTIFY:
        return False
        
    try:
        # 获取通知URL
        notify_url = os.environ.get('NOTIFY_URL', '')
        if not notify_url:
            return False
            
        # 发送通知
        headers = {'Content-Type': 'application/json'}
        data = {
            'title': title,
            'content': content,
            'timestamp': int(time.time())
        }
        
        response = requests.post(notify_url, json=data, headers=headers, timeout=10)
        
        # 检查响应
        if response.status_code == 200:
            return True
        else:
            return False
    except Exception as e:
        return False


def get_ql_token() -> Optional[str]:
    """获取青龙API的token
    
    Returns:
        青龙API的token，如果获取失败返回None
    """
    if not QL_HOST or not QL_CLIENT_ID or not QL_CLIENT_SECRET:
        print('❌ 青龙API配置不完整，请设置QL_HOST、QL_CLIENT_ID和QL_CLIENT_SECRET环境变量')
        return None
    
    try:
        print('🔑 正在获取青龙API Token...')
        url = f"{QL_HOST}/open/auth/token"
        params = {
            'client_id': QL_CLIENT_ID,
            'client_secret': QL_CLIENT_SECRET
        }
        
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        if result.get('code') == 200:
            token = result.get('data', {}).get('token')
            if token:
                print('✅ 成功获取青龙API Token')
                return token
            else:
                print('❌ 获取青龙API Token失败：响应中没有token')
                return None
        else:
            print(f"❌ 获取青龙API Token失败：{result.get('message', '未知错误')}")
            return None
    except Exception as e:
        print(f"❌ 获取青龙API Token过程出错：{str(e)}")
        return None


def get_ql_env(ql_token: str, search_value: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
    """获取青龙环境变量列表
    
    Args:
        ql_token: 青龙API的token
        search_value: 搜索关键词
        
    Returns:
        环境变量列表，如果获取失败返回None
    """
    try:
        print('🔍 正在获取青龙环境变量列表...')
        url = f"{QL_HOST}/open/envs"
        headers = {
            'Authorization': f'Bearer {ql_token}',
            'Accept': 'application/json'
        }
        
        params = {}
        if search_value:
            params['searchValue'] = search_value
        
        response = requests.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        if result.get('code') == 200:
            envs = result.get('data', [])
            print(f"✅ 成功获取青龙环境变量列表，共 {len(envs)} 个变量")
            return envs
        else:
            print(f"❌ 获取青龙环境变量列表失败：{result.get('message', '未知错误')}")
            return None
    except Exception as e:
        print(f"❌ 获取青龙环境变量列表过程出错：{str(e)}")
        return None


def update_ql_env(ql_token: str, env_id: int, name: str, value: str, remarks: Optional[str] = None) -> bool:
    """更新青龙环境变量
    
    Args:
        ql_token: 青龙API的token
        env_id: 环境变量ID
        name: 变量名
        value: 变量值
        remarks: 备注
        
    Returns:
        更新成功返回True，失败返回False
    """
    try:
        print(f'📝 正在更新青龙环境变量：{name}')
        url = f"{QL_HOST}/open/envs"
        headers = {
            'Authorization': f'Bearer {ql_token}',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
        
        data = {
            'id': env_id,
            'name': name,
            'value': value
        }
        
        if remarks:
            data['remarks'] = remarks
        
        response = requests.put(url, headers=headers, json=data, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        if result.get('code') == 200:
            print(f"✅ 成功更新青龙环境变量：{name}")
            return True
        else:
            print(f"❌ 更新青龙环境变量失败：{result.get('message', '未知错误')}")
            return False
    except Exception as e:
        print(f"❌ 更新青龙环境变量过程出错：{str(e)}")
        return False


def create_ql_env(ql_token: str, name: str, value: str, remarks: Optional[str] = None) -> bool:
    """创建青龙环境变量
    
    Args:
        ql_token: 青龙API的token
        name: 变量名
        value: 变量值
        remarks: 备注
        
    Returns:
        创建成功返回True，失败返回False
    """
    try:
        print(f'➕ 正在创建青龙环境变量：{name}')
        url = f"{QL_HOST}/open/envs"
        headers = {
            'Authorization': f'Bearer {ql_token}',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
        
        data = [{
            'name': name,
            'value': value
        }]
        
        if remarks:
            data[0]['remarks'] = remarks
        
        response = requests.post(url, headers=headers, json=data, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        if result.get('code') == 200:
            print(f"✅ 成功创建青龙环境变量：{name}")
            return True
        else:
            print(f"❌ 创建青龙环境变量失败：{result.get('message', '未知错误')}")
            return False
    except Exception as e:
        print(f"❌ 创建青龙环境变量过程出错：{str(e)}")
        return False


# 定义HTTP客户端接口，便于依赖注入和单元测试
class HttpClient:
    def post(self, url: str, json: Dict[str, Any] = None, headers: Dict[str, str] = None, 
            timeout: int = 30) -> Dict[str, Any]:
        try:
            # 发送POST请求（禁用SSL证书验证，解决证书验证失败问题）
            response = requests.post(url, json=json, headers=headers, timeout=timeout, verify=False)
            
            # 尝试解析响应内容
            try:
                response_text = response.text
                if response_text.strip():
                    response_json = response.json()
                else:
                    response_json = {}
            except Exception as json_error:
                response_json = {}
            
            # 检查HTTP状态码
            if response.status_code >= 400:
                print(f"❌ 请求失败: {response.status_code} - {response.reason}")
                print(f"   错误详情: {response_text[:300]}...")
                
                # 不抛出异常，而是返回错误信息
                return {
                    "Success": False,
                    "Message": f"HTTP {response.status_code}: {response.reason}",
                    "Data": response_json if response_json else response_text,
                    "StatusCode": response.status_code
                }
            
            # 成功响应
            if response_json:
                return response_json
            else:
                return {
                    "Success": True,
                    "Data": response_text,
                    "Message": "响应内容为空或非JSON格式"
                }
                
        except requests.exceptions.RequestException as e:
            print(f"❌ 网络请求异常: {str(e)}")
            return {
                "Success": False,
                "Message": f"网络请求异常: {str(e)}",
                "Data": None
            }
        except Exception as e:
            print(f"❌ 未知异常: {str(e)}")
            return {
                "Success": False,
                "Message": f"未知异常: {str(e)}",
                "Data": None
            }
    
    def get(self, url: str, headers: Dict[str, str] = None, 
            timeout: int = 30) -> Dict[str, Any]:
        try:
            # 发送GET请求（禁用SSL证书验证，解决证书验证失败问题）
            response = requests.get(url, headers=headers, timeout=timeout, verify=False)
            
            # 尝试解析响应内容
            try:
                response_text = response.text
                if response_text.strip():
                    response_json = response.json()
                else:
                    response_json = {}
            except Exception as json_error:
                response_json = {}
            
            # 检查HTTP状态码
            if response.status_code >= 400:
                print(f"❌ 请求失败: {response.status_code} - {response.reason}")
                print(f"   错误详情: {response_text[:300]}...")
                
                # 不抛出异常，而是返回错误信息
                return {
                    "Success": False,
                    "Message": f"HTTP {response.status_code}: {response.reason}",
                    "Data": response_json if response_json else response_text,
                    "StatusCode": response.status_code
                }
            
            # 成功响应
            if response_json:
                return response_json
            else:
                return {
                    "Success": True,
                    "Data": response_text,
                    "Message": "响应内容为空或非JSON格式"
                }
                
        except requests.exceptions.RequestException as e:
            print(f"❌ 网络请求异常: {str(e)}")
            return {
                "Success": False,
                "Message": f"网络请求异常: {str(e)}",
                "Data": None
            }
        except Exception as e:
            print(f"❌ 未知异常: {str(e)}")
            return {
                "Success": False,
                "Message": f"未知异常: {str(e)}",
                "Data": None
            }


class RenyangClient:
    """认养一头牛微信小程序客户端"""
    
    def __init__(self, server: str, wxid: str, appid: Optional[str] = None, 
                 log_level: int = logging.INFO, http_client: Optional[HttpClient] = None):
        # 基本配置
        self.server = server  # 神秘协议地址
        self.wxid = wxid
        self.appid = appid if appid else DEFAULT_APPID  # 使用传入的APPID或默认值
        
        # 设置日志
        self.setup_logger(log_level)
        
        # 设置HTTP客户端
        self.http_client = http_client or HttpClient()
        
        # 通知消息收集
        self.notify_messages = []
            
    def setup_logger(self, log_level: int) -> None:
        self.logger = logging.getLogger(f"renyang.{self.wxid}")
        self.logger.propagate = False
        
        if self.logger.hasHandlers():
            self.logger.handlers.clear()

        if PRINT_ONLY_TOKEN:
            self.logger.setLevel(logging.ERROR)
            handler = logging.StreamHandler(sys.stderr)
            handler.setLevel(logging.ERROR)
            formatter = logging.Formatter('%(message)s')
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
        else:
            self.logger.setLevel(log_level)
            handler = logging.StreamHandler(sys.stdout)
            handler.setLevel(log_level)
            formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)

    def log_msg(self, msg: str, level: int = logging.INFO) -> None:
        # 在只打印Token的模式下，为确保错误信息可见，直接将其打印到stderr
        if level >= logging.ERROR and PRINT_ONLY_TOKEN:
            print(msg, file=sys.stderr)

        global notify_messages
        
        # 始终记录日志，由logger的level控制是否输出
        self.logger.log(level, msg)
        
        if level >= logging.INFO and ENABLE_NOTIFY:
            if level >= logging.ERROR:
                notify_messages.append(f"错误: {msg}")
            elif level >= logging.WARNING:
                notify_messages.append(f"警告: {msg}")
            else:
                notify_messages.append(msg)
    
    def print_token(self, token: str) -> None:
        """只打印token到stdout"""
        if PRINT_ONLY_TOKEN:
            print(token, file=sys.stdout)
        else:
            self.log_msg(f"Mobile Token: {token}", logging.INFO)
    
    def send_notify(self, title: Optional[str] = None) -> bool:
        if not ENABLE_NOTIFY or not self.notify_messages:
            return False
            
        title = title or f"认养一头牛登录 - {self.wxid}"
        content = "\n".join(self.notify_messages)
        
        return send_notify(title, content)
    
    def _generate_sign(self, timestamp: int, appid: str) -> str:
        """生成签名
        
        Args:
            timestamp: 时间戳
            appid: 小程序APPID
            
        Returns:
            签名字符串
        """
        # 这里需要根据实际的签名算法实现
        # 示例中使用了一个固定的签名，实际需要根据后端要求生成
        # 通常签名算法会包括时间戳、appid、secret等参数的组合
        sign_str = f"{timestamp}{appid}"
        return hashlib.sha1(sign_str.encode('utf-8')).hexdigest()
    
    def get_login_code(self) -> Optional[str]:
        print('🔐 正在获取微信小程序登录码...')
        
        try:
            # 构建请求参数
            request_body = {
                "appid": self.appid,
                "wxid": self.wxid
            }
            
            # 构建请求头
            headers = {
                'accept': 'application/json',
                'content-type': 'application/json'
            }
            
            # 构建完整URL
            if self.server.startswith(('http://', 'https://')):
                api_url = f"{self.server}/api/v1/wx/app/get/code"
            else:
                api_url = f"http://{self.server}/api/v1/wx/app/get/code"
            
            # 发送请求
            result = self.http_client.post(api_url, json=request_body, headers=headers)
            
            # 检查响应
            if not result or result.get('Code') != 0:
                error_msg = result.get('Message', '未知错误') if result else '请求失败'
                print(f"❌ 获取登录码失败: {error_msg}")
                return None
            
            code = result.get('Data', {}).get('code')
            if code:
                print('✅ 成功获取登录码')
                return code
            else:
                print('❌ 获取登录码失败: 未返回code')
                return None
        except Exception as e:
            print(f"❌ 获取登录码过程出错: {str(e)}")
            return None
    
    def get_shop_customer(self, token: str, shop_id: str = "10017728") -> Optional[Dict[str, Any]]:
        """获取店铺顾客信息
        
        Args:
            token: mobileToken
            shop_id: 店铺ID
            
        Returns:
            成功返回顾客信息字典，失败返回None
        """
        print('🔍 正在获取用户信息...')
        
        try:
            # 生成时间戳
            timestamp = int(time.time() * 1000)
            start_time = timestamp + 1
            
            # 生成X-TracedId
            traced_id = str(uuid.uuid4())
            
            # 生成签名
            sign = self._generate_sign(timestamp, self.appid)
            
            # 构建请求头
            headers = {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c23) NetType/WIFI Language/zh_CN',
                'Accept-Encoding': 'gzip,compress,br,deflate',
                'Content-Type': 'application/json',
                'content-type': 'application/json;charset=UTF-8',
                'ts': str(timestamp),
                'X-TracedId': traced_id,
                'token': token,
                'sign': sign,
                'startTime': str(start_time),
                'appid': self.appid,
                'Referer': f'https://servicewechat.com/{self.appid}/224/page-frame.html'
            }
            
            # 构建完整URL
            url = f"{RENYANG_GET_SHOP_CUSTOMER}?shopId={shop_id}"
            
            # 发送GET请求
            response = self.http_client.get(url, headers=headers)
            
            # 处理响应
            if response.get('success'):
                result_data = response.get('result', {})
                customer_id = result_data.get('customerId')
                
                if customer_id:
                    print(f'✅ 成功获取用户信息，Customer ID: {customer_id}')
                    return result_data
                else:
                    print('❌ 获取用户信息成功但未返回Customer ID')
                    return None
            else:
                error_msg = response.get('msg', '未知错误')
                print(f"❌ 获取用户信息失败: {error_msg}")
                return None
                
        except Exception as e:
            print(f"❌ 获取用户信息过程出错: {str(e)}")
            return None
    
    def login_with_renyang(self, code: str) -> Optional[str]:
        """使用微信code登录认养一头牛
        
        Args:
            code: 微信小程序登录code
            
        Returns:
            登录成功返回mobileToken，失败返回None
        """
        print('🚀 正在登录认养一头牛小程序...')
        
        try:
            # 生成时间戳
            timestamp = int(time.time() * 1000)
            start_time = timestamp + 1
            
            # 生成X-TracedId
            traced_id = str(uuid.uuid4())
            
            # 生成签名
            sign = self._generate_sign(timestamp, self.appid)
            
            # 构建请求头
            headers = {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c23) NetType/WIFI Language/zh_CN',
                'Accept-Encoding': 'gzip,compress,br,deflate',
                'Content-Type': 'application/json',
                'content-type': 'application/json;charset=UTF-8',
                'ts': str(timestamp),
                'X-TracedId': traced_id,
                'token': '',
                'sign': sign,
                'startTime': str(start_time),
                'appid': self.appid,
                'Referer': f'https://servicewechat.com/{self.appid}/224/page-frame.html'
            }
            
            # 构建请求体
            request_body = {
                "code": code,
                "appid": self.appid,
                "shopId": "10017728",
                "envVersion": "release",
                "isEnterpriseWx": False,
                "scene": 1089,
                "referrerInfo": {}
            }
            
            # 发送请求
            response = self.http_client.post(RENYANG_WXAPP_LOGIN, json=request_body, headers=headers)
            
            # 处理响应
            if response.get('success'):
                result_data = response.get('result', {})
                mobile_token = result_data.get('mobileToken')
                
                if mobile_token:
                    print('🎉 登录成功！正在获取Token...')
                    
                    # 获取用户信息（解决用户id不能为空的问题）
                    self.get_shop_customer(mobile_token)
                    
                    # 只打印mobileToken
                    self.print_token(mobile_token)
                    
                    return mobile_token
                else:
                    print('❌ 登录成功但未返回Token')
                    return None
            else:
                error_msg = response.get('msg', '未知错误')
                print(f"❌ 登录失败: {error_msg}")
                return None
                
        except Exception as e:
            print(f"❌ 登录过程出错: {str(e)}")
            return None
    

    
    def login_process(self) -> bool:
        # 验证必要参数
        if not self.wxid:
            self.log_msg('错误：未配置WXID', logging.ERROR)
            return False
        
        # 获取code
        code = self.get_login_code()
        if not code:
            return False
        
        # 登录认养一头牛
        return bool(self.login_with_renyang(code))


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='认养一头牛小程序Token获取工具')
    parser.add_argument('--server', help='神秘协议地址，格式为 http://ip:port')
    parser.add_argument('--wxid', help='微信ID，多个ID请用环境变量WRH_WXID设置')
    parser.add_argument('--debug', action='store_true', help='启用调试模式')
    parser.add_argument('--appid', help='小程序APPID，默认使用内置值')
    return parser.parse_args()

def main() -> bool:
    # 解析命令行参数
    args = parse_arguments()
    
    # 设置日志级别
    log_level = logging.DEBUG if args.debug else logging.INFO
    
    # 设置通知开关
    global ENABLE_NOTIFY
    ENABLE_NOTIFY = 1 if os.environ.get('PHONECODE_NOTIFY') == '1' else 0
    
    # 获取配置参数 - 优先使用命令行参数，其次使用环境变量
    server = args.server or os.environ.get('WECHAT_SERVER')
    appid = args.appid or DEFAULT_APPID
    
    # 验证必要参数
    if not server:
        print('❌ 错误：未提供神秘协议地址，请设置WECHAT_SERVER环境变量')
        return False
    
    # 处理账号 - 支持多种格式
    wxid_info_list = []
    
    # 1. 命令行参数指定的单账号
    if args.wxid:
        # 命令行参数只支持wxid，不使用备注
        wxid_info_list = [{'remarks': '', 'wxid': args.wxid}]
    # 2. 环境变量
    else:
        env_wxid = os.environ.get('WRH_WXID')
        
        if env_wxid:
            # 优先使用换行符分隔
            if '\n' in env_wxid:
                wxid_lines = [wxid.strip() for wxid in env_wxid.split('\n') if wxid.strip()]
            else:
                wxid_lines = [env_wxid]
            
            # 解析每行，格式为"{备注}#{wxid}"
            for line in wxid_lines:
                if '#' in line:
                    parts = line.split('#', 1)
                    remarks = parts[0].strip()
                    wxid = parts[1].strip()
                    wxid_info_list.append({'remarks': remarks, 'wxid': wxid})
                else:
                    # 如果没有备注，只使用wxid
                    wxid_info_list.append({'remarks': '', 'wxid': line.strip()})
    
    if not wxid_info_list:
        print('❌ 错误：未提供任何WXID，请使用--wxid参数或设置WRH_WXID环境变量')
        return False
    
    print(f"📋 任务开始：为 {len(wxid_info_list)} 个账号获取认养一头牛Token")
    print(f"📡 神秘协议地址：{server}")
    print(f"🆔 小程序APPID：{appid}")
    print()
    
    # 多账号处理
    success_count = 0
    failed_accounts = []
    error_accounts = []
    token_results = []
    
    for i, account in enumerate(wxid_info_list):
        remarks = account['remarks']
        wxid = account['wxid']
        print(f"--- 处理账号 {i+1}/{len(wxid_info_list)}: {remarks or wxid} ---")
        try:            
            client = RenyangClient(
                server, wxid, appid, log_level
            )
            
            # 直接调用login_with_renyang获取token
            code = client.get_login_code()
            if code:
                token = client.login_with_renyang(code)
                if token:
                    success_count += 1
                    token_results.append({'remarks': remarks, 'token': token})
                    print('✅ 账号处理成功')
                else:
                    failed_accounts.append({'remarks': remarks, 'wxid': wxid})
                    print('❌ 账号处理失败：获取Token失败')
            else:
                failed_accounts.append({'remarks': remarks, 'wxid': wxid})
                print('❌ 账号处理失败：获取登录码失败')
            
            # 添加账号处理之间的延迟
            if i < len(wxid_info_list) - 1:
                print('⏳ 等待5秒后处理下一个账号...')
                time.sleep(5)
        except Exception as e:
            print(f"❌ 处理账号 {remarks or wxid} 时发生严重错误: {str(e)}")
            error_accounts.append({'remarks': remarks, 'wxid': wxid})
        print()
    
    # 构建新的ryytn变量值
    if token_results:
        print('📝 正在构建新的ryytn变量值...')
        ryytn_value = ''
        for result in token_results:
            remarks = result['remarks']
            token = result['token']
            ryytn_value += f"{remarks}#{token}\n"
        
        # 去除末尾的换行符
        ryytn_value = ryytn_value.strip()
        print('✅ 成功构建新的ryytn变量值')
        
        # 使用青龙API更新ryytn变量
        ql_token = get_ql_token()
        if ql_token:
            # 获取现有ryytn变量
            envs = get_ql_env(ql_token, RY_YTN_VAR_NAME)
            if envs is not None:
                ryytn_env = None
                for env in envs:
                    if env.get('name') == RY_YTN_VAR_NAME:
                        ryytn_env = env
                        break
                
                if ryytn_env:
                    # 更新现有变量
                    env_id = ryytn_env.get('id')
                    if env_id:
                        update_ql_env(ql_token, env_id, RY_YTN_VAR_NAME, ryytn_value, '认养一头牛小程序Token')
                    else:
                        print('❌ 更新ryytn变量失败：环境变量ID不存在')
                else:
                    # 创建新变量
                    create_ql_env(ql_token, RY_YTN_VAR_NAME, ryytn_value, '认养一头牛小程序Token')
            else:
                print('❌ 更新ryytn变量失败：获取环境变量列表失败')
        else:
            print('❌ 更新ryytn变量失败：获取青龙API Token失败')
    
    # 打印任务摘要
    print("\n🏁 任务完成！")
    print("--- 任务摘要 ---")
    print(f"总账号数: {len(wxid_info_list)}")
    print(f"成功获取Token: {success_count}")
    if failed_accounts:
        print(f"失败账号数: {len(failed_accounts)}")
        for account in failed_accounts:
            print(f"  - {account['remarks'] or account['wxid']}")
    if error_accounts:
        print(f"异常账号数: {len(error_accounts)}")
        for account in error_accounts:
            print(f"  - {account['remarks'] or account['wxid']}")
    print()
    
    return success_count > 0


# 作为模块导入时不执行主函数
def cli_entry_point() -> None:
    try:
        if not main():
            sys.exit(1)
    except Exception as e:
        print(f"程序意外终止: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli_entry_point()
