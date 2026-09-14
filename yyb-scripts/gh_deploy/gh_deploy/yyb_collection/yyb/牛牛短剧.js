/*
牛牛短剧微信小程序任务
cron: 35 8 * * *
说明：
- 小程序 appid：wxcb95401f250e9a53
*/

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const APP_NAME = "牛牛短剧微信小程序任务";
const MINI_APP_ID = "wxcb95401f250e9a53";
const API_BASE = "https://api.tianjinzhitongdaohe.com/sqx_fast";
const TOKEN_CACHE_FILE = path.join(__dirname, "niuniuduanju_code_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254181d) XWEB/19201";
const DAILY_ACTION_COUNT = 2;
const EAT_GOLD_COUNT = 4;
const VIDEO_COUNT_STEPS = [1, 5, 9, 15, 20];
const VIDEO_DURATION_STEPS = [60, 300, 900, 1800, 3600, 7200, 9000];
const CACHE_FALLBACK = String(process.env.NIUNIU_CACHE_FALLBACK || "1") !== "0";

function log(msg) {
    console.log(msg);
}

function env(name, fallback = "") {
    return process.env[name] || fallback;
}

function splitList(raw = "") {
    return String(raw || "").split(/[\n,;&|]+/).map(x => x.trim()).filter(Boolean);
}

function mask(v = "", left = 8, right = 6) {
    v = String(v || "");
    if (v.length <= left + right) return v ? `${v.slice(0, Math.min(4, v.length))}***` : "";
    return `${v.slice(0, left)}***${v.slice(-right)}`;
}

function randomUserName() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    return `用户${suffix}`;
}

function today() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function joinUrl(base, suffix) {
    const b = String(base || "").replace(/\/+$/, "");
    const s = String(suffix || "").replace(/^\/+/, "");
    return `${b}/${s}`;
}

function extractCode(data) {
    return data?.code || data?.wxCode || data?.wx_code || data?.data?.code || data?.data?.wxCode || data?.data?.wx_code || data?.result?.code || "";
}

function readJsonFile(file) {
    try {
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
        return {};
    }
}

function writeJsonFile(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        log(`写入缓存失败: ${e.message || e}`);
    }
}

function rawRequest(method, urlStr, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const headers = Object.assign({
            "Accept": "application/json, text/plain, */*",
            "Accept-Encoding": "identity",
        }, options.headers || {});
        let body = null;
        if (options.json !== undefined) {
            body = JSON.stringify(options.json);
            headers["Content-Type"] = headers["Content-Type"] || "application/json";
        } else if (options.form !== undefined) {
            body = new URLSearchParams(options.form).toString();
            headers["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded;charset=utf-8";
        }
        if (body !== null) headers["Content-Length"] = Buffer.byteLength(body);
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers,
            timeout: options.timeout || 30000,
        }, res => {
            let raw = "";
            res.setEncoding("utf8");
            res.on("data", chunk => raw += chunk);
            res.on("end", () => {
                let json = null;
                try { json = raw ? JSON.parse(raw) : null; } catch {}
                resolve({ status: res.statusCode, headers: res.headers, raw, json });
            });
        });
        req.on("timeout", () => req.destroy(new Error(`${method} ${urlStr} timeout`)));
        req.on("error", reject);
        if (body !== null) req.write(body);
        req.end();
    });
}

class Task {
    constructor(account, index) {
        this.openid = account.openid;
        this.nickname = account.nickname || account.openid;
        this.index = index;
        this.token = "";
        this.user = {};
        this.wxInfo = {};
    }

    async run() {
        await this.loginByCode();
        if (!this.token && CACHE_FALLBACK) await this.tryCacheFallback();
        if (!this.token) return;
        await this.getPoints("任务前积分");
        await this.getSignStatus();
        await this.signIn();
        await this.doDailyTasks();
        await this.getPoints("任务后积分");
    }

    cacheKey() {
        return this.openid;
    }

    saveCache() {
        if (!this.token) return;
        const cache = readJsonFile(TOKEN_CACHE_FILE);
        cache[this.cacheKey()] = { token: this.token, user: this.user, wxInfo: this.wxInfo, updatedAt: new Date().toISOString() };
        writeJsonFile(TOKEN_CACHE_FILE, cache);
    }

