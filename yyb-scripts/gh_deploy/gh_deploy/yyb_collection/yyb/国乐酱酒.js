const axios = require("axios");

// ===================== 配置项 =====================
// PushPlus 通知Token（在青龙面板环境变量中设置 PLUSPLUS_TOKEN）
const PLUSPLUS_TOKEN = process.env.PLUSPLUS_TOKEN || "";
// YYB 协议配置
const YYB_BASE_URL = process.env.YYB_BASE_URL || "http://172.17.0.1:18080";

// 固定配置
const APP_ID = "wxeff120e4d11594c0";
const BASE = "https://member.guoyuejiu.com";
const defaultUserAgent = "Mozilla/5.0 (Linux; Android 15; 22061218C Build/AQ3A.250226.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.177 Mobile Safari/537.36 XWEB/1460075 MMWEBSDK/20260202 MMWEBID/6435 MicroMessenger/8.0.71.3080(0x18004739) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android";

// ===================== 工具 =====================
const sleep = ms => new Promise(r => setTimeout(r, ms));
function jitter(base) {
  return base + Math.random() * base;
}

// PushPlus通知函数
async function sendPlusPlusNotification(title, content) {
    if (!PLUSPLUS_TOKEN) return;
    try {
        await axios.post("https://www.pushplus.plus/send", {
            token: PLUSPLUS_TOKEN,
            title: title,
            content: content,
            template: "txt"
        }, { timeout: 5000 });
        console.log("✅ 通知推送成功");
    } catch (e) {
        console.log("❌ 通知推送失败：", e.message);
    }
}

// ===================== 获取微信 Code =====================
async function getCode(wxid) {
  try {
    const response = await axios.post(`${YYB_BASE_URL}/wxapp/getCode`, {
      ref: wxid,
      app_id: APP_ID
    }, { timeout: 10000 });
    const res = response.data;
    // 兼容 YYB 格式：code=0, data.result.code
    if (res.code === 0) {
      const data = res.data || {};
      const result = data.result || {};
      const code = result.code || data.code;
      if (code) return code;
    }
    // 兼容旧格式
    if (res.status && res.Data && res.Data.code) {
      return res.Data.code;
    }
    console.log(`❌ 获取code失败: ${JSON.stringify(res)}`);
  } catch (e) {
    console.log(`❌ 获取code失败：`, e.message);
  }
  return null;
}

// ===================== 从 YYB 协议获取账号 =====================
async function fetchAccountsFromYYB() {
  try {
    const response = await axios.get(`${YYB_BASE_URL}/accounts`, { timeout: 10000 });
    const data = response.data;
    if (data.code === 0 && data.data) {
      return data.data.map(acc => ({
        nickname: acc.nickname || acc.alias || acc.openid,
        openid: acc.openid
      }));
    }
  } catch (e) {
    console.log(`❌ 从 YYB 协议获取账号失败：`, e.message);
  }
  return [];
}

