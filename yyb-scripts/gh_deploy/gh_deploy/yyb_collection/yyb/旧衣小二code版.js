/**
 * 描述：微信小程序旧衣小二 (Code版) 
  * 环境变量：
 *   YYB_BASE_URL - YYB协议地址
 *   DD_BOT_TOKEN - 钉钉机器人access_token
 *   DD_BOT_SECRET - 钉钉机器人签名密钥
 *   wqwl_daili - 代理链接（可选）
 *   wqwl_useProxy - 是否使用代理（可选）
 *   wqwl_bfs - 并发数，默认4（可选）
 * 
 * appid: wx426d52c8130b8559 (旧衣小二的appid)
 * cron: 25 0 * * *
 */

const axios = require('axios');
const fs = require('fs');
const qs = require('qs');
const crypto = require('crypto');
const path = require('path');

// ====================== 全局配置 ======================
const YYB_BASE_URL = process.env.YYB_BASE_URL || 'http://172.17.0.1:18080';
const APPID = 'wx426d52c8130b8559';
let proxy = process.env["wqwl_daili"] || '';
let isProxy = process.env["wqwl_useProxy"] || false;
let bfs = process.env["wqwl_bfs"] || 4;
const isNotify = true;
const ckName = 'wqwl_jyxe_code';
const name = '微信小程序旧衣小二(Code版) V1.5.2';

// 钉钉配置
const DD_BOT_TOKEN = process.env.DD_BOT_TOKEN;
const DD_BOT_SECRET = process.env.DD_BOT_SECRET;

// 重试配置
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2秒
const TIMEOUT = 20000; // 20秒

// 全局变量
let index = 0;
let notifyMessages = [];
let isExiting = false;
let failedAccounts = []; // 记录失败的账号

// ====================== 工具函数 ======================
/**
 * 延时函数
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


// ====================== 从 YYB 协议获取账号 ======================
async function fetchAccountsFromYYB() {
  try {
    const response = await axios.get(`${YYB_BASE_URL}/accounts`, { timeout: 10000 });
    const data = response.data;
    if (data.code === 0 && data.data) {
      return data.data.map(acc => ({
        remark: acc.nickname || acc.alias || acc.openid,
        wxid: acc.openid
      }));
    }
  } catch (e) {
    console.log(`❌ 从 YYB 协议获取账号失败：`, e.message);
  }
  return [];
}

/**
 * 通过wxid获取微信code（带重试机制）
 */
async function fetchCodeFromWxid(wxid, retryCount = 0) {
    if (!YYB_BASE_URL) {
        console.log('❌ 未配置YYB_BASE_URL环境变量');
        return null;
    }
    
    try {
        const url = `${YYB_BASE_URL}/wxapp/getCode`;
        console.log(`📡 请求code服务...`);
        
        const response = await axios.post(url, {
            ref: wxid,
            app_id: APPID
        }, { 
            timeout: TIMEOUT,
            headers: { 'Content-Type': 'application/json' }
        });
        
        // 兼容 YYB 格式：code=0, data.result.code
        if (response.data && response.data.code === 0) {
            const data = response.data.data || {};
            const result = data.result || {};
            const code = result.code || data.code;
            if (code) {
                console.log(`✅ 获取code成功: ${code.substring(0, 10)}...`);
                return code;
            }
        }
        
        console.log(`❌ 获取code失败: ${response.data?.msg || '未知错误'}`);
        return null;
        
    } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        const errorMsg = isTimeout ? '超时' : error.message;
        
        console.log(`❌ 获取code失败 (${errorMsg})`);
        
        // 重试逻辑
        if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAY * (retryCount + 1);
            console.log(`🔄 第${retryCount + 1}/${MAX_RETRIES}次重试，等待${delay/1000}秒...`);
            await sleep(delay);
            return fetchCodeFromWxid(wxid, retryCount + 1);
        }
        
        return null;
    }
}

/**
 * 通过code获取token（带重试机制）
 */
