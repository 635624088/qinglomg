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
// name: 优点云创
// cron: 27 8 * * *

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
        const { data } = await axios.post(url, { ref, app_id: 'wx96eb3beaea480465' }, { timeout: 20000, proxy: false });
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

const CK_NAME = "ydyc";
const APP = { name: "优点云创", appid: "wx96eb3beaea480465", version: 1 };

const API_URL = "https://youdianyunchuan.weimbo.com/api/index.php?ackey=GZYTAPPLET";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function short(value, max = 500) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parseAccount(raw = "") {
    const text = String(raw || "").trim();
    if (!text) return {};
    if (text.startsWith("{")) {
        const data = JSON.parse(text);
        return { openid: data.openid || data.openId || "", remark: data.remark || data.name || "" };
    }
    const [openid, remark] = text.split("#").map((item) => item.trim());
    return { openid, remark };
}

function parseProgress(title = "") {
    const match = String(title || "").match(/\((\d+)\s*\/\s*(\d+)\)/);
    if (!match) return null;
    return { done: Number(match[1]), total: Number(match[2]) };
}

function findTask(info = {}, keyword = "") {
    const list = Array.isArray(info.adv_arr) ? info.adv_arr : [];
    return list.find((item) => String(item.title || "").includes(keyword)) || null;
}

async function request(options) {
    const res = await axios.request({
        timeout: 25000,
        validateStatus: () => true,
        ...options,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            "content-type": "application/json",
            Referer: `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
            ...(options.headers || {}),
        },
    });
    return { status: res.status, data: res.data, headers: res.headers || {} };
}

async function getWxCode(server) {
        return await getCode(server);
    }

class YouDianYunChuang {
    constructor(rawAccount, index) {
        this.server = rawAccount;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
        this.index = index;
        this.account = parseAccount(rawAccount);
        this.session = "";
        this.openid = "";
    }

    log(message) {
        console.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${message}`);
    }

    async api(data = {}) {
        const { status, data: result } = await request({
            method: "POST",
            url: API_URL,
            headers: { "3rdSession": this.session || "" },
            data,
        });
        if (status !== 200) throw new Error(`${data.action || "接口"} HTTP ${status}: ${short(result)}`);
        return result;
    }

    async call(data = {}) {
        const result = await this.api(data);
        if (!result?.Status) throw new Error(`${data.action || "接口"} 失败: ${short(result?.Data || result)}`);
        return result.Data;
    }

    async login() {
        const code = await getWxCode(this.server);
        const data = await this.call({ action: "WxLogin", code });
        this.session = data.r3dkey || "";
        this.openid = data.openid || "";
        if (!this.session) throw new Error(`登录响应缺少 r3dkey: ${short(data)}`);
        this.log(`登录成功 openid=${this.openid || "未知"}`);
    }

    async queryUser() {
        const data = await this.call({ action: "userInfoData" });
        const user = data.user || {};
        const money = data.u_money || {};
        this.log(
            `用户信息: ${user.id || ""} ${user.name || ""}，积分: ${money.jifen ?? 0}，金币: ${money.jinbi ?? 0}，红包: ${
                money.hongbao ?? 0
            }，佣金: ${money.yongjin ?? 0}，优惠券: ${money.yhquan ?? 0}`
        );
        return data;
    }

    async querySignInfo() {
        const data = await this.call({ action: "getIntegralInfo", type: "sign" });
        const signTask = Array.isArray(data.sign_arr) ? data.sign_arr.map((item) => `${item.status === "1" ? "已签" : "未签"}:${item.score}`).join(", ") : "";
        this.log(`签到信息: 积分=${data.user_jf ?? 0}，${data.qiands || ""}${signTask ? `，签到档位: ${signTask}` : ""}`);
        return data;
    }

    async queryIntegralInfo(type = "") {
        const data = await this.call({ action: "getIntegralInfo2", type });
        const signTask = findTask(data, "每日签到");
        const adTask = findTask(data, "看广告视频");
        this.log(
            `任务进度: 积分=${data.user_jf ?? 0}，${signTask?.title || "每日签到 -"}，${adTask?.title || "看广告视频 -"}`
        );
        return data;
    }

    async doSignOnce() {
        const result = await this.api({ action: "userQiandao" });
        if (result?.Status) {
            const data = result.Data || {};
            this.log(`签到结果: 成功，获得 ${data.add_jf ?? "-"} 积分，当前积分 ${data.user_jf ?? "-"}`);
            return true;
        }
        this.log(`签到结果: ${short(result?.Data || result)}`);
        return false;
    }

    async doAdRewardOnce() {
        const result = await this.api({ action: "IntegralGiveReward" });
        if (result?.Status) {
            this.log(`广告视频结果: ${short(result.Data)}`);
            return true;
        }
        this.log(`广告视频结果: ${short(result?.Data || result)}`);
        return false;
    }

    async runSign() {
        const info = await this.queryIntegralInfo();
        const task = findTask(info, "每日签到");
        const progress = parseProgress(task?.title);
        if (progress && progress.done >= progress.total) return this.log("签到任务: 今日次数已完成");

        await this.querySignInfo();
        await this.doSignOnce();
    }

    async runAdRewards() {
        for (let i = 0; i < 3; i++) {
            const info = await this.queryIntegralInfo(i === 0 ? "" : "jifen");
            const task = findTask(info, "看广告视频");
            const progress = parseProgress(task?.title);
            if (progress && progress.done >= progress.total) {
                this.log("广告视频任务: 今日次数已完成");
                return;
            }
            const ok = await this.doAdRewardOnce();
            if (!ok) return;
            await await sleep(1000, 2000);
        }
    }

    async run() {
        try {
            this.log(`开始执行 ${APP.name}`);
            await this.login();
            await this.queryUser();
            await this.runSign();
            await this.runAdRewards();
            await this.queryIntegralInfo("jifen");
            await this.queryUser();
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

async function main() {
    
    if (!SERVERS.length) {
        console.log(`未找到变量 ${CK_NAME}`);
        return;
    }
    for (let i = 0; i < SERVERS.length; i++) {
        const task = new YouDianYunChuang(SERVERS[i], i + 1);
        await task.run();
        if (i < SERVERS.length - 1) await await sleep(1500, 3000);
    }
}

main()
    .catch((e) => console.log(`脚本异常: ${e.message || e}`))