    removeCache() {
        const cache = readJsonFile(TOKEN_CACHE_FILE);
        if (cache[this.cacheKey()]) {
            delete cache[this.cacheKey()];
            writeJsonFile(TOKEN_CACHE_FILE, cache);
        }
        this.token = "";
        this.user = {};
    }

    async tryCacheFallback() {
        const cache = readJsonFile(TOKEN_CACHE_FILE);
        const item = cache[this.cacheKey()];
        if (!item?.token) return false;
        this.token = item.token;
        this.user = item.user || {};
        this.wxInfo = item.wxInfo || {};
        log(`账号[${this.index}] ${this.nickname} 使用 token 缓存兜底: ${mask(this.token)}`);
        if (await this.checkToken()) return true;
        this.removeCache();
        log(`账号[${this.index}] ${this.nickname} token 缓存已失效`);
        return false;
    }

    headers(extra = {}) {
        return Object.assign({
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/19/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded",
            "xweb_xhr": "1",
        }, this.token ? { token: this.token } : {}, extra);
    }

    async request({ method = "GET", apiPath, params = {}, data = null, token = true, json = false }) {
        const url = new URL(`${API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`);
        if (method === "GET") {
            for (const [k, v] of Object.entries(params || {})) {
                if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
            }
        }
        const headers = this.headers(json ? { "Content-Type": "application/json" } : {});
        if (!token) delete headers.token;
        const res = await rawRequest(method, url.toString(), { headers, json: method === "GET" ? undefined : (json ? data : undefined), timeout: 30000 });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${String(res.raw || "").slice(0, 200)}`);
        const result = res.json;
        if (!result || result.code !== 0) {
            const err = new Error(result?.msg || result?.message || JSON.stringify(result));
            err.code = result?.code;
            throw err;
        }
        return result;
    }

    async getWxCode() {
        const wxServerUrl = env("YYB_BASE_URL", env("YYB_BASE_URL", "http://172.17.0.1:18080")).replace(/\/+$/, "");
        const wxAuth = env("wx_auth", env("WX_AUTH"));
        if (!wxServerUrl) throw new Error("未配置 YYB_BASE_URL");
        const headers = { "Content-Type": "application/json" };
        if (wxAuth) headers["Authorization"] = "Bearer " + wxAuth;
        const res = await rawRequest("POST", joinUrl(wxServerUrl, "/wxapp/getCode"), {
            headers,
            json: { app_id: MINI_APP_ID, ref: this.openid },
            timeout: 30000,
        });
        const data = res.json;
        if (res.status !== 200 || data?.code !== 0) throw new Error(`wxapp/getCode 获取失败: ${String(res.raw || "").slice(0, 300)}`);
        const code = data?.data?.result?.code || "";
        if (!code) throw new Error(`wxapp/getCode 未返回 code: ${String(res.raw || "").slice(0, 300)}`);
        log(`账号[${this.index}] ${this.nickname} 获取 code 成功`);
        return code;
    }

    async loginByCode() {
        try {
            const code = await this.getWxCode();
            const wxLogin = await this.request({ apiPath: "/app/Login/wxLogin", params: { code }, token: false });
            const wxData = wxLogin.data || {};
            const openId = wxData.open_id || wxData.openId || "";
            const unionId = wxData.unionId || wxData.unionid || "";
            if (!openId || !unionId) throw new Error(`wxLogin 未返回 openId/unionId: ${JSON.stringify(wxLogin)}`);
            this.wxInfo = wxData;
            const login = await this.request({
                method: "POST",
                apiPath: "/app/Login/insertWxUser",
                token: false,
                json: true,
                data: {
                    openId,
                    unionId,
                    userName: this.user.userName || randomUserName(),
                    avatar: this.user.avatar || "https://nnduanju.oss-cn-beijing.aliyuncs.com/01image/re-512.png",
                    sex: 1,
                    phone: "",
                    inviterCode: "",
                    qdCode: "",
                },
            });
            this.token = login.token || "";
            this.user = login.user || {};
            if (!this.token) throw new Error(`insertWxUser 未返回 token: ${JSON.stringify(login)}`);
            this.saveCache();

        } catch (e) {
            log(`账号[${this.index}] ${this.nickname} 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            const result = await this.request({ apiPath: "/app/user/selectUserById" });
            this.user = result.data || this.user;
            return true;
        } catch {
            return false;
        }
    }

    async getPoints(label) {
        const result = await this.request({ apiPath: "/app/integral/selectByUserId" });
        log(`账号[${this.index}] ${this.nickname} ${label}: ${result.data?.integralNum ?? "未知"}`);
        return result.data;
    }

    async getSignStatus() {
        try {
            const result = await this.request({ apiPath: "/app/integral/selectIntegralDay", params: { classify: 1, userId: this.user.userId || "" } });
            const list = Array.isArray(result.data) ? result.data : [];
            log(`账号[${this.index}] ${this.nickname} 本周签到记录: ${list.filter(x => x?.num).length}/${list.length || 7}`);
            return list;
        } catch (e) {
            log(`账号[${this.index}] 查询签到记录失败: ${e.message || e}`);
            return [];
        }
    }

    async signIn() {
        try {
            const result = await this.request({ apiPath: "/app/integral/signIn", params: { date: today() } });
            log(`账号[${this.index}] 签到成功: ${result.msg || "success"}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|已经签到|重复|今日.*签|不能重复|签到过/.test(message)) return log(`账号[${this.index}] 今日已签到`);
            log(`账号[${this.index}] 签到失败: ${message}`);
            if (e.code === 401 || /token|登录|验证失败/.test(message)) this.removeCache();
        }
    }

    async doDailyTasks() {
        await this.completeDramaTasks();
        await this.completeEatGoldTasks();
        await this.completeVideoCoinTasks();
        await this.completeVideoDurationTasks();
        const tasks = [
            { name: "开宝箱", apiPath: "/app/integral/userTimer" },
            { name: "推荐剧观看金币", apiPath: "/app/integral/userDataVideo", params: await this.getUserDataVideoParams() },
            { name: "每日点赞剧集", apiPath: "/app/integral/goodVideo" },
            { name: "收藏新剧", apiPath: "/app/integral/collectVideo" },
            { name: "分享新剧", apiPath: "/app/integral/shareVideo" },
        ];
        for (const task of tasks) await this.claimDailyTask(task);
    }

    async claimDailyTask(task) {
        try {
            const result = await this.request({ apiPath: task.apiPath, params: task.params || {} });
            log(`账号[${this.index}] ${task.name}: ${result.msg || "已领取"}${result.data !== undefined ? ` ${result.data}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) return log(`账号[${this.index}] ${task.name}: 今日已完成`);
            if (/未完成|请先|任务未达成|次数不足|时间未到|倒计时|稍后|观看/.test(message)) return log(`账号[${this.index}] ${task.name}: ${message}`);
            log(`账号[${this.index}] ${task.name}失败: ${message}`);
            if (e.code === 401 || /token|登录|验证失败/.test(message)) this.removeCache();
        }
    }

    async completeEatGoldTasks() {
        try {
            for (let num = 0; num < EAT_GOLD_COUNT; num++) {
                try {
                    const result = await this.request({ apiPath: "/app/integral/addEatGold", params: { num } });
                    log(`账号[${this.index}] 吃饭看剧补贴[${num + 1}/${EAT_GOLD_COUNT}]: ${result.msg || "success"}`);
                } catch (e) {
                    const message = String(e.message || e);
                    if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) log(`账号[${this.index}] 吃饭看剧补贴[${num + 1}/${EAT_GOLD_COUNT}]: 今日已完成`);
                    else log(`账号[${this.index}] 吃饭看剧补贴[${num + 1}/${EAT_GOLD_COUNT}]: ${message}`);
                    if (e.code === 401 || /token|登录|验证失败/.test(message)) this.removeCache();
                }
            }
            try {
                const result = await this.request({ apiPath: "/app/integral/eatGold" });
                log(`账号[${this.index}] 当前餐点补贴: ${result.msg || "success"}`);
            } catch (e) {
                const message = String(e.message || e);
                log(`账号[${this.index}] 当前餐点补贴: ${/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message) ? "今日已完成" : message}`);
            }
        } catch (e) {
            log(`账号[${this.index}] 吃饭看剧补贴失败: ${e.message || e}`);
        }
    }

    async completeVideoCoinTasks() {
        try {
            let userInfo = await this.getUserInfo();
            let nextStep = Number(userInfo.okLookVideoNum || 0) + 1;
            if (nextStep < 1) nextStep = 1;
            if (nextStep > VIDEO_COUNT_STEPS.length) return log(`账号[${this.index}] 看视频次数前置: 今日已完成`);
            for (let step = nextStep; step <= VIDEO_COUNT_STEPS.length; step++) {
                await this.updateUserWatchCount(VIDEO_COUNT_STEPS[step - 1], step);
                try {
                    const result = await this.request({ apiPath: "/app/integral/lookVideoNum" });
                    log(`账号[${this.index}] 看视频次数金币[${step}/${VIDEO_COUNT_STEPS.length}]: ${result.msg || "success"}`);
                    userInfo = await this.getUserInfo();
                    if (Number(userInfo.okLookVideoNum || 0) >= VIDEO_COUNT_STEPS.length) break;
                } catch (e) {
                    const message = String(e.message || e);
                    if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) log(`账号[${this.index}] 看视频次数金币: 今日已完成`);
                    else log(`账号[${this.index}] 看视频次数金币[${step}/${VIDEO_COUNT_STEPS.length}]: ${message}`);
                    if (e.code === 401 || /token|登录|验证失败/.test(message)) this.removeCache();
                    break;
                }
            }
        } catch (e) {
            log(`账号[${this.index}] 看视频次数前置失败: ${e.message || e}`);
        }
    }

    async completeVideoDurationTasks() {
        try {
            let userInfo = await this.getUserInfo();
            let nextStep = Number(userInfo.okLookVideoSec || 0) + 1;
            if (nextStep < 1) nextStep = 1;
            if (nextStep > VIDEO_DURATION_STEPS.length) return log(`账号[${this.index}] 看视频时长前置: 今日已完成`);
            for (let step = nextStep; step <= VIDEO_DURATION_STEPS.length; step++) {
                await this.updateUserWatchDuration(VIDEO_DURATION_STEPS[step - 1], step);
                try {
                    const result = await this.request({ apiPath: "/app/integral/lookVideoSec" });
                    log(`账号[${this.index}] 看视频时长金币[${step}/${VIDEO_DURATION_STEPS.length}]: ${result.msg || "success"}`);
                    userInfo = await this.getUserInfo();
                    if (Number(userInfo.okLookVideoSec || 0) >= VIDEO_DURATION_STEPS.length) break;
                } catch (e) {
                    const message = String(e.message || e);
                    if (/已领取|已完成|今日.*完成|重复|不能重复|已经.*领取/.test(message)) log(`账号[${this.index}] 看视频时长金币: 今日已完成`);
                    else log(`账号[${this.index}] 看视频时长金币[${step}/${VIDEO_DURATION_STEPS.length}]: ${message}`);
                    if (e.code === 401 || /token|登录|验证失败/.test(message)) this.removeCache();
                    break;
                }
            }
        } catch (e) {
            log(`账号[${this.index}] 看视频时长前置失败: ${e.message || e}`);
        }
    }

    async updateUserWatchDuration(videoSec, lookVideoSec) {
        const userInfo = await this.getUserInfo();
        await this.request({ method: "POST", apiPath: "/app/user/updateUsers", json: true, data: { userName: userInfo.userName || randomUserName(), avatar: userInfo.avatar || "https://nnduanju.oss-cn-beijing.aliyuncs.com/01image/re-512.png", phone: userInfo.phone || "", videoSec, lookVideoSec } });
        log(`账号[${this.index}] 模拟观看时长: ${Math.floor(videoSec / 60)}分钟`);
    }

    async updateUserWatchCount(lookDayVideoNum, lookVideoNum) {
        const userInfo = await this.getUserInfo();
        await this.request({ method: "POST", apiPath: "/app/user/updateUsers", json: true, data: { userName: userInfo.userName || randomUserName(), avatar: userInfo.avatar || "https://nnduanju.oss-cn-beijing.aliyuncs.com/01image/re-512.png", phone: userInfo.phone || "", lookDayVideoNum, lookVideoNum } });
        log(`账号[${this.index}] 模拟观看视频次数: ${lookDayVideoNum}次`);
    }

    async getUserDataVideoParams() {
        try {
            const courses = await this.getDailyCourses();
            const course = courses[0] || {};
            if (!course.courseId) return {};
            const episode = await this.getCourseEpisode(course.courseId);
            return { courseId: course.courseId, courseDetailsId: episode?.courseDetailsId || course.courseDetailsId || "" };
        } catch {
            return {};
        }
    }

    async completeDramaTasks() {
        try {
            const userInfo = await this.getUserInfo();
            const needGood = Number(userInfo.goodVideo || 0) < DAILY_ACTION_COUNT;
            const needCollect = Number(userInfo.collectVideo || 0) < DAILY_ACTION_COUNT;
            if (!needGood && !needCollect) return;
            const courses = await this.getDailyCourses();
            if (!courses.length) return log(`账号[${this.index}] 剧集任务前置: 未获取到推荐剧`);
            let goodDone = 0;
            let collectDone = 0;
            for (const course of courses) {
                if (goodDone >= DAILY_ACTION_COUNT && collectDone >= DAILY_ACTION_COUNT) break;
                const episode = await this.getCourseEpisode(course.courseId);
                const courseDetailsId = episode?.courseDetailsId || course.courseDetailsId || "";
                if (!course.courseId || !courseDetailsId) continue;
                if (needGood && goodDone < DAILY_ACTION_COUNT) {
                    await this.setCourseCollect(course.courseId, courseDetailsId, 2, 0);
                    await this.setCourseCollect(course.courseId, courseDetailsId, 2, 1);
                    goodDone++;
                }
                if (needCollect && collectDone < DAILY_ACTION_COUNT) {
                    await this.setCourseCollect(course.courseId, courseDetailsId, 1, 0);
                    await this.setCourseCollect(course.courseId, courseDetailsId, 1, 1);
                    collectDone++;
                }
            }
            if (goodDone || collectDone) log(`账号[${this.index}] 剧集任务前置: 点赞${goodDone}次 收藏${collectDone}次`);
        } catch (e) {
            log(`账号[${this.index}] 剧集任务前置失败: ${e.message || e}`);
        }
    }

    async getUserInfo() {
        const result = await this.request({ apiPath: "/app/user/selectUserById" });
        this.user = result.data || this.user;
        return this.user;
    }

    async getDailyCourses() {
        const result = await this.request({ apiPath: "/app/common/type/922" });
        const list = result.data?.courseList;
        return Array.isArray(list) ? list : [];
    }

    async getCourseEpisode(courseId) {
        const result = await this.request({ apiPath: "/app/course/selectCourseDetailsByCourseId", params: { id: courseId, token: this.token } });
        return result.data || {};
    }

    async setCourseCollect(courseId, courseDetailsId, classify, type) {
        await this.request({ method: "POST", apiPath: "/app/courseCollect/insertCourseCollect", json: true, data: { courseId, courseDetailsId, classify, type } });
    }
}

async function fetchAccounts() {
    const wxServerUrl = env("YYB_BASE_URL", env("YYB_BASE_URL", "http://172.17.0.1:18080")).replace(/\/+$/, "");
    const wxAuth = env("wx_auth", env("WX_AUTH"));
    try {
        const headers = { "Content-Type": "application/json" };
        if (wxAuth) headers["Authorization"] = "Bearer " + wxAuth;
        const res = await rawRequest("GET", joinUrl(wxServerUrl, "/accounts"), { headers, timeout: 10000 });
        const d = res.json;
        if (res.status !== 200 || d?.code !== 0) return [];
        const accounts = d?.data ?? [];
        return accounts.map(a => ({
            openid: a.openid || "",
            nickname: a.nickname || a.name || "账号"
        })).filter(a => a.openid);
    } catch { return []; }
}

(async () => {
    log(`🔔${APP_NAME},开始!`);
    const accounts = await fetchAccounts();
    if (!accounts.length) throw new Error("未获取到有效账号，请确认 wx_server 已登录账号");
    log(`共${accounts.length}个账号`);
    for (let i = 0; i < accounts.length; i++) await new Task(accounts[i], i + 1).run();
    log(`🔔${APP_NAME},结束!`);
})().catch(e => {
    console.log(`运行失败: ${e.message || e}`);
});
