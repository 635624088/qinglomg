import os
import json
import requests
from datetime import datetime
import time

# -------------------------- 全局配置与公用请求头 --------------------------
# 基础配置
APPID = "wxb346465fe8212a32"
YYB_BASE_URL = os.getenv("YYB_BASE_URL", "http://172.17.0.1:18080")
CODE_URL = f"{YYB_BASE_URL}/wxapp/getCode"
BASE_URL = "https://sys.cscmgg.com/api/siyu"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254162e) XWEB/18163"
RETRY_TIMES = 3  # code获取重试次数
SHARE_TIMES = 3  # 分享任务执行次数
SID = "94cf977599a346d01c26048db7ef1755"
SCENE = 1256
RECORD_FILE = "通信甄选.txt"  # OpenID记录文件名称
# 401未登录标识
UNLOGIN_CODE = 401
UNLOGIN_MSG = "未登录,刷新小程序"

# 公用请求头
COMMON_HEADERS = {
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Connection": "keep-alive",
    "Content-Type": "application/json",
    "Host": "sys.cscmgg.com",
    "Referer": "https://servicewechat.com/wxb346465fe8212a32/127/page-frame.html",
    "User-Agent": UA,
    "channelKey": "",
    "hideToast": "[object Boolean]",
    "page": "/pages/index/index",
    "scene": str(SCENE),
    "sid": SID,
    "sourceMedia": "weixin",
    "staffId": "",
    "xweb_xhr": "1"
}

requests.packages.urllib3.disable_warnings()
session = requests.Session()
session.verify = False 


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

def get_wxid_list():
    """从 YYB 协议或环境变量nzcode读取账号列表，返回 [(nickname, wxid), ...]"""
    # 优先从 YYB 协议获取
    yyb_accounts = fetch_accounts_from_yyb(YYB_BASE_URL)
    if yyb_accounts:
        print(f"✅ 从 YYB 协议获取到 {len(yyb_accounts)} 个账号")
        return yyb_accounts
    
    # 回退到环境变量
    nzcode = os.getenv("nzcode", "")
    wxid_list = [wxid.strip() for wxid in nzcode.split("\n") if wxid.strip()]
    if not wxid_list:
        print("❌ YYB 协议和环境变量nzcode均未配置账号")
        exit(1)
    print(f"✅ 从环境变量读取到 {len(wxid_list)} 个有效wxid账号")
    return [(wxid, wxid) for wxid in wxid_list]

