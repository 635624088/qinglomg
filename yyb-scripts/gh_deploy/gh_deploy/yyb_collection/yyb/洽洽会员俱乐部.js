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
// name: 洽洽会员俱乐部
// cron: 31 8 * * *

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

const MINI_APP_ID = "wxc72491b6cd007333";
const PAGE_VERSION = "520";
const TENANT_ID = "1";
const USER_ID = "c10cff02123a9e2697d875262612399d";
const VIP_BASE = "https://vip.qiaqiafood.com";
const MOBILE_BASE = "https://qq-tasting-hall.qiaqiafood.com/mobile";
const TOKEN_CACHE_FILE = path.join(__dirname, "token_caches", "qiaqia_token_cache.json");
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

function getSessionId(headers = {}) {
    const cookies = headers["set-cookie"] || headers["Set-Cookie"] || headers["set-Cookie"];
    const list = Array.isArray(cookies) ? cookies : (cookies ? [cookies] : []);
    for (const cookie of list) {
        const match = String(cookie).match(/(?:^|;\s*)SESSION=([^;]+)/);
        if (match) return match[1];
    }
    return "";
}

function today() {
    const date = new Date();
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function isLoginError(message) {
    return /登录|授权|SESSION|token|-2|401|403|expire|过期|失效/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.server = openid;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
        this.index = userIdx++;
        this.openid = String(openid || "").trim();
        this.session = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.session = cached;
            console.log(`账号[${this.index}] 使用缓存登录态`);
            if (!(await this.checkSession())) {
                this.removeCachedToken();
                console.log(`账号[${this.index}] 缓存登录态失效，重新登录`);
            }
        }

        if (!this.session.sessionId) {
            await this.login();
            if (!this.session.sessionId) return;
        }

        await this.doSign();
        // 浏览页面任务（VISIT_PAGE），浏览商城10秒，每天2次
        await this.doVisitPage();
        this.saveCachedToken();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.session.sessionId) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            sessionId: this.session.sessionId,
            token: this.session.token || "",
            loginId: this.session.loginId || "",
            customerId: this.session.customerId || "",
            uid: this.session.uid || "",
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
        this.session = {};
    }

    async getLoginCode() {
        return await getCode(this.server);
    }

    commonHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "charset": "utf-8",
            ...extra,
        };
    }

    // vip 侧接口用 JSON
    vipHeaders(extra = {}) {
        return this.commonHeaders({
            "content-type": "application/json",
            "Authorization": this.session.token || "",
            ...extra,
        });
    }

    // mobile 侧接口用 form（登录时用）
    mobileHeaders(extra = {}) {
        return this.commonHeaders({
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "from_env": "app",
            ...extra,
        });
    }

    async login() {
        try {
            await this.loginMobile();
            await this.loginUpms();
            this.saveCachedToken();
            console.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            console.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async loginMobile() {
        const code = await this.getLoginCode();
        if (!code) throw new Error("获取code失败");

        const body = new URLSearchParams();
        body.append("code", code);
        body.append("userId", USER_ID);

        const res = await axios.post(`${MOBILE_BASE}/wechat/login`, body.toString(), {
            headers: this.mobileHeaders(),
            timeout: 20000,
            validateStatus: () => true,
        });

        if (res.status !== 200 || String(res.data?.status) !== "0") {
            throw new Error(res.data?.msg || `mobile登录失败 HTTP ${res.status}`);
        }

        const mobileSession = getSessionId(res.headers);
        if (mobileSession) this.session.sessionId = mobileSession;
        const cust = res.data?.customer || {};
        this.session.customerId = cust.id || "";
        this.session.customer = cust;
        if (cust.token && !this.session.token) {
            this.session.token = cust.token;
        }
        // 优先用 customer 中的 userId 作为 uid
        if (cust.userId && !this.session.uid) {
            this.session.uid = cust.userId;
        }
    }

    async loginUpms() {
        const code = await this.getLoginCode();
        if (!code) throw new Error("获取code失败");

        // 从 customer 中获取 unionId，HAR 中 upms 用 uid=userId 登录
        const uid = this.session.customer?.unionId || this.session.uid || "";
        const res = await axios.post(`${VIP_BASE}/upms/wechat/login/code`, {
            code,
            tenantId: TENANT_ID,
            appId: MINI_APP_ID,
            componentAppId: MINI_APP_ID,
            uid: uid,
        }, {
            headers: this.vipHeaders({ Authorization: this.session.token || "" }),
            timeout: 20000,
            validateStatus: () => true,
        });

        if (res.status !== 200 || !res.data?.success || String(res.data?.status) !== "0") {
            throw new Error(res.data?.msg || `upms登录失败 HTTP ${res.status}`);
        }

        const payload = res.data?.data || {};
        this.session.token = payload.token || this.session.token || "";
        this.session.loginId = payload.loginId || "";
        // 从返回中提取 uid（account.userId），每个号不同
        this.session.uid = payload.account?.userId || uid || "";
    }

    // 签到相关接口用 vip/member（HAR 中的实际路径）
    async vipPost(apiPath, data = {}) {
        if (!this.session.token) throw new Error("缺少token");
        const res = await axios.post(`${VIP_BASE}${apiPath}`, {
            ...data,
            uid: this.session.uid || "",
            tenantId: TENANT_ID,
        }, {
            headers: this.vipHeaders(),
            timeout: 20000,
            validateStatus: () => true,
        });

        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        // HAR: status === "0" 且 success === true 才成功
        if (!res.data?.success || String(res.data?.status) !== "0") {
            throw new Error(res.data?.msg || `接口异常: ${res.data?.status || "unknown"}`);
        }
        return res.data;
    }

    async checkSession() {
        try {
            await this.vipPost("/vip/member/listUserSignLog", { yearMonth: today().slice(0, 7) });
            return true;
        } catch (e) {
            return false;
        }
    }

    async getSignLogs(yearMonth) {
        const data = await this.vipPost("/vip/member/listUserSignLog", { yearMonth });
        return data?.data || [];
    }

    async doSign() {
        try {
            const ym = today().slice(0, 7);
            const signLogs = await this.getSignLogs(ym);
            const signedToday = Array.isArray(signLogs) && signLogs.some(
                (item) => String(item?.dayMonth || "") === String(new Date().getDate())
            );

            if (signedToday) {
                const last = signLogs[signLogs.length - 1];
                console.log(`账号[${this.index}] 今日已签到，连续${last?.continueDays || 0}天`);
                return;
            }

            // HAR: /vip/member/sign，body: { channel: "", uid, tenantId }
            const res = await this.vipPost("/vip/member/sign", { channel: "" });
            const rd = res?.data || {};
            console.log(`账号[${this.index}] 签到成功，积分+${rd.value || 1}，连续${rd.continueDays || 0}天`);
        } catch (e) {
            const message = e.message || e;
            if (/已签到|每天只能签到一次|重复|今日已/.test(String(message))) {
                console.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            console.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isLoginError(message)) this.removeCachedToken();
        }
    }

    // ====== 浏览页面任务（VISIT_PAGE） ======

    async getIntegralTaskList() {
        const data = await this.vipPost("/vip/member/listIntegralTask", {});
        return data?.data || [];
    }

    async getPointTaskConfig() {
        const data = await this.vipPost("/vip/point/config/getPointTaskConfig", {});
        return data?.data || [];
    }

    async doVisitPage() {
        try {
            // 1. 获取任务配置：确定浏览时长和每日上限
            const configs = await this.getPointTaskConfig();
            const visitConfig = Array.isArray(configs)
                ? configs.find(c => c.taskType === "VISIT_PAGE")
                : null;
            if (!visitConfig || visitConfig.enable !== "T") {
                console.log(`账号[${this.index}] 没有可做的浏览任务`);
                return;
            }

            const limitPerDay = parseInt(visitConfig.limitValue || "2", 10);
            const duration = parseInt(visitConfig.undefined1 || "10", 10);
            const value = parseInt(visitConfig.giveValue || "2", 10);

            // 2. 获取当前任务完成情况
            const tasks = await this.getIntegralTaskList();
            const visitTask = Array.isArray(tasks)
                ? tasks.find(t => t.taskType === "VISIT_PAGE")
                : null;
            if (!visitTask) {
                console.log(`账号[${this.index}] 未找到浏览任务`);
                return;
            }

            const finishedCount = parseInt(visitTask.finishedCount || "0", 10);
            const remaining = limitPerDay - finishedCount;

            if (remaining <= 0) {
                console.log(`账号[${this.index}] 今日浏览任务已完成(${finishedCount}/${limitPerDay})`);
                return;
            }

            console.log(`账号[${this.index}] 浏览页面任务: 需完成${remaining}次, 每次${duration}秒, 每次+${value}积分`);

            // 3. 逐次完成任务，每次间隔 duration 秒
            for (let i = 0; i < remaining; i++) {
                console.log(`账号[${this.index}] 浏览第${finishedCount + i + 1}/${limitPerDay}次...`);
                await this.vipPost("/vip/member/taskFinished", { pointTaskType: "VISIT_PAGE" });
                console.log(`账号[${this.index}] 第${finishedCount + i + 1}次完成, +${value}积分`);
                if (i < remaining - 1) {
                    await sleep(duration * 1000);
                }
            }

            console.log(`账号[${this.index}] 浏览任务全部完成, 共+${value * remaining}积分`);
        } catch (e) {
            const message = e.message || e;
            if (/今日已完成|每天只能|重复/.test(String(message))) {
                console.log(`账号[${this.index}] 浏览任务今日已完成`);
                return;
            }
            console.log(`账号[${this.index}] 浏览任务失败: ${message}`);
            if (isLoginError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    for (let i = 0; i < SERVERS.length; i++) {
        try {
            await new Task(SERVERS[i]).run();
        } catch (e) {
            console.log(`账号[${i + 1}] 执行异常: ${e.message || e}`);
        }
    }
})()
    .catch((e) => console.log(e.message || e))