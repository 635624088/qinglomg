/**
 * @name 同程旅行每日签到+任务（自动登录版）
 * @description 通过微信 code 自动获取 token 并执行签到和任务
 * @origin 逆向自同程旅行微信小程序 wx.17u.cn
 *
 * FEISHU_WEBHOOK - 可选，飞书机器人 Webhook 地址
 *
 * Cron: 30 7 * * *
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');

const BASE_URL = 'https://wx.17u.cn';
const SIGN_URL = BASE_URL + '/wxmpsign/sign';
const HOME_URL = BASE_URL + '/wxmpsign/home';
const TASK_URL = BASE_URL + '/qiushiinnerapi/task';
const LOGIN_URL = BASE_URL + '/wechatappapi/wxUser/login';

const SHARE_URL = BASE_URL + '/wxmpsign/share/mileage';
const PARTICIPATE_IN_SHARE = SHARE_URL + '/participateInShareMileage';
const GET_USER_PARTICIPATION = SHARE_URL + '/getUserParticipationInfo';
const CHECK_IN_SHARE = SHARE_URL + '/checkInShareMileage';
const GET_TODAY_TOTAL = SHARE_URL + '/getTodayTotalShareMileage';
const GET_SHARE_CONFIG = SHARE_URL + '/getShareMileageConfig';

const FLOWER_BASE = BASE_URL + '/platformflowpool/flowerGod';
const FLOWER_HOME = FLOWER_BASE + '/home';          
const FLOWER_TASKS = BASE_URL + '/platformflowpool/taskApi/listTask'; 
const FLOWER_SHARE_REWARD = FLOWER_BASE + '/receiveSharingReward';   
const FLOWER_CARD_LIST = FLOWER_BASE + '/cardList';  
const FLOWER_DRAW = FLOWER_BASE + '/drawCard';       

const CARD_TYPE_MAP = {
  0: '花神签(稀有)',
  1: '牡丹签',
  2: '梨花签',
  3: '荷花签',
  4: '桃花签',
  5: '梅花签'
};

const ALL_CARD_TYPES = [0, 1, 2, 3, 4, 5];

const DEFAULT_APPID = process.env.TC_APPID || 'wx336dcaf6a1ecf632';

// ── Bridge (本地 API 服务器) ─────────────────────────────────────
const YYB_BASE_URL = (process.env.YYB_BASE_URL || 'http://172.17.0.1:18080').replace(/\/+$/, '');
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';

function bridgeHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (BRIDGE_KEY) h['Authorization'] = 'Bearer ' + BRIDGE_KEY;
    return h;
}

async function fetchAccounts() {
    try {
        const res = await httpRequest(YYB_BASE_URL + '/accounts', 'GET', bridgeHeaders());
        const list = (res.data || []).map(a => ({
            wxid: (a.openid || '').trim(),
            appid: DEFAULT_APPID,
            remark: (a.nickname || a.name || '账号').trim(),
            index: 0
        })).filter(a => a.wxid);
        console.log('共获取到 ' + list.length + ' 个账号');
        list.forEach((a, i) => console.log('   ' + (i+1) + '. ' + a.remark + ' (openid: ' + a.wxid.substring(0,12) + '...)'));
        return list;
    } catch (e) {
        console.log('获取账号失败: ' + (e.message || e));
        return [];
    }
}

async function bridgeGetCode(openid) {
    const res = await httpRequest(YYB_BASE_URL + '/wxapp/getCode', 'POST', bridgeHeaders(), { app_id: DEFAULT_APPID, ref: openid });
    if (res.code !== 0) throw new Error('bridge 拒绝: ' + JSON.stringify(res));
    const code = res.data?.result?.code || '';
    if (!code) throw new Error('bridge 未返回 code');
    return code;
}

function getEnv(n) { return process.env[n] || ''; }
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function randomDelay() {
  const delay = Math.floor(Math.random() * 2000) + 3000;
  console.log(`⏱️ 等待 ${(delay / 1000).toFixed(1)} 秒...`);
  return new Promise(resolve => setTimeout(resolve, delay));
}

function shortDelay() {
  const delay = Math.floor(Math.random() * 2000) + 1000;
  return new Promise(resolve => setTimeout(resolve, delay));
}

function generateApmat(openid) {
    openid = openid || 'o498X0ScTl0oO6aj0taIYuXYvM9I';
    const now = new Date();
    const ts = '' + now.getFullYear() + pad2(now.getMonth()+1) + pad2(now.getDate()) + pad2(now.getHours()) + pad2(now.getMinutes());
    const rand = Math.floor(Math.random() * 900000) + 100000;
    return openid + '|' + ts + '|' + rand;
}

function httpRequest(url, method, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const lib = isHttps ? https : http;
        const port = urlObj.port || (isHttps ? 443 : 80);
        const req = lib.request({ hostname: urlObj.hostname, port, path: urlObj.pathname + urlObj.search, method, headers }, (res) => {
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (encoding === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
                stream = res.pipe(zlib.createBrotliDecompress());
            }
            const chunks = [];
            stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            stream.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
                try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); }
            });
            stream.on('error', reject);
        });
        req.on('error', reject);
        if (body && (method === 'POST' || method === 'PUT')) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function getWxCode(wxid, appid) {
    ;
    return bridgeGetCode(wxid);
}

async function tcLogin(wxCode) {
    ;
    const res = await httpRequest(LOGIN_URL, 'POST', { 'Content-Type': 'application/json' }, { code: wxCode, scene: '1001' });
    const content = res.data?.content || res.content || {};
    if (!content.sectoken) throw new Error(res.msg || '登录成功但未返回 sectoken');
    return { tcsectk: content.sectoken, mallUserToken: content.sectoken, openid: content.openId, unionid: content.unionId, expts: content.expts };
}

function parseAccounts() {
    const raw = getEnv('WXID');
    if (!raw) {
        return []; // main() will fall back to bridge
    }

    const lines = raw.split('&')
                    .map(item => item.trim())
                    .join('\n')
                    .split('\n')
                    .map(line => line.trim())
                    .filter(Boolean);

    return lines.map((line, i) => {
        const p = line.split('#');
        const remark = p[0]?.trim() || ('账号'+(i+1)); 
        const wxid = p[1]?.trim(); 
        
        if (!wxid) {
            console.log(`⚠️ 第 ${i + 1} 个账号格式错误，缺少 wxid`);
            return null;
        }
        
        return { 
            wxid, 
            appid: getEnv('TC_APPID') || DEFAULT_APPID, 
            remark, 
            index: i+1 
        };
    }).filter(Boolean);
}

function buildHeaders(acct) {
    return {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c32) NetType/WIFI Language/zh_CN',
        'tcsectk': acct.tcsectk, 'TCSecTk': acct.tcsectk,
        'tc-mall-platform-code': 'WX_MP', 'tc-mall-user-token': acct.mallUserToken,
        'secToken': acct.mallUserToken, 'platform': 'WX_MP', 'osType': '1',
        'apmat': generateApmat(acct.openid),
        'TCxcxVersion': '7.8.9', 'TCReferer': 'page%2Fhome%2Fmall%2Fmall', 'TCPrivacy': '1',
        'Referer': 'https://servicewechat.com/wx336dcaf6a1ecf632/885/page-frame.html',
        'Accept': '*/*', 'Accept-Encoding': 'gzip, compress, br, deflate', 'Accept-Language': 'zh-CN,zh;q=0.9',
    };
}

