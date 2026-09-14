/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 好人家签到
cron: 36 8 * * *
------------------------------------------
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
const $ = new Env("好人家签到");
const axios = require("axios");
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

const MINI_APP_ID = "wx160c589739c6f8b0";
const PAGE_VERSION = "116";
const API_HOST = "https://xapi.weimob.com";
const API_BASE = `${API_HOST}/api3`;
const TOKEN_CACHE_FILE = path.join(__dirname, "hrj_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const FORM_BASIC_INFO = {
    bosId: "4021565647273",
    cid: "505934273",
    productInstanceId: "8689235273",
    tcode: "weimob",
    vid: "6015869513273",
};

const ONECRM_BASIC_INFO = {
    bosId: "4021565647273",
    cid: "505934273",
    productId: 146,
    productInstanceId: "8689224273",
    tcode: "weimob",
    vid: "6015869513273",
};

const EXTEND_INFO = {
    analysis: [],
    bosTemplateId: 1000002218,
    childTemplateIds: [
        { customId: 90004, version: "crm@0.1.90" },
        { customId: 90002, version: "ec@84.0" },
        { customId: 90006, version: "hudong@0.0.251" },
        { customId: 90008, version: "cms@0.0.529" },
        { customId: 90070, version: "1.0.19y" },
    ],
    quickdeliver: { enable: false },
    wxTemplateId: 8169,
    youshu: { enable: false },
    source: 1,
    channelsource: 1,
    mpScene: 1001,
};

let ckName = "hrj";

const wechat = new WeChatServer({
    url: process.env.YYB_BASE_URL || "http://192.168.3.177:8000",
    appid: MINI_APP_ID,
    auth: process.env.wx_auth || "",
});

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
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function isTokenError(message) {
    return /token|登录|授权|invalid|expire|过期|1041|401|403/i.test(String(message || ""));
}

function rewardText(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return items.map((item) => `${item.key || "奖励"}${item.value || ""}`).join(" ");
}

class Task {
    constructor(account) {
        this.index = $.userIdx++;
        this.openid = String(account.openid || "").trim();
        this.nickname = String(account.nickname || this.openid).trim();
        this.session = {};
    }

    async run() {
        const cached = this.getCachedToken();
        if (cached) {
            this.session = cached;
            $.log(`账号[${this.index}] ${this.nickname} 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] ${this.nickname} 缓存token失效，重新登录`);
            }
        }

        if (!this.session.token) {
            await this.loginByWxCode();
            if (!this.session.token) return;
        }

