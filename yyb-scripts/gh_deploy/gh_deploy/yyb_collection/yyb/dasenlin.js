/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 大参林小程序签到
cron: 35 8 * * *
------------------------------------------
------------------------------------------
*/

const { Env } = require("./env.js");
const $ = new Env("大参林小程序签到");
const axios = require("axios");
const crypto = require("crypto");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx16ed9a8bbb188228";
const PAGE_VERSION = "992";
const CRM_BASE = "https://crmweixin.dslbuy.com";
const SIGN_BASE = CRM_BASE;
const SIGN_SALT = "LYq76ucaPg2nsO7E";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

let ckName = "dasenlin";

const wechat = new WeChatServer({ appid: MINI_APP_ID });

function todayText() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function maskPhone(phone = "") {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function md5(text) {
    return crypto.createHash("md5").update(String(text)).digest("hex").toLowerCase();
}

function getMessage(result) {
    return result?.message || result?.msg || result?.resp_msg || JSON.stringify(result);
}

function isSuccess(result) {
    return result && (Number(result.status) === 200 || result.code === "A0200" || result.resp_code === "0000");
}

function isTokenError(message) {
    return /300|311|token|登录|授权|未登录|无效|过期|您好，请登录/i.test(String(message || ""));
}

class Task {
    constructor(openid, nickname) {
        this.index = $.userIdx++;
        this.nickname = nickname;
        this.openid = openid;
        this.token = "";
        this.userInfo = {};
        this.signInfo = null;
    }

    async run() {
        if (!this.token) {
            await this.loginByWxCode();
            if (!this.token) return;
        }

        await this.getSignInfo();
        await this.signIn();
        await this.getSignInfo();
    }

    getHeaders(extra = {}) {
        return {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            ...extra,
        };
    }

    async request({ base = SIGN_BASE, method = "GET", apiPath, params = {}, data = {}, raw = false, stringifyPost = false, urlToken = false }) {
        const upperMethod = method.toUpperCase();
        const token = this.token;
        const options = {
            method: upperMethod,
            url: `${base}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`,
            headers: this.getHeaders(),
            timeout: 20000,
            validateStatus: () => true,
        };

        if (token && urlToken) {
            if (options.url.includes("?")) options.url += `&mini_token=${encodeURIComponent(token)}`;
            else options.url += `?mini_token=${encodeURIComponent(token)}`;
        }

        const payload = token ? { ...data, mini_token: token, type: data.type ?? 1 } : { ...data };
        if (upperMethod === "GET") options.params = token ? { ...params, mini_token: token, type: params.type ?? 1 } : params;
        else options.data = stringifyPost ? JSON.stringify(payload) : payload;

        const { data: result, status } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(result)}`);
        if (raw) return result;
        if (!isSuccess(result)) throw new Error(getMessage(result));
        return result.data ?? result.datas ?? result;
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
            const result = await axios.request({
                method: "POST",
                url: `${CRM_BASE}/member-center/entrance/registryByWeiXinCode`,
                headers: this.getHeaders(),
                data: {
                    code,
                    storeNo: "",
                },
                timeout: 20000,
                validateStatus: () => true,
            });
            if (result.status !== 200) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.data)}`);
            const body = result.data;
            if (!isSuccess(body)) throw new Error(getMessage(body));
            const data = body.data || {};
            this.token = data.token || "";
            const crm = data.crmMemberInfo || {};
            const third = data.miniUserThirdVo || {};
            this.userInfo = {
                id: data.id || crm.id || "",
                name: crm.name || crm.nickName || data.nickName || "",
                phone: crm.phone || crm.mobile || data.phone || data.mobile || "",
                mobile: crm.mobile || crm.phone || data.mobile || data.phone || "",
                tier: crm.tier || data.tier || "",
                point: crm.point || data.point || "",
                openId: third.openId || "",
                unionId: third.unionId || "",
            };
            if (!this.token) throw new Error(`登录响应未返回token: ${JSON.stringify(body)}`);
            $.log(`${this.nickname} 登录成功${this.userInfo.phone ? `: ${maskPhone(this.userInfo.phone)}` : ""}`);
        } catch (e) {
            $.log(`${this.nickname} 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getSignInfo(false);
            return true;
        } catch (e) {
            return false;
        }
    }

    async getSignInfo(needLog = true) {
        const data = await this.request({
            base: SIGN_BASE,
            apiPath: "/integralmall/signTemp/getByUser.do",
            raw: true,
        });
        if (!isSuccess(data)) throw new Error(getMessage(data));
        const result = data?.data?.result || data?.datas?.result || {};
        this.signInfo = result;
        const member = data?.data?.member || {};
        const miniUser = data?.data?.miniUser || {};
        const phone = this.userInfo.phone || this.userInfo.mobile || member.phone || member.mobile || miniUser.mobile || "";
        this.userInfo = {
            ...this.userInfo,
            name: this.userInfo.name || member.name || miniUser.name || "",
            phone,
            mobile: phone,
            tier: this.userInfo.tier || member.tier || miniUser.tier || "",
            point: member.point ?? miniUser.point ?? this.userInfo.point ?? "",
        };

        if (needLog) {
            const userSign = result.userSign || {};
            const signed = this.isSignedToday(userSign.signDate);
            $.log(`${this.nickname} 会员: ${this.userInfo.name || "未知"} ${maskPhone(phone)}`);
            $.log(`${this.nickname} 签到状态: 连续${userSign.signDay ?? userSign.successionDay ?? 0}天 今日=${signed ? "已签" : "未签"}`);
        }
        return result;
    }

    isSignedToday(signDate) {
        if (!signDate) return false;
        const date = new Date(Number(signDate) || signDate);
        if (Number.isNaN(date.getTime())) return false;
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}` === todayText();
    }

    async signIn() {
        const userSign = this.signInfo?.userSign || {};
        if (this.isSignedToday(userSign.signDate)) {
            $.log(`${this.nickname} 今日已签到`);
            return;
        }

        const mobile = this.userInfo.phone || this.userInfo.mobile;
        if (!mobile) {
            $.log(`${this.nickname} 签到失败: 未获取到会员手机号`);
            return;
        }

        try {
            await this.request({
                base: SIGN_BASE,
                apiPath: "/integralmall/userSign/updateFormId.do",
                data: {
                    remind: false,
                },
            }).catch(() => {});

            const timestamp = Math.round(Date.now() / 1000);
            const sign = md5(`${mobile}${timestamp}${SIGN_SALT}`);
            const result = await this.request({
                base: SIGN_BASE,
                apiPath: "/integralmall/userSign/sign.do",
                data: {
                    mobile,
                    timestamp,
                    sign,
                    storeNo: "",
                },
                raw: true,
            });

            if (Number(result.status) === 1 || /今日已签到/.test(getMessage(result))) {
                $.log(`${this.nickname} 今日已签到`);
                return;
            }
            if (!isSuccess(result)) throw new Error(getMessage(result));

            const data = result.data || {};
            if (data.yearPointFull) {
                $.log(`${this.nickname} 签到成功，本年积分已达上限`);
                return;
            }
            const integral = data.integral ?? result.message ?? "";
            $.log(`${this.nickname} 签到成功${integral !== "" && integral !== "0" ? `: +${integral}积分` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/今日已签到|已签到/.test(message)) {
                $.log(`${this.nickname} 今日已签到`);
                return;
            }
            $.log(`${this.nickname} 签到失败: ${message}`);
            if (isTokenError(message)) this.token = "";
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