/*
风云再起北京 - 每日签到
cron: 20 8 * * *

*/

// prettier-ignore
function Env(t, s) {
    return new (class {
        constructor(t, s) {
            this.userIdx = 1;
            this.userList = [];
            this.userCount = 0;
            this.name = t;
            this.notifyStr = [];
            this.logSeparator = "\n";
            this.startTime = new Date().getTime();
            Object.assign(this, s);
            this.log(`\ud83d\udd14${this.name},\u5f00\u59cb!`);
            this.bucket = this.bucket || ''
            this.fs = require("fs");
            if (this.isNode() && this.bucket) {
                try {
                    if (!this.fs.existsSync(this.bucket)) {
                        this.fs.writeFileSync(this.bucket, JSON.stringify({}, null, 2));
                        this.log(`📁 已创建 bucket 文件: ${this.bucket}`);
                    }
                } catch (e) {
                    this.log("❌ 初始化 bucket 失败: " + e.message);
                }
            }
        }
        async get(key, def = null) {
            if (!this.isNode()) return def;
            try {
                const data = await this.fs.promises.readFile(this.bucket, "utf-8");
                const json = JSON.parse(data);
                return json.hasOwnProperty(key) ? json[key] : def;
            } catch (e) {
                this.log("❌ 读取bucket失败: " + e.message);
                return def;
            }
        }
        async set(key, value) {
            if (!this.isNode()) return;
            try {
                const data = await this.fs.promises.readFile(this.bucket, "utf-8");
                const json = JSON.parse(data);
                json[key] = value;
                await this.fs.promises.writeFile(this.bucket, JSON.stringify(json, null, 2));
            } catch (e) {
                this.log("❌ 写入bucket失败: " + e.message);
            }
        }
        checkEnv(ckName) {
            const envSplitor = ["&", "\n"];
            let userCookie = (this.isNode() ? process.env[ckName] : "") || "";
            this.userList = userCookie.split(envSplitor.find((o) => userCookie.includes(o)) || "&").filter((n) => n);
            this.userCount = this.userList.length;
            this.log(`共找到${this.userCount}个账号`);
        }
        toStr(v) {
            if (v instanceof Error) return v.stack || v.message;
            if (v && typeof v == "object") try { return JSON.stringify(v) } catch { return "[Complex Object]" }
            return String(v);
        }
        async sendMsg() {
            this.log("==============📣Center 通知📣==============")
            let message = this.notifyStr.join(this.logSeparator);
            if (this.isNode()) {
                try {
                    const { sendNotify } = require("./sendNotify.js")
                    await sendNotify(this.name, message);
                } catch (e) {
                    console.error(e.code === "MODULE_NOT_FOUND" ? "发送通知失败: 未找到 sendNotify.js 模块" : `发送通知失败: sendNotify.js 内部错误 (${e.message})`);
                }

            }
        }
        isNode() {
            return "undefined" != typeof module && !!module.exports;
        }
        jsonToStr(obj, c = '&', encodeUrl = false) {
            let ret = []
            for (let keys of Object.keys(obj).sort()) {
                let v = obj[keys]
                if (v && encodeUrl) v = encodeURIComponent(v)
                ret.push(keys + '=' + v)
            }
            return ret.join(c);
        }
        getURLParams(url) {
            try { return Object.fromEntries(new URL(url, "http://localhost").searchParams) } catch { return {} }
        }
        isJSONString(str) {
            try {
                return JSON.parse(str) && typeof JSON.parse(str) === "object";
            } catch (e) {
                return false;
            }
        }
        isJson(obj) {
            var isjson =
                typeof obj == "object" &&
                Object.prototype.toString.call(obj).toLowerCase() ==
                "[object object]" &&
                !obj.length;
            return isjson;
        }

        randomNumber(length) {
            const characters = "0123456789";
            return Array.from(
                { length },
                () => characters[Math.floor(Math.random() * characters.length)]
            ).join("");
        }
        randomString(length) {
            const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
            return Array.from(
                { length },
                () => characters[Math.floor(Math.random() * characters.length)]
            ).join("");
        }
        uuid() {
            return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
                /[xy]/g,
                function (c) {
                    var r = (Math.random() * 16) | 0,
                        v = c == "x" ? r : (r & 0x3) | 0x8;
                    return v.toString(16);
                }
            );
        }
        time(t) {
            let s = {
                "M+": new Date().getMonth() + 1,
                "d+": new Date().getDate(),
                "H+": new Date().getHours(),
                "m+": new Date().getMinutes(),
                "s+": new Date().getSeconds(),
                "q+": Math.floor((new Date().getMonth() + 3) / 3),
                S: new Date().getMilliseconds(),
            };
            /(y+)/.test(t) &&
                (t = t.replace(
                    RegExp.$1,
                    (new Date().getFullYear() + "").substr(4 - RegExp.$1.length)
                ));
            for (let e in s) {
                new RegExp("(" + e + ")").test(t) &&
                    (t = t.replace(
                        RegExp.$1,
                        1 == RegExp.$1.length
                            ? s[e]
                            : ("00" + s[e]).substr(("" + s[e]).length)
                    ));
            }
            return t;
        }

        log(content) {
            this.notifyStr.push(`[${this.time("HH:mm:ss")}]` + " " + this.toStr(content))
            console.log(content)
        }

        wait(min, max = null) {
            const ms = max == null ? min : Math.random() * (max - min + 1) + min | 0;
            ms >= 1000 && this.log(`等待 ${(ms / 1000).toFixed(2)} 秒...`, { notify: false });
            return new Promise(r => setTimeout(r, ms));
        }
        async done() {
            await this.sendMsg();
            const s = new Date().getTime(),
                e = (s - this.startTime) / 1e3;
            this.log(
                `\ud83d\udd14${this.name},\u7ed3\u675f!\ud83d\udd5b ${e}\u79d2`
            );
            if (this.isNode()) {
                process.exit(0);
            }
        }
        parseCookie(ck) {
            return typeof ck != "string" || !ck ? {} : Object.fromEntries(
                ck.split(/;\s*/).filter(v => v.includes("=")).map(v => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)])
            );
        }

    })(t, s);
}
const $ = new Env("风云再起北京");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
class WeChatCodeServer {
    constructor(options) {
        this.serverUrl = options.url;
        this.appid = options.appid;
        this.auth = options.auth;
    }
    getCode(openid) {
        console.log('等待获取code:');
        return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json" };
            if (this.auth) headers["Authorization"] = "Bearer " + this.auth;
            axios.post(this.serverUrl + '/wxapp/getCode', { app_id: this.appid, ref: openid }, {
                headers,
                timeout: 30 * 1000
            }).then(res => {
                const d = res.data;
                if (d.code === 0) {
                    const code = d.data?.result?.code || "";
                    console.log('获取code成功:');
                    resolve({ status: 200, data: { status: true, data: { code } } });
                } else {
                    resolve({ status: 200, data: { status: false, data: null } });
                }
            }).catch(err => {
                reject(err);
            });
        });
    }

    cloudInit(openid) {
        console.log('等待云函数初始化:');
        return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json" };
            if (this.auth) headers["Authorization"] = "Bearer " + this.auth;
            axios.post(this.serverUrl + '/wxapp/operateWxData', { app_id: this.appid, ref: openid, payload: { action: "init" } }, {
                headers,
                timeout: 30 * 1000
            }).then(res => {
                console.log('云函数初始化成功:');
                resolve(res);
            }).catch(err => {
                reject(err);
            });
        });
    }
    cloudCall(openid) {
        console.log('等待云函数调用:');
        return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json" };
            if (this.auth) headers["Authorization"] = "Bearer " + this.auth;
            axios.post(this.serverUrl + '/wxapp/operateWxData', { app_id: this.appid, ref: openid, payload: { action: "call" } }, {
                headers,
                timeout: 30 * 1000
            }).then(res => {
                console.log('云函数调用成功:');
                resolve(res);
            }).catch(err => {
                reject(err);
            });
        });
    }
}
const WeChatServer = WeChatCodeServer;