/**
 * 花神祈福 H5 接口专用 headers（走 webview 路径）
 * 注意：这套接口是 webview H5 内的接口，Referer/UA 与小程序端略有不同
 */
function buildFlowerHeaders(acct) {
    return {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.60(0x18003c32) NetType/WIFI Language/zh_CN miniProgram/wx336dcaf6a1ecf632',
        'Referer': 'https://wx.17u.cn/wxweb/',
        'Origin': 'https://wx.17u.cn',
        'platform': 'WX_MP',
        'osType': '1',
        'accountSystem': '1',
        'TC-PLATFORM-CODE': 'WX_MP',
        'TC-OS-TYPE': '1',
        'TC-USER-TOKEN': acct.tcsectk,
        'secToken': acct.tcsectk,
    };
}

function request(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const bodyStr = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const finalHeaders = { ...headers };
        if (bodyStr && method === 'POST') {
            finalHeaders['Content-Length'] = Buffer.byteLength(bodyStr).toString();
        }
        const req = https.request({ hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search, method, headers: finalHeaders }, (res) => {
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (encoding === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
                stream = res.pipe(zlib.createBrotliDecompress());
            }
            const chunks = [];
            stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            stream.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
                try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); }
            });
            stream.on('error', reject);
        });
        req.on('error', reject);
        if (bodyStr && method === 'POST') req.write(bodyStr);
        req.end();
    });
}

