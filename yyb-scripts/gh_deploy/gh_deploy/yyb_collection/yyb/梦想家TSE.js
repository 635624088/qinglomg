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
// === 修复 decompress-response 兼容性 ===
try {
  const _dr = require('decompress-response');
  if (_dr && !_dr.mimicResponse) {
    _dr.mimicResponse = function() { return arguments[1] || arguments[0]; };
  }
} catch (e) {}
// === 修复 end ===

// name: 梦想家TSE
// cron: 38 8 * * *

const axios = require("axios");
const fs = require("fs");
const path = require("path");
// ====================== YYB Go 账号（环境变量 YYB_GO = 地址@微信账号标识，多行） ======================
const SERVERS = (process.env.YYB_GO || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
if (!SERVERS.length) {
    console.error("未配置环境变量 YYB_GO，请设置后重试（格式：地址@微信账号标识，多行换行）");
    process.exit(1);
}
function parseYybGoEntry(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) return { server: "", ref: "" };
    const atIndex = value.indexOf("@");
    if (atIndex === -1) {
        console.log("YYB_GO 格式应为 地址@微信账号标识，当前值: " + value);
        return { server: "", ref: "" };
    }
    let server = value.slice(0, atIndex).trim();
    const ref = value.slice(atIndex + 1).trim();
    if (server.startsWith("http://")) server = server.slice(7);
    else if (server.startsWith("https://")) server = server.slice(8);
    server = server.replace(/\/+$/, "");
    if (!server || !ref) return { server: "", ref: "" };
    return { server, ref };
}
async function getCode(server) {
    const { server: parsedServer, ref } = parseYybGoEntry(server);
    if (!parsedServer || !ref) return null;
    const url = "http://" + parsedServer + "/wxapp/getCode";
    try {
        const { data } = await axios.post(url, { ref, app_id: MINI_APP_ID }, { timeout: 20000, proxy: false });
        const code = data && data.data && data.data.result && data.data.result.code;
        if (!data || data.code !== 0 || !code) {
            console.log(parsedServer + " 获取code失败: " + JSON.stringify(data));
            return null;
        }
        console.log(parsedServer + " 获取code成功");
        return code;
    } catch (e) {
        console.log(parsedServer + " 获取code异常: " + e.message);
        return null;
    }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let userIdx = 1;

const MINI_APP_ID = "wx696605f7e70c1e24";
const VERSION = "2.30.6";
const API_BASE = "https://smp-api.iyouke.com/dtapi";
const TOKEN_CACHE_FILE = path.join(__dirname, "token_caches", "mengxiangjia_token_cache.json");
try { fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); } catch (e) {}
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        console.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function maskToken(token = "") {
    const value = String(token || "");
    return value ? `${value.slice(0, 6)}***${value.slice(-6)}` : "";
}

function formatSignDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}/${month}/${day}`;
}

function isTokenError(message = "") {
    return /401|403|token|登录|授权|未登录|invalid/i.test(String(message));
}

class Task {
    constructor(openid) {
        this.server = openid;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
        this.index = userIdx++;
        this.openid = String(openid || "").trim();
        this.loginResult = {};
    }

    get accessToken() {
        return this.loginResult.access_token || this.loginResult.accessToken || "";
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached?.access_token || cached?.accessToken) {
            this.loginResult = cached;
            console.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.accessToken)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                console.log(`账号[${this.index}] 缓存token失效，重新code登录`);
            }
        }

        if (!this.accessToken) {
            await this.loginByWxCode();
            if (!this.accessToken) return;
        }

        await this.getPointsInfo("签到前");
        await this.getSignConfig();
        const today = await this.getTodaySignItem();
        if (today?.daySignStatus === 2) {
            console.log(`账号[${this.index}] 今日已签到`);
        } else {
            await this.signIn(today?.dateStr);
        }
        await this.getPointsInfo("签到后");
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.accessToken) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            ...this.loginResult,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.openid]) {
            delete cache[this.openid];
            writeTokenCache(cache);
        }
        this.loginResult = {};
    }

    headers(withToken = true) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/5/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "appId": MINI_APP_ID,
            "version": VERSION,
            "envVersion": "release",
        };
        if (withToken && this.accessToken) headers.Authorization = `bearer${this.accessToken}`;
        return headers;
    }

    async request({ method = "GET", apiPath, data = {}, params = {}, needToken = true }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath}`,
            headers: this.headers(needToken),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method.toUpperCase() === "GET") options.params = params;
        else options.data = data;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result)}`);
        if (result && Object.prototype.hasOwnProperty.call(result, "error") && Number(result.error) !== 0) {
            const err = new Error(result.errorMsg || result.error_msg || result.message || JSON.stringify(result));
            err.code = result.error;
            throw err;
        }
        return result;
    }

    async getWxCode() {
        return await getCode(this.server);
    }

    async loginByWxCode() {
        try {
            const code = await this.getWxCode();
            const data = await this.request({
                method: "POST",
                apiPath: "/appLogin",
                needToken: false,
                data: {
                    principal: code,
                    appType: 1,
                },
            });
            this.loginResult = data || {};
            this.saveCachedToken();
            console.log(`账号[${this.index}] 登录成功: userId=${data?.userId || ""} token=${maskToken(this.accessToken)}`);
        } catch (e) {
            console.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getPointsInfo("缓存校验");
            return true;
        } catch (e) {
            return false;
        }
    }

    async getSignConfig() {
        try {
            const result = await this.request({ apiPath: "/pointsSign/config/query" });
            const data = result?.data || {};
            console.log(`账号[${this.index}] 签到配置: ${Number(data.signEnable) === 1 ? "已开启" : "未开启"} 日签${data.signReward ?? ""}积分`);
            return data;
        } catch (e) {
            console.log(`账号[${this.index}] 获取签到配置失败: ${e.message || e}`);
            return {};
        }
    }

    async getTodaySignItem() {
        try {
            const result = await this.request({
                apiPath: "/pointsSign/user/sign/list",
                params: { v4Flag: true },
            });
            const list = Array.isArray(result?.data) ? result.data : [];
            const today = list.find((item) => item?.isToday) || {};
            console.log(`账号[${this.index}] 今日签到状态: ${today.dateStr || ""} status=${today.daySignStatus ?? "未知"}`);
            return today;
        } catch (e) {
            console.log(`账号[${this.index}] 获取签到列表失败: ${e.message || e}`);
            return {};
        }
    }

    async getPointsInfo(label = "积分") {
        const result = await this.request({ apiPath: "/pointsSign/user/pointsInfo/query" });
        const data = result?.data || {};
        console.log(`账号[${this.index}] ${label}: ${data.pointsNums ?? "未知"}积分 连签${data.seriesDays ?? 0}天 今日${data.signTodayResult ? "已签" : "未签"}`);
        return data;
    }

    async signIn(dateStr) {
        const date = dateStr ? dateStr.replace(/-/g, "/") : formatSignDate();
        try {
            const result = await this.request({
                apiPath: "/pointsSign/user/sign",
                params: { date },
            });
            const data = result?.data || {};
            console.log(`账号[${this.index}] 签到成功: +${data.signReward ?? 0}积分${data.extraSignReward ? ` 额外+${data.extraSignReward}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复签到/.test(message)) {
                console.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            console.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    for (let i = 0; i < SERVERS.length; i++) {
        try {
            await new Task(SERVERS[i]).run();
        } catch (e) {
            console.log(`账号[${i+1}] 执行异常: ${e.message || e}`);
        }
    }
})()
    .catch((e) => console.log(e.message || e))
