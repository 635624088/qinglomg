import requests
import json
import os
import sys
import time
import random

# YYB 协议获取 code
def fetch_code_yyb(yyb_base_url, appid, wxid):
    """从 YYB 协议获取小程序 code"""
    try:
        url = f"{yyb_base_url}/wxapp/getCode"
        payload = {"ref": wxid, "app_id": appid}
        headers = {"Content-Type": "application/json"}
        for _ in range(3):
            resp = requests.post(url, json=payload, headers=headers, timeout=60)
            data = resp.json()
            if data.get("code") == 0:
                result = data.get("data", {}).get("result") if isinstance(data.get("data"), dict) else data.get("data")
                if isinstance(result, dict):
                    code = result.get("code")
                else:
                    code = data.get("data", {}).get("code") or data.get("data", {}).get("result")
                if code:
                    return code
            time.sleep(2)
    except Exception as e:
        print(f"❌ 获取code失败: {e}")
    return None

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

# 配置
CACHE_FILE = "金粉荟会员中心ck.txt"
ENV_NAME = "jfhhyzx"
MINIPROGRAM_APPID = "wxad89e6496de97dab"
BASE_URL = "https://hyzx.jinshajiuye.cn"
LOGIN_URL = f"{BASE_URL}/api/identity/v2/oauth2/token"
SIGN_URL = f"{BASE_URL}/api/member/v1/js/signIn/trigger/2581069687075957844"
MEMBER_BY_USER_URL = f"{BASE_URL}/api/member/v1/member-info/sample/by-user-id/"
MEMBER_INFO_URL = f"{BASE_URL}/api/member/v1/member-info/applet/member-info/"

def get_headers(token=None):
    headers = {
        'User-Agent': "Mozilla/5.0 (Linux; Android 13; Mi 10 Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.7444.173 Mobile Safari/537.36 XWEB/1420087 MMWEBSDK/20250904 MMWEBID/8648 MicroMessenger/8.0.65.2960(0x28004156) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android",
        'Content-Type': "application/json",
        'yes-req-bizmode': "B2C",
        'x-real-hostname': "https://hyzx.jinshajiuye.cn",
        'application-key': "e1fce770a0abb2a831d7058d8251e210",
        'yes-req-bizspaceid': "1",
        'yes-req-cus-b2c-channeltype': "2",
        'scenecode': "mp",
        'mallmode': "B2C",
        'yes-req-cus-member-flag': "new",
        'referer': "https://servicewechat.com/wxad89e6496de97dab/83/page-frame.html",
        'priority': "u=1, i"
    }
    if token:
        headers['access-token'] = token
    return headers

def fetch_code(remark, wxid):
    global YYB_BASE_URL
    if not YYB_BASE_URL:
        print(f"❌ {remark}：YYB_BASE_URL 未设置")
        return None
    return fetch_code_yyb(YYB_BASE_URL, MINIPROGRAM_APPID, wxid)

def login_and_get_token(remark, code):
    try:
        payload = {
            "loginSource": 3,
            "thirdType": 6,
            "configLevel": 2,
            "code": code,
            "validTime": 2592000
        }
        
        response = requests.post(
            LOGIN_URL,
            json=payload,
            headers=get_headers(),
            timeout=30
        )
        response.raise_for_status()
        data = response.json()
        
        if data.get("resultCode") == "0" and data.get("data", {}).get("token"):
            token = data["data"]["token"]
            user_id = data["data"].get("userId", "")
            
            return {
                "token": token,
                "user_id": user_id
            }
        else:
            return None
            
    except Exception:
        return None

