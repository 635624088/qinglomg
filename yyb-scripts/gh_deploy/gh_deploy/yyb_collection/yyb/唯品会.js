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
// name: 唯品会
// cron: 18 8 * * *

const axios = require("axios");
const crypto = require("crypto");
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

const MINI_APP_ID = "wxe9714e742209d35f";
const PACKAGE_VERSION = "1371";
const API_KEY = "ce29a51aa5c94a318755b2529dcb8e0b";
const HASH = "ptx26";
const ACT_ID = "H3gRnE1Xi18=";
const SIGN_SECRET_ENC = "Ql4mW09F3urBNdzBLfK6UuRTqj22Bta7eEKTO7n5jFf9uU6FZZmcfe/gurOAOB+o";

const CACHE_FILE = path.join(__dirname, "token_caches", "vipshop_token_cache.json");
try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); } catch (e) {}
const DEFAULT_MARS_CID = process.env.vipshop_mars_cid || "104104";
const DEFAULT_WAREHOUSE = "VIP_NH";
const DEFAULT_AREA = "104104";

function splitAccounts(value = "") {
  return String(value)
    .split(/\n|&/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    console.log(`缓存写入失败: ${e.message || e}`);
  }
}

function short(value, max = 600) {
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

function sha1(text) {
  return crypto.createHash("sha1").update(String(text)).digest("hex");
}

function md5(text) {
  return crypto.createHash("md5").update(String(text)).digest("hex");
}

function aesDecryptBase64(text) {
  const key = Buffer.from("weixin_smallmina");
  const iv = Buffer.concat([Buffer.from("weixin"), Buffer.alloc(10)]);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  let out = decipher.update(text, "base64", "utf8");
  out += decipher.final("utf8");
  return out;
}

function form(data = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    params.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return params.toString();
}

function parseAccount(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    const data = JSON.parse(text);
    return {
      openid: data.openid || data.openId || data.rawOpenid || "",
      token: data.token || data.VIP_TANK || data.vipTank || "",
      userId: data.userId || data.uid || "",
      vipOpenid: data.vipOpenid || data.vip_openid || data.encryptedOpenid || "",
      unionid: data.unionid || data.unionId || "",
      marsCid: data.marsCid || data.mars_cid || "",
      remark: data.remark || data.name || "",
    };
  }

  const [openid, token, userId, vipOpenid, remark] = text.split("#").map((item) => item.trim());
  if (!token && /^[A-F0-9]{32,}$/i.test(openid)) return { token: openid };
  return { openid, token, userId, vipOpenid, remark };
}

function isSuccess(data) {
  return Number(data?.code) === 1 || Number(data?.code) === 0;
}

async function request(options) {
  const res = await axios.request({
    timeout: 30000,
    validateStatus: () => true,
    ...options,
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger MiniProgramEnv/Windows",
      Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
      ...(options.headers || {}),
    },
  });
  return { status: res.status, data: res.data, headers: res.headers || {} };
}

async function getWxCode(server) {
        return await getCode(server);
    }


class Vipshop {
  constructor(rawAccount, index) {
        this.server = rawAccount;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
    this.index = index;
    this.account = parseAccount(rawAccount);
    this.openid = this.openid || "";
    this.token = this.account.token || "";
    this.userId = this.account.userId || "";
    this.vipOpenid = this.account.vipOpenid || "";
    this.unionid = this.account.unionid || "";
    this.marsCid = this.account.marsCid || DEFAULT_MARS_CID;
    this.cacheKey = this.openid || (this.vipOpenid ? md5(this.vipOpenid).slice(0, 16) : `account_${index}`);
  }