const doSign = h => request('POST', SIGN_URL + '/saveSignInfo', h, {});
const getSignInfo = h => request('POST', SIGN_URL + '/getSignInfo', h, {});
const getHomeTop = h => request('POST', HOME_URL + '/top', h, {});
const getTaskList = (h, sg) => request('POST', TASK_URL + '/detailList', h, { detailGuid:'', pageNum:1, pageSize:999, schemeGuid:sg||'task-2025-nflygijg' });
const startTask = (h, dg, sg) => request('POST', TASK_URL + '/startTask', h, { detailGuid:dg, pageNum:1, pageSize:999, schemeGuid:sg||'task-2025-nflygijg' });
const finishTask = (h, dg, sg) => request('POST', TASK_URL + '/finishTask', h, { detailGuid:dg, pageNum:1, pageSize:999, schemeGuid:sg||'task-2025-nflygijg' });
const sendPrize = (h, dg, sg) => request('POST', TASK_URL + '/sendTaskPrize', h, { detailGuid:dg, pageNum:1, pageSize:999, schemeGuid:sg||'task-2025-nflygijg' });

function getTodayRange() {
    const now = new Date();
    const d = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
    return { startDate: d + ' 00:00:00', endDate: d + ' 23:59:59' };
}
const getUserShareInfo = h => {
    const { startDate, endDate } = getTodayRange();
    return request('POST', GET_USER_PARTICIPATION, h, { startDate, limitAmount: 1, endDate });
};
const doParticipateShare = h => request('POST', PARTICIPATE_IN_SHARE, h, {});
const doCheckInShare = h => request('POST', CHECK_IN_SHARE, h, {});

const getFlowerHome = (fh) => request('GET', FLOWER_HOME, fh, undefined);

const getFlowerTasks = (fh, activityCode) => request('POST', FLOWER_TASKS, fh, { activityCode });

const doFlowerShareReward = (fh) => request('POST', FLOWER_SHARE_REWARD, fh, {});

const getFlowerCardList = (fh) => request('GET', FLOWER_CARD_LIST, fh, undefined);

const doFlowerDraw = (fh) => request('POST', FLOWER_DRAW, fh, {});

