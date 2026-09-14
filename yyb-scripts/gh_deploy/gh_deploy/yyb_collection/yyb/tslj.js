/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description:  
cron: 30 9 * * *
------------------------------------------
#Notice:   
谢瑞麟 微信小程序 签到得积分 
需要配置 YYB_BASE_URL 环境变量
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

const { Env } = require("./env")
const $ = new Env("谢瑞麟小程序签到");
const WeChatServer = require("./wcs.js");
const axios = require("axios");
let wechat = new WeChatServer({ appid: 'wx439d0e0cc6742818' });

class Task {
    constructor(openid, nickname) {
        this.index = $.userIdx++
        this.nickname = nickname
        this.openid = openid
        this.token = null
        this.isSign = false
    }

    async run() {
       await $.wait(Math.floor(Math.random() * 20 + 5) * 1000);
        let { data: codeRes } = await wechat.getCode(this.openid)
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code)
        }
        if (!this.token) {
            $.log(`获取用户Token失败❌`)
            return
        }
        this.token = 'Bearer ' + this.token

        await this.getUserInfo()
        if (!this.isSign) await this.doSign()
    }
    async getUserToken(code) {
        let options = {
            method: 'POST',
            url: `https://tslmember-crm.tslj.com.cn/api/auth/login`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "content-type": "application/json",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249"
            },
            data: { "code": code }
        }
        let { data: result } = await axios.request(options);
        if (result?.code == '0') {
            this.token = result.data.user_info.token
            this.openid = result.data.user_info.openid
            $.log(`获取用户Token成功`)
        } else {
            $.log(`获取用户Token失败:${result.msg}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'POST',
            url: `https://tslmember-crm.tslj.com.cn/api/user/index`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/x-www-form-urlencoded",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site",
                "user-agent": 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254173b) XWEB/19027'
            },
            data: { "openid": this.openid }
        }
        let { data: result } = await axios.request(options);
        if (result?.code == '0') {
            $.log(`[${result.data.mobile}] 积分[${result.data.integral}]🎉`);
            for (let task of result.data.task_list) {
                if (task.name == '每日签到') {
                    this.isSign = task.status
                }
            }
        } else {
            $.log(`获取用户信息失败:${result.msg}❌`)
        }
    }

    async doSign() {
        let options = {
            method: 'POST',
            url: `https://tslmember-crm.tslj.com.cn/api/userSignIn/signIn`,
            headers: {
                "accept": "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
                "authorization": "" + this.token + "",
                "content-type": "application/x-www-form-urlencoded",
                "priority": "u=1, i",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "cross-site"
            },
            data: { "openid": `${this.openid}` }
        };
        let { data: result } = await axios.request(options);
        if (result?.code == '0') {
            const { integral, total_days } = result?.data;
            $.log(`签到成功, 已连续签到 ${total_days} 天, 获得 ${integral} 积分 🎉`);
        } else {
            $.log(`签到失败:${result.msg}❌`)
        }
    }
}

!(async () => {
    await getNotice()
    const _accounts = await wechat.getAccounts();
    for (let i = 0; i < _accounts.length; i++) {
        const acct = _accounts[i];
        $.log(`[${i+1}/${_accounts.length}] ${acct.nickname}`);
        await new Task(acct.openid, acct.nickname).run();
    }
})()
    .catch((e) => console.log(e))
    .finally(() => $.done());
async function getNotice() {
    try {
        let options = {
            url: `https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json`,
            headers: {
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram",
            },
            timeout: 3000
        }
        let { data: res } = await axios.request(options);
        $.log(res)
        return res
    } catch (e) { }
}