async function getTokenFromCode(code, wxid, retryCount = 0) {
    try {
        const url = 'https://jiuyixiaoer.fzjingzhou.com/api/login/getWxMiniProgramSessionKey';
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'xweb_xhr': '1',
            'platform': 'MP-WEIXIN',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': 'https://servicewechat.com/wx426d52c8130b8559/5/page-frame.html'
        };
        
        const data = qs.stringify({ 
            code: code,
            gdtVid: '',
            token: ''
        });
        
        console.log(`📤 请求登录接口...`);
        
        const response = await axios.post(url, data, { 
            headers, 
            timeout: TIMEOUT 
        });
        
        if (response.data) {
            console.log(`📥 响应状态: ${response.status}`);
            
            let token = null;
            if (typeof response.data === 'string') {
                token = response.data;
            } else if (response.data.data && typeof response.data.data === 'string') {
                token = response.data.data;
            } else if (response.data.token) {
                token = response.data.token;
            } else if (response.data.session_key) {
                token = response.data.session_key;
            } else if (response.data.data && response.data.data.token) {
                token = response.data.data.token;
            }
            
            if (token) {
                console.log(`✅ 获取token成功: ${token.substring(0, 10)}...`);
                return token;
            } else {
                console.log('❌ 无法从响应中提取token');
            }
        }
        return null;
        
    } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        const errorMsg = isTimeout ? '超时' : error.message;
        
        console.log(`❌ 获取token失败 (${errorMsg})`);
        
        // 重试逻辑
        if (retryCount < MAX_RETRIES) {
            const delay = RETRY_DELAY * (retryCount + 1);
            console.log(`🔄 第${retryCount + 1}/${MAX_RETRIES}次重试，等待${delay/1000}秒...`);
            await sleep(delay);
            return getTokenFromCode(code, wxid, retryCount + 1);
        }
        
        return null;
    }
}

/**
 * 通过wxid获取token
 */
async function getTokenFromWxid(wxid) {
    console.log(`🔑 正在为wxid: ${wxid} 获取token...`);
    
    const code = await fetchCodeFromWxid(wxid);
    if (!code) {
        console.log('❌ 获取code失败，无法继续');
        return null;
    }
    
    const token = await getTokenFromCode(code, wxid);
    if (!token) {
        console.log('❌ 获取token失败');
        return null;
    }
    
    return token;
}

/**
 * 发送钉钉通知 - 精简版
 */
async function sendDingTalkNotify(title, content) {
    if (!DD_BOT_TOKEN) {
        console.log('⚠️ 未配置钉钉机器人，跳过通知');
        return;
    }
    
    try {
        let url = `https://oapi.dingtalk.com/robot/send?access_token=${DD_BOT_TOKEN}`;
        
        if (DD_BOT_SECRET) {
            const timestamp = Date.now();
            const sign = crypto
                .createHmac('sha256', DD_BOT_SECRET)
                .update(`${timestamp}\n${DD_BOT_SECRET}`)
                .digest('base64');
            url = `${url}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
        }
        
        if (content.length > 5000) {
            content = content.substring(0, 4500) + '\n\n...内容过长已截断';
        }
        
        await axios.post(url, {
            msgtype: 'markdown',
            markdown: { 
                title: title, 
                text: content 
            }
        }, { 
            headers: { 'Content-Type': 'application/json' }, 
            timeout: 10000 
        });
        
        console.log('✅ 钉钉通知发送成功');
    } catch (error) {
        console.log(`❌ 钉钉通知发送失败: ${error.message}`);
    }
}

/**
 * 处理退出信号
 */
function setupExitHandlers() {
    const exitHandler = async () => {
        if (isExiting) return;
        isExiting = true;
        
        console.log('\n🔔 收到退出信号，准备发送已完成账号的通知...');
        
        if (notifyMessages.length > 0 || failedAccounts.length > 0) {
            let content = `### ⏹️ 脚本手动停止\n\n`;
            content += `已处理账号数：${notifyMessages.length}\n`;
            if (failedAccounts.length > 0) {
                content += `失败账号数：${failedAccounts.length}\n\n`;
                content += `### ❌ 失败账号列表\n`;
                failedAccounts.forEach(acc => {
                    content += `- ${acc.remark}: ${acc.reason}\n`;
                });
            }
            content += `\n\n${notifyMessages.join('\n')}`;
            
            await sendDingTalkNotify(name, content);
        }
        
        process.exit(0);
    };
    
    process.on('SIGINT', exitHandler);
    process.on('SIGTERM', exitHandler);
}

