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
// name: 华住会
// cron: 37 9 * * *

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

const MINI_APP_ID = "wx286efc12868f2559";
const PACKAGE_VERSION = "580";

const LOGIN_BASE = "https://hweb-minilogin.huazhu.com/api";
const PERSONAL_BASE = "https://hweb-personalcenter.huazhu.com";
const SIGN_BASE = "https://appgw.huazhu.com";

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

function mask(value = "") {
  value = String(value || "");
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function parseAccount(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return {};

  if (text.startsWith("{")) {
    const data = JSON.parse(text);
    return {
      openid: data.openid || data.openId || "",
      sId: data.sId || data.sid || data.crossAuth || data.token || "",
      remark: data.remark || data.name || "",
    };
  }

  const [openid, sId, remark] = text.split("#").map((item) => item.trim());
  if (!sId && /^[0-9a-f]{32,}\d*$/i.test(openid) && !/^o[A-Za-z0-9_-]{20,}$/.test(openid)) {
    return { openid: "", sId: openid, remark: "" };
  }
  return { openid, sId, remark };
}

async function request(options) {
  const res = await axios.request({
    timeout: 25000,
    validateStatus: () => true,
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger MiniProgramEnv/Windows",
      Accept: "application/json, text/plain, */*",
      ...(options.headers || {}),
    },
  });
  return { status: res.status, data: res.data, headers: res.headers || {} };
}

async function getWxCode(server) {
        return await getCode(server);
    }


function wxHeaders(sId = "") {
  return {
    "Content-Type": "application/json",
    "Client-Platform": "WX-MP",
    version: "",
    sId,
    Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
  };
}

function signHeaders(sId = "") {
  return {
    "Content-Type": "application/json;charset=UTF-8",
    Origin: "https://cdn.huazhu.com",
    Referer: "https://cdn.huazhu.com/hzapp-signinfe/",
    sId,
  };
}

function ok(data) {
  return String(data?.businessCode) === "1000" || Number(data?.code) === 200;
}

class Huazhu {
  constructor(rawAccount, index) {
        this.server = rawAccount;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
    this.index = index;
    this.account = parseAccount(rawAccount);
    this.sId = this.account.sId || "";
    this.memberId = "";
  }

  log(message) {
    console.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${message}`);
  }

  async login() {
    if (this.sId) {
      this.log(`使用已有 sId: ${mask(this.sId)}`);
      return;
    }

    const code = await getWxCode(this.server);
    const { status, data } = await request({
      method: "POST",
      url: `${LOGIN_BASE}/applet/authCheck?code=${encodeURIComponent(code)}`,
      headers: wxHeaders(""),
      data: {},
    });
    if (status !== 200 || !ok(data) || !data?.Result) throw new Error(`登录失败 HTTP ${status}: ${short(data)}`);

    this.sId = data?.Extend?.crossAuth || data?.Data || "";
    this.memberId = data?.Extend?.memberId || "";
    if (!this.sId) throw new Error(`登录响应缺少 sId: ${short(data)}`);
    this.log(`登录成功 memberId=${this.memberId || "-"} sId=${mask(this.sId)}`);
  }

  async queryMember() {
    const { status, data } = await request({
      method: "POST",
      url: `${PERSONAL_BASE}/personalCenter/rightAndInterest/getBriefInfo`,
      headers: wxHeaders(this.sId),
      data: {},
    });
    if (status !== 200 || !ok(data)) throw new Error(`会员查询失败 HTTP ${status}: ${short(data)}`);

    const basic = data?.content?.basicInfo || {};
    const level = data?.content?.standardLevelInfo || {};
    this.memberId = basic.memberId || this.memberId;
    this.log(
      `会员信息: ${basic.name || basic.mobile || "-"}，等级: ${basic.memberLevelText || level.levelText || "-"}，积分: ${
        basic.point ?? "-"
      }，30天到期积分: ${basic.expireDay30Point ?? 0}，升级: ${level.upgradeText || "-"}`
    );
    return data;
  }

  async querySignHeader() {
    const { status, data } = await request({
      method: "GET",
      url: `${SIGN_BASE}/game/sign_header`,
      headers: signHeaders(this.sId),
    });
    if (status !== 200 || !ok(data)) throw new Error(`签到查询失败 HTTP ${status}: ${short(data)}`);

    const info = data?.content || {};
    this.log(
      `签到信息: 今日${info.signToday ? "已签" : "未签"}，签到积分: ${info.point ?? "-"}，会员积分: ${
        info.memberPoint ?? "-"
      }，年签到: ${info.yearSignInCount ?? "-"}，下个奖励: ${info.nextAwardName || "-"}`
    );
    return info;
  }

  async sign() {
    const before = await this.querySignHeader();
    if (before.signToday) {
      this.log("签到结果: 今日已签到");
      return before;
    }

    const date = Math.floor(Date.now() / 1000);
    const { status, data } = await request({
      method: "GET",
      url: `${SIGN_BASE}/game/sign_in`,
      params: { date },
      headers: signHeaders(this.sId),
    });

    if (ok(data)) {
      const content = data?.content || {};
      this.log(
        `签到结果: 成功，获得 ${content.point ?? "-"} 积分，活跃值 ${content.activityPoints ?? "-"}，年签到 ${
          content.yearSignInCount ?? "-"
        }`
      );
      return this.querySignHeader();
    }

    if (String(data?.businessCode) === "5010") {
      this.log("签到结果: 今日已签到");
      return this.querySignHeader();
    }
    throw new Error(`签到失败 HTTP ${status}: ${short(data)}`);
  }

  async run() {
    try {
      this.log("开始执行");
      await this.login();
      await this.queryMember();
      await this.sign();
      await this.queryMember();
    } catch (e) {
      this.log(`执行失败: ${e.message || e}`);
    }
  }
}

async function main() {
  
  const accounts = SERVERS && SERVERS.length ? SERVERS : splitAccounts(process.env["YYB_GO"]);
  if (!accounts.length) {
    console.log(`未找到变量 ${"YYB_GO"}`);
    return;
  }
  for (let i = 0; i < accounts.length; i++) {
    await new Huazhu(accounts[i], i + 1).run();
    if (i < accounts.length - 1) await await sleep(1500, 3000);
  }
}

main()
  .catch((e) => console.log(`脚本异常: ${e.message || e}`))
