import os
import time
import requests
import json
import re
from xml.etree import ElementTree as ET
from datetime import datetime

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

class YiLiQQStar:
    """伊利QQ星 - 全自动每日任务（微信code登录版，支持多账号，单一缓存文件）"""
    
    APPID = "wx650bdff059f63f5b"
    SECRET = "d1e4b452117fa4ff4af6fa319fd858ff"
    TOKEN_FILE = "yili_tokens.json"          # 统一缓存文件
    
    # 每日任务（已验证）
    TASKS = {
        11: "发起分享",
        31: "单次签到",
        40: "分享文章",
        47: "使用工具",
        53: "知识库每日打卡",
        56: "关注公众号",
        62: "活动签到",
        75: "活动连续签到",
    }
    
    def __init__(self, wxid, remark=None):
        self.wxid = wxid
        self.remark = remark or wxid
        self.yyb_base_url = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080").rstrip('/')
        
        self.base_url = "https://mall.yili.com/MAMAIF/MCSWSIAPI.asmx/Call"
        self.device_code = self.APPID
        self.activity_id = "13D88C0D-A850-4278-A718-35CD397EF922"
        self.auth_key = None
        self.user_id = None
        self.points_before = 0
        
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows',
            'Content-Type': 'application/x-www-form-urlencoded',
            'xweb_xhr': '1',
            'Referer': f'https://servicewechat.com/{self.APPID}/162/page-frame.html',
        }
        self._load_token()
    
    def _load_token(self):
        """从统一缓存文件读取当前 wxid 的 auth_key"""
        if os.path.exists(self.TOKEN_FILE):
            try:
                with open(self.TOKEN_FILE, 'r') as f:
                    tokens = json.load(f)
                    self.auth_key = tokens.get(self.wxid)
            except:
                pass
    
    def _save_token(self):
        """保存当前 wxid 的 auth_key 到统一缓存文件（不影响其他账号）"""
        tokens = {}
        if os.path.exists(self.TOKEN_FILE):
            try:
                with open(self.TOKEN_FILE, 'r') as f:
                    tokens = json.load(f)
            except:
                pass
        tokens[self.wxid] = self.auth_key
        with open(self.TOKEN_FILE, 'w') as f:
            json.dump(tokens, f, indent=2)
    
    def _parse(self, resp):
        text = resp.text.strip()
        if not text: return {}
        if text.startswith('<?xml') or text.startswith('<string'):
            try:
                root = ET.fromstring(text)
                if root.text: return json.loads(root.text)
            except:
                m = re.search(r'<string[^>]*>(.*?)</string>', text, re.DOTALL)
                if m:
                    try: return json.loads(m.group(1))
                    except: pass
        return {}
    
    def call(self, method, params, retry=2):
        if isinstance(params, dict): p = json.dumps(params)
        elif isinstance(params, str) and params: p = params
        else: p = ""
        
        for i in range(retry):
            s = requests.Session()
            try:
                r = s.post(
                    self.base_url, headers=self.headers,
                    data={'RequestPack': json.dumps({
                        "DeviceCode": self.device_code,
                        "AuthKey": self.auth_key or "0"*36,
                        "Method": method, "Params": p
                    })}, timeout=15
                )
                s.close()
                result = self._parse(r)
                if 'Result' in result and isinstance(result['Result'], str):
                    try: result['Result'] = json.loads(result['Result'])
                    except: pass
                return result
            except:
                s.close()
                if i < retry - 1: time.sleep(3)
                else: return {"Return": -999}
    
    def get_wx_code(self):
        url = f"{self.yyb_base_url}/wxapp/getCode"
        try:
            r = requests.post(url, json={"ref": self.wxid, "app_id": self.APPID}, timeout=10)
            data = r.json()
            # 兼容 YYB 格式：code=0, data.result.code
            if isinstance(data, dict):
                if data.get("code") == 0:
                    result = data.get("data") or {}
                    if isinstance(result, dict):
                        code = result.get("result", {}).get("code") if isinstance(result.get("result"), dict) else result.get("code")
                        if code:
                            return code
                # 兼容旧格式
                code = data.get('Data', {}).get('code') or data.get('code') or data.get('data', {}).get('code')
                if code:
                    return code
        except:
            pass
        return None
    
    def login(self):
        code = self.get_wx_code()
        if not code:
            print(f"[{self.remark}] ❌ 获取微信code失败")
            return False
        r1 = self.call("WechatService.GetWxOpenID", json.dumps({
            "AppID": self.APPID, "Secret": self.SECRET,
            "Js_Code": code, "Grant_Type": "authorization_code"
        }))
        if r1.get('Return', -1) < 0:
            print(f"[{self.remark}] ❌ 换取openid失败")
            return False
        result = r1.get('Result', {})
        if isinstance(result, str):
            try: result = json.loads(result)
            except: pass
        self.open_id = result.get('openid', '')
        if not self.open_id:
            print(f"[{self.remark}] ❌ 未获得openid")
            return False
        r2 = self.call("MemberService.LoginByWechatOpenId", json.dumps({
            "Platform": self.APPID, "OpenId": self.open_id,
            "UnionId": result.get('unionid', '')
        }))
        if r2.get('Return', -1) < 0:
            print(f"[{self.remark}] ❌ 登录失败")
            return False
        self.auth_key = (r2.get('Result', {}) or {}).get('AuthKey', '')
        if self.auth_key:
            self._save_token()
        return bool(self.auth_key)
    
    def get_info(self):
        r = self.call("MemberService.GetMyMemberInfo", "")
        if r.get('Return') == 0:
            info = r['Result']
            self.user_id = info.get('ID')
            self.points_before = float(info.get('PointsBalance', 0))
            return info
        return None
    
    def get_points(self):
        r = self.call("PointsService.GetPointsBalance", "")
        return r.get('Result', {}) if r.get('Return') == 0 else None
    
    def do_join(self, jt):
        if not self.user_id: return None
        ji = json.dumps({"Activity": self.activity_id, "JoinType": jt, "UserId": self.user_id})
        return self.call("MemberService.CampaignJoin", json.dumps({"JoinInfo": ji}))
    
    def run(self):
        print(f"\n{'='*40}")
        print(f" 伊利QQ星 | {self.remark} | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'='*40}")
        
        info = self.get_info() if self.auth_key else None
        if not info:
            print("[登录] ...")
            if not self.login():
                print(f"[{self.remark}] ❌ 登录失败")
                return False
            info = self.get_info()
            if not info:
                print(f"[{self.remark}] ❌ 获取信息失败")
                return False
        
        print(f"👤 {info.get('RealName')} | {info.get('MemberLevelName')} | {self.points_before}积分\n")
        
        for jt, name in self.TASKS.items():
            r = self.do_join(jt)
            ret = r.get('Return', -999)
            
            if ret == 0:
                print(f"✅ [{jt}] {name} 完成!")
            elif ret in [-31, -33]:
                print(f"⏭️  [{jt}] {name} 已完成")
            elif ret == -10:
                print(f"🔄 [{jt}] 刷新AuthKey...")
                if self.login():
                    r = self.do_join(jt)
                    print(f"  {'✅ 完成' if r.get('Return')==0 else '❌ 失败'}")
            elif ret == -999:
                print(f"⚠️  [{jt}] {name} 网络错误")
            else:
                print(f"❌ [{jt}] {name}: {ret}")
            
            time.sleep(0.8)
        
        pts = self.get_points()
        if pts:
            a = float(pts.get('Points', self.points_before))
            d = a - self.points_before
            if d > 0:
                print(f"\n🎉 积分: {self.points_before} → {a} (+{d})")
            else:
                print(f"\n📊 积分: {self.points_before}")
        print(f"{'='*40}\n")
        return True