// ====================== 主逻辑 ======================
!(async function () {
    let wqwlkj;

    const filePath = 'wqwl_require.js';
    const url = 'https://raw.githubusercontent.com/298582245/wqwl_qinglong/refs/heads/main/wqwl_require.js';

    if (fs.existsSync(filePath)) {
        console.log('✅wqwl_require.js已存在，无需重新下载，如有报错请重新下载覆盖\n');
        wqwlkj = require('./wqwl_require');
    } else {
        console.log('正在下载wqwl_require.js，请稍等...\n');
        try {
            const res = await axios.get(url, { timeout: 30000 });
            fs.writeFileSync(filePath, res.data);
            console.log('✅下载完成，准备开始运行脚本\n');
            wqwlkj = require('./wqwl_require');
        } catch (e) {
            console.log('❌下载失败，请手动下载');
            return;
        }
    }

    // 设置退出处理
    setupExitHandlers();

    try {
        wqwlkj.disclaimer();
        
        // 检查配置
        if (!YYB_BASE_URL) {
            console.log('⚠️ 警告: 未配置YYB_BASE_URL环境变量，将无法获取code！');
        }
        
        if (!DD_BOT_TOKEN) {
            console.log('⚠️ 警告: 未配置DD_BOT_TOKEN，将不会发送钉钉通知');
        }

        let fileData = wqwlkj.readFile('jyxe_code') || {}
        
        class Task {
            constructor(account) {
                this.index = index++;
                this.account = account;
                this.baseUrl = 'https://jiuyixiaoer.fzjingzhou.com/api'
                this.maxRetries = 3;
                this.retryDelay = 3;
                this.token = null;
                this.remark = '';
                this.wxid = '';
                this.startTime = Date.now();
                this.signStatus = ''; // 签到状态
                this.score = ''; // 环保币
                this.money = ''; // 金额
                this.withdrawStatus = ''; // 提现状态
            }

            async init() {
                const accountData = this.account.split('#')
                if (accountData.length < 2) {
                    this.sendMessage(`环境变量格式错误，正确格式: 备注#wxid`, true);
                    failedAccounts.push({
                        remark: accountData[0] || '未知',
                        reason: '格式错误'
                    });
                    return false;
                }
                
                this.remark = accountData[0];
                this.wxid = accountData[1];
                
                // 通过wxid获取token
                ;
                this.token = await getTokenFromWxid(this.wxid);
                
                if (!this.token) {
                    const reason = '获取token失败';
                    console.log(`账号[${this.index + 1}](${this.remark}): ❌ ${reason}，跳过该账号`);
                    failedAccounts.push({
                        remark: this.remark,
                        reason: reason
                    });
                    return false;
                }
                
                // 保存信息
                if (!fileData[this.remark]) {
                    fileData[this.remark] = {};
                }
                fileData[this.remark]['wxid'] = this.wxid;
                fileData[this.remark]['last_token'] = this.token;
                fileData[this.remark]['last_time'] = new Date().toLocaleString();
                
                let ua;
                if (!fileData[this.remark]['ua']) {
                    ua = wqwlkj.generateRandomUA();
                    fileData[this.remark]['ua'] = ua
                } else {
                    ua = fileData[this.remark]['ua'];
                }
                
                console.log(`账号[${this.index + 1}](${this.remark}): 🎲使用ua：${ua.substring(0, 30)}...`);
                
                this.headers = {
                    'Host': 'jiuyixiaoer.fzjingzhou.com',
                    'Connection': 'keep-alive',
                    'xweb_xhr': '1',
                    'platform': 'MP-WEIXIN',
                    'User-Agent': ua,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': '*/*',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Dest': 'empty',
                    'Referer': 'https://servicewechat.com/wx426d52c8130b8559/5/page-frame.html',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Accept-Encoding': 'gzip, deflate'
                }

                if (proxy && isProxy) {
                    this.proxy = await wqwlkj.getProxy(this.index, proxy)
                    console.log(`账号[${this.index + 1}](${this.remark}): ✅使用代理：${this.proxy}`)
                } else {
                    this.proxy = ''
                    console.log(`账号[${this.index + 1}](${this.remark}): ⚠️不使用代理`)
                }
                
                return true
            }

            async sign() {
                try {
                    const options = {
                        method: 'POST',
                        url: `${this.baseUrl}/Person/sign`,
                        headers: this.headers,
                        data: qs.stringify({ token: this.token })
                    }
                    const res = await this.request(options)
                    
                    if (res.code === 1000) {
                        this.signStatus = '✅签到成功';
                        console.log(`账号[${this.index + 1}](${this.remark}): ✅签到成功,获得：${res.data}环保币`);
                    } else if (res.code === 1004) {
                        this.signStatus = 'ℹ️今日已签到';
                        console.log(`账号[${this.index + 1}](${this.remark}): ℹ️今天已经签到过了`);
                    } else {
                        this.signStatus = '❌签到失败';
                        console.log(`账号[${this.index + 1}](${this.remark}): ❌签到失败，${res.msg}`);
                    }
                    return true
                } catch (e) {
                    this.signStatus = '❌签到异常';
                    console.log(`账号[${this.index + 1}](${this.remark}): ❌签到请求失败，${e.message}`);
                    return false
                }
            }

            async info() {
                try {
                    const options = {
                        method: 'POST',
                        url: `${this.baseUrl}/Person/index`,
                        headers: this.headers,
                        data: qs.stringify({ token: this.token })
                    }
                    const res = await this.request(options)
                    
                    if (res.code === 1000) {
                        // 控制台显示昵称
                        console.log(`账号[${this.index + 1}](${this.remark}): 👤【${res.data.nickname}】`)
                        
                        this.score = res.data.score;
                        this.money = res.data.exchange;
                        console.log(`账号[${this.index + 1}](${this.remark}): 🪙环保币：${this.score} ≈ ${this.money}元`);
                        
                        if (this.score >= 20) {
                            await this.withdraw(this.score, this.money)
                        } else {
                            this.withdrawStatus = '暂不提现';
                            console.log(`账号[${this.index + 1}](${this.remark}): ⚠️环保币不足20，暂不提现`);
                        }
                        
                        // 生成一行精简通知
                        let notifyLine = `账号[${this.index + 1}](${this.remark}): ${this.signStatus}`;
                        if (this.score) {
                            notifyLine += `，🪙环保币：${this.score} ≈ ${this.money}元`;
                        }
                        if (this.withdrawStatus) {
                            notifyLine += `，${this.withdrawStatus}`;
                        }
                        notifyMessages.push(notifyLine);
                        
                    } else {
                        console.log(`账号[${this.index + 1}](${this.remark}): ❌信息获取失败，${res.msg}`);
                    }
                    return true
                } catch (e) {
                    console.log(`账号[${this.index + 1}](${this.remark}): ❌信息获取请求失败，${e.message}`);
                    return false
                }
            }

            async withdraw(score, money) {
                try {
                    const options = {
                        method: 'POST',
                        url: `${this.baseUrl}/cash/scoreWithdraw`,
                        headers: this.headers,
                        data: qs.stringify({
                            type: 'wx_account',
                            score: score,
                            token: this.token
                        })
                    }
                    console.log(`账号[${this.index + 1}](${this.remark}): 💸尝试提现${score}环保币（≈${money}元）...`);
                    const res = await this.request(options)
                    
                    if (res.code === 1000) {
                        this.withdrawStatus = `🎉提现成功 ${score}环保币`;
                        console.log(`账号[${this.index + 1}](${this.remark}): 🎉提现成功！提现 ${score} 环保币(≈${money}元)`);
                        await this.info(); // 重新获取余额
                    } else {
                        this.withdrawStatus = '❌提现失败';
                        console.log(`账号[${this.index + 1}](${this.remark}): ❌提现失败，${res.msg}`);
                    }
                    return true
                } catch (e) {
                    this.withdrawStatus = '❌提现异常';
                    console.log(`账号[${this.index + 1}](${this.remark}): ❌提现请求失败，${e.message}`);
                    return false
                }
            }

            async main() {
                const isFinish = await this.init()
                if (!isFinish) return
                
                await wqwlkj.sleep(wqwlkj.getRandom(3, 5))
                const bool = await this.sign()
                if (!bool) return
                
                await wqwlkj.sleep(wqwlkj.getRandom(3, 5))
                await this.info()
                
                const costTime = ((Date.now() - this.startTime) / 1000).toFixed(1);
                console.log(`⏱️ 账号[${this.index + 1}](${this.remark}) 耗时: ${costTime}秒\n`);
            }

            async request(options, retryCount = 0) {
                if (isExiting) throw new Error('脚本正在退出中');
                
                try {
                    const data = await wqwlkj.request(options, this.proxy);
                    return data;
                } catch (error) {
                    if (retryCount < this.maxRetries && !isExiting) {
                        console.log(`账号[${this.index + 1}](${this.remark}): 🔐检测到请求错误，${this.retryDelay}秒后重试...`)
                        await wqwlkj.sleep(this.retryDelay * 1000);
                        return await this.request(options, retryCount + 1);
                    }
                    throw error;
                }
            }
        }

        console.log(`${name}开始执行...`);
        console.log(`⏱️ 超时设置: ${TIMEOUT/1000}秒, 最大重试: ${MAX_RETRIES}次\n`);
        
        // 从 YYB 协议获取账号
        const yybAccounts = await fetchAccountsFromYYB();
        if (yybAccounts.length === 0) {
            console.log(`❌ 未从 YYB 协议获取到账号，请检查 YYB_BASE_URL 配置`);
            return;
        }
        
        const accounts = yybAccounts.map(acc => `${acc.remark}#${acc.wxid}`);
        console.log(`📋 共${accounts.length}个账号`);
        
        const totalBatches = Math.ceil(accounts.length / bfs);
        const startTime = Date.now();

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            if (isExiting) break;
            
            const start = batchIndex * bfs;
            const end = start + bfs;
            const batch = accounts.slice(start, end);

            console.log(`\n📦 开始执行第 ${batchIndex + 1} 批任务 (${start + 1}-${Math.min(end, accounts.length)})`);

            const taskInstances = batch.map(account => new Task(account));
            const tasks = taskInstances.map(instance => instance.main());
            const results = await Promise.allSettled(tasks);

            results.forEach((result, index) => {
                const task = taskInstances[index];
                if (result.status === 'rejected') {
                    console.log(`账号[${task.index + 1}](${task.remark}): ❌ ${result.reason}`);
                }
            });

            if (batchIndex < totalBatches - 1 && !isExiting) {
                await wqwlkj.sleep(wqwlkj.getRandom(5, 8));
            }
        }
        
        wqwlkj.saveFile(fileData, 'jyxe_code')
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ ${name}全部任务已完成！总耗时: ${totalTime}秒`);
        
        // 统计成功失败
        console.log(`📊 统计: 成功 ${notifyMessages.length} 个, 失败 ${failedAccounts.length} 个`);

        // 发送钉钉通知
        if ((notifyMessages.length > 0 || failedAccounts.length > 0) && !isExiting) {
            let content = `### ✅ 执行完成\n\n`;
            content += `总账号数：${accounts.length}\n`;
            content += `成功：${notifyMessages.length} 个\n`;
            content += `失败：${failedAccounts.length} 个\n`;
            content += `总耗时：${totalTime}秒\n\n`;
            
            if (failedAccounts.length > 0) {
                content += `### ❌ 失败账号列表\n`;
                failedAccounts.forEach(acc => {
                    content += `- ${acc.remark}: ${acc.reason}\n`;
                });
                content += `\n`;
            }
            
            content += notifyMessages.join('\n');
            
            await sendDingTalkNotify(name, content);
        }

    } catch (e) {
        if (e && e.message) {
            console.error('❌ 执行过程中发生异常:', e.message);
        } else {
            console.log('✨ 脚本执行完成（无异常）');
        }
        
        if (notifyMessages.length > 0 || failedAccounts.length > 0) {
            let content = `### ❌ 执行异常\n\n`;
            if (e?.message) content += `异常信息：${e.message}\n\n`;
            if (failedAccounts.length > 0) {
                content += `失败账号：${failedAccounts.length} 个\n\n`;
                failedAccounts.forEach(acc => {
                    content += `- ${acc.remark}: ${acc.reason}\n`;
                });
                content += `\n`;
            }
            content += notifyMessages.join('\n');
            
            await sendDingTalkNotify(name, content);
        }
    }
})();