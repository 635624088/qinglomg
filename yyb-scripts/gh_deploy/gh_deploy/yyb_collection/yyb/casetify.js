/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: CASETiFY 签到
cron: 46 8 * * *
------------------------------------------
------------------------------------------
*/

const { Env } = require("./env.js");
const $ = new Env("CASETiFY 签到");
const axios = require("axios");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wxd0c71d6bf928a416";
const PAGE_VERSION = "160";
const API_BASE = "https://mini-app-api.casetify.cn/api/v4";
const WECHAT_ID = 260;
const POINT_MALL_TYPE = 13;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "tongyiwxid";

const wechat = new WeChatServer({ appid: MINI_APP_ID });

function normalizeDate(value) {
    const parts = String(value || "").split("-");
    if (parts.length !== 3) return String(value || "");
    return `${parts[0]}-${String(Number(parts[1])).padStart(2, "0")}-${String(Number(parts[2])).padStart(2, "0")}`;
}

function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isTokenError(message) {
    return /token|登录|授权|invalid|expire|过期|401|403/i.test(String(message || ""));
}

class Task {
    constructor(openid, nickname) {
        this.index = $.userIdx++;
        this.openid = String(openid || "").trim();
        this.nickname = nickname;
        this.token = "";
        this.memberId = "";
        this.customerNo = "";
        this.phone = "";
        this.levels = "";
        this.campaignId = "";
    }

    async run() {
        await this.loginByWxCode();
        if (!this.token) return;

        await this.getCampaignId();
        await this.doSign();
    }

    getHeaders(auth = false) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        };
        if (!auth) headers.token = this.token || "";
        return headers;
    }

    async request(method, apiPath, data = {}, options = {}) {
        const requestOptions = {
            method,
            url: `${API_BASE}/${apiPath}`,
            headers: this.getHeaders(options.auth),
            timeout: 20000,
            validateStatus: () => true,
        };
        if (method === "GET") requestOptions.params = data;
        else requestOptions.data = data;

        const { status, data: result } = await axios.request(requestOptions);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (!options.allowAnyCode && result?.resultCode !== "1") {
            const err = new Error(result?.msg || JSON.stringify(result));
            err.resultCode = result?.resultCode;
            throw err;
        }
        return result;
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
            const result = await this.request("GET", `estore/member/onLogin/${code}/${WECHAT_ID}`, {}, { auth: true });
            const user = result.data || {};
            this.token = user.token || "";
            this.memberId = user.id || "";
            this.customerNo = user.customerNo || "";
            this.phone = user.phone || "";
            this.levels = user.levels || "";
            $.log(`${this.nickname} 登录成功: ${this.levels || "会员"} ${this.customerNo || this.memberId || ""}`);
        } catch (e) {
            $.log(`${this.nickname} 登录失败: ${e.message || e}`);
        }
    }

    async getCampaignId(silent = false) {
        if (this.campaignId) return this.campaignId;
        const result = await this.request("GET", "estore-campaign/campaign/info/get", {
            campaignType: POINT_MALL_TYPE,
        });
        const campaignId = result.data?.detail?.campaignId || result.data?.campaignId || "";
        if (!campaignId) throw new Error("未找到积分商城活动");
        this.campaignId = campaignId;
        if (!silent) $.log(`${this.nickname} 积分商城活动: ${campaignId}`);
        return campaignId;
    }

    async getSignInfo() {
        if (!this.campaignId) await this.getCampaignId(true);
        const result = await this.request("GET", "estore-campaign/campaign/pointsMall/assignment/sign", {
            campaignId: this.campaignId,
        });
        return result.data || {};
    }

    async doSign() {
        try {
            const before = await this.getSignInfo();
            const signDays = Array.isArray(before.signDays) ? before.signDays : [];
            const todayStatus = signDays.find((item) => normalizeDate(item.signDay) === today());
            const dailyTask = Array.isArray(before.assignDetail)
                ? before.assignDetail.find((item) => item.assignmentName && item.assignmentName.includes("单日"))
                : null;
            if (todayStatus?.signStatus === 1 || dailyTask?.completeStatus === 1) {
                $.log(`${this.nickname} 今日已签到`);
                return;
            }

            const sign = await this.request("POST", "estore-campaign/member/sign/do", {}, { allowAnyCode: true });
            if (sign.resultCode !== "1") {
                const message = sign.msg || JSON.stringify(sign);
                if (/已签|重复/.test(message)) {
                    $.log(`${this.nickname} 今日已签到`);
                    return;
                }
                throw new Error(message);
            }

            const after = await this.getSignInfo();
            const task = Array.isArray(after.assignDetail)
                ? after.assignDetail.find((item) => item.assignmentName && item.assignmentName.includes("单日"))
                : null;
            $.log(`${this.nickname} 签到成功: +${task?.awardPrice || "未知"}积分`);
        } catch (e) {
            const message = e.message || e;
            $.log(`${this.nickname} 签到失败: ${message}`);
        }
    }
}

!(async () => {
    const _accounts = await wechat.getAccounts();
    for (let i = 0; i < _accounts.length; i++) {
        const acct = _accounts[i];
        $.log(`[${i+1}/${_accounts.length}] ${acct.nickname}`);
        await new Task(acct.openid, acct.nickname).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());