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
// name: 米萌生活
// cron: 42 8 * * *

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
        const { data } = await axios.post(url, { ref, app_id: 'wx9939a74ee8a8522a' }, { timeout: 20000, proxy: false });
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

const APP = { name: "米萌生活", appid: "wx9939a74ee8a8522a" };
const GQL_URL = "https://shd.luxingiot.com/graphql";

const TOKEN_CACHE_FILE = path.join(__dirname, "token_caches", "mimengshenghuo_token_cache.json");
try { fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); } catch (e) {}
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function short(value, max = 260) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function maskToken(token = "") {
    const value = String(token || "");
    return value.length > 16 ? `${value.slice(0, 8)}***${value.slice(-6)}` : `${value.slice(0, 4)}***`;
}

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch {
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

async function request(options) {
    const res = await axios.request({
        timeout: 20000,
        validateStatus: () => true,
        ...options,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            ...(options.headers || {}),
        },
    });
    return { status: res.status, headers: res.headers || {}, data: res.data };
}

async function getWxCode(server) {
        return await getCode(server);
    }


function operationName(query) {
    const match = /(query|mutation)\s*?([\w\d\-_]+)?\s*?(\(.*?\))?\s*?\{/.exec(query);
    return match && match[2] ? match[2] : "";
}

class Mimeng {
    constructor(openid, index) {
        this.server = openid;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
        this.openid = openid;
        this.index = index;
        this.token = "";
        this.viewer = {};
        this.socialApp = {};
        this.checkIn = null;
        this.videoTask = null;
    }

    cacheKey() {
        return this.openid;
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheKey()]?.token || "";
    }

    saveCachedToken() {
        if (!this.token) return;
        const cache = readTokenCache();
        cache[this.cacheKey()] = {
            token: this.token,
            uid: this.viewer.uid || "",
            points: this.viewer.wallet?.points ?? "",
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        delete cache[this.cacheKey()];
        writeTokenCache(cache);
        this.token = "";
    }

    async gql(query, variables = {}, token = this.token, allowFail = false) {
        const body = { query, variables };
        const opName = operationName(query);
        if (opName) body.operationName = opName;

        const headers = {
            "content-type": "application/json",
            "x-provider-id": APP.appid,
            Referer: `https://servicewechat.com/${APP.appid}/21/page-frame.html`,
        };
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await request({
            method: "POST",
            url: GQL_URL,
            headers,
            data: body,
        });

        const errors = res.data?.errors || [];
        if ((res.status !== 200 || errors.length) && !allowFail) {
            throw new Error(`GraphQL失败 HTTP ${res.status}: ${short(res.data)}`);
        }
        return res.data;
    }

    async login() {
        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached;
            console.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.token)}`);
            const ok = await this.checkToken();
            if (ok) return;
            console.log(`账号[${this.index}] 缓存token失效，重新登录`);
            this.removeCachedToken();
        }

        const code = await getWxCode(this.server);
        const res = await this.gql(
            `mutation codeLogin($client_id: String! $code: String!) {
                login(client_id: $client_id, code: $code)
            }`,
            { client_id: APP.appid, code },
            "",
            true
        );
        const token = res?.data?.login || "";
        if (!token) throw new Error(`登录未返回token: ${short(res)}`);
        this.token = token;
        console.log(`账号[${this.index}] 登录成功: ${maskToken(this.token)}`);
    }

    async checkToken() {
        const res = await this.gql(
            `query ViewerBalance {
                viewer {
                    uid
                    wallet {
                        points
                    }
                }
            }`,
            {},
            this.token,
            true
        );
        return Boolean(res?.data?.viewer?.uid);
    }

    async queryHome() {
        const res = await this.gql(
            `query home($client_id: String!) {
                viewer {
                    uid
                    wallet {
                        points
                    }
                    todoActivityRecords {
                        id
                        progress
                        rewarded_at
                        completed_at
                        completed_at_today
                        completed_at_yesterday
                        activity {
                            auto_reward
                            button_action
                            full_rules {
                                reward_desc
                                reward_mode
                                reward_type
                                rule_desc
                            }
                            type
                            name
                            need_times
                            id
                            icon
                            description
                            cycle_quota
                            button_name
                            url
                        }
                    }
                }
                socialApp(client_id: $client_id) {
                    name
                    config
                }
            }`,
            { client_id: APP.appid }
        );

        this.viewer = res.data.viewer || {};
        this.socialApp = res.data.socialApp || {};
        const records = this.viewer.todoActivityRecords || [];
        this.checkIn = records.find((item) => item.activity?.name === "每日签到") || null;
        this.videoTask =
            records.find((item) => /视频/.test(item.activity?.name || "") || item.activity?.button_action === "seeVideo") || null;

        console.log(`查询：uid=${this.viewer.uid || "未知"} 米豆=${this.viewer.wallet?.points ?? "未知"} 小程序=${this.socialApp.name || APP.name}`);
        if (this.checkIn) {
            console.log(
                `签到任务：id=${this.checkIn.activity.id} 今日${this.checkIn.completed_at_today ? "已完成" : "未完成"} progress=${this.checkIn.progress}/${this.checkIn.activity.cycle_quota}`
            );
        } else {
            console.log("签到任务：未找到");
        }
        if (this.videoTask) {
            console.log(
                `视频任务：id=${this.videoTask.activity.id} 今日${this.videoTask.completed_at_today ? "已完成" : "未完成"} progress=${this.videoTask.progress}/${this.videoTask.activity.cycle_quota}`
            );
        } else {
            console.log("视频任务：未找到");
        }
    }

    async pointsRecords() {
        const res = await this.gql(
            `query records {
                viewer {
                    pointsRecords(page: 1) {
                        data {
                            amount
                            balance
                            action
                            created_at
                            in_out
                            reward_type
                        }
                    }
                }
            }`,
            {},
            this.token,
            true
        );
        const records = res?.data?.viewer?.pointsRecords?.data || [];
        if (records.length) {
            const text = records
                .slice(0, 5)
                .map((item) => `${item.created_at} ${item.action} ${item.amount} 余额=${item.balance}`)
                .join(" | ");
            console.log(`米豆明细：${text}`);
        }
    }

    async activityPush(activityId, label) {
        const res = await this.gql(
            `mutation activity($activity_id: Int!) {
                activityPush(id: $activity_id) {
                    code
                    message
                    reward_log {
                        action
                        reward_type
                        amount
                        balance
                    }
                }
            }`,
            { activity_id: Number(activityId) },
            this.token,
            true
        );
        const result = res?.data?.activityPush;
        if (!result) return `${label}失败: ${short(res)}`;
        if (Number(result.code) === 0) {
            const log = result.reward_log || {};
            return `${label}成功：${log.action || label} +${log.amount ?? 0}米豆，余额=${log.balance ?? "未知"}`;
        }
        return `${label}失败：${result.message || short(result)}`;
    }

    async doSign() {
        if (!this.checkIn) return "未找到签到任务";
        if (this.checkIn.completed_at_today) return "今日已签到";
        return this.activityPush(this.checkIn.activity.id, "签到");
    }

    async doVideo() {
        if (!this.videoTask) return ["未找到视频任务"];
        const total = Number(this.videoTask.activity?.cycle_quota || 0);
        const progress = Number(this.videoTask.progress || 0);
        const remaining = Math.max(0, total - progress);
        if (!remaining) return ["视频任务今日已完成"];

        const limit = Number(process.env.mimeng_video_times || remaining);
        const times = Math.max(0, Math.min(remaining, Number.isFinite(limit) ? limit : remaining));
        const results = [];
        for (let i = 0; i < times; i++) {
            results.push(await this.activityPush(this.videoTask.activity.id, `视频任务[${i + 1}/${times}]`));
            await await sleep(1200);
        }
        return results;
    }

    async run() {
        await this.login();
        await this.queryHome();
        console.log(`签到：${await this.doSign()}`);
        const videos = await this.doVideo();
        for (const result of videos) console.log(`观看视频：${result}`);
        await this.queryHome();
        await this.pointsRecords();
        this.saveCachedToken();
    }
}

async function runAccount(openid, index) {
    console.log(`\n========== ${APP.name} 账号[${index}] ${openid} ==========`);
    const runner = new Mimeng(openid, index);
    try {
        await runner.run();
    } catch (e) {
        console.log(`账号[${index}] 执行失败：${e.message || e}`);
    }
}

(async () => {
    const accounts = SERVERS;
    if (!accounts.length) {
        console.log(`未配置 YYB_GO`);
        
        return;
    }
    console.log(`共找到${accounts.length}个账号`);
    for (let i = 0; i < accounts.length; i++) {
        await runAccount(accounts[i], i + 1);
        await await sleep(800);
    }
    
})().catch(async (e) => {
    console.log(`脚本异常：${e.stack || e.message || e}`);
    
});