const ckName = "fyzq";
const MINI_APP_ID = "wxbc00cc79a68e2305";
const BRAND_KEY = "bjfyzq";
const CITY_NAME = "北京";
const APPLET_BASE = "https://aplet.njqsmx.com".replace("aplet", "applet");
const SIGN_KEY = Buffer.from("rwCyegYqZjtnBPND", "utf8");
const TOKEN_CACHE_FILE = path.join(__dirname, "fyzq_token_cache.json");

const YYB_BASE_URL = (process.env.YYB_BASE_URL || "http://172.17.0.1:18080").replace(/\/+$/, "");
const BRIDGE_KEY = process.env.wx_auth || "";

function bridgeHeaders() {
    const h = { "Content-Type": "application/json" };
    if (BRIDGE_KEY) h["Authorization"] = "Bearer " + BRIDGE_KEY;
    return h;
}

async function fetchAccounts() {
    try {
        const r = await axios.get(`${YYB_BASE_URL}/accounts`, { headers: bridgeHeaders(), timeout: 15000 });
        return (r.data?.data || []).map(a => ({ openid: a.openid, nickname: a.nickname || a.alias || a.openid }));
    } catch { return []; }
}

const wechat = new WeChatServer({
  url: YYB_BASE_URL,
  appid: MINI_APP_ID,
  auth: BRIDGE_KEY,
});

function readCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    $.log(`token缓存写入失败: ${e.message || e}`);
  }
}

function makeSign(params) {
  const text = Object.keys(params)
    .sort()
    .filter((key) => params[key] !== null && params[key] !== undefined && params[key] !== "")
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  const cipher = crypto.createCipheriv("aes-128-ecb", SIGN_KEY, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(Buffer.from(`"${text}"`, "utf8")),
    cipher.final(),
  ]).toString("base64").replace(/=/g, "");
}