// ===================== Code 登录 =====================
async function codeLogin(remark) {
  let code = await getCode(remark);
  if (!code) return null;

  try {
    let payload = {
      "avatarUrl": "https://thirdwx.qlogo.cn/mmopen/vi_32/POgEwh4mIHO4nibH0KlMECNjjGxQUq24ZEaGT4poC6icRiccVGKSyXwibcPq4BWmiaIGuG1icwxaQX6grC9VemZoJ8rg/132",
      "city": "",
      "country": "",
      "gender": 0,
      "nickName": "微信用户",
      "province": "",
      "code": code,
      "source": 2
    };

    let { data } = await axios.post(`${BASE}/api/user/wxLogin`, payload, {
      headers: {
        "User-Agent": defaultUserAgent,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    if (data.code === 0) {
      ;
      return data.data.authorization;
    }
  } catch (e) {
    console.log(`❌ [${remark}] 登录失败：`, e.message);
  }
  return null;
}

// ===================== 签到【修改：增加remark入参】 =====================
async function sign(remark, token) {
  let signResult = { success: false, msg: "", spanSumDays: 0 };
  try {
    let { data } = await axios.get(`${BASE}/api/sign/daily/sign`, {
      headers: {
        "Authorization": "Mer" + token,
        "User-Agent": defaultUserAgent,
        "Referer": "https://servicewechat.com/wxeff120e4d11594c0/87/page-frame.html"
      }
    });
    if (data.code === 0) {
      signResult.success = true;
      signResult.msg = "签到成功";
      signResult.spanSumDays = data.data.spanSumDays;
      console.log(`📊 [${remark}] 签到成功 | 连续 ${data.data.spanSumDays} 天`);
    } else {
      signResult.msg = data.message;
      console.log(`❌ [${remark}] 签到失败：${data.message}`);
    }
  } catch (e) {
    signResult.msg = "签到异常：" + e.message;
    console.log(`❌ [${remark}] 签到异常：`, e.message);
  }
  return signResult;
}

// ===================== 查询积分【修改：增加remark入参】 =====================
async function getPoints(remark, token) {
  let pointResult = { success: false, score: 0, msg: "" };
  try {
    let { data } = await axios.get(`${BASE}/api/user/info`, {
      headers: {
        "Authorization": "Mer" + token,
        "User-Agent": defaultUserAgent
      }
    });
    if (data.code === 0) {
      pointResult.success = true;
      pointResult.score = data.data.score;
      console.log(`💰 [${remark}] 总积分：${data.data.score}`);
    }
  } catch (e) {
    pointResult.msg = "查询积分异常：" + e.message;
    console.log(`❌ [${remark}] 查询积分异常：`, e.message);
  }
  return pointResult;
}

// 单个账号执行逻辑
async function runServer(remark, wxid) {
  let result = {
    server: remark,
    loginSuccess: false,
    signResult: {},
    pointResult: {}
  };

  console.log(`\n===== 国乐酱酒 - ${remark} 账号 =====`);
  await sleep(jitter(1500));
  
  // 登录
  let token = await codeLogin(wxid);
  if (!token) {
    result.loginSuccess = false;
    console.log(`===== ${remark} 登录失败，跳过后续操作 =====`);
    return result;
  }
  result.loginSuccess = true;

  // 签到 + 查询积分【传remark进去】
  result.signResult = await sign(remark, token);
  result.pointResult = await getPoints(remark, token);
  await sleep(jitter(1000));

  return result;
}

// ===================== 主程序 =====================
(async () => {
  console.log("===== 国乐酱酒多账号任务启动（YYB协议版） =====");

  // 优先从 YYB 协议获取账号
  let accounts = [];
  const yybAccounts = await fetchAccountsFromYYB();
  if (yybAccounts.length > 0) {
    console.log(`✅ 从 YYB 协议获取到 ${yybAccounts.length} 个账号`);
    accounts = yybAccounts.map(acc => ({ remark: acc.nickname, wxid: acc.openid }));
  } else {
    // 回退到环境变量
    const raw = process.env[ckName] || "";
    const lines = raw.split("\n").map(l => l.trim()).filter(l => l);
    if (lines.length === 0) {
      console.log(`❌ 未找到环境变量 ${ckName}，且 YYB 协议无账号`);
      return;
    }
    accounts = lines.map(line => {
      const idx = line.indexOf("#");
      if (idx === -1) return { remark: line, wxid: line };
      return { remark: line.substring(0, idx), wxid: line.substring(idx + 1) };
    });
    console.log(`📋 从环境变量解析到 ${accounts.length} 个账号`);
  }
  console.log(`📋 共加载 ${accounts.length} 个账号\n`);

  const results = [];
  for (const acc of accounts) {
    const res = await runServer(acc.remark, acc.wxid);
    results.push(res);
    await sleep(2000);
  }

  // 汇总结果并推送通知
  let notifyContent = "### 国乐酱酒双账号任务执行结果\n";
  results.forEach(res => {
    notifyContent += `\n#### ${res.server}
- 登录状态：${res.loginSuccess ? "成功" : "失败"}
`;
    if (res.loginSuccess) {
      notifyContent += `- 签到状态：${res.signResult.success ? "成功" : "失败"}
- 签到信息：${res.signResult.msg}
- 总积分：${res.pointResult.success ? res.pointResult.score : "查询失败"}
`;
    }
  });

  await sendPlusPlusNotification("国乐酱酒双账号任务完成", notifyContent);
  console.log("\n===== 所有账号执行完成 =====");
})();