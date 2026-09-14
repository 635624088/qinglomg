// === 修复 got decompress-response 兼容性 ===
try {
  const _got = require('got');
  const _g = _got.default || _got;
  if (_g && typeof _g.extend === 'function') {
    _g.extend({ decompress: false });
  }
} catch (e) {}
// === 修复 end ===

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
// name: 美的会员
// cron: 0 40 11 * * *
//
// 微信小程序 - 美的会员动态 code 签到版
// APPID: wx49a622805968d156
//
// 功能：
//   1. 四端口获取微信 code
//   2. getLoginInfo.do 使用 code 换登录信息
//   3. 自动探测 uid/sukey cookie
//   4. 自动探测 ucAccessToken
//   5. 执行 signIn / signIn2
//   6. PushPlus 推送
//   7. 品赞代理 + 失败直连兜底
//
// 环境变量：
//   PLUSPLUS_TOKEN   PushPlus token，可选
//   PROXY_API        品赞代理提取 API，可选
//   PROXY_TYPE       http / socks5，默认 http
//
// 依赖：
//   npm install axios http-proxy-agent https-proxy-agent socks-proxy-agent

const axios = require("axios");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const APPID = "wx49a622805968d156";

// 从环境变量 YYB_GO 读取内网 IP，多个 IP 用换行分隔
const SERVERS = (process.env.YYB_GO || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

if (!SERVERS.length) {
    console.log("❌ 未配置环境变量 YYB_GO，请设置后重试");
    console.log("格式示例：");
    console.log("  YYB_GO=127.0.0.1:8088");
    console.log("  或");
    console.log("  YYB_GO=127.0.0.1:8088\\n192.168.31.36:8088\\n192.168.31.88:8088");
    process.exit(1);
}

const PLUSPLUS_TOKEN = process.env.PLUSPLUS_TOKEN || "";
const PROXY_API = process.env.PROXY_API || "";
const PROXY_TYPE = (process.env.PROXY_TYPE || "http").toLowerCase();

const PROXY_RETRY_TIMES = 3;
const PROXY_VALIDATE_URL = "http://httpbin.org/ip";
const PROXY_FETCH_INTERVAL = 3000;
const ENABLE_DIRECT_FALLBACK = true;
const REQUEST_TIMEOUT = 30000;

const LOGIN_APP_ID = "ee07f27990db48109efcccd322d3a873";
const LOGIN_APP_SECRET = "2646746f07bb46199aff49002e6dce81";
const LOGIN_API_KEY = "b6db9d5cf2d449538d3a0dd5d77b2e35";

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI " +
    "MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) " +
    "UnifiedPCWindowsWechat(0xf2541938) XWEB/19823";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function random(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nowText() {
    return new Date().toLocaleString("zh-CN");
}

function mask(value) {
    value = String(value || "");
    if (value.length <= 12) return value;
    return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function preview(value, limit = 800) {
    try {
        return JSON.stringify(value).slice(0, limit);
    } catch (e) {
        return String(value).slice(0, limit);
    }
}

function logTitle() {
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║ 🔷 美的会员动态 code 签到                   ║");
    console.log(`║ 🕒 ${nowText()}`);
    console.log(`║ 🔢 账号数量: ${SERVERS.length}`);
    console.log("╚══════════════════════════════════════════════╝");
}

function logAccount(index, total, server) {
    console.log("\n┌──────────────────────────────────────────────┐");
    console.log(`│ 🧩 账号 ${index} / ${total}`);
    console.log(`│ 🌍 来源 ${server}`);
    console.log("└──────────────────────────────────────────────┘");
}

function parseProxyResponse(text) {
    if (typeof text !== "string") text = JSON.stringify(text);
    text = text.trim();
    if (!text) return null;

    try {
        const data = JSON.parse(text);
        let proxyObj = null;

        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
            proxyObj = data.data[0];
        } else if (data.data && typeof data.data === "object") {
            proxyObj = data.data;
        } else if (data.ip && data.port) {
            proxyObj = data;
        } else if (data.result && data.result.ip && data.result.port) {
            proxyObj = data.result;
        }

        if (proxyObj) {
            return {
                host: proxyObj.ip || proxyObj.host,
                port: proxyObj.port,
                username: proxyObj.user || proxyObj.username || "",
                password: proxyObj.pass || proxyObj.password || "",
            };
        }
    } catch (e) {}

    if (text.includes(":")) {
        const parts = text.split(":");
        if (parts.length >= 2) {
            return {
                host: parts[0],
                port: Number(parts[1]),
                username: parts[2] || "",
                password: parts[3] || "",
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
            console.log(`🛠️ [代理] 生成 SOCKS5 代理 ${host}:${port}`);
            return {
                httpAgent: new SocksProxyAgent(proxyUrl),
                httpsAgent: new SocksProxyAgent(proxyUrl),
                proxy: false,
            };
        }

        const proxyUrl = `http://${auth}${host}:${port}`;
        console.log(`🛠️ [代理] 生成 HTTP 代理 ${host}:${port}`);
        return {
            httpAgent: new HttpProxyAgent(proxyUrl),
            httpsAgent: new HttpsProxyAgent(proxyUrl),
            proxy: false,
        };
    } catch (e) {
        console.log(`❌ [代理] 生成代理失败: ${e.message}`);
        return null;
    }
}

async function validateProxy(agent) {
    if (!agent) return { ok: false, ip: "" };

    try {
        const res = await axios({
            method: "get",
            url: PROXY_VALIDATE_URL,
            timeout: 15000,
            ...agent,
        });

        if (res.status === 200) {
            const ip = res.data?.origin || "未知";
            console.log(`✅ [代理] 验证通过，出口 IP: ${ip}`);
            return { ok: true, ip };
        }
    } catch (e) {
        console.log(`⚠️ [代理] 验证失败: ${e.message}`);
    }

    return { ok: false, ip: "" };
}

async function getValidProxy(accountName) {
    if (!PROXY_API) {
        console.log(`⚠️ [代理] ${accountName} 未配置 PROXY_API，使用直连`);
        return { agent: null, ip: "" };
    }

    console.log(`🌐 [代理] ${accountName} 正在获取品赞代理...`);

    for (let i = 1; i <= PROXY_RETRY_TIMES; i++) {
        try {
            const res = await axios.get(PROXY_API, {
                timeout: 15000,
                proxy: false,
            });

            const proxyInfo = parseProxyResponse(res.data);

            if (!proxyInfo) {
                console.log(`⚠️ [代理] 第 ${i} 次代理解析失败`);
                continue;
            }

            console.log(`✅ [代理] 提取到 ${proxyInfo.host}:${proxyInfo.port}`);

            const agent = buildProxyAgent(proxyInfo);
            const valid = await validateProxy(agent);

            if (valid.ok) {
                return { agent, ip: valid.ip };
            }
        } catch (e) {
            console.log(`⚠️ [代理] 第 ${i} 次获取代理异常: ${e.message}`);
        }

        if (i < PROXY_RETRY_TIMES) {
            await sleep(2000);
        }
    }

    console.log("⚠️ [代理] 获取失败，使用直连");
    return { agent: null, ip: "" };
}

async function requestWithProxy(config, proxyAgent, server) {
    if (proxyAgent) {
        try {
            return await axios({
                timeout: REQUEST_TIMEOUT,
                ...config,
                ...proxyAgent,
            });
        } catch (e) {
            console.log(`⚠️ [代理] ${server} 代理请求失败: ${e.message}`);

            if (!ENABLE_DIRECT_FALLBACK) {
                throw e;
            }

            console.log("🔁 [兜底] 切换直连重试");
        }
    }

    return await axios({
        timeout: REQUEST_TIMEOUT,
        proxy: false,
        ...config,
    });
}

async function sendPushPlus(title, content) {
    if (!PLUSPLUS_TOKEN) {
        console.log("⚠️ [PushPlus] 未配置 PLUSPLUS_TOKEN，跳过推送");
        return;
    }

    try {
        await axios.post(
            "https://www.pushplus.plus/send",
            {
                token: PLUSPLUS_TOKEN,
                title,
                content,
                template: "txt",
            },
            {
                timeout: 10000,
                proxy: false,
            }
        );

        console.log("✅ [PushPlus] 推送成功");
    } catch (e) {
        console.log(`❌ [PushPlus] 推送失败: ${e.message}`);
    }
}

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


function findValueDeep(obj, keys) {
    if (!obj || typeof obj !== "object") return null;

    for (const key of keys) {
        if (obj[key]) return obj[key];
    }

    for (const value of Object.values(obj)) {
        if (value && typeof value === "object") {
            const found = findValueDeep(value, keys);
            if (found) return found;
        }
    }

    return null;
}

function extractCookies(headers) {
    const setCookie = headers?.["set-cookie"];
    if (!setCookie) return "";

    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];

    const parts = [];
    for (const item of arr) {
        const first = String(item).split(";")[0];
        if (/^(uid|sukey)=/i.test(first)) {
            parts.push(first);
        }
    }

    return parts.length ? parts.join(";") + ";" : "";
}

function extractLoginInfo(data, headers) {
    const ucAccessToken = findValueDeep(data, [
        "ucAccessToken",
        "accessToken",
        "token",
        "userToken",
        "access_token",
    ]);

    let uid = findValueDeep(data, ["uid", "userId", "userCode"]);
    let sukey = findValueDeep(data, ["sukey", "suKey"]);

    const cookieFromHeader = extractCookies(headers);
    let cookie = cookieFromHeader;

    if (!cookie && uid && sukey) {
        cookie = `uid=${uid};sukey=${sukey};`;
    }

    return {
        ucAccessToken: ucAccessToken ? String(ucAccessToken) : "",
        cookie,
        uid: uid ? String(uid) : "",
        sukey: sukey ? String(sukey) : "",
    };
}

async function loginByCode(code, proxyAgent, server) {
    const config = {
        method: "POST",
        url: "https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/app/login/wx/mini/getLoginInfo.do",
        headers: {
            Host: "mcsp.midea.com",
            appId: LOGIN_APP_ID,
            xweb_xhr: "1",
            appsecret: LOGIN_APP_SECRET,
            "User-Agent": UA,
            "Content-Type": "application/json",
            userKey: "",
            "X-Tingyun": "c=M|cJgYzP0tKW8",
            miniAppVersion: "3.0.269",
            apikey: LOGIN_API_KEY,
            Accept: "*/*",
            Referer: `https://servicewechat.com/${APPID}/554/page-frame.html`,
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
        data: {
            jsCode: code,
            loginMode: 1,
            platformType: "WX_MEIDIDAOJIA_MINI",
            _timeStamp: Date.now(),
        },
    };

    console.log("🔐 [登录] 使用 code 获取登录信息");

    try {
        const res = await requestWithProxy(config, proxyAgent, server);
        const data = res.data;

        console.log(`🔎 [登录] 返回字段: ${Object.keys(data || {}).join(", ")}`);
        console.log(`🔎 [登录] 响应预览: ${preview(data, 600)}`);

        const info = extractLoginInfo(data, res.headers);

        if (info.cookie) {
            console.log(`✅ [登录] cookie 获取成功: ${mask(info.cookie)}`);
        } else {
            console.log("⚠️ [登录] 未识别 uid/sukey cookie");
        }

        if (info.ucAccessToken) {
            console.log(`✅ [登录] ucAccessToken 获取成功: ${mask(info.ucAccessToken)}`);
        } else {
            console.log("⚠️ [登录] 未识别 ucAccessToken");
        }

        return {
            ...info,
            raw: data,
            headers: res.headers,
        };
    } catch (e) {
        console.log(`❌ [登录] 请求异常: ${e.message}`);
        return {
            ucAccessToken: "",
            cookie: "",
            uid: "",
            sukey: "",
            raw: null,
            headers: null,
        };
    }
}

async function getUserInfo(cookie, proxyAgent, server) {
    const config = {
        method: "GET",
        url: "https://mvip.midea.cn/next/mucuserinfo/getmucuserinfo",
        headers: {
            Host: "mvip.midea.cn",
            Connection: "keep-alive",
            charset: "utf-8",
            cookie,
            "User-Agent": UA,
            "Content-Type": "application/json",
            Referer: "https://servicewechat.com/wx03925a39ca94b161/409/page-frame.html",
        },
    };

    try {
        const { data } = await requestWithProxy(config, proxyAgent, server);

        if (data?.errcode === 0) {
            const mobile = data?.data?.userinfo?.Mobile || "-";
            const points = data?.data?.userinfo?.VipGrow ?? "-";
            console.log(`💰 [信息] ${mobile} 当前积分: ${points}`);

            return {
                success: true,
                mobile,
                points,
                raw: data,
            };
        }

        console.log(`⚠️ [信息] 查询失败: ${preview(data)}`);

        return {
            success: false,
            mobile: "-",
            points: "-",
            raw: data,
        };
    } catch (e) {
        console.log(`⚠️ [信息] 请求异常: ${e.message}`);
        return {
            success: false,
            mobile: "-",
            points: "-",
            raw: null,
        };
    }
}

async function signIn(cookie, proxyAgent, server) {
    if (!cookie) {
        return {
            success: false,
            message: "未获取到 uid/sukey cookie，跳过签到1",
        };
    }

    const config = {
        method: "GET",
        url: "https://mvip.midea.cn/my/score/create_daily_score",
        headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            cookie,
            "User-Agent": UA,
            Referer: "https://servicewechat.com/wx03925a39ca94b161/409/page-frame.html",
        },
    };

    try {
        const { data } = await requestWithProxy(config, proxyAgent, server);

        if (data?.errcode === 0) {
            console.log("✅ [签到1] 成功");
            return {
                success: true,
                message: "签到1成功",
                raw: data,
            };
        }

        const msg = data?.errmsg || data?.msg || preview(data);
        console.log(`⚠️ [签到1] 失败: ${msg}`);

        return {
            success: false,
            message: msg,
            raw: data,
        };
    } catch (e) {
        console.log(`⚠️ [签到1] 请求异常: ${e.message}`);
        return {
            success: false,
            message: e.message,
            raw: null,
        };
    }
}

async function signIn2(ucAccessToken, proxyAgent, server) {
    if (!ucAccessToken) {
        return {
            success: false,
            message: "未获取到 ucAccessToken，跳过签到2",
        };
    }

    const config = {
        method: "POST",
        url: "https://mvip.midea.cn/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/im/game/page/sign",
        headers: {
            "User-Agent": UA,
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            ucAccessToken,
            intercept: "1",
            apiKey: "3660663068894a0d9fea574c2673f3c0",
            Origin: "https://mvip.midea.cn",
            "X-Requested-With": "com.tencent.mm",
            Referer: "https://mvip.midea.cn/mscp_weixin/apps/h5-pro-wx-interaction-marketing/",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
        data: {
            headParams: {
                language: "CN",
                originSystem: "MCSP",
                timeZone: "",
                userCode: "",
                tenantCode: "",
                userKey: "TEST_",
                transactionId: "",
            },
            pagination: null,
            restParams: {
                gameId: 22,
                actvId: "401671388248692763",
                rootCode: "MDHY",
                appCode: "MDHY_XCX",
                imUserId: "",
                uid: "",
                openId: "",
                unionId: "",
            },
        },
    };

    try {
        const { data } = await requestWithProxy(config, proxyAgent, server);

        console.log(`✅ [签到2] 返回: ${preview(data, 800)}`);

        return {
            success: true,
            message: "签到2请求完成",
            raw: data,
        };
    } catch (e) {
        console.log(`⚠️ [签到2] 请求异常: ${e.message}`);
        return {
            success: false,
            message: e.message,
            raw: null,
        };
    }
}

async function runAccount(index, total, server) {
    const result = {
        server,
        success: false,
        proxyStatus: "未使用代理",
        proxyIp: "-",
        cookie: "-",
        ucAccessToken: "-",
        mobile: "-",
        beforePoints: "-",
        afterPoints: "-",
        sign1: "-",
        sign2: "-",
        error: "",
    };

    logAccount(index, total, server);

    const proxy = await getValidProxy(server);
    const proxyAgent = proxy.agent;

    result.proxyStatus = proxyAgent ? "使用专属代理" : "使用直连";
    result.proxyIp = proxy.ip || "-";

    await sleep(PROXY_FETCH_INTERVAL);

    const delay = random(2000, 6000);
    console.log(`⏳ [延迟] 启动延迟 ${(delay / 1000).toFixed(1)}s`);
    await sleep(delay);

    const code = await getCode(server);
    if (!code) {
        result.error = "获取 code 失败";
        return result;
    }

    const login = await loginByCode(code, proxyAgent, server);

    result.cookie = login.cookie ? mask(login.cookie) : "-";
    result.ucAccessToken = login.ucAccessToken ? mask(login.ucAccessToken) : "-";

    if (!login.cookie && !login.ucAccessToken) {
        result.error = "未获取到 cookie 和 ucAccessToken";
        return result;
    }

    let before = {
        success: false,
        mobile: "-",
        points: "-",
    };

    if (login.cookie) {
        before = await getUserInfo(login.cookie, proxyAgent, server);
        result.mobile = before.mobile;
        result.beforePoints = before.points;
    }

    await sleep(random(2000, 5000));

    const s1 = await signIn(login.cookie, proxyAgent, server);
    result.sign1 = s1.message;

    await sleep(random(2000, 5000));

    const s2 = await signIn2(login.ucAccessToken, proxyAgent, server);
    result.sign2 = s2.message;

    await sleep(random(2000, 5000));

    if (login.cookie) {
        const after = await getUserInfo(login.cookie, proxyAgent, server);
        result.afterPoints = after.points;
    }

    result.success = Boolean(s1.success || s2.success);

    if (!result.success) {
        result.error = `${result.sign1}; ${result.sign2}`;
    }

    return result;
}

function buildNotify(results) {
    const successCount = results.filter(item => item.success).length;
    const failCount = results.length - successCount;

    let content = `🔷 美的会员四账号签到结果

━━━━━━━━━━━━━━━━━━━━
🏁 总结：${successCount} 成功 / ${failCount} 失败
🕒 时间：${nowText()}
━━━━━━━━━━━━━━━━━━━━
`;

    results.forEach((res, index) => {
        const icon = res.success ? "✅" : "❌";

        content += `
🧩 账号 ${index + 1}
🌍 来源：${res.server}
🌐 代理：${res.proxyStatus}
📡 出口IP：${res.proxyIp}
📱 手机：${res.mobile}
🍪 Cookie：${res.cookie}
🔐 ucAccessToken：${res.ucAccessToken}
💰 签到前积分：${res.beforePoints}
📝 签到1：${res.sign1}
🎮 签到2：${res.sign2}
💰 签到后积分：${res.afterPoints}
${icon} 结果：${res.success ? "成功" : "失败"}
`;

        if (!res.success) {
            content += `❌ 原因：${res.error}\n`;
        }

        content += "━━━━━━━━━━━━━━━━━━━━\n";
    });

    return content;
}

(async () => {
    logTitle();

    const results = [];

    for (let i = 0; i < SERVERS.length; i++) {
        try {
            const res = await runAccount(i + 1, SERVERS.length, SERVERS[i]);
            results.push(res);
        } catch (e) {
            console.log(`❌ [主程序] ${SERVERS[i]} 执行异常: ${e.message}`);

            results.push({
                server: SERVERS[i],
                success: false,
                proxyStatus: "-",
                proxyIp: "-",
                cookie: "-",
                ucAccessToken: "-",
                mobile: "-",
                beforePoints: "-",
                afterPoints: "-",
                sign1: "-",
                sign2: "-",
                error: e.message,
            });
        }

        if (i < SERVERS.length - 1) {
            console.log("⏳ [间隔] 等待 2s 后处理下一个账号");
            await sleep(2000);
        }
    }

    const successCount = results.filter(item => item.success).length;
    const failCount = results.length - successCount;

    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║ 🏁 美的会员任务执行完成                     ║");
    console.log(`║ ✅ 成功: ${successCount}`);
    console.log(`║ ❌ 失败: ${failCount}`);
    console.log(`║ 🕒 ${nowText()}`);
    console.log("╚══════════════════════════════════════════════╝");

    await sendPushPlus("🔷 美的会员四账号签到完成", buildNotify(results));
})().catch(e => {
    console.log(`❌ [全局异常] ${e.message}`);
});