        await this.doSign();
        this.saveCachedToken();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.openid] || null;
    }

    saveCachedToken() {
        if (!this.session.token) return;
        const cache = readTokenCache();
        cache[this.openid] = {
            uuid: this.session.uuid,
            bosId: this.session.bosId,
            wid: this.session.wid,
            appId: this.session.appId,
            cid: this.session.cid,
            scope: this.session.scope,
            status: this.session.status,
            sourceType: this.session.sourceType,
            source: this.session.source,
            token: this.session.token,
            expireTime: this.session.expireTime,
            latestExpireTime: this.session.latestExpireTime,
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

    getHeaders() {
        return {
            "Content-Type": "application/json",
            "X-WX-Token": this.session.token || "",
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "weimob-bosId": ONECRM_BASIC_INFO.bosId,
            "weimob-pid": "N/A",
        };
    }

    buildWosBody(data = {}) {
        return {
            appid: MINI_APP_ID,
            basicInfo: { ...ONECRM_BASIC_INFO },
            extendInfo: { ...EXTEND_INFO },
            i18n: {
                language: "zh",
                timezone: "8",
            },
            ...data,
        };
    }

    async request(apiPath, data = {}) {
        const res = await axios.post(`${API_BASE}${apiPath}`, this.buildWosBody(data), {
            headers: this.getHeaders(),
            timeout: 20000,
            validateStatus: () => true,
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        if (`${res.data?.errcode}` !== "0") {
            const error = new Error(res.data?.errmsg || `接口错误: ${res.data?.errcode || "unknown"}`);
            error.data = res.data;
            throw error;
        }
        return res.data?.data;
    }

    async getLoginCode() {
        const { data } = await wechat.getCode(this.openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const loginBody = {
                appid: MINI_APP_ID,
                basicInfo: { ...FORM_BASIC_INFO },
                env: "production",
                extendInfo: { ...EXTEND_INFO },
                is_pre_fetch_open: true,
                parentVid: 0,
                pid: "",
                storeId: "",
                code,
                queryAuthConfig: true,
            };
            delete loginBody.basicInfo.productInstanceId;

            const res = await axios.post(`${API_HOST}/fe/mapi/user/loginX`, loginBody, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
                    "weimob-bosId": FORM_BASIC_INFO.bosId,
                    "weimob-cid": FORM_BASIC_INFO.cid,
                },
                timeout: 20000,
                validateStatus: () => true,
            });
            if (res.status !== 200 || Number(res.data?.errcode) !== 0) {
                throw new Error(res.data?.errmsg || res.data?.errormsg || `HTTP ${res.status}`);
            }
            this.session = res.data.data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] ${this.nickname} 登录成功: wid ${this.session.wid || ""}`);
        } catch (e) {
            $.log(`账号[${this.index}] ${this.nickname} 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignMainInfo(true);
            return true;
        } catch (e) {
            return false;
        }
    }

    customInfo(extra = {}) {
        return {
            ...ONECRM_BASIC_INFO,
            source: 0,
            wid: this.session.wid,
            ...extra,
        };
    }

    async getSignMainInfo(silent = false) {
        const data = await this.request("/onecrm/mactivity/sign/misc/sign/activity/c/signMainInfo", {
            customInfo: this.customInfo(),
        });
        if (!silent) {
            $.log(`账号[${this.index}] ${this.nickname} 签到状态: ${data?.hasSign ? "今日已签" : "今日未签"} ${rewardText(data?.signForwardMsg)}`);
        }
        return data || {};
    }

    async doSign() {
        try {
            const info = await this.getSignMainInfo();
            if (info.hasSign) {
                $.log(`账号[${this.index}] ${this.nickname} 今日已签到`);
                return;
            }

            const data = await this.request("/onecrm/mactivity/sign/misc/sign/activity/core/c/sign", {
                customInfo: this.customInfo(),
            });
            const rewards = [
                rewardText(data?.fixedReward),
                rewardText(data?.extraReward),
            ].filter(Boolean).join(" ");
            $.log(`账号[${this.index}] ${this.nickname} 签到成功${rewards ? `: ${rewards}` : ""}`);
        } catch (e) {
            const message = e.message || e;
            if (/已签|重复|今日已|60070013000332/.test(String(message))) {
                $.log(`账号[${this.index}] ${this.nickname} 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] ${this.nickname} 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

async function fetchAccounts() {
    const base = (process.env.YYB_BASE_URL || "http://192.168.3.177:8000").replace(/\/+$/, "");
    const h = { "Content-Type": "application/json" };
    if (process.env.wx_auth) h["Authorization"] = "Bearer " + process.env.wx_auth;
    try {
        const r = await (await fetch(base + "/accounts", { headers: h, signal: AbortSignal.timeout(10000) })).json();
        if (r.code !== 0) return [];
        return (r.data || []).map(a => ({ openid: a.openid, nickname: a.nickname || a.alias || a.openid })).filter(a => a.openid);
    } catch { return []; }
}

!(async () => {
    const _accounts = await fetchAccounts();
    if (!_accounts.length) {
        console.log("未获取到账号，请确认 wx_server 已登录");
        return;
    }
    for (const account of _accounts) {
        await new Task(account).run();
    }
})().catch(e => console.log(e))
    .finally(() => $.done());
