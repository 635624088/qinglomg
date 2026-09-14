/*
------------------------------------------
@Author: sm
@Date: 2026.06.05
@Description: jingjianx 小程序统一登录查询签到
cron: 30 8 * * *
------------------------------------------

依赖变量：
YYB_BASE_URL  默认 http://172.17.0.1:18080
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
const $ = new Env("jingjianx统一签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatCodeServer = class {
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
};
const WeChatServer = WeChatCodeServer;

const CK_NAME = "jingjianx_all";
const YYB_BASE_URL = process.env.YYB_BASE_URL || "http://192.168.3.177:8000";
const WX_AUTH = process.env.wx_auth || "";
const CACHE_FILE = path.join(__dirname, "jingjianx_all_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

const APPS = [
    {
        ck: "cwsjnbyyz",
        name: "潮玩社 JN北园银座店",
        appid: "wx533baf4b9428d47f",
        chainId: "8684",
        shops: [{ shopId: "15666", shopName: "潮玩社 JN北园银座店" }],
    },
    {
        ck: "afdacw",
        name: "阿凡达潮玩荟家庭娱乐中心",
        appid: "wxea93bab38fc144d1",
        chainId: "10967",
        shops: [
            { shopId: "21380", shopName: "阿凡达潮玩荟文水店" },
            { shopId: "21094", shopName: "阿凡达潮玩荟太原迎春街店" },
            { shopId: "20169", shopName: "阿凡达潮玩荟忻州店" },
            { shopId: "19075", shopName: "阿凡达潮玩荟榆次店" },
        ],
    },
    {
        ck: "dywj",
        name: "D1玩家",
        appid: "wxcced0bb82c738dd1",
        chainId: "3708",
        shops: [
            { shopId: "7960", shopName: "D1玩家-大丰保利店" },
            { shopId: "18811", shopName: "D1玩家友谊广场店" },
            { shopId: "14082", shopName: "D1玩家-大丰汇融店" },
            { shopId: "13473", shopName: "D1玩家-阳光新业店" },
            { shopId: "13190", shopName: "D1玩家-龙湖金楠天街店" },
            { shopId: "19190", shopName: "酷啦啦-甘孜店" },
            { shopId: "12302", shopName: "D1玩家-龙湖锦宸店" },
        ],
    },
    {
        ck: "gxdwj",
        name: "高新大玩家",
        appid: "wx7ec8c4f08046df18",
        chainId: "11279",
        shops: [{ shopId: "19642", shopName: "高新大玩家" }],
    },
    {
        ck: "dwjjxyl",
        name: "大玩家匠心娱乐",
        appid: "wxf64d5e147f9cc3b6",
        chainId: "9663",
        shops: [{ shopId: "17093", shopName: "大玩家匠心娱乐" }],
    },
    {
        ck: "wjsldwjxy",
        name: "玩家森林大玩家XY",
        appid: "wx6136bd123a990614",
        chainId: "9095",
        shops: [{ shopId: "18894", shopName: "玩家森林大玩家XY" }],
    },
    {
        ck: "jswjbzjk",
        name: "极速玩家巴中经开店",
        appid: "wx174a477493da1aeb",
        chainId: "4748",
        shops: [{ shopId: "19081", shopName: "极速玩家巴中经开店" }],
    },
    {
        ck: "jyxmhdylly",
        name: "嘉鱼县梦幻岛游乐园",
        appid: "wxb7fcdb0c375bac0c",
        chainId: "10762",
        shops: [{ shopId: "18752", shopName: "嘉鱼县梦幻岛游乐园" }],
    },
    {
        ck: "qccwc",
        name: "七彩潮玩城",
        appid: "wx72727cb43e04f838",
        chainId: "7243",
        shops: [{ shopId: "12860", shopName: "七彩潮玩城" }],
    },
    {
        ck: "jhjtylclc",
        name: "吉合家庭娱乐超乐场",
        appid: "wxdc43cd8bfcfd00ad",
        chainId: "3580",
        shops: [{ shopId: "8551", shopName: "吉合家庭娱乐超乐场" }],
    },
    {
        ck: "super101cmdwyd",
        name: "SUPER101潮漫电玩宜都店",
        appid: "wx1031a0ff78dbb777",
        chainId: "3091",
        shops: [{ shopId: "13516", shopName: "SUPER101潮漫电玩宜都店" }],
    },
    {
        ck: "wx_three_sign",
        name: "城市星空颖上恒太",
        appid: "wxab97f393b22fc3f0",
        chainId: "3900",
        shops: [{ shopId: "7726", shopName: "城市星空颖上恒太" }],
    },
    {
        ck: "wjcq",
        name: "维京传奇长春店",
        appid: "wxf4a3dae0d0cfd841",
        chainId: "11383",
        shops: [{ shopId: "19820", shopName: "维京传奇长春店" }],
    },
    {
        ck: "xswj",
        name: "像素玩家电玩城",
        appid: "wx16ad44c68249d573",
        chainId: "10557",
        shops: [{ shopId: "18417", shopName: "像素玩家电玩城" }],
    },
    {
        ck: "xblfysx",
        name: "星贝乐阜阳商厦中心店",
        appid: "wxf0a7f75ab1670953",
        chainId: "3900",
        shops: [{ shopId: "17457", shopName: "星贝乐阜阳商厦中心店" }],
    },
    {
        ck: "zjdmc",
        name: "中嘉动漫创美店",
        appid: "wx97b6b57988678880",
        chainId: "8006",
        shops: [{ shopId: "21310", shopName: "中嘉动漫创美店" }],
    },
    {
        ck: "zjdmzj",
        name: "中嘉动漫城樽憬店",
        appid: "wx334c4ec677c62f96",
        chainId: "8006",
        shops: [{ shopId: "16741", shopName: "中嘉动漫城樽憬店" }],
    },
];

for (const app of APPS) {
    app.apiBase = process.env[`${app.ck}_api_base`] || "https://capi.jingjianx.vip";
    app.chainId = process.env[`${app.ck}_chainid`] || app.chainId;
    app.version = process.env[`${app.ck}_version`] || "release";
    const shopIds = (process.env[`${app.ck}_shop_ids`] || "")
        .split(/[,，&;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    if (shopIds.length) {
        app.shops = app.shops
            .filter((shop) => shopIds.includes(String(shop.shopId)))
            .concat(
                shopIds
                    .filter((id) => !app.shops.some((shop) => String(shop.shopId) === id))
                    .map((id) => ({ shopId: id, shopName: `门店${id}` }))
            );
    }
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
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function shortToken(token = "") {
    const value = String(token).replace(/^Bearer\s+/i, "");
    return value ? `${value.slice(0, 4)}***${value.slice(-4)}` : "";
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function createGuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function isToday(dateText = "") {
    if (!dateText) return false;
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return String(dateText).startsWith(`${y}-${m}-${d}`);
}

function addStoreAsset(assets, category, value, name = "") {
    const amount = Number(value || 0);
    const label = String(name || "");
    if (label) {
        if (/积分|Point/i.test(label)) assets.integral += amount;
        else if (/彩票|票/.test(label)) assets.ticket += amount;
        else if (/游戏币|本币|代币/.test(label)) assets.coin += amount;
        return;
    }
    if ([101, 102, 103].includes(Number(category))) assets.coin += amount;
    else if (Number(category) === 105) assets.integral += amount;
    else if ([104, 106, 1001, 1002, 1003].includes(Number(category))) assets.ticket += amount;
}

function parseEntries(raw = "") {
    if (!raw.trim()) return [];
    if (/^\s*[\[{]/.test(raw)) {
        try {
            const data = JSON.parse(raw);
            if (Array.isArray(data)) return data.map(String).filter(Boolean);
            if (data && typeof data === "object") {
                return Object.entries(data).map(([key, value]) => `${key}=${value}`);
            }
        } catch {
            return [];
        }
    }
    return raw
        .split(/[\n&;|]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolveAccounts(app, totalEntries) {
    const entries = totalEntries.length ? totalEntries : parseEntries(process.env[app.ck] || "");
    const mapped = [];
    const common = [];
    for (const entry of entries) {
        const index = entry.indexOf("=");
        if (index > 0) {
            const key = entry.slice(0, index).trim();
            const value = entry.slice(index + 1).trim();
            if (value && [app.appid, app.ck, app.name].includes(key)) mapped.push(value);
        } else {
            common.push(entry);
        }
    }
    return mapped.length ? mapped : common;
}

class AppContext {
    constructor(app) {
        this.app = app;
        this.wx = new WeChatServer({
            url: YYB_BASE_URL,
            appid: app.appid,
            auth: WX_AUTH,
        });
    }

    async getCode(openid) {
        const { data } = await this.wx.getCode(openid);
        const code = data?.code || data?.data?.code;
        if (!code) throw new Error(`wx_server 未返回 code: ${JSON.stringify(data)}`);
        return code;
    }

    headers(shopId = "", token = "", extra = {}) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${this.app.appid}/1/page-frame.html`,
            "content-type": "application/json",
            "JJ-CHAINID": this.app.chainId,
            "BDSZH-SHOPID": shopId,
            "JJ-SHOPID": shopId,
            "JJ-MiniAppVersion": this.app.version,
            "JJ-AppId": this.app.appid,
            ...extra,
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    async request({ method = "GET", apiPath, shopId = "", token = "", params = {}, data = {}, bizCode = "" }) {
        const options = {
            method,
            url: `${this.app.apiBase}${apiPath}`,
            headers: this.headers(shopId, token, bizCode ? { "JJ-BizCode": bizCode } : {}),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (method === "GET") options.params = params;
        else options.data = data;

        const { data: result, status } = await axios.request(options);
        if (status > 400) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        return result;
    }
}

class ShopTask {
    constructor(ctx, shop, account, index) {
        this.ctx = ctx;
        this.app = ctx.app;
        this.shop = {
            shopId: String(shop.shopId),
            shopName: String(shop.shopName || `门店${shop.shopId}`).trim(),
        };
        this.account = String(account || "").trim();
        this.index = index;
        this.token = "";
        this.isMember = false;
        this.member = null;
        this.loginShopName = "";
    }

    prefix() {
        return `[${this.app.name}][${this.shop.shopName}][账号${this.index}]`;
    }

    cacheKey() {
        return `${this.app.appid}:${this.account}:${this.shop.shopId}`;
    }

    getCachedToken() {
        const cache = readCache();
        return cache[this.cacheKey()] || null;
    }

    saveToken() {
        if (!this.token) return;
        const cache = readCache();
        cache[this.cacheKey()] = {
            token: this.token,
            isMember: this.isMember,
            member: this.member,
            shopId: this.shop.shopId,
            shopName: this.loginShopName || this.shop.shopName,
            appid: this.app.appid,
            appName: this.app.name,
            updatedAt: new Date().toISOString(),
        };
        writeCache(cache);
    }

    clearToken() {
        const cache = readCache();
        delete cache[this.cacheKey()];
        writeCache(cache);
        this.token = "";
    }

    applyLogin(data = {}) {
        this.token = data.token || "";
        this.isMember = !!data.isMember;
        this.member = data.member || null;
        this.loginShopName = data.shopName || "";
    }

    async run() {
        const result = {
            appName: this.app.name,
            shopName: this.shop.shopName,
            loginShopName: "",
            member: false,
            memberText: "",
            assets: { coin: 0, integral: 0, ticket: 0, coupon: 0 },
            sign: "未执行",
        };

        const cached = this.getCachedToken();
        if (cached) {
            this.token = cached.token || "";
            this.isMember = !!cached.isMember;
            this.member = cached.member || null;
            this.loginShopName = cached.shopName || "";
            $.log(`${this.prefix()} 使用缓存token ${shortToken(this.token)}`);
            if (!(await this.checkToken())) {
                this.clearToken();
                $.log(`${this.prefix()} 缓存token失效，重新登录`);
            }
        }

        if (!this.token) await this.login();
        if (!this.token) {
            result.sign = "登录失败";
            $.log(`${this.prefix()} 结果=${result.sign}`);
            return result;
        }

        const memberText = this.member
            ? `${this.member.nickName || this.member.name || this.member.memberName || "member"}${this.member.phone ? ` ${maskPhone(this.member.phone)}` : ""}`
            : "非会员";
        const assets = this.isMember ? await this.getAssets() : result.assets;
        result.loginShopName = this.loginShopName || this.shop.shopName;
        result.member = this.isMember;
        result.memberText = memberText;
        result.assets = assets;

        $.log(
            `${this.prefix()} 查询: 登录门店=${result.loginShopName} member=${this.isMember} ${memberText} 代币=${assets.coin} 积分=${assets.integral} 彩票=${assets.ticket} 优惠券=${assets.coupon}`
        );

        if (!this.isMember) {
            result.sign = "非会员跳过";
            $.log(`${this.prefix()} 签到: ${result.sign}`);
            return result;
        }

        result.sign = await this.sign();
        $.log(`${this.prefix()} 签到: ${result.sign}`);
        return result;
    }

    async checkToken() {
        try {
            const result = await this.ctx.request({
                apiPath: "/signed/capp/signed/getreward",
                shopId: this.shop.shopId,
                token: this.token,
            });
            return !!result.success;
        } catch {
            return false;
        }
    }

    async login() {
        try {
            const code = await this.ctx.getCode(this.account);
            const result = await this.ctx.request({
                method: "POST",
                apiPath: "/capp/account/login",
                shopId: this.shop.shopId,
                data: { code },
            });
            if (!result.success) throw new Error(result.msg || JSON.stringify(result));
            this.applyLogin(result.data || {});
            if (!this.token) throw new Error(`登录响应无token: ${JSON.stringify(result)}`);
            this.saveToken();
            $.log(`${this.prefix()} 登录成功 token=${shortToken(this.token)}`);
        } catch (e) {
            $.log(`${this.prefix()} 登录失败: ${e.message || e}`);
        }
    }

    async getAssets() {
        const assets = { coin: 0, integral: 0, ticket: 0, coupon: 0 };
        const accountNames = {};
        try {
            const account = await this.ctx.request({
                apiPath: "/basic/shop/xcx/scene/getaccount",
                shopId: this.shop.shopId,
                token: this.token,
            });
            const list = Array.isArray(account?.data) ? account.data : [];
            for (const item of list) accountNames[Number(item.key)] = item.value;
        } catch (e) {
            $.log(`${this.prefix()} 查询账户类型失败: ${e.message || e}`);
        }

        try {
            const store = await this.ctx.request({
                apiPath: "/member/capp/member/store/get",
                shopId: this.shop.shopId,
                token: this.token,
            });
            const list = Array.isArray(store?.data) ? store.data : [];
            for (const item of list) addStoreAsset(assets, item.storeCategory, item.value, accountNames[Number(item.storeCategory)]);
        } catch (e) {
            $.log(`${this.prefix()} 查询资产失败: ${e.message || e}`);
        }
        try {
            const coupon = await this.ctx.request({
                apiPath: "/coupon/capp/membercoupon/count",
                shopId: this.shop.shopId,
                token: this.token,
            });
            if (coupon?.success) assets.coupon = Number(coupon.data || 0);
        } catch (e) {
            $.log(`${this.prefix()} 查询优惠券失败: ${e.message || e}`);
        }
        return assets;
    }

    async getReward() {
        const result = await this.ctx.request({
            apiPath: "/signed/capp/signed/getreward",
            shopId: this.shop.shopId,
            token: this.token,
        });
        if (!result.success) throw new Error(result.msg || JSON.stringify(result));
        return result.data || {};
    }

    async getProgress(signType) {
        const apiPath = Number(signType) === 0 ? "/signed/capp/signed/getprogress" : "/signed/capp/signed/getnewprogress";
        const result = await this.ctx.request({
            apiPath,
            shopId: this.shop.shopId,
            token: this.token,
        });
        if (!result.success) throw new Error(result.msg || JSON.stringify(result));
        return result.data || {};
    }

    getSignedState(reward, progress) {
        const signType = Number(reward.signCycle || 0);
        const signMode = Number(reward.signMode || 1);

        if (signType === 0) {
            return {
                signType,
                signMode,
                signed: !progress.isSigning,
                currentDay: progress.signInDays || 0,
                apiPath: "/signed/capp/signed/confirm",
            };
        }

        if (signMode === 2 && progress.totalDay) {
            return {
                signType,
                signMode,
                signed: !progress.totalDay.isSigning,
                currentDay: progress.totalDay.signInDays || 0,
                apiPath: "/signed/capp/signed/newconfirm",
            };
        }

        if (signMode === 3 && Array.isArray(progress.dailyDay)) {
            return {
                signType,
                signMode,
                signed: progress.dailyDay.some((item) => isToday(item.signDate)),
                currentDay: progress.dailyDay.length,
                apiPath: "/signed/capp/signed/newconfirm",
            };
        }

        return {
            signType,
            signMode,
            signed: progress.totalDay ? !progress.totalDay.isSigning : false,
            currentDay: progress.totalDay?.signInDays || 0,
            apiPath: "/signed/capp/signed/newconfirm",
        };
    }

    async sign() {
        try {
            const reward = await this.getReward();
            if (!reward.isEnabled) return "未开启签到";

            const progress = await this.getProgress(reward.signCycle);
            const state = this.getSignedState(reward, progress);
            $.log(`${this.prefix()} 签到状态: signType=${state.signType} signMode=${state.signMode} currentDay=${state.currentDay} signed=${state.signed}`);

            if (state.signed) return "今日已签到";

            const result = await this.ctx.request({
                method: "POST",
                apiPath: state.apiPath,
                shopId: this.shop.shopId,
                token: this.token,
                data: { longitude: 0, latitude: 0 },
                bizCode: createGuid(),
            });
            if (!result.success) throw new Error(result.msg || JSON.stringify(result));
            const data = result.data || {};
            return `签到成功${data.rewardName || data.prizeName ? ` 奖励=${data.rewardName || data.prizeName}` : ""}`;
        } catch (e) {
            return `签到失败: ${e.message || e}`;
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
        return (r.data || []).map(a => a.openid).filter(Boolean);
    } catch { return []; }
}

!(async () => {
    const totalEntries = await fetchAccounts();
    if (!totalEntries.length) {
        $.log("未获取到账号，请确认 wx_server 已登录");
        await $.done();
        return;
    }

    const summaries = [];

    for (const app of APPS) {
        const accounts = resolveAccounts(app, totalEntries);
        if (!accounts.length) {
            $.log(`[${app.name}] 未配置账号，跳过`);
            continue;
        }

        $.log(`\n===== ${app.name} appid=${app.appid} chainId=${app.chainId} 门店数=${app.shops.length} =====`);
        const ctx = new AppContext(app);
        for (const shop of app.shops) {
            let index = 1;
            for (const account of accounts) {
                summaries.push(await new ShopTask(ctx, shop, account, index++).run());
            }
        }
    }

    if (!summaries.length) {
        $.log(`未找到账号，请确认 wx_server 已登录`);
        await $.done();
        return;
    }

    $.log("\n========== jingjianx 签到汇总 ==========");
    for (const item of summaries) {
        $.log(
            `${item.appName} | ${item.loginShopName || item.shopName} | ${item.memberText || "未知用户"} | 代币=${item.assets.coin} 积分=${item.assets.integral} 彩票=${item.assets.ticket} 优惠券=${item.assets.coupon} | ${item.sign}`
        );
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