function mask(value = "") {
  value = String(value);
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

async function appletPost(urlPath, params = {}, token = "") {
  const body = {
    ...params,
    deviceType: "4",
    channel: "wxxcx",
  };
  if (token) body.token = token;
  body.sign = makeSign(body);

  const { data } = await axios.post(`${APPLET_BASE}${urlPath}`, new URLSearchParams(body).toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://servicewechat.com/${MINI_APP_ID}/53/page-frame.html`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF",
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  return data;
}

// New sign API - uses JSON body with header/body structure
async function signApiPost(urlPath, token) {
  const headerParams = { portType: "MIN", sourcePlatform: "2", token };
  const headerSign = makeSign(headerParams);
  const payload = { header: { ...headerParams, sign: headerSign }, body: { sourcePlatform: "2", token } };
  const { data } = await axios.post(`${APPLET_BASE}${urlPath}`, payload, {
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Referer: `https://image.njqsmx.com/`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF",
      Origin: "https://image.njqsmx.com",
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  return data;
}

class Task {
  constructor(account) {
    this.index = $.userIdx++;
    this.openid = (typeof account === 'string' ? account : (account.openid || account.ref || "")).trim();
    this.nickname = (typeof account === 'string' ? account : (account.nickname || account.alias || this.openid)).trim();
    this.account = this.openid;
    this.token = "";
  }

  getCachedToken() {
    return readCache()[this.account]?.token || "";
  }

  saveToken(token, extra = {}) {
    if (!token) return;
    const cache = readCache();
    cache[this.account] = {
      token,
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  removeToken() {
    const cache = readCache();
    if (cache[this.account]) {
      delete cache[this.account];
      writeCache(cache);
    }
  }

  async getWxCode() {
    const { data } = await wechat.getCode(this.account);
    if (!data?.status) throw new Error(data?.message || "wx_server 获取 code 失败");
    const code = data.data?.code || data.code;
    if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
    return code;
  }

  async login() {
    const code = await this.getWxCode();
    const res = await appletPost("/min/min-user/find_brand_key", {
      code,
      brandKey: BRAND_KEY,
    });

    if (String(res.code) !== "1") {
      throw new Error(res.message || `登录失败: ${JSON.stringify(res)}`);
    }

    let token = res.data?.data?.token || res.data?.token || "";
    if (token) {
      this.token = token;
      this.saveToken(token, { brandId: res.data?.brandId || "", isBind: res.data?.isBind });

      return;
    }

    // No token - need second step with openIdkey
    const openIdkey = res.data?.openIdkey || res.data?.data?.openIdkey;
    if (!openIdkey) throw new Error(`接口未返回 openIdkey: ${JSON.stringify(res)}`);

    $.log(`账号[${this.index}] ${this.nickname} 首次登录，执行二步登录...`);
    const res2 = await appletPost("/min/min-user/wechat_one_key_login_new", {
      code,
      openIdkey,
      brandKey: BRAND_KEY,
      cityName: CITY_NAME,
      nickName: "",
      headUrl: "",
    });

    const res2Data = res2?.data || res2;
    token = res2Data?.data?.token || res2Data?.token || "";
    if (!token) throw new Error(`二步登录未返回 token: ${JSON.stringify(res2)}`);

    this.token = token;
    this.saveToken(token);

  }

  async signBanner() {
    const res = await signApiPost("/mobile/business/sign/info/getCheckinInfo", this.token);
    if (String(res?.header?.code) !== "0") throw new Error(res?.header?.message || `查询签到状态失败: ${JSON.stringify(res)}`);
    const body = res.body || {};
    return { signed: body.checkStatus === 1, continuous: body.consCheckDays || 0 };
  }

  async doSign() {
    const res = await signApiPost("/mobile/business/sign/info/signIn", this.token);
    if (String(res?.header?.code) !== "0") throw new Error(res?.header?.message || `签到失败: ${JSON.stringify(res)}`);
    return res.body || {};
  }

  async run() {
    $.log(`\n账号[${this.index}] ${this.nickname}`);
    this.token = this.getCachedToken();

    if (this.token) {
      $.log(`账号[${this.index}] ${this.nickname} 使用缓存 token`);
      try {
        const status = await this.signBanner();
        await this.handleStatus(status);
        return;
      } catch (e) {
        $.log(`账号[${this.index}] ${this.nickname} 缓存失效: ${e.message || e}`);
        this.removeToken();
      }
    }

    await this.login();
    const status = await this.signBanner();
    await this.handleStatus(status);
  }

  async handleStatus(status) {
    if (status.signed) {
      $.log(`账号[${this.index}] ${this.nickname} 今日已签到，连续签到 ${status.continuous ?? "未知"} 天`);
      return;
    }

    await this.doSign();
    const after = await this.signBanner();
    $.log(`账号[${this.index}] ${this.nickname} 签到成功，连续签到 ${after.continuous ?? "未知"} 天`);
  }
}

!(async () => {
    const _accounts = await fetchAccounts();
    if (!_accounts.length) {
        console.log("未获取到账号，请确认 wx_server 已登录");
        return;
    }
    for (const account of _accounts) {
        try {
            await new Task(account).run();
        } catch (e) {
            $.log(`账号[${this.index}] ${this.nickname} 跳过: ${e.message || e}`);
        }
    }
})().catch(e => console.log(e))
  .finally(() => $.done && $.done());
