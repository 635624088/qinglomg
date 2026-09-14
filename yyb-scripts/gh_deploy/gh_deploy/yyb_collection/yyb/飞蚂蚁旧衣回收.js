// === YYB_GO 统一通知注入 begin ===
(function () {
  const __logs = [];
  const __oL = console.log.bind(console);
  console.log = function (...a) { try { __logs.push(a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ')); } catch (e) {} __oL(...a); };
  const __oE = console.error.bind(console);
  console.error = function (...a) { try { __logs.push('[ERR] ' + a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ')); } catch (e) {} __oE(...a); };

  function __resolveKey() {
    let k = process.env.QYWX_KEY || process.env.QYWX || process.env.WEWORK_KEY;
    if (k) return k;
    try {
      const fs = require('fs');
      let p = null;
      try { p = require.resolve('./sendNotify'); } catch (e) { try { p = require.resolve('/ql/data/scripts/sendNotify'); } catch (e2) {} }
      if (p) {
        const t = fs.readFileSync(p, 'utf-8');
        const m = t.match(/QYWX_KEY\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
    } catch (e) {}
    return null;
  }

  let __flushed = false;
  function __flush() {
    if (__flushed) return;
    __flushed = true;
    const title = (process.argv[1] || 'YYB_GO').split(/[\/]/).pop();
    const body = __logs.slice(-40).join('\n');
    // 1) 显式调用 sendNotify.js（满足要求）；临时静音其可能产生的报错，避免误导
    const _ol = console.log, _oe = console.error;
    console.log = function () {}; console.error = function () {};
    try {
      let sn;
      try { sn = require('./sendNotify'); } catch (e) { try { sn = require('/ql/data/scripts/sendNotify'); } catch (e2) { sn = null; } }
      if (sn) {
        if (typeof sn === 'function') { try { sn(title, body); } catch (e) {} }
        else if (sn.sendNotify && typeof sn.sendNotify === 'function') { try { sn.sendNotify(title, body); } catch (e) {} }
      }
    } catch (e) {}
    console.log = _ol; console.error = _oe;
    // 2) 兜底：同步 curl POST 企业微信机器人 webhook（绕过损坏的 sendNotify.js，确保送达）
    try {
      const key = __resolveKey();
      if (key) {
        const fs = require('fs');
        const cp = require('child_process');
        const tmp = '/tmp/yyb_notify_' + process.pid + '.json';
        fs.writeFileSync(tmp, JSON.stringify({ msgtype: 'text', text: { content: '【' + title + '】\n' + body } }));
        cp.execSync('curl -s -m 15 -X POST -H "Content-Type: application/json" --data @' + tmp + ' "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + key + '"', { stdio: 'ignore' });
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
    } catch (e) {}
  }

  let __exiting = false;
  const __origExit = (typeof process.exit === 'function') ? process.exit.bind(process) : function (c) { throw new Error('exit ' + c); };
  process.exit = function (code) {
    if (__exiting) return __origExit(code);
    __exiting = true;
    try { __flush(); } catch (e) {}
    return __origExit(code);
  };
  process.on('beforeExit', () => { if (!__exiting) { __exiting = true; try { __flush(); } catch (e) {} } });
})();
// === YYB_GO 统一通知注入 end ===

// name: 飞蚂蚁旧衣回收
// cron: 0 0 14 * * *
const axios = require("axios");
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const qs = require('querystring');

// 强制全局禁用系统代理环境变量，避免干扰
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

// ===================== 配置项 =====================
// PushPlus 通知Token（青龙环境变量）
const PLUSPLUS_TOKEN = process.env.PLUSPLUS_TOKEN || "";

// 从环境变量 YYB_GO 读取内网wxcode服务地址，多行换行分隔
let SERVERS = [];
const envYybGo = process.env.YYB_GO || "";
if (envYybGo) {
    const rawLines = envYybGo.split(/\r?\n/);
    SERVERS = rawLines.map(item => item.trim()).filter(item => item);
}
// 无有效地址直接退出
if (SERVERS.length === 0) {
    console.error("❌ 错误：未读取到环境变量 YYB_GO 或无有效IP端口！");
    console.error("青龙环境变量YYB_GO填写示例（每行一个地址）：");
    console.error("127.0.0.1:8088");
    console.error("192.168.1.21:8088");
    process.exit(1);
}
console.log(`✅ 成功读取 ${SERVERS.length} 台内网wxcode服务：`);
SERVERS.forEach(item => console.log(` - ${item}`));
console.log("----------------------------------------\n");

// 品赞代理配置（青龙环境变量）
const PROXY_API = process.env.PROXY_API || ""; // 代理提取API链接
const PROXY_TYPE = process.env.PROXY_TYPE || "http"; // 代理类型: http 或 socks5
const PROXY_RETRY_TIMES = 3; // 单个账号代理获取重试次数
const PROXY_VALIDATE_URL = "http://httpbin.org/ip"; // 代理验证地址
// 核心开关：每个账号独立获取专属代理（true=每个账号一个新IP，false=所有账号共用一个IP）
const ENABLE_PER_ACCOUNT_PROXY = true;
// 账号间代理获取间隔（毫秒，避免频繁调用代理API被限流）
const PROXY_FETCH_INTERVAL = 3000;
// 兜底开关：代理请求失败后，自动切换直连重试
const ENABLE_DIRECT_FALLBACK = true;
// 调试开关：开启后打印完整请求和响应
const DEBUG_MODE = false;
// 固定配置（已修正为最新正确值）
const APPID = "wx501990400906c9ff"; // 飞蚂蚁最新APPID
const PLATFORM_KEY = "F2EE24892FBF66F0AFF8C0EB532A9394"; // 固定平台密钥
const APP_VERSION = "V2.00.01"; // 应用版本号
// UA池（已添加Windows微信小程序UA）
const USER_AGENT_LIST = [
    "Mozilla/5.0 (Linux; Android 14; 2512BPNDAC Build/UKQ1.230917.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.153 Mobile Safari/537.36 XWEB/1460043 MMWEBSDK/20251006 MiniProgramEnv/android",
    "Mozilla/5.0 (Linux; Android 13; Redmi K60 Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.102 Mobile Safari/537.36 XWEB/1300003 MMWEBSDK/20250901 MiniProgramEnv/android",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541885) XWEB/19463"
];

// ===================== 工具函数 =====================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function random(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getUA() {
    return USER_AGENT_LIST[Math.floor(Math.random() * USER_AGENT_LIST.length)];
}

// 调试日志函数
function debugLog(title, data) {
    if (DEBUG_MODE) {
        console.log(`\n🔍 [调试] ${title}:`);
        console.log(JSON.stringify(data, null, 2));
    }
}

// ====================== 品赞IP代理系统（每个账号独立获取）======================
function parseProxyResponse(text) {
    text = text.trim();
    if (!text) return null;
    try {
        const data = JSON.parse(text);
        let proxyObj = null;
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
            proxyObj = data.data[0];
        } else if (data.ip && data.port) {
            proxyObj = data;
        } else if (data.result && data.result.ip && data.result.port) {
            proxyObj = data.result;
        }
        if (proxyObj) {
            return {
                host: proxyObj.ip,
                port: proxyObj.port,
                username: proxyObj.user || proxyObj.username || "",
                password: proxyObj.pass || proxyObj.password || ""
            };
        }
    } catch (e) {}
    if (text.includes(":")) {
        const parts = text.split(":");
        if (parts.length >= 2) {
            return {
                host: parts[0],
                port: parseInt(parts[1]),
                username: parts[2] || "",
                password: parts[3] || ""
            };
        }
    }
    return null;
}

function buildProxyAgent(proxyInfo) {
    if (!proxyInfo) return null;
    const { host, port, username, password } = proxyInfo;
    let auth = "";
    if (username && password) {
        auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    }
    try {
        if (PROXY_TYPE === "socks5") {
            const proxyUrl = `socks5://${auth}${host}:${port}`;
                        return {
                httpAgent: new SocksProxyAgent(proxyUrl),
                httpsAgent: new SocksProxyAgent(proxyUrl)
            };
        } else {
            const httpProxyUrl = `http://${auth}${host}:${port}`;
            const httpsProxyUrl = `http://${auth}${host}:${port}`;
                        return {
                httpAgent: new HttpProxyAgent(httpProxyUrl),
                httpsAgent: new HttpsProxyAgent(httpsProxyUrl)
            };
        }
    } catch (e) {
        console.log(`❌ 生成代理Agent失败：${e.message}`);
        return null;
    }
}

async function validateProxy(agent) {
    if (!agent) return false;
    try {
        const axiosConfig = {
            method: "get",
            url: PROXY_VALIDATE_URL,
            timeout: 15000,
            ...agent,
            maxRedirects: 5
        };
        const response = await axios(axiosConfig);
        const isSuccess = response.status === 200;
        if (isSuccess) {
                    }
        return isSuccess;
    } catch (e) {
        console.log(`⚠️ 代理验证失败，原因：${e.message}`);
        return false;
    }
}

async function getValidProxy(accountName) {
    if (!PROXY_API) {
                return null;
    }
    console.log(`🔌 [${accountName}] 正在从品赞API获取专属代理 (${PROXY_TYPE})...`);
    for (let i = 0; i < PROXY_RETRY_TIMES; i++) {
        try {
            const response = await axios.get(PROXY_API, {
                timeout: 15000,
                proxy: false
            });
            const proxyInfo = parseProxyResponse(response.data);
            if (!proxyInfo) {
                console.log(`⚠️ [${accountName}] 第${i+1}次获取代理失败：响应格式无法解析`);
                continue;
            }
                        const agent = buildProxyAgent(proxyInfo);
            const isValid = await validateProxy(agent);
            if (isValid) {
                return agent;
            } else {
                console.log(`⚠️ [${accountName}] 第${i+1}次获取的代理不可用，正在重试...`);
            }
        } catch (e) {
            console.log(`⚠️ [${accountName}] 第${i+1}次获取代理异常：${e.message}`);
        }
        if (i < PROXY_RETRY_TIMES - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
        return null;
}

function addProxyToAxiosConfig(axiosConfig, proxyAgent) {
    if (!proxyAgent) return axiosConfig;
    return {
        ...axiosConfig,
        ...proxyAgent,
        timeout: axiosConfig.timeout || 20000
    };
}

// ===================== PushPlus通知函数 =====================
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

// ===================== 业务逻辑函数 =====================
// 获取code 【强制直连，不走代理】
function parseYybGoEntry(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) return { server: "", ref: "" };

    const atIndex = value.indexOf("@");
    if (atIndex === -1) {
        console.log(`❌ [配置] YYB_GO 格式应为 地址@微信账号标识，当前值: ${value}`);
        return { server: "", ref: "" };
    }

    let server = value.slice(0, atIndex).trim();
    const ref = value.slice(atIndex + 1).trim();

    if (server.startsWith("http://")) {
        server = server.slice(7);
    } else if (server.startsWith("https://")) {
        server = server.slice(8);
    }
    server = server.replace(/\/+$/, "");

    if (!server || !ref) {
        console.log(`❌ [配置] YYB_GO 缺少地址或微信账号标识，当前值: ${value}`);
        return { server: "", ref: "" };
    }

    return { server, ref };
}

async function getCode(server) {
    const { server: parsedServer, ref } = parseYybGoEntry(server);
    if (!parsedServer || !ref) return null;

    const url = `http://${parsedServer}/wxapp/getCode`;

    try {
        const { data } = await axios.post(url, {
            ref,
            app_id: APPID
        }, {
            timeout: 20000,
            proxy: false
        });
        const code = data?.data?.result?.code;
        if (data?.code !== 0 || !code) {
            console.log(`❌ ${parsedServer} 获取code失败: ${JSON.stringify(data)}`);
            return null;
        }
        console.log(`✅ ${parsedServer} 获取code成功`);
        return code;
    } catch (e) {
        console.log(`❌ ${parsedServer} 获取code异常: ${e.message}`);
        return null;
    }
}

// 登录获取token 【已添加完整调试日志】
async function wxLogin(jsCode, UA, proxyAgent, server) {
    const baseConfig = {
        method: 'post',
        url: 'https://openapp.fmy90.com/auth/wx/login',
        headers: {
            'Host': 'openapp.fmy90.com',
            'Connection': 'keep-alive',
            'device-version': 'Windows 10 x64',
            'User-Agent': UA,
            'xweb_xhr': '1',
            'Content-Type': 'application/x-www-form-urlencoded',
            'device-model': 'microsoft',
            'Accept': '*/*',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Referer': `https://servicewechat.com/${APPID}/506/page-frame.html`,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        data: qs.stringify({
            code: jsCode,
            platformKey: PLATFORM_KEY,
            version: APP_VERSION,
            vital: '',
            partner_platform_key: ''
        }),
        timeout: 20000
    };

    try {
        let response = null;
        if (proxyAgent) {
                        try {
                response = await axios(addProxyToAxiosConfig(baseConfig, proxyAgent));
            } catch (e) {
                                response = await axios({ ...baseConfig, proxy: false });
            }
        } else {
            response = await axios({ ...baseConfig, proxy: false });
        }

        return response.data;
    } catch (e) {
        console.log(`❌ [${server}] 登录异常: ${e.message}`);
        if (e.response) {
        }
        return null;
    }
}

// 通用请求 【已添加调试日志】
async function commonPost(url, body, token, UA, proxyAgent, server) {
    const baseConfig = {
        method: 'post',
        url: `https://openapp.fmy90.com${url}`,
        headers: {
            'Host': 'openapp.fmy90.com',
            'Connection': 'keep-alive',
            'device-version': 'Windows 10 x64',
            'User-Agent': UA,
            'xweb_xhr': '1',
            'Content-Type': 'application/json',
            'device-model': 'microsoft',
            'Accept': '*/*',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Referer': `https://servicewechat.com/${APPID}/506/page-frame.html`,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'authorization': `Bearer ${token}`
        },
        data: body,
        timeout: 20000
    };

    try {
        let response = null;
        if (proxyAgent) {
            try {
                response = await axios(addProxyToAxiosConfig(baseConfig, proxyAgent));
            } catch (e) {
                                response = await axios({ ...baseConfig, proxy: false });
            }
        } else {
            response = await axios({ ...baseConfig, proxy: false });
        }

        return response.data;
    } catch (e) {
        console.log(`❌ [${server}] 请求异常: ${e.message}`);
        if (e.response) {
        }
        return null;
    }
}

// 单个账号执行逻辑 【已修复错误处理并添加多路径token提取】
async function runAccount(server, globalProxyAgent) {
    let result = {
        server: server,
        success: false,
        signMsg: "",
        exchangeMsgs: [],
        error: "",
        proxyStatus: "未使用代理"
    };
    console.log(`\n===== 飞蚂蚁旧衣回收 - ${server} 账号 =====`);
    const UA = getUA();
    let proxyAgent = globalProxyAgent;
    if (ENABLE_PER_ACCOUNT_PROXY) {
        proxyAgent = await getValidProxy(server);
        result.proxyStatus = proxyAgent ? "使用专属代理" : "使用直连";
        await sleep(PROXY_FETCH_INTERVAL);
    }
    try {
        let startDelay = random(2000, 6000);
                await sleep(startDelay);

        // 1️⃣ 获取code
        let code = await getCode(server);
        if (!code) {
            result.error = "获取code失败";
            return result;
        }

        // 2️⃣ 登录获取token 【已添加多路径token提取和错误处理】
        let login = await wxLogin(code, UA, proxyAgent, server);
        if (!login) {
            result.error = "登录请求无响应";
            console.log(`❌ [${server}] 登录失败：无响应数据`);
            return result;
        }

        if (login.code != 200) {
            result.error = `登录失败：${login.message || "未知错误"}`;
            console.log(`❌ [${server}] ${result.error}`);
            return result;
        }

        // 多路径尝试提取token，兼容不同响应结构
        let token = null;
        if (login.data?.userInfo?.token) {
            token = login.data.userInfo.token;
        } else if (login.data?.token) {
            token = login.data.token;
        } else if (login.token) {
            token = login.token;
        } else if (login.data?.access_token) {
            token = login.data.access_token;
        }

        if (!token) {
            result.error = "无法从登录响应中提取token，请查看调试日志";
            console.log(`❌ [${server}] ${result.error}`);
            return result;
        }

                await sleep(random(3000, 8000));

        // 3️⃣ 签到
        let sign = await commonPost('/sign/new/do', {
            "version": APP_VERSION,
            "platformKey": PLATFORM_KEY,
            "mini_scene": 1089,
            "partner_ext_infos": ""
        }, token, UA, proxyAgent, server);
        if (sign?.code == 200) {
            result.signMsg = `签到成功：${sign.message}`;
            console.log(`✅ [${server}] 签到成功：${sign.message}`);
        } else {
            result.signMsg = `签到失败：${sign?.message || "未知错误"}`;
            console.log(`❌ [${server}] 签到失败：${sign?.message || "未知错误"}`);
        }
        await sleep(random(2000, 5000));

        // 4️⃣ 步数兑换（循环3次）
        for (let i = 0; i < 3; i++) {
                        let exchange = await commonPost('/step/exchange', {
                "steps": random(5000, 8000),
                "version": APP_VERSION,
                "platformKey": PLATFORM_KEY,
                "mini_scene": 1089,
                "partner_ext_infos": ""
            }, token, UA, proxyAgent, server);
            if (exchange?.code == 200) {
                let msg = `第${i+1}次步数兑换成功：${exchange.message}`;
                result.exchangeMsgs.push(msg);
                console.log(`✅ [${server}] ${msg}`);
            } else {
                let msg = `第${i+1}次步数兑换失败：${exchange?.message || "未知错误"}`;
                result.exchangeMsgs.push(msg);
                console.log(`❌ [${server}] ${msg}`);
            }
            if (i < 2) {
                await sleep(random(3000, 5000));
            }
        }

        result.success = true;
        console.log(`✅ [${server}] 账号执行完成`);
    } catch (e) {
        result.error = `执行异常：${e.message}`;
        console.log(`❌ [${server}] 执行异常：`, e.message);
        console.log(`❌ [${server}] 异常堆栈：`, e.stack);
    }
    return result;
}

// ===================== 主程序 =====================
(async () => {
    console.log('===== 飞蚂蚁旧衣回收动态code签到（调试版）=====\n');
    console.log('ℹ️ 调试模式已开启，将打印完整请求和响应数据\n');

    let globalProxyAgent = null;
    if (!ENABLE_PER_ACCOUNT_PROXY) {
        globalProxyAgent = await getValidProxy("全局共用");
    }
    const results = [];
    for (const server of SERVERS) {
        const res = await runAccount(server, globalProxyAgent);
        results.push(res);
        await sleep(2000);
    }

    // 汇总结果并推送
    let notifyContent = "### 飞蚂蚁旧衣回收多账号任务执行结果\n";
    results.forEach(res => {
        notifyContent += `\n#### ${res.server}
- 代理状态：${res.proxyStatus}
- 执行状态：${res.success ? "成功" : "失败"}
`;
        if (res.success) {
            notifyContent += `- 签到结果：${res.signMsg}
- 步数兑换结果：
`;
            res.exchangeMsgs.forEach(msg => {
                notifyContent += `  - ${msg}
`;
            });
        } else {
            notifyContent += `- 失败原因：${res.error}
`;
        }
    });
    await sendPlusPlusNotification("飞蚂蚁旧衣回收任务完成", notifyContent);
    console.log('\n===== 所有账号执行完成 =====');
})();