async function sendFeishu(webhook, msgs) {
    if (!webhook) return;
    try {
        const urlObj = new URL(webhook);
        const lib = urlObj.protocol === 'https:' ? https : http;
        await new Promise((res, rej) => {
            const req = lib.request({ hostname: urlObj.hostname, port: urlObj.port||(urlObj.protocol==='https:'?443:80), path: urlObj.pathname+urlObj.search, method:'POST', headers:{'Content-Type':'application/json'} }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',res); });
            req.on('error', rej);
            req.write(JSON.stringify({ msg_type:'text', content:{ text: msgs.join('\n\n') } }));
            req.end();
        });
        console.log('✅ 飞书通知已发送');
    } catch(e) { console.log(`⚠️ 飞书通知发送失败: ${e.message}`); }
}

function getStatusText(status) {
    const statusMap = {
        0: '⏳ 未开始',
        1: '🔄 进行中',
        2: '✅ 已完成',
        3: '🎁 已领取'
    };
    return statusMap[status] || `❓ 未知(${status})`;
}

async function processFlowerActivity(acct) {
    const fh = buildFlowerHeaders(acct);
    const result = {
        enabled: false,        // 活动是否开放
        shareTaskDone: false,  // 分享任务是否完成
        drawCount: 0,          // 本次抽签次数
        draws: [],             // 每次抽签结果
        cardsBefore: [],       // 操作前卡片状态
        cardsAfter: [],        // 操作后卡片状态
        message: ''
    };

    console.log('\n🌸 花神祈福（集花签名）活动...');

    let homeData;
    try {
        const homeRes = await getFlowerHome(fh);
        if (homeRes?.code !== 0) {
            result.message = `获取首页失败: ${homeRes?.msg || JSON.stringify(homeRes)}`;
            console.log(`  ❌ ${result.message}`);
            return result;
        }
        homeData = homeRes.data;
        result.enabled = true;
        const remainDraw = homeData?.remainDrawCount ?? 0;
        const challengeCode = homeData?.challengeTaskCode || '';
        console.log(`  📊 首页信息: 剩余摇签次数=${remainDraw}`);

  
        const cardList = homeData?.cardList || [];
        result.cardsBefore = cardList.map(c => ({
            type: c.cardType,
            name: CARD_TYPE_MAP[c.cardType] || `卡片${c.cardType}`,
            count: c.cardCount || 0
        }));
        console.log('\n  📦 当前收集状态（操作前）:');
        printCardStatus(result.cardsBefore);

 
        if (challengeCode) {
            console.log('\n  📋 获取花神祈福任务列表...');
            try {
                const taskRes = await getFlowerTasks(fh, challengeCode);
                const tasks = taskRes?.data?.values || [];
                console.log(`  共 ${tasks.length} 个任务`);

            } catch(e) {
                console.log(`  ⚠️ 获取任务列表异常: ${e.message}`);
            }

            console.log('\n  🔗 执行分享任务（获取额外摇签机会）...');
            try {
                await shortDelay();
                const shareRes = await doFlowerShareReward(fh);
                if (shareRes?.code === 0) {
                    result.shareTaskDone = true;
                    console.log('  ✅ 分享任务完成，+1次摇签机会');
                } else {
                    console.log(`  ℹ️ 分享任务: ${shareRes?.msg || '已完成或未满足条件'}`);
                }
            } catch(e) {
                console.log(`  ⚠️ 分享任务异常: ${e.message}`);
            }
        }

  
        await shortDelay();
        const homeRes2 = await getFlowerHome(fh);
        if (homeRes2?.code === 0) {
            homeData = homeRes2.data;
        }
        const finalRemainDraw = homeData?.remainDrawCount ?? 0;
        console.log(`\n  🎯 最终剩余摇签次数: ${finalRemainDraw}`);

  
        if (finalRemainDraw > 0) {
            console.log(`\n  🎰 开始摇花签，共 ${finalRemainDraw} 次...`);
            let remaining = finalRemainDraw;
            while (remaining > 0) {
                try {
                    await shortDelay();
                    const drawRes = await doFlowerDraw(fh);
                    if (drawRes?.code === 0) {
                        const d = drawRes.data;
                        const cardName = d?.cardName || CARD_TYPE_MAP[d?.cardType] || '未知花签';
                        const rewardName = d?.rewardName || '';
                        const fortuneText = d?.fortuneText || '';
                        result.draws.push({
                            cardName,
                            cardType: d?.cardType,
                            rewardName,
                            fortuneText
                        });
                        result.drawCount++;
                        console.log(`  🎴 第${result.drawCount}次 → 【${cardName}】${rewardName ? ' | ' + rewardName : ''}`);
                        if (fortuneText) console.log(`       签文: ${fortuneText}`);
                        remaining--;
                    } else {
                        console.log(`  ⚠️ 摇签失败: ${drawRes?.msg || '未知'}`);
                        break;
                    }
                } catch(e) {
                    console.log(`  ❌ 摇签异常: ${e.message}`);
                    break;
                }
            }
        } else {
            console.log('  ℹ️ 今日摇签次数已用完');
        }

        await shortDelay();
        try {
            const homeRes3 = await getFlowerHome(fh);
            if (homeRes3?.code === 0) {
                const newCardList = homeRes3.data?.cardList || [];
                result.cardsAfter = newCardList.map(c => ({
                    type: c.cardType,
                    name: CARD_TYPE_MAP[c.cardType] || `卡片${c.cardType}`,
                    count: c.cardCount || 0
                }));
            }
        } catch(e) {
            result.cardsAfter = [...result.cardsBefore];
        }

        console.log('\n  📦 最新收集状态（操作后）:');
        printCardStatus(result.cardsAfter);

    
        const totalCards = result.cardsAfter.reduce((s, c) => s + c.count, 0);
        const hasAllTypes = ALL_CARD_TYPES.every(t => {
            const card = result.cardsAfter.find(c => c.type === t);
            return card && card.count > 0;
        });
        if (hasAllTypes) {
            console.log('  🏆 恭喜！已集齐全套花签，可兑换大奖！');
        }

    } catch(e) {
        result.message = `花神祈福活动异常: ${e.message}`;
        console.log(`  ❌ ${result.message}`);
    }

    return result;
}

function printCardStatus(cards) {
    const allTypes = [
        { type: 0, name: '花神签(稀有)' },
        { type: 1, name: '牡丹签' },
        { type: 2, name: '梨花签' },
        { type: 3, name: '荷花签' },
        { type: 4, name: '桃花签' },
        { type: 5, name: '梅花签' }
    ];
    for (const t of allTypes) {
        const card = cards.find(c => c.type === t.type);
        const count = card?.count || 0;
        const icon = count > 0 ? '✅' : '⬜';
        console.log(`     ${icon} ${t.name}: ${count}张`);
    }
    const owned = allTypes.filter(t => (cards.find(c => c.type === t.type)?.count || 0) > 0).length;
    console.log(`     进度: ${owned}/${allTypes.length} 种`);
}

async function processAccount(cfg) {
    const tag = `${cfg.remark}(${cfg.wxid.substring(0,8)}...)`;
    console.log(`\n========== ${tag} ==========`);
    console.log(`  wxid: ${cfg.wxid.substring(0,8)}...`);
    const res = { 
        sign:{success:false, message:''}, 
        tasks:{total:0, completed:0, claimed:0, failed:0, details:[]}, 
        share: {participate: '', checkin: '', info: null}, 
        flower: null,
        totalMileage:0, 
        loginOK:false 
    };

    let acct;
    try {
        const code = await getWxCode(cfg.wxid, cfg.appid);
        console.log('  ✅ 微信 code 获取成功');
        acct = await tcLogin(code);
        ;
        acct.remark = cfg.remark; 
        acct.index = cfg.index;
        res.loginOK = true;
    } catch(e) { 
        ; 
        res.sign.message = e.message; 
        return res; 
    }

    const h = buildHeaders(acct);

    console.log('\n📊 获取用户信息...');
    try { 
        const r = await getHomeTop(h); 
        if(r?.code===200) {
            const d = r.data || {};
            res.totalMileage = d.remainCoin||0;
            console.log(`  💰 当前里程: ${d.showCoin || 0} (本月过期: ${d.monthExpireCoin || 0})`);
        }
    } catch(e) { 
        console.log(`  ⚠️ 获取用户信息失败: ${e.message}`);
    }

    console.log('\n📝 签到任务...');
    try {
        const si = await getSignInfo(h);
        if(si?.code===200) {
            const d = si.data||{};
            console.log(`  今日: ${d.todaySigned ? '已签到 ✅' : '未签到'} | 连续: ${d.periodContinuedSignDays || 0}天`);
            if(d.todaySigned) {
                res.sign = {
                    success:true, 
                    message: `今日已签到 ✅ 连续${d.periodContinuedSignDays}天`
                };
            } else if(d.canSign) {
                const sr = await doSign(h);
                if(sr?.code===200) { 
                    const sd=sr.data||{}; 
                    res.sign={
                        success:true,
                        message: `签到成功 🎉 里程+${sd.signMileage || 0} 连续${sd.periodContinuedSignDays || 0}天`
                    }; 
                    console.log(`  ✅ 签到成功！里程+${sd.signMileage || 0}`); 
                } else { 
                    res.sign={
                        success:false,
                        message: `签到失败: ${sr?.msg || '未知错误'}`
                    }; 
                    console.log(`  ❌ 签到失败: ${sr?.msg || '未知错误'}`); 
                }
            }
        }
    } catch(e) { 
        res.sign={
            success:false,
            message: `签到异常: ${e.message}`
        }; 
        console.log(`  ❌ 签到异常: ${e.message}`);
    }

    console.log('\n📋 每日任务...');
    try {
        const tr = await getTaskList(h);
        if(tr?.code===0) {
            const tasks = tr.data?.taskDetails||[];
            const sg = tr.data?.taskScheme?.schemeGuid||'task-2025-nflygijg';
            res.tasks.total = tasks.length;
            console.log(`  共 ${tasks.length} 个任务`);
            
            for(const t of tasks) {
                const name = t.title||'未知任务', 
                      dg=t.detailGuid, 
                      st=t.status, 
                      prize=t.prizeTitle||'0';
                
                console.log(`\n  📌 ${name}`);
                console.log(`     状态: ${getStatusText(st)} | 奖励: ${prize}里程`);
                
                const tr2 = {
                    name,
                    prize,
                    status:st,
                    success:false,
                    message:''
                };

                if(st===3) { 
                    tr2.success=true; 
                    tr2.message='已领取奖励'; 
                    res.tasks.claimed++; 
                }
                else if(st===2) {
                    console.log(`     🎁 领取奖励...`);
                    try { 
                        const r=await sendPrize(h,dg,sg); 
                        if(r?.code===0){
                            tr2.success=true;
                            tr2.message='领取奖励成功';
                            res.tasks.claimed++;
                            console.log(`     ✅ 领取奖励成功`);
                        } else {
                            tr2.message=`领取奖励失败: ${r?.msg || '未知错误'}`;
                            res.tasks.failed++;
                            console.log(`     ❌ 领取奖励失败: ${r?.msg || '未知错误'}`);
                        } 
                    } catch(e) {
                        tr2.message=`领取奖励异常: ${e.message}`;
                        res.tasks.failed++;
                        console.log(`     ❌ 领取奖励异常: ${e.message}`);
                    }
                } else if(st===1) {
                    console.log(`     ✅ 完成任务...`);
                    try { 
                        const fr=await finishTask(h,dg,sg); 
                        if(fr?.code===0){
                            console.log(`     🎁 领取奖励...`);
                            const pr=await sendPrize(h,dg,sg); 
                            if(pr?.code===0){
                                tr2.success=true;
                                tr2.message='完成任务并领取奖励';
                                res.tasks.completed++;
                                res.tasks.claimed++;
                                console.log(`     ✅ 完成任务并领取奖励成功`);
                            } else {
                                tr2.message=`完成任务但领取奖励失败: ${pr?.msg || '未知错误'}`;
                                res.tasks.completed++;
                                res.tasks.failed++;
                                console.log(`     ⚠️ 完成任务但领取奖励失败: ${pr?.msg || '未知错误'}`);
                            }
                        } else {
                            tr2.message=`完成任务失败: ${fr?.msg || '未知错误'}`;
                            res.tasks.failed++;
                            console.log(`     ❌ 完成任务失败: ${fr?.msg || '未知错误'}`);
                        } 
                    } catch(e) {
                        tr2.message=`完成任务异常: ${e.message}`;
                        res.tasks.failed++;
                        console.log(`     ❌ 完成任务异常: ${e.message}`);
                    }
                } else if(st===0) {
                    console.log(`     🚀 开始任务...`);
                    try { 
                        const sr=await startTask(h,dg,sg); 
                        if(sr?.code===0){
                            console.log(`     ✅ 完成任务...`);
                            const fr=await finishTask(h,dg,sg); 
                            if(fr?.code===0){
                                console.log(`     🎁 领取奖励...`);
                                const pr=await sendPrize(h,dg,sg); 
                                if(pr?.code===0){
                                    tr2.success=true;
                                    tr2.message='完成全部流程';
                                    res.tasks.completed++;
                                    res.tasks.claimed++;
                                    console.log(`     ✅ 任务完成并领取奖励成功`);
                                } else {
                                    tr2.message=`完成但领取奖励失败: ${pr?.msg || '未知错误'}`;
                                    res.tasks.completed++;
                                    res.tasks.failed++;
                                    console.log(`     ⚠️ 完成但领取奖励失败: ${pr?.msg || '未知错误'}`);
                                }
                            } else {
                                tr2.message=`完成失败: ${fr?.msg || '未知错误'}`;
                                res.tasks.failed++;
                                console.log(`     ❌ 完成失败: ${fr?.msg || '未知错误'}`);
                            }
                        } else {
                            tr2.message=`开始失败: ${sr?.msg || '未知错误'}`;
                            res.tasks.failed++;
                            console.log(`     ❌ 开始失败: ${sr?.msg || '未知错误'}`);
                        } 
                    } catch(e) {
                        tr2.message=`任务异常: ${e.message}`;
                        res.tasks.failed++;
                        console.log(`     ❌ 任务异常: ${e.message}`);
                    }
                }
                res.tasks.details.push(tr2);
                await randomDelay();
            }
        } else {
            console.log(`  ❌ 获取任务列表失败: ${tr?.msg || '未知错误'}`);
        }
    } catch(e) { 
        console.log(`  ❌ 任务处理异常: ${e.message}`); 
    }

    console.log('\n🏆 里程瓜分活动...');
    try {
        const userInfo = await getUserShareInfo(h);
        res.share.info = userInfo;
        console.log('  🔍 参与信息原始响应:', JSON.stringify(userInfo).substring(0, 300));
        if (userInfo?.code === 200) {
            const dataList = userInfo.data || [];
            const todayData = dataList[0] || null;

            if (!todayData) {
         
                console.log('  📝 未报名，开始自动报名...');
                const joinRes = await doParticipateShare(h);
                if (joinRes?.code === 200) {
                    res.share.participate = "✅ 报名成功（扣100里程）";
                    console.log('  ✅ 报名成功');
                } else {
                    res.share.participate = "❌ 报名失败：" + (joinRes?.msg || '未知错误');
                    console.log('  ❌ 报名失败');
                }
                res.share.checkin = "ℹ️ 报名后次日打卡";
            } else {
          
                res.share.participate = "✅ 今日已报名";
                const status = todayData.finishStatus || -1;
                const hasCheck = status === 1; 

                if (hasCheck) {
                    res.share.checkin = "✅ 今日已打卡";
                    console.log('  ✅ 已打卡');
                } else {
                    console.log('  📌 已报名未打卡，开始打卡...');
                    const checkRes = await doCheckInShare(h);
                    if (checkRes?.code === 200) {
                        res.share.checkin = "✅ 打卡成功";
                        console.log('  ✅ 打卡成功');
                    } else {
                        res.share.checkin = "❌ 打卡失败：" + (checkRes?.msg || '未知错误');
                        console.log('  ❌ 打卡失败');
                    }
                }
            }
        } else {
            res.share.participate = "⚠️ 活动未开启";
            res.share.checkin = "⚠️ 活动未开启";
        }
    } catch (e) {
        console.log(`  ⚠️ 瓜分活动异常：${e.message}`);
        res.share.participate = "⚠️ 异常：" + e.message;
        res.share.checkin = "⚠️ 异常：" + e.message;
    }

    await randomDelay();
    try {
        res.flower = await processFlowerActivity(acct);
    } catch(e) {
        console.log(`  ❌ 花神祈福模块异常: ${e.message}`);
        res.flower = { enabled: false, message: e.message, draws: [], cardsBefore: [], cardsAfter: [], shareTaskDone: false, drawCount: 0 };
    }

    console.log('\n💰 更新里程信息...');
    try { 
        const r=await getHomeTop(h); 
        if(r?.code===200) {
            const d = r.data || {};
            res.totalMileage = d.remainCoin||0;
            console.log(`  最新里程: ${d.showCoin || 0}`);
        }
    } catch(e) { 
        console.log(`  ⚠️ 获取最新里程失败: ${e.message}`);
    }
    
    return res;
}

function generateFlowerSummary(flower) {
    if (!flower) return '🌸 花神祈福: 未执行';
    if (!flower.enabled) return `🌸 花神祈福: 活动未开启${flower.message ? ' - ' + flower.message : ''}`;

    const lines = ['🌸 花神祈福（集花签名）'];

    lines.push(`  分享任务: ${flower.shareTaskDone ? '✅ 已完成，获得额外1次机会' : 'ℹ️ 已完成或不可重复领取'}`);

    if (flower.drawCount > 0) {
        lines.push(`  本次摇签: ${flower.drawCount} 次`);
        for (const d of flower.draws) {
            lines.push(`    🎴 ${d.cardName}${d.rewardName ? ' (+' + d.rewardName + ')' : ''}${d.fortuneText ? ' — ' + d.fortuneText : ''}`);
        }
    } else {
        lines.push('  摇签次数: 今日已用完');
    }

    if (flower.cardsAfter.length > 0) {
        const allTypes = [
            { type: 0, name: '花神签(稀有)' },
            { type: 1, name: '牡丹签' },
            { type: 2, name: '梨花签' },
            { type: 3, name: '荷花签' },
            { type: 4, name: '桃花签' },
            { type: 5, name: '梅花签' }
        ];
        lines.push('  卡片收集进度:');
        for (const t of allTypes) {
            const before = flower.cardsBefore.find(c => c.type === t.type)?.count || 0;
            const after = flower.cardsAfter.find(c => c.type === t.type)?.count || 0;
            const icon = after > 0 ? '✅' : '⬜';
            const diff = after - before;
            const diffStr = diff > 0 ? ` (+${diff})` : '';
            lines.push(`    ${icon} ${t.name}: ${after}张${diffStr}`);
        }
        const ownedTypes = allTypes.filter(t => (flower.cardsAfter.find(c => c.type === t.type)?.count || 0) > 0).length;
        const missingTypes = allTypes.filter(t => (flower.cardsAfter.find(c => c.type === t.type)?.count || 0) === 0);
        lines.push(`  收集进度: ${ownedTypes}/${allTypes.length} 种`);
        if (missingTypes.length > 0) {
            lines.push(`  ❌ 还缺: ${missingTypes.map(t => t.name).join('、')}`);
        } else {
            lines.push('  🏆 已集齐全套！可兑换大奖！');
        }
    }

    return lines.join('\n');
}

function generateSummary(tag, r) {
    const lines = [];
    lines.push(`【同程旅行】${tag}`);
    lines.push('');
    
    lines.push(`📝 签到: ${r.sign.message}`);
    
    const t = r.tasks;
    lines.push(`📋 任务: ${t.total}个 | ✅完成${t.completed} | 🎁领取${t.claimed} | ❌失败${t.failed}`);
    
    if (t.details.length > 0) {
        lines.push('');
        lines.push('任务详情:');
        for (const task of t.details) {
            const icon = task.success ? '✅' : '❌';
            lines.push(`  ${icon} ${task.name} (+${task.prize}里程) - ${task.message}`);
        }
    }

    lines.push('');
    lines.push(`🏆 里程瓜分: ${r.share.participate} | ${r.share.checkin}`);

    lines.push('');
    lines.push(generateFlowerSummary(r.flower));

    lines.push('');
    lines.push(`💰 当前总里程: ${r.totalMileage}`);
    
    return lines.join('\n');
}

async function main() {
    console.log('========================================');
    console.log('        同程旅行每日签到+任务');
    console.log('========================================');
    let accts = parseAccounts();
    if (!accts.length) {
        accts = await fetchAccounts();
        if (accts.length) {
            accts.forEach((a, i) => a.index = i+1);
        }
    }
    if(!accts.length) {
        console.log('❌ 没有找到有效账号，请检查环境变量');
        return;
    }
    console.log(`共加载 ${accts.length} 个账号`);
    
    const summaries = [];
    for(const a of accts) {
        try { 
            const r=await processAccount(a); 
            summaries.push(generateSummary(a.remark, r)); 
        } catch(e) { 
            console.log(`  ❌ 账号 ${a.index} 异常: ${e.message}`);
            summaries.push(`【同程旅行】账号${a.index} 异常: ${e.message}`);
        }
    }
    
    const wh = getEnv('FEISHU_WEBHOOK');
    if(wh) await sendFeishu(wh, summaries);
    
    console.log('\n========================================');
    console.log('              执行完毕');
    console.log('========================================');
    
    console.log('\n📊 执行汇总:');
    for(const s of summaries) {
        console.log('\n' + s);
        console.log('----------------------------------------');
    }
}

main().catch(e => console.log(`❌ 脚本执行异常: ${e.message}`));