def load_openid_record():
    """加载通信甄选.txt中的openid记录，返回字典{wxid: openid}"""
    openid_dict = {}
    if not os.path.exists(RECORD_FILE):
        print(f"ℹ️ 未找到{RECORD_FILE}，首次运行将自动创建")
        return openid_dict
    try:
        with open(RECORD_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()
        for line in lines:
            line = line.strip()
            if not line or "#" not in line:
                continue
            wxid, openid = line.split("#", 1)
            wxid, openid = wxid.strip(), openid.strip()
            if wxid and openid:
                openid_dict[wxid] = openid
        print(f"✅ 从{RECORD_FILE}加载到{len(openid_dict)}条有效wxid->openid记录")
    except Exception as e:
        print(f"⚠️ 读取{RECORD_FILE}异常，将忽略历史记录：{str(e)}")
    return openid_dict

def save_openid_to_record(wxid, openid):
    """将wxid和openid写入通信甄选.txt，格式wxid#openid，自动换行"""
    content = ""
    if os.path.exists(RECORD_FILE):
        with open(RECORD_FILE, "r", encoding="utf-8") as f:
            content = f.read()
    new_line = f"\n{wxid}#{openid}" if content else f"{wxid}#{openid}"
    with open(RECORD_FILE, "a", encoding="utf-8") as f:
        f.write(new_line)
    print(f"✅ 已将{wxid}#{openid}写入{RECORD_FILE}")

def update_openid_record(wxid, old_openid, new_openid):
    """更新通信甄选.txt中的openid记录（替换旧值），保持文件格式不变"""
    if not os.path.exists(RECORD_FILE):
        print(f"ℹ️ {RECORD_FILE}不存在，直接新增{wxid}#{new_openid}记录")
        save_openid_to_record(wxid, new_openid)
        return
    try:
        # 读取所有行，替换对应wxid的openid
        with open(RECORD_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()
        updated_lines = []
        is_updated = False
        for line in lines:
            original_line = line.strip()
            if not original_line or "#" not in original_line:
                updated_lines.append(line)
                continue
            line_wxid, line_openid = original_line.split("#", 1)
            line_wxid = line_wxid.strip()
            # 匹配到目标wxid，替换为新openid
            if line_wxid == wxid:
                updated_lines.append(f"{wxid}#{new_openid}\n")
                is_updated = True
                print(f"✅ 已替换{wxid}的openid：{old_openid} → {new_openid}")
            else:
                updated_lines.append(line)
        # 若未找到旧记录，直接追加新记录
        if not is_updated:
            updated_lines.append(f"{wxid}#{new_openid}\n")
            print(f"ℹ️ 未找到{wxid}旧记录，直接新增{wxid}#{new_openid}")
        # 写入更新后的内容
        with open(RECORD_FILE, "w", encoding="utf-8") as f:
            f.writelines(updated_lines)
        print(f"✅ {RECORD_FILE}记录更新完成")
    except Exception as e:
        print(f"❌ 更新{RECORD_FILE}失败：{str(e)}")

def get_code(wxid):
    """获取code，失败重试3次，仍失败返回None"""
    headers = {"Content-Type": "application/json"}
    payload = {"ref": wxid, "app_id": APPID}
    for retry in range(1, RETRY_TIMES + 1):
        try:
            response = session.post(CODE_URL, headers=headers, json=payload, timeout=10)
            response.raise_for_status()
            res_data = response.json()
            # 兼容 YYB 格式：code=0, data.result.code
            if isinstance(res_data, dict):
                if res_data.get("code") == 0:
                    data = res_data.get("data") or {}
                    result = data.get("result") if isinstance(data, dict) else None
                    if isinstance(result, dict):
                        code = result.get("code")
                    else:
                        code = data.get("code") or data.get("result")
                    if code:
                        print(f"✅ 账号[{wxid}]第{retry}次请求成功，获取code：{code}")
                        return code
                # 兼容旧格式：Data.code
                if "Data" in res_data and isinstance(res_data["Data"], dict) and "code" in res_data["Data"]:
                    code = res_data["Data"]["code"]
                    print(f"✅ 账号[{wxid}]第{retry}次请求成功，获取code：{code}")
                    return code
            print(f"❌ 账号[{wxid}]第{retry}次请求返回格式错误：{res_data}")
        except Exception as e:
            print(f"❌ 账号[{wxid}]第{retry}次请求失败：{str(e)[:50]}")
        if retry < RETRY_TIMES:
            time.sleep(1)
    print(f"❌ 账号[{wxid}]获取code重试{RETRY_TIMES}次均失败，跳过该账号")
    return None

def login_get_openid(code):
    """登录接口，通过code获取openid，失败返回None"""
    url = f"{BASE_URL}/loginFlash"
    payload = {"jscode": code, "staffId": "", "parentId": "", "copId": "", "kr": ""}
    try:
        response = session.post(url, headers=COMMON_HEADERS, json=payload, timeout=10)
        res_data = response.json()
        if res_data.get("code") == 200 and "data" in res_data and "openId" in res_data["data"]:
            openid = res_data["data"]["openId"]
            
            return openid
        else:
            print(f"❌ 登录失败，响应数据：{res_data}")
            return None
    except Exception as e:
        print(f"❌ 登录请求异常：{str(e)}")
        return None

def sign_task(openid, wxid, openid_dict):
    """
    签到任务，新增401未登录处理逻辑
    :param openid: 当前使用的openid
    :param wxid: 对应账号wxid
    :param openid_dict: 本地openid字典（用于更新）
    :return: 可用的openid（原openid/新openid），None表示失败
    """
    url = f"{BASE_URL}/sign/click"
    repair_date = datetime.now().strftime("%Y-%m-%d")
    headers = COMMON_HEADERS.copy()
    headers["openid"] = openid
    params = {"repairDate": repair_date}
    try:
        response = session.get(url, headers=headers, params=params, timeout=10)
        res_data = response.json()
        # 正常响应判断
        if res_data.get("code") == 200:
            print(f"✅ 签到成功：{res_data.get('msg')}")
            return openid
        elif res_data.get("code") == 500 and "今天已经签到" in res_data.get("msg", ""):
            print(f"ℹ️ 签到提示：{res_data.get('msg')}")
            return openid
        # 检测401未登录异常
        elif res_data.get("code") == UNLOGIN_CODE and res_data.get("msg") == UNLOGIN_MSG:
            print(f"⚠️ 检测到401未登录：{res_data}，开始自动重连流程...")
            # 步骤1：重新获取code（3次重试）
            new_code = get_code(wxid)
            if not new_code:
                print(f"❌ 重连失败：获取新code失败，跳过该账号")
                return None
            # 步骤2：用新code获取新openid
            new_openid = login_get_openid(new_code)
            if not new_openid:
                print(f"❌ 重连失败：用新code获取openid失败，跳过该账号")
                return None
            # 步骤3：更新本地记录和字典
            update_openid_record(wxid, openid, new_openid)
            openid_dict[wxid] = new_openid  # 内存字典更新，供后续流程使用
            # 步骤4：用新openid重新执行签到
            print(f"ℹ️ 使用新openid[{new_openid}]重新签到...")
            headers["openid"] = new_openid
            retry_response = session.get(url, headers=headers, params=params, timeout=10)
            retry_res = retry_response.json()
            if retry_res.get("code") == 200:
                print(f"✅ 重连成功，新openid签到成功：{retry_res.get('msg')}")
                return new_openid
            elif retry_res.get("code") == 500 and "今天已经签到" in retry_res.get("msg", ""):
                print(f"✅ 重连成功，新openid检测到今日已签到")
                return new_openid
            else:
                print(f"❌ 重连失败：新openid签到仍失败，响应：{retry_res}")
                return None
        # 其他异常
        else:
            print(f"❌ 签到失败：{res_data}")
            return openid
    except Exception as e:
        print(f"❌ 签到请求异常：{str(e)}")
        return openid

def check_share_task(openid):
    """查询分享任务完成状态，返回未完成的任务列表（['分享小程序','分享商品']）"""
    url = f"{BASE_URL}/getGrowthList"
    headers = COMMON_HEADERS.copy()
    headers["openid"] = openid
    headers["page"] = "[object Undefined]"
    unfinished_tasks = []
    try:
        response = session.get(url, headers=headers, timeout=10)
        res_data = response.json()
        if res_data.get("code") == 200 and "data" in res_data:
            for task in res_data["data"]:
                task_desc = task.get("taskDesc", "")
                finished = task.get("finished", True)
                if task_desc in ["分享小程序", "分享商品"] and not finished:
                    unfinished_tasks.append(task_desc)
            print(f"ℹ️ 分享任务检查结果：{unfinished_tasks if unfinished_tasks else '无'}未完成")
        else:
            print(f"❌ 查询分享任务失败：{res_data}")
    except Exception as e:
        print(f"❌ 查询分享任务异常：{str(e)}")
    return unfinished_tasks

def share_mini_program(openid):
    """执行分享小程序任务，固定执行3次"""
    url = f"{BASE_URL}/event/shareMiniProgram"
    headers = COMMON_HEADERS.copy()
    headers["openid"] = openid
    headers["page"] = "/vip-center/point/task"
    for i in range(1, SHARE_TIMES + 1):
        try:
            response = session.get(url, headers=headers, timeout=10)
            res_data = response.json()
            if res_data.get("code") == 200:
                print(f"✅ 分享小程序第{i}次执行成功")
            else:
                print(f"❌ 分享小程序第{i}次执行失败：{res_data}")
        except Exception as e:
            print(f"❌ 分享小程序第{i}次执行异常：{str(e)}")
        time.sleep(0.5)

def share_products(openid):
    """执行分享商品任务，固定执行3次，带固定id=435"""
    url = f"{BASE_URL}/event/shareProducts"
    headers = COMMON_HEADERS.copy()
    headers["openid"] = openid
    headers["page"] = "/pages/goods/detail?id=435&modeNo=4&logId=&isSms="
    params = {"id": 435}
    for i in range(1, SHARE_TIMES + 1):
        try:
            response = session.get(url, headers=headers, params=params, timeout=10)
            res_data = response.json()
            if res_data.get("code") == 200:
                print(f"✅ 分享商品第{i}次执行成功")
            else:
                print(f"❌ 分享商品第{i}次执行失败：{res_data}")
        except Exception as e:
            print(f"❌ 分享商品第{i}次执行异常：{str(e)}")
        time.sleep(0.5)

def query_integral(openid):
    """查询当前积分，提取并打印userIgl"""
    url = f"{BASE_URL}/sign/initSign"
    headers = COMMON_HEADERS.copy()
    headers["openid"] = openid
    headers["page"] = "[object Undefined]"
    headers.pop("scene", None)
    headers.pop("staffId", None)
    try:
        response = session.get(url, headers=headers, timeout=10)
        res_data = response.json()
        if res_data.get("code") == 200 and "data" in res_data and "userIgl" in res_data["data"]:
            user_igl = res_data["data"]["userIgl"]
            print(f"✅ 当前积分：{user_igl}")
            return user_igl
        else:
            print(f"❌ 积分查询失败：{res_data}")
    except Exception as e:
        print(f"❌ 积分查询异常：{str(e)}")
    return None

def process_single_account(wxid, openid_dict):
    """处理单个wxid账号的全流程，支持401自动重连"""
    print(f"\n==================== 开始处理账号：{wxid} ====================")
    # 第一步：获取初始openid（本地记录/重新获取）
    if wxid in openid_dict:
        current_openid = openid_dict[wxid]
        print(f"✅ 从{RECORD_FILE}获取到openid：{current_openid}，跳过code获取流程")
    else:
        code = get_code(wxid)
        if not code:
            return
        current_openid = login_get_openid(code)
        if not current_openid:
            return
        save_openid_to_record(wxid, current_openid)
        openid_dict[wxid] = current_openid  # 内存字典更新

    # 第二步：执行签到（处理401，返回可用的openid）
    current_openid = sign_task(current_openid, wxid, openid_dict)
    if not current_openid:  # 401重连失败，直接跳过后续流程
        print(f"==================== 账号：{wxid} 处理终止（重连失败）====================\n")
        return

    # 后续流程：使用签到返回的可用openid（原/新）执行所有操作
    # 第三步：查询分享任务
    unfinished_tasks = check_share_task(current_openid)
    # 第四步：执行未完成分享任务
    if "分享小程序" in unfinished_tasks:
        share_mini_program(current_openid)
    if "分享商品" in unfinished_tasks:
        share_products(current_openid)
    # 第五步：查询积分
    query_integral(current_openid)
    print(f"==================== 账号：{wxid} 处理完成 ====================\n")

if __name__ == "__main__":
    # 主流程：加载记录 → 读取wxid → 逐个处理
    openid_record = load_openid_record()
    wxid_list = get_wxid_list()
    for nickname, wxid in wxid_list:
        print(f"👤 账号: {nickname}")
        process_single_account(wxid, openid_record)
        time.sleep(2)  # 账号间限流
    print(f"🎉 所有账号处理完毕，OpenID记录已同步至{RECORD_FILE}！")