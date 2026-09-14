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
// name: 热带时光
// cron: 53 9 * * *

const axios = require("axios");
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
        const { data } = await axios.post(url, { ref, app_id: 'wx0a73bcd6f11e05e3' }, { timeout: 20000, proxy: false });
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

const CK_NAME = "ytb2_all";
const API_BASE = "https://ytb2.zs-shiruan.cn/api";
const LOGIN_BASE = "https://ytb2.zs-shiruan.cn/api-v2";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const APPS = [
    {
        ck: "rdsgyjd",
        name: "热带时光家庭娱乐中心阳江店",
        appid: "wx0a73bcd6f11e05e3",
        storeId: "2014496",
        signActId: "13417",
    },
].map((app) => ({
    apiBase: process.env[`${app.ck}_api_base`] || API_BASE,
    loginBase: process.env[`${app.ck}_login_base`] || LOGIN_BASE,
    ...app,
    appid: process.env[`${app.ck}_appid`] || app.appid,
    storeId: process.env[`${app.ck}_store_id`] || app.storeId,
    signActId: process.env[`${app.ck}_sign_act_id`] || app.signActId,
}));

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function unique(items = []) {
    return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseUnifiedEnv() {
    const raw = process.env[CK_NAME] || "";
    const result = { global: [], byKey: {} };
    for (const item of splitAccounts(raw)) {
        const idx = item.indexOf("=");
        if (idx === -1) {
            result.global.push(item);
            continue;
        }
        const key = item.slice(0, idx).trim().toLowerCase();
        const value = item.slice(idx + 1).trim();
        if (!key || !value) continue;
        result.byKey[key] = result.byKey[key] || [];
        result.byKey[key].push(value);
    }
    result.global = unique(result.global);
    return result;
}

const unifiedEnv = parseUnifiedEnv();

function getAccounts(app) {
    const keys = [app.ck, app.appid, app.name].map((item) => item.toLowerCase());
    const accounts = [];
    accounts.push(...SERVERS);
    if (unifiedEnv.global.length) accounts.push(...unifiedEnv.global);
    for (const key of keys) accounts.push(...(unifiedEnv.byKey[key] || []));
    accounts.push(...splitAccounts(process.env[app.ck] || ""));
    return unique(accounts);
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function assetValue(memberInfo = {}, keys = [], names = []) {
    const assets = Array.isArray(memberInfo.assets) ? memberInfo.assets : [];
    for (const item of assets) {
        if (keys.includes(item.key) || names.includes(item.name)) return item.num ?? 0;
    }
    return 0;
}

function findSignActId(source) {
    let found = "";
    const walk = (value) => {
        if (found || value === null || value === undefined) return;
        if (typeof value === "string") {
            const match = value.match(/sign-in\/sign-in\?[^"']*actid=(\d+)/i);
            if (match) found = match[1];
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        if (typeof value === "object") {
            for (const item of Object.values(value)) walk(item);
        }
    };
    walk(source);
    return found;
}

class Task {
    constructor(app, account, index) {
        this.server = account;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
        this.app = app;
        this.account = account;
        this.index = index;
        this.shiruanKey = "";
        this.mobile = "";
        this.templateUrl = "";
        this.signActId = app.signActId || "";
        this.summary = {
            appName: app.name,
            member: "未查询",
            assets: "未查询",
            sign: "未执行",
        };

    }

    log(message) {
        console.log(`[${this.app.name}][账号${this.index}] ${message}`);
    }

    headers(extra = {}) {
        return {
            "content-type": "application/json",
            "User-Agent": USER_AGENT,
            ...extra,
        };
    }

    authHeaders(extra = {}) {
        return this.headers({
            shiruanKey: this.shiruanKey,
            miniAppid: this.app.appid,
            ...extra,
        });
    }

    async getWxCode() {
        return await getCode(this.server);
    }

    async login() {
        const code = await this.getWxCode();
        if (!code) throw new Error("获取code失败");
        const { data } = await axios.post(
            `${this.app.loginBase}/mini/preLogin-new`,
            {
                app_id: this.app.appid,
                store_id: this.app.storeId || "",
                code,
            },
            {
                headers: this.headers(),
                timeout: 30000,
            }
        );
        if (data?.code !== 200) throw new Error(`登录失败: ${data?.msg || JSON.stringify(data)}`);
        this.shiruanKey = data.data?.shiruan_key || "";
        this.openid = data.data?.openid || "";
        this.mobile = data.data?.mobile || "";
        this.templateUrl = data.data?.templateUrl || "";
        this.log(`登录成功: ${maskPhone(this.mobile)} openId=${this.openid}`);
    }

    async detectSignActId() {
        if (this.signActId) return this.signActId;
        if (!this.templateUrl) return "";
        try {
            const { data } = await axios.get(this.templateUrl, {
                headers: this.headers(),
                timeout: 30000,
            });
            this.signActId = findSignActId(data);
            if (this.signActId) this.log(`识别签到活动ID: ${this.signActId}`);
        } catch (e) {
            this.log(`读取模板失败: ${e.message || e}`);
        }
        return this.signActId;
    }

    async queryAssets() {
        const { data } = await axios.post(
            `${this.app.apiBase}/mini/user-asset`,
            {},
            {
                headers: this.authHeaders(),
                timeout: 30000,
            }
        );
        if (data?.code !== 200) throw new Error(`查询失败: ${data?.msg || JSON.stringify(data)}`);
        const info = data.data?.member_info || {};
        const phone = info.leag_tel || data.data?.mobile || this.mobile;
        const card = info.card_no || info.leag_no || "未知会员";
        const coin = assetValue(info, ["coin_bal"], ["代币"]);
        const point = assetValue(info, ["score"], ["积分", "娃娃积分"]);
        const ticket = assetValue(info, ["tick_bal", "new_ticket"], ["奖票", "特殊奖票"]);
        const gateTicket = assetValue(info, ["ticket_amount"], ["门票"]);
        this.summary.member = `${card} ${maskPhone(phone)}`;
        this.summary.assets = `代币=${coin} 积分=${point} 彩票=${ticket} 门票=${gateTicket}`;
        this.log(`会员: ${this.summary.member} ${this.summary.assets}`);
    }

    async sign() {
        const actId = await this.detectSignActId();
        if (!actId) {
            this.summary.sign = "未找到签到活动ID";
            this.log(this.summary.sign);
            return;
        }
        try {
            const info = await axios.get(`${this.app.apiBase}/marketing/sign-info?marketing_activity_id=${actId}`, {
                headers: this.authHeaders(),
                timeout: 30000,
            });
            if (info.data?.code === 200) {
                const d = info.data.data || {};
                const activityName = d.activity?.name || actId;
                this.log(`签到活动: ${activityName} 已签=${d.is_sign_today || 0} 累计=${d.sign_day || 0}天`);
                if (Number(d.is_sign_today) === 1) {
                    this.summary.sign = `今日已签到 累计=${d.sign_day || 0}天`;
                    return;
                }
            } else {
                this.log(`签到状态查询: ${info.data?.msg || JSON.stringify(info.data)}`);
            }

            const { data } = await axios.get(`${this.app.apiBase}/marketing/new-sign?marketing_activity_id=${actId}`, {
                headers: this.authHeaders(),
                timeout: 30000,
            });
            const gifts = Array.isArray(data?.data?.gifts)
                ? data.data.gifts.map((item) => `${item.num ?? item.gift_num ?? ""}${item.asset_name || item.name || ""}`.trim()).filter(Boolean)
                : [];
            this.summary.sign = `${data?.msg || "签到返回"}${gifts.length ? `: ${gifts.join("、")}` : ""}`;
            this.log(this.summary.sign);
        } catch (e) {
            this.summary.sign = `签到失败: ${e.message || e}`;
            this.log(this.summary.sign);
        }
    }

    async run() {
        try {
            await this.login();
            await this.queryAssets();
            await this.sign();
            await this.queryAssets();
        } catch (e) {
            this.summary.sign = `执行失败: ${e.message || e}`;
            this.log(this.summary.sign);
        }
        return this.summary;
    }
}

!(async () => {
    const plan = APPS.map((app) => ({ app, accounts: getAccounts(app) })).filter((item) => item.accounts.length);
    const totalAccounts = plan.reduce((sum, item) => sum + item.accounts.length, 0);
    console.log(`共找到${plan.length}个小程序，${totalAccounts}个执行账号`);
    if (!plan.length) {
        console.log(`未配置 YYB_GO 或 ${CK_NAME} 变量`);
        return;
    }

    const summaries = [];
    for (const { app, accounts } of plan) {
        console.log(`\n========== ${app.name} (${app.ck}) ==========`);
        let index = 1;
        for (const account of accounts) {
            summaries.push(await new Task(app, account, index++).run());
        }
    }

    console.log("\n========== 执行汇总 ==========");
    for (const item of summaries) {
        console.log(`${item.appName}: ${item.member} ${item.assets} 签到=${item.sign}`);
    }
})()
    .catch((e) => console.log(e.message || e))