def parse_accounts():

    # 优先从 YYB 协议获取账号
    yyb_base_url = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
    yyb_accounts = fetch_accounts_from_yyb(yyb_base_url)
    if yyb_accounts:
        print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
        return [(wxid, nickname) for nickname, wxid in yyb_accounts]
    
    # 回退到环境变量
    raw = os.getenv("YILI_WXID", "")
    if not raw:
        print('未找到环境变量 YILI_WXID，且 YYB 协议无账号')
        return []
    accounts = []
    # 支持换行和 @ 分隔
    lines = raw.replace('\r\n', '\n').replace('&', '\n').split('\n')
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if '#' in line:
            parts = line.split('#')
            remark = parts[0].strip()
            wxid = parts[1].strip()
        else:
            remark = line
            wxid = line
        accounts.append((wxid, remark))
    return accounts

def main():
    accounts = parse_accounts()
    if not accounts:
        print("❌ 未找到账号配置，请设置环境变量 YILI_WXID")

        return
    
    print(f"✅ 共加载 {len(accounts)} 个账号")
    for wxid, remark in accounts:
        try:
            star = YiLiQQStar(wxid, remark)
            star.run()
        except Exception as e:
            print(f"[{remark}] ❌ 执行异常: {e}")
        time.sleep(2)  # 账号间隔

if __name__ == "__main__":
    main()