  log(message) {
    console.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${message}`);
  }

  baseData() {
    return {
      app_name: "shop_weixin_mina",
      client: "wechat_mini_program",
      source_app: "shop_weixin_mina",
      api_key: API_KEY,
      app_version: "4.0",
      client_type: "wap",
      format: "json",
      mobile_platform: "2",
      ver: "2.0",
      standby_id: "native",
      union_mark: "",
      sd_tuijian: "",
      mobile_channel: "nature",
      mars_cid: this.marsCid,
      warehouse: DEFAULT_WAREHOUSE,
      fdc_area_id: DEFAULT_AREA,
      province_id: DEFAULT_AREA,
      wap_consumer: "A1",
      t: Math.floor(Date.now() / 1000),
      net: "WIFI",
      width: 375,
      height: 667,
      phone_model: "Windows",
      phone_brand: "",
      sys_version: "Windows 10",
      is_default_area: "1",
      app_theme_mode: "0",
      app_theme_action: "0",
      req_scene: 0,
    };
  }

  cookie() {
    const items = [
      `mars_cid=${this.marsCid}`,
      this.userId ? `userId=${this.userId}` : "",
      `warehouse=${DEFAULT_WAREHOUSE}`,
      this.token ? `VIP_TANK=${this.token}` : "",
      "wap_consumer=A1",
    ].filter(Boolean);
    return items.join(";");
  }

  paramHash(data = {}, method = "POST") {
    const sorted = Object.keys(data)
      .sort()
      .reduce((obj, key) => {
        obj[key] = data[key];
        return obj;
      }, {});
    const text = Object.keys(sorted)
      .filter((key) => key !== "api_key")
      .map((key) => {
        let value = sorted[key];
        if (typeof value === "object" && String(method).toLowerCase() === "post") value = JSON.stringify(value);
        return `${key}=${value}`;
      })
      .join("&");
    return sha1(text);
  }

  signHeader(url, data = {}, method = "POST") {
    const pathOnly = url.replace(/^http(s)?:\/\/.*?\//, "/");
    const secret = aesDecryptBase64(SIGN_SECRET_ENC);
    const apiSign = sha1(`${pathOnly}${this.paramHash(data, method)}${this.token}${this.marsCid}${secret}`);
    return `OAuth api_sign=${apiSign}`;
  }

  signedHeaders(url, data) {
    const cookie = this.cookie();
    return {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      "X-Traceid": `${cookie};__need_sign=1`,
      Authorization: this.signHeader(url, data, "POST"),
    };
  }

  getCached() {
    return readCache()[this.cacheKey] || {};
  }

  saveCache(extra = {}) {
    const cache = readCache();
    cache[this.cacheKey] = {
      ...(cache[this.cacheKey] || {}),
      ...(this.openid ? { openid: this.openid } : {}),
      ...(this.vipOpenid ? { vipOpenid: this.vipOpenid } : {}),
      ...(this.unionid ? { unionid: this.unionid } : {}),
      ...(this.token ? { token: this.token } : {}),
      ...(this.userId ? { userId: this.userId } : {}),
      marsCid: this.marsCid,
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  removeLoginCache() {
    const cache = readCache();
    if (cache[this.cacheKey]) {
      delete cache[this.cacheKey].token;
      delete cache[this.cacheKey].userId;
      writeCache(cache);
    }
  }

  loadCache() {
    const cached = this.getCached();
    this.token = this.token || cached.token || "";
    this.userId = this.userId || cached.userId || "";
    this.vipOpenid = this.vipOpenid || cached.vipOpenid || "";
    this.unionid = this.unionid || cached.unionid || "";
    this.marsCid = this.account.marsCid || cached.marsCid || this.marsCid;
  }

  async getVipWechatInfo(code) {
    const data = { ...this.baseData(), code, iv: "", encryptedData: "", hash: HASH };
    const { status, data: res } = await request({
      method: "POST",
      url: `https://weixin-api.vip.com/v4/LiteApp/getUserInfo?api_key=${API_KEY}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: this.cookie() },
      data: form(data),
    });
    if (status !== 200 || Number(res?.code) !== 0 || !res?.data?.openid) {
      throw new Error(`获取唯品会openid失败 HTTP ${status}: ${short(res)}`);
    }
    this.vipOpenid = res.data.openid;
    this.unionid = res.data.unionid || this.unionid;
    this.log(`唯品会openid获取成功: ${mask(this.vipOpenid)}`);
  }

  async autoLogin(code) {
    const data = {
      ...this.baseData(),
      hash: HASH,
      code,
      event: 2,
      deviceId: this.marsCid,
      context: JSON.stringify({ iv: "", encryptedData: "" }),
      source_app_type: "shop_weixin_mina",
      login_type: "WEIXIN_SMALL_APP",
      third_type: "WEIXIN",
    };
    const { status, data: res } = await request({
      method: "POST",
      url: `https://mapi.vip.com/vips-mobile/rest/auth/third_party/trylogin/v1?api_key=${API_KEY}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: this.cookie() },
      data: form(data),
    });
    if (status !== 200 || Number(res?.code) !== 1 || !res?.data?.tokenId) {
      throw new Error(`自动登录失败 HTTP ${status}: ${short(res)}`);
    }
    this.token = res.data.tokenId;
    this.userId = String(res.data.userId || "");
    this.log(`登录成功 userId=${this.userId || "-"} VIP_TANK=${mask(this.token)}`);
  }

  async ensureLogin() {
    this.loadCache();
    if (this.token && this.userId && this.vipOpenid) {
      this.log(`使用缓存登录态 userId=${this.userId} VIP_TANK=${mask(this.token)}`);
      return;
    }
    const code = await getWxCode(this.server);
    if (!this.vipOpenid) await this.getVipWechatInfo(code);
    if (!this.token || !this.userId) await this.autoLogin(code);
    this.saveCache();
  }

  async signInfo() {
    const url = "https://act-ug.vip.com/checkInAward/withSign/info";
    const data = { ...this.baseData(), openid: this.vipOpenid, actId: ACT_ID, biz_code: "old" };
    const { status, data: res } = await request({
      method: "POST",
      url: `${url}?api_key=${API_KEY}`,
      headers: this.signedHeaders(url, data),
      data: form(data),
    });
    if (status !== 200 || Number(res?.code) !== 1) {
      if (Number(res?.code) === 10013 || Number(res?.code) === -2) this.removeLoginCache();
      throw new Error(`签到查询失败 HTTP ${status}: ${short(res)}`);
    }
    const info = res.data || {};
    const today = (info.checkInList || []).find((item) => Number(item.isCheckInDay) === 1) || {};
    this.log(
      `签到信息: 今日${Number(today.isCheckIn) === 1 ? "已签" : "未签"}，累计${info.numTotal ?? "-"}天，连续${
        info.nonStopNum ?? "-"
      }天，已得唯品币${info.awardVipcoinTotal ?? "-"}，下次奖励${info.nextTimeAwardAmount ?? "-"}`
    );
    return info;
  }

  async sign() {
    const before = await this.signInfo();
    const today = (before.checkInList || []).find((item) => Number(item.isCheckInDay) === 1) || {};
    if (Number(today.isCheckIn) === 1) {
      this.log("签到结果: 今日已签到");
      return before;
    }

    const url = "https://act-ug.vip.com/checkInAward/withSign/checkin";
    const data = { ...this.baseData(), openid: this.vipOpenid, actId: ACT_ID, biz_code: "old" };
    const { status, data: res } = await request({
      method: "POST",
      url: `${url}?api_key=${API_KEY}`,
      headers: this.signedHeaders(url, data),
      data: form(data),
    });
    if (status !== 200 || Number(res?.code) !== 1) {
      const message = String(res?.msg || "");
      if (/已签|重复|already/i.test(message)) {
        this.log("签到结果: 今日已签到");
        return this.signInfo();
      }
      throw new Error(`签到失败 HTTP ${status}: ${short(res)}`);
    }
    const result = res.data || {};
    this.log(
      `签到结果: 成功，获得${result.awardAmount ?? result.awardValDesc ?? "-"}，累计${result.numTotal ?? "-"}天，连续${
        result.nonStopNum ?? "-"
      }天`
    );
    return this.signInfo();
  }

  async run() {
    try {
      this.log(`开始执行 ${mask(this.openid || this.vipOpenid || this.token)}`);
      await this.ensureLogin();
      await this.sign();
      this.saveCache();
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
    await new Vipshop(accounts[i], i + 1).run();
    if (i < accounts.length - 1) await await sleep(1500, 3000);
  }
}

main()
  .catch((e) => console.log(`脚本异常: ${e.message || e}`))
