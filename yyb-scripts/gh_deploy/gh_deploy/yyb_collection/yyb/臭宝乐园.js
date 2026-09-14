/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description:  
cron: 30 9 * * *
------------------------------------------
⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
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
            ms >= 1000 && this.log(`等待 ${Math.round(ms / 1000)} 秒...`, { notify: false });
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
const $ = new Env("臭宝乐园");
class WeChatCodeServer {
    constructor(options) {
        this.serverUrl = options.url;
        this.appid = options.appid;
        this.auth = options.auth;
    }
    getCode(openid) {
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
                return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json" };
            if (this.auth) headers["Authorization"] = "Bearer " + this.auth;
            axios.post(this.serverUrl + '/wxapp/operateWxData', { app_id: this.appid, ref: openid, payload: { action: "init" } }, {
                headers,
                timeout: 30 * 1000
            }).then(res => {
                                resolve(res);
            }).catch(err => {
                reject(err);
            });
        });
    }
    cloudCall(openid) {
                return new Promise((resolve, reject) => {
            const headers = { "Content-Type": "application/json" };
            if (this.auth) headers["Authorization"] = "Bearer " + this.auth;
            axios.post(this.serverUrl + '/wxapp/operateWxData', { app_id: this.appid, ref: openid, payload: { action: "call" } }, {
                headers,
                timeout: 30 * 1000
            }).then(res => {
                                resolve(res);
            }).catch(err => {
                reject(err);
            });
        });
    }
}
const WeChatServer = WeChatCodeServer;

let ckName = `choubaoleyuan`;
const strSplitor = "#";
const axios = require("axios");
const fs = require("fs");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
let wechat = new WeChatServer({
    url: process.env.YYB_BASE_URL || 'http://172.17.0.1:18080',
    appid: 'wx2206cca563f6f937',
    auth: process.env.wx_auth || "your-api-key",

}
);

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);

        this.wcsid = this.user[0]
    }

    async run() {
       //随机延迟5-30s 模拟人工操作
       await $.wait(Math.floor(Math.random() * 20 + 5) * 1000);
        let { data: codeRes } = await wechat.getCode(this.wcsid)
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code)
        }
        if (!this.token) {
            $.log(`账号[${this.index}] 获取用户Token失败❌`)
            return
        }
        this.token = 'Bearer' + this.token
        await this.getUserInfo()
        await this.track()
        await this.checkSign()
        
    }
    async getUserToken(code) {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/bff/v1/auth/wechatLogin`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "content-type": "application/json",
                "authorization": "Bearer" + this.token
            }
            ,
            data: {
                loginCode: code
            }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            this.token = result.data
            $.log(`🌸账号[${this.index}] 获取用户Token成功:${this.token.slice(0,16)}...`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.msg}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/wnuser/v1/memberUser/getMemberUser`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            }
        }
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `[${result.data.nickName}] 积分[${result.data.points}]🎉`);
        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.msg}❌`)
        }
    }
    async track() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/member/v1/memberBuryPoint/add`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            },
            data: { "appletVersion": "2.0.31", "phoneSystem": "Windows Unknown x64", "phoneModel": "microsoft", "functionName": "签到", "module": "首页", "linkUrl": "pages/signIn/signIn", "secondPage": "" }
        }
        await axios.request(options);
    }
    async checkSign() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/wnuser/v1/memberUser/checkSignNum`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            },
            data: {

            }
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            //打印签到结果
            await this.signIn()
        } else {

        }

    }

    async signIn() {
        let options = {
            method: 'POST',
            url: `https://cb-bags-slb.weinian.com.cn/wnuser/v1/memberUser/daySign`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/json",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site"
            },
            data: {

            }
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.status == '200') {
            //打印签到结果
            $.log(`🌸账号[${this.index}]` + `签到成功🎉`);
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.msg}❌`)
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
    await getNotice()
    const _accounts = await fetchAccounts();
    if (!_accounts.length) {
        console.log("未获取到账号，请确认 wx_server 已登录");
        return;
    }
    for (const user of _accounts) {
        await new Task(user).run();
    }
})().catch(e => console.log(e)).finally(() => $.done());
async function getNotice() {
    try {
        let options = {
            url: `https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json`,
            headers: {
                "User-Agent": defaultUserAgent,
            },
            timeout: 3000
        }
        let {
            data: res
        } = await axios.request(options);
        $.log(res)
        return res
    } catch (e) { }

}