def get_member_id_by_user_id(remark, token, user_id):
    try:
        if not user_id:
            return None
        
        url = f"{MEMBER_BY_USER_URL}{user_id}?id={user_id}"
        response = requests.get(
            url,
            headers=get_headers(token),
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            if data.get("resultCode") == "0":
                member_data = data.get("data", {})
                return member_data.get("id", "")
        
        return None
        
    except Exception:
        return None

def get_member_points(remark, token, member_id):
    try:
        if not member_id:
            return None
        
        url = f"{MEMBER_INFO_URL}{member_id}"
        response = requests.get(
            url,
            headers=get_headers(token),
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            if data.get("resultCode") == "0":
                member_data = data.get("data", {})
                return member_data.get("availablePoints", 0)
        
        return None
        
    except Exception:
        return None

def check_token_validity(remark, token, user_id):
    """验证token有效性"""
    try:
        response = requests.post(
            SIGN_URL,
            json={},
            headers=get_headers(token),
            timeout=10
        )
        
        if response.status_code == 200:
            return True
        else:
            return False
        
    except Exception:
        return False

def get_all_accounts():
    global YYB_BASE_URL
    # 优先从 YYB 协议获取账号
    yyb_accounts = []
    if YYB_BASE_URL:
        yyb_accounts = fetch_accounts_from_yyb(YYB_BASE_URL)
    
    if yyb_accounts:
        accounts_to_process = []
        for nickname, wxid in yyb_accounts:
            accounts_to_process.append({
                "remark": nickname,
                "type": "new",
                "token": None,
                "user_id": "",
                "wxid": wxid
            })
        print(f"📊 从 YYB 协议获取到 {len(accounts_to_process)} 个账号")
        return accounts_to_process
    
    # 回退到原有逻辑
    cached_accounts = {}
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and '#' in line:
                    parts = line.split('#')
                    if len(parts) >= 2:
                        remark = parts[0].strip()
                        token = parts[1].strip()
                        user_id = parts[2].strip() if len(parts) > 2 else ""
                        if remark and token:
                            cached_accounts[remark] = {
                                "token": token,
                                "user_id": user_id
                            }
    
    env_accounts = []
    env = os.getenv(ENV_NAME, "")
    if env:
        for line in env.strip().split('\n'):
            line = line.strip()
            if line and '#' in line:
                parts = line.split('#', 1)
                if len(parts) == 2 and parts[0].strip() and parts[1].strip():
                    remark, wxid = parts[0].strip(), parts[1].strip()
                    env_accounts.append((remark, wxid))
    
    accounts_to_process = []
    cached_count = 0
    new_count = 0
    
    for remark, wxid in env_accounts:
        if remark in cached_accounts:
            accounts_to_process.append({
                "remark": remark,
                "type": "cached",
                "token": cached_accounts[remark]["token"],
                "user_id": cached_accounts[remark].get("user_id", ""),
                "wxid": wxid
            })
            cached_count += 1
        else:
            accounts_to_process.append({
                "remark": remark,
                "type": "new",
                "token": None,
                "user_id": "",
                "wxid": wxid
            })
            new_count += 1
    
    print(f"📊 共{len(accounts_to_process)}个账号（缓存{cached_count}个，新账号{new_count}个）")
    return accounts_to_process

def save_account_to_cache(remark, token, user_id=""):
    try:
        existing_lines = []
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                existing_lines = [line.strip() for line in f if line.strip()]
        
        new_line = f"{remark}#{token}#{user_id}" if user_id else f"{remark}#{token}"
        
        updated_lines = []
        found = False
        for line in existing_lines:
            parts = line.split('#', 1)
            if parts[0] == remark:
                updated_lines.append(new_line)
                found = True
            else:
                updated_lines.append(line)
        
        if not found:
            updated_lines.append(new_line)
        
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            for line in updated_lines:
                f.write(line + "\n")
                
    except Exception:
        pass

def single_account_sign(remark, token):
    try:
        payload = {}
        response = requests.post(
            SIGN_URL,
            json=payload,
            headers=get_headers(token),
            timeout=30
        )
        
        if response.status_code == 200:
            data = response.json()
            result_code = data.get("resultCode")
            result_msg = data.get("resultMsg", "")
            
            if result_code == "0":
                return True, "签到成功"
            elif "已签到" in result_msg:
                return True, "今日已签到"
            elif result_code == "100000" and "已签到" in result_msg:
                return True, "今日已签到"
            else:
                return False, "签到失败"
                
        else:
            return False, f"HTTP状态码 {response.status_code}"
            
    except Exception:
        return False, "请求异常"

def refresh_account_token(remark, wxid):
    code = fetch_code(remark, wxid)
    if not code:
        return None, None, "获取code失败"
    
    login_info = login_and_get_token(remark, code)
    if not login_info:
        return None, None, "登录获取token失败"
    
    return login_info["token"], login_info.get("user_id", ""), "token已更新"

def main():
    global YYB_BASE_URL
    YYB_BASE_URL = os.getenv("YYB_BASE_URL", "").rstrip('/')
    print("="*40 + " 金粉荟自动签到 " + "="*40)
    
    accounts = get_all_accounts()
    
    if not accounts:
        print("❌ 未找到任何账号配置")
        return
    
    print(f"📢 开始签到...\n")
    
    results = []
    points_summary = []
    
    for i, account in enumerate(accounts):
        if i > 0:
            time.sleep(random.uniform(3, 8))
        
        remark = account["remark"]
        wxid = account["wxid"]
        
        print(f"🔍 处理账号：{remark}")
        
        if account["type"] == "cached":
            token = account["token"]
            user_id = account["user_id"]
            
            # 验证token有效性
            is_valid = check_token_validity(remark, token, user_id)
            
            if is_valid:
                print(f"✅ {remark}：缓存token有效")
                
                # 执行签到
                success, result_msg = single_account_sign(remark, token)
                
                # 签到完成后才查询积分
                if success:
                    # 签到成功，现在查询积分
                    if user_id:
                        member_id = get_member_id_by_user_id(remark, token, user_id)
                        if member_id:
                            points = get_member_points(remark, token, member_id)
                            if points is not None:
                                points_summary.append({
                                    "remark": remark,
                                    "points": points
                                })
                    
                    results.append(f"✅ {remark}：{result_msg}")
                    print(f"📝 {remark}：{result_msg}")
                else:
                    results.append(f"❌ {remark}：{result_msg}")
                    print(f"❌ {remark}：{result_msg}")
            else:
                print(f"❌ {remark}：缓存token失效，重新获取...")
                new_token, new_user_id, refresh_result = refresh_account_token(remark, wxid)
                if new_token:
                    save_account_to_cache(remark, new_token, new_user_id)
                    print(f"✅ {remark}：获取新token成功")
                    
                    # 用新token执行签到
                    success, result_msg = single_account_sign(remark, new_token)
                    
                    # 签到完成后才查询积分
                    if success:
                        # 签到成功，现在查询积分
                        if new_user_id:
                            member_id = get_member_id_by_user_id(remark, new_token, new_user_id)
                            if member_id:
                                points = get_member_points(remark, new_token, member_id)
                                if points is not None:
                                    points_summary.append({
                                        "remark": remark,
                                        "points": points
                                    })
                        
                        results.append(f"✅ {remark}：{result_msg}")
                        print(f"📝 {remark}：{result_msg}")
                    else:
                        results.append(f"❌ {remark}：{result_msg}")
                        print(f"❌ {remark}：{result_msg}")
                else:
                    results.append(f"❌ {remark}：{refresh_result}")
                    print(f"❌ {remark}：{refresh_result}")
                    
        else:  # 新账号
            print(f"🆕 {remark}：新账号处理")
            code = fetch_code(remark, wxid)
            if not code:
                results.append(f"❌ {remark}：获取code失败")
                print(f"❌ {remark}：获取code失败")
                print()
                continue
                
            login_info = login_and_get_token(remark, code)
            if not login_info:
                results.append(f"❌ {remark}：登录失败")
                print(f"❌ {remark}：登录失败")
                print()
                continue
                
            token = login_info["token"]
            user_id = login_info.get("user_id", "")
            
            save_account_to_cache(remark, token, user_id)
            print(f"✅ {remark}：获取新token成功")
            
            # 执行签到
            success, result_msg = single_account_sign(remark, token)
            
            # 签到完成后才查询积分
            if success:
                # 签到成功，现在查询积分
                if user_id:
                    member_id = get_member_id_by_user_id(remark, token, user_id)
                    if member_id:
                        points = get_member_points(remark, token, member_id)
                        if points is not None:
                            points_summary.append({
                                "remark": remark,
                                "points": points
                            })
                
                results.append(f"✅ {remark}：{result_msg}")
                print(f"📝 {remark}：{result_msg}")
            else:
                results.append(f"❌ {remark}：{result_msg}")
                print(f"❌ {remark}：{result_msg}")
        
        # 每个账号处理完后添加空行分隔
        print()
    
    # 打印签到结果
    print("="*60)
    print("📝 签到结果：")
    print("-"*60)
    for result in results:
        print(result)
    
    # 打印积分汇总（签到后查询的）
    if points_summary:
        print(f"\n" + "="*60)
        print("💰 账号目前积分：")
        print("-"*60)
        total_points = 0
        for item in points_summary:
            print(f"{item['remark']}：{item['points']}积分")
            total_points += item['points']
        print("-"*60)
        print(f"📈 总积分：{total_points}")
        print("="*60)
    else:
        print("\n⚠️ 未获取到积分信息")
    
    # 统计结果
    success_count = sum(1 for r in results if "✅" in r)
    fail_count = len(results) - success_count
    
    print(f"\n📊 签到统计：共{len(accounts)}个账号，成功{success_count}个，失败{fail_count}个")
    
    # 发送通知
    try:
        from notify import send
        send_title = "金粉荟签到结果"
        
        points_info = ""
        if points_summary:
            total_points = sum(item['points'] for item in points_summary)
            points_info = f"\n积分汇总：\n"
            for item in points_summary:
                points_info += f"{item['remark']}：{item['points']}积分\n"
            points_info += f"总积分：{total_points}\n"
        
        send_content = f"签到统计：共{len(accounts)}个账号，成功{success_count}个，失败{fail_count}个\n" + "\n".join(results) + points_info
        send(send_title, send_content)
    except ImportError:
        pass
    
    print("\n" + "="*40 + " 签到任务结束 " + "="*40)

if __name__ == "__main__":
    main()