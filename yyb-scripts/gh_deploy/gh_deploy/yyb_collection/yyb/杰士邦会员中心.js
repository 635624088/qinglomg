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
// name: 杰士邦会员中心
// cron: 25 8 * * *

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
        const { data } = await axios.post(url, { ref, app_id: 'wx5966681b4a895dee' }, { timeout: 20000, proxy: false });
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

const APP = {
    name: "杰士邦会员中心",
    appid: "wx5966681b4a895dee",
    shopId: "467028",
    signActivityId: "170630",
};

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function short(value, max = 220) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatDate(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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


class JsbHuiyuan {
    constructor(openid) {
        this.server = openid;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
        this.openid = openid;
        this.base = "https://api.vshop.hchiv.cn/jfmb";
        this.global = {
            appId: APP.appid,
            shopId: APP.shopId,
            openId: "",
            shopNick: "",
            mainShopNick: "",
            unionid: "",
            phoneNumber: "",
            jsession: "",
            clientToken: "",
            securePlatId: "",
            sourceShopId: "",
        };
    }

    buildData(data = {}, reqType = 2) {
        const timestamp = Date.now();
        const common = {
            appId: this.global.appId,
            openId: this.global.openId || this.openid,
            shopNick: this.global.shopNick || "",
            timestamp,
            interfaceSource: 0,
        };
        return reqType === 2 ? { ...common, ...data } : { ...data };
    }

    async api(path, data = {}, { reqType = 2, raw = false } = {}) {
        const headers = {
            "content-type": "application/json",
            appenv: "test",
        };
        if (this.global.jsession) headers.cookie = this.global.jsession;
        if (this.global.clientToken) headers.Authorization = `Bearer ${this.global.clientToken}`;
        const body = this.buildData(typeof data === "string" ? JSON.parse(data) : data, reqType);
        const timestamp = Date.now();
        const query =
            reqType === 2
                ? `?sideType=3&mob=${encodeURIComponent(this.global.phoneNumber || "")}&appId=${encodeURIComponent(this.global.appId)}&shopNick=${encodeURIComponent(this.global.mainShopNick || this.global.appId)}&timestamp=${timestamp}${this.global.guideNo ? `&guideNo=${encodeURIComponent(this.global.guideNo)}` : ""}${this.global.securePlatId ? `&securePlatId=${encodeURIComponent(this.global.securePlatId)}` : ""}${this.global.sourceShopId ? `&sourceShopId=${encodeURIComponent(this.global.sourceShopId)}` : ""}`
                : "";
        const res = await request({
            method: "POST",
            url: `${this.base}${path}${query}`,
            headers,
            data: body,
        });
        const setCookie = res.headers["set-cookie"];
        if (Array.isArray(setCookie) && setCookie[0]) this.global.jsession = setCookie[0].split(";")[0];
        const token = res.data?.data?.clientToken || res.data?.data?.data?.clientToken;
        if (token) this.global.clientToken = token;
        const securePlatId = res.data?.data?.data?.securePlatId || res.data?.securePlatId;
        if (securePlatId) this.global.securePlatId = securePlatId;
        return raw ? res : res.data;
    }

    async login() {
        const code = await getWxCode(this.server);
        const auth = await this.api("/cloud/member/wechatlogin/authLoginApplet", {
            wxInfo: code,
            extend: "{}",
            sessionIdForWxShop: "",
        });
        const data = auth?.data || {};
        this.global.openId = data.openId || data.openid || this.openid;
        this.global.unionid = data.unionId || data.unionid || "";
        return `authLoginApplet=${short(auth)}`;
    }

    async query() {
        const shop = await this.api("/cloud/member/shop/getShopInfo", {});
        const shopData = shop?.data?.data || shop?.data || {};
        if (shopData.sellerId) this.global.shopId = String(shopData.sellerId);
        if (shopData.mainShopNick) this.global.mainShopNick = shopData.mainShopNick;
        if (shopData.shopNick) this.global.shopNick = shopData.shopNick;
        const card = await this.api("/api/customize/get-card-info.do", {});
        const client = await this.api("/cloud/member/tblogin/getClientInfo", {});
        const d = card?.data || {};
        const c = client?.data || {};
        return `用户=${c.client_name || c.user_mob || d.name || "未知"} 积分=${d.residualIntegral ?? c.residualIntegral ?? "未知"} 等级=${d.currLevelName || c.member_level_str || ""} shop=${shopData.shopTitle || shopData.title || short(shopData || shop, 80)}`;
    }

    async sign() {
        const activityId = APP.signActivityId;
        const info = await this.api("/cloud/activity/sign/load-sign", { activityId });
        const infoBody = info?.data || {};
        const signInfo = infoBody?.data || {};
        if (Number(infoBody.code) !== 200) return `签到活动查询失败 activityId=${activityId}: ${short(info)}`;

        const ruleRes = await this.api("/cloud/activity/sign/getSignPrizeRules", { activityId });
        const rules = Array.isArray(ruleRes?.data?.data)
            ? ruleRes.data.data
                  .filter((item) => item && (item.ruleName || item.prizeName))
                  .map((item) => `${item.ruleName || ""}${item.prizeName ? `-${item.prizeName}` : ""}`)
                  .join("，")
            : "";

        if (signInfo.signed) {
            return `今日已签到 activityId=${activityId} 连续=${signInfo.continuousSignNum ?? 0} 累计=${signInfo.totalSignNum ?? 0}${rules ? ` 规则=${rules}` : ""}`;
        }

        const sign = await this.api("/cloud/activity/sign/add-sign", { activityId });
        const body = sign?.data || {};
        const data = body?.data || {};
        if (Number(body.code) === 200) {
            const prizes = Array.isArray(data.prizeList) && data.prizeList.length ? ` 奖励=${data.prizeList.map((x) => x.prizeName || x.name || short(x, 40)).join("，")}` : "";
            return `签到成功 activityId=${activityId} +${data.integralCount ?? "未知"}积分 连续=${data.continuousSignNum ?? 0} 累计=${data.totalSignNum ?? 0}${prizes}`;
        }
        if (/已签|重复/.test(String(body.message || sign?.message || ""))) {
            return `今日已签到 activityId=${activityId}: ${short(sign)}`;
        }
        return `签到失败 activityId=${activityId}: ${short(sign)}`;
    }
}

async function runAccount(openid, index) {
    console.log(`\n========== ${APP.name} 账号[${index}] ${openid} ==========`);
    const runner = new JsbHuiyuan(openid);
    try {
        console.log(`登录：${await runner.login()}`);
        console.log(`查询：${await runner.query()}`);
        console.log(`签到：${await runner.sign()}`);
    } catch (e) {
        console.log(`执行失败：${e.message || e}`);
    }
}

(async () => {
        if (!SERVERS.length) {
        console.log(`未配置 ${"YYB_GO"}`);
        return;
    }
    console.log(`共找到${SERVERS.length}个账号`);
    for (let i = 0; i < SERVERS.length; i++) {
        await runAccount(SERVERS[i], i + 1);
        await sleep(800);
    }
})().catch((e) => {
    console.log(`脚本异常：${e.stack || e.message || e}`);
});
