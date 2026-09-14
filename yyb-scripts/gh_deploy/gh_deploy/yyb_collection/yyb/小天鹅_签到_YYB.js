#!/usr/bin/env node
/**
 * 全心全意小天鹅 合并版 (YYB版)
 *
 * 入口: 微信小程序搜索"全心全意小天鹅"
 * 功能: 签到 + 打工收蛋 + 养鹅 + 精灵任务
 *
 * 环境变量:
 *   YYB_BASE_URL  YYB 服务地址 (必填)
 *   YYB_REF       指定账号 ref (可选，默认遍历所有账号)
 */

const axios = require('axios');

// ====== 登录态 (401) 检测 ======
// HTTP 401 说明 ucAccessToken/bearer 已失效，需重新获取变量并重跑
let AUTH_FAILED = false;
axios.interceptors.response.use(
  resp => resp,
  err => {
    if (err.response && err.response.status === 401) {
      AUTH_FAILED = true;
    }
    throw err;
  }
);
// ==============================

// ====== YYB 配置 ======
const YYB_BASE = process.env.YYB_BASE_URL;
const YYB_REF = process.env.YYB_REF || '';
// ======================

// ====== 业务常量 ======
const APP_NAME = '全心全意小天鹅';
const APPID = 'wx33856a6b31431c6e';
const URLS = 'https://littleswanmp.midea.com';
// ======================

// ====== 通知配置 ======
const DD_BOT_TOKEN = process.env.DD_BOT_TOKEN || '';
const DD_BOT_SECRET = process.env.DD_BOT_SECRET || '';
// ======================

let successCount = 0, failedCount = 0, skippedCount = 0;

// ====== YYB 接口封装 ======
async function yybGetAccounts() {
  const resp = await axios.get(`${YYB_BASE}/accounts`, { timeout: 10000 });
  const data = resp.data;
  if (data.code === 0) return data.data || [];
  console.log(`  ❌ 获取账号列表失败: ${data.msg || '未知错误'}`);
  return [];
}

async function yybGetCode(ref) {
  const resp = await axios.post(`${YYB_BASE}/wxapp/getCode`, { ref, app_id: APPID }, { timeout: 30000 });
  const data = resp.data;
  if (data.code === 0) {
    const result = data.data?.result || {};
    if (result.code) return result.code;
    console.log(`    ❌ getCode 返回中没有 code: ${JSON.stringify(result)}`);
    return null;
  }
  console.log(`    ❌ YYB getCode 失败: ${data.msg || '未知错误'}`);
  return null;
}
// ==========================

// ====== 缓存机制 ======
const path = require('path');
const fs = require('fs');
const CACHE_FILE = path.join(__dirname, '小天鹅_签到_YYB.txt');
function cacheLoad(openid) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const entry = cache[openid];
    if (!entry) return null;
    return entry.data;
  } catch (e) {
    return null;
  }
}

function cacheSave(openid, data) {
  try {
    let cache = {};
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
    cache[openid] = {
      data,
      cached_at: new Date().toLocaleString('zh-CN'),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    // 缓存写入失败不影响主流程
  }
}

function cacheDelete(openid) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    delete cache[openid];
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }
}
// =====================

// ====== 通用工具 ======
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomSleep(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(delay * 1000);
}

function sc_ua() {
  const ua = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a30) NetType/WIFI Language/zh_CN',
    'Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.42.2540(0x2800002F) NetType/WIFI Language/zh_CN',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a30) NetType/WIFI Language/zh_CN',
  ];
  return ua[Math.floor(Math.random() * ua.length)];
}

function hs(uc_access_token, bearer_token) {
  return {
    'User-Agent': sc_ua(),
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': `https://servicewechat.com/${APPID}/148/page-frame.html`,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json',
    'xweb_xhr': '1',
    'ucAccessToken': uc_access_token,
    'authorization': `Bearer ${bearer_token}`,
  };
}
// =====================

// ====== 业务接口 ======

// 用 YYB jsCode 换取 ucAccessToken（通过 getLoginInfo.do）
async function exchangeCodeForUcToken(jsCode, openid) {
  // 根据抓包分析，正确的接口是 getLoginInfo.do
  const url = 'https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/app/login/wx/mini/getLoginInfo.do';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'xweb_xhr': '1',
    'Referer': `https://servicewechat.com/${APPID}/191/page-frame.html`,
  };

  const body = {
    jsCode: jsCode,
    platformType: 'WX_LS_MINI',
    loginMode: 1
  };

  try {
    console.log(`    ⏳ 调用 getLoginInfo.do...`);
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;

    // 检查响应中的 ucAccessToken
    let token = null;

    // 格式1: data.data.ucAccessToken
    if (data.data?.ucAccessToken) {
      token = data.data.ucAccessToken;
    }
    // 格式2: data.ucAccessToken
    else if (data.ucAccessToken) {
      token = data.ucAccessToken;
    }

    if (token && token.length > 10) {
      console.log(`    ✅ 成功获取 ucAccessToken`);
      return token;
    }

    // 打印详细错误
    const code = data.code || data.errcode || data.status;
    const msg = data.msg || data.message || data.chnDesc || '';
    console.log(`    ❌ 失败: code=${code} msg=${msg.slice(0, 80)}`);
    console.log(`    ⏳ 响应: ${JSON.stringify(data).slice(0, 200)}`);

    return null;
  } catch (e) {
    console.log(`    ❌ 请求异常: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// 获取 bearer_token
async function getBearerToken(bz, uc_access_token) {
  const url = `${URLS}/api/auth/login/uc_token`;
  const headers = {
    'User-Agent': sc_ua(),
    'Content-Type': 'application/x-www-form-urlencoded',
    'ucAccessToken': uc_access_token,
    'charset': 'utf-8',
    'Referer': `https://servicewechat.com/${APPID}/148/page-frame.html`
  };
  try {
    const resp = await axios.post(url, `uc_token=${uc_access_token}`, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === 200 && data.content?.access_token) {
      return data.content.access_token;
    }
    console.log(`  ❌ 获取bearer_token失败: code=${data.code} msg=${data.chnDesc || data.engDesc || ''}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 获取bearer_token异常: ${e.message}`);
    return null;
  }
}

// 签到2 - 步骤1: 转换token
async function signin2Step1(bz, uc_access_token) {
  const url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/common/login/convertUcAccessToken';
  const headers = {
    'User-Agent': sc_ua(),
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'appId': 'QLZZ9Fr7w2to',
    'apiKey': '3660663068894a0d9fea574c2673f3c0',
    'Origin': 'https://weixin.midea.com',
    'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
  };
  const body = {
    headParams: { language: 'CN', originSystem: 'MCSP', timeZone: '', userCode: '', tenantCode: '', userKey: 'TEST_', transactionId: '' },
    pagination: null,
    restParams: { ucAccessToken: uc_access_token, rootCode: 'XTE', imUserId: '', uid: '', openId: '', unionId: '' }
  };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000') return data.data;
    console.log(`  ❌ 签到步骤1失败: ${data.msg || ''}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 签到步骤1异常: ${e.message}`);
    return null;
  }
}

// 签到2 - 步骤2.1: 获取C4aToken
async function signin2Step2_1(bz, uc_access_token, user_data) {
  const url = 'https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/token/exchange/getC4aToken.do';
  const headers = {
    'User-Agent': sc_ua(),
    'Content-Type': 'application/json',
    'ucAccessToken': uc_access_token,
    'charset': 'utf-8',
    'Referer': `https://servicewechat.com/${APPID}/148/page-frame.html`,
  };
  const body = {
    restParams: {
      mobile: String(user_data.phone || ''),
      appId: '10080',
      openid: String(user_data.openId || '')
    }
  };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000' && data.data) {
      return data.data.jwtToken || data.data;
    }
    console.log(`  ❌ 签到步骤2.1失败: ${data.msg || ''}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 签到步骤2.1异常: ${e.message}`);
    return null;
  }
}

// 签到2 - 步骤2.2: 获取长链接
async function signin2Step2_2(bz, uc_access_token, user_data, jwt_token) {
  const url = 'https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/im-svr/cmimp/user/login/enc/getLongUrlByToken';
  const headers = {
    'User-Agent': sc_ua(),
    'Content-Type': 'application/json',
    'ucAccessToken': uc_access_token,
    'charset': 'utf-8',
    'Referer': `https://servicewechat.com/${APPID}/148/page-frame.html`,
  };
  const rest = {
    brand: 2, sourceSys: 'LSWX',
    unionId: user_data.unionId || '',
    openId: user_data.openId || '',
    uid: user_data.uid || '',
    rootCode: 'XTE', appCode: 'XTE_SHG',
    shortUrl: 'https://d.midea.com/d/L1AbJNjWiQw',
    jwtToken: jwt_token, ucToken: uc_access_token,
  };
  const body = { pagination: {}, restParams: rest, openid: user_data.openId || '' };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000' && data.data) {
      const long_url = data.data;
      const urlObj = new URL(long_url);
      const params = new URLSearchParams(urlObj.search || urlObj.hash.split('?')[1] || '');
      return { long_url, channel_id: params.get('channelId'), actv_id: params.get('actvId') };
    }
    console.log(`  ❌ 签到步骤2.2失败: ${data.msg || ''}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 签到步骤2.2异常: ${e.message}`);
    return null;
  }
}

// 签到2 - 步骤2.3: 获取活动信息
async function signin2Step2_3(bz, actv_id, channel_id) {
  const url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/cmimp/activity/getActvInfo';
  const headers = {
    'User-Agent': sc_ua(),
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'appId': 'QLZZ9Fr7w2to',
    'apiKey': '3660663068894a0d9fea574c2673f3c0',
    'Origin': 'https://weixin.midea.com',
    'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
  };
  const body = {
    headParams: { language: 'CN', originSystem: 'MCSP', timeZone: '', userCode: '', tenantCode: '', userKey: 'TEST_', transactionId: '' },
    pagination: null,
    restParams: { actvId: String(actv_id), rootCode: 'XTE', appCode: 'XTE_SHG', channelId: String(channel_id), imUserId: '', uid: '', openId: '', unionId: '' }
  };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000') return data.data;
    return null;
  } catch (e) {
    return null;
  }
}

// 签到2 - 步骤2.4: 注册用户
async function signin2Step2_4(bz, user_data, actv_id) {
  const url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/common/login/register';
  const headers = {
    'User-Agent': sc_ua(),
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'appId': 'QLZZ9Fr7w2to',
    'apiKey': '3660663068894a0d9fea574c2673f3c0',
    'Origin': 'https://weixin.midea.com',
    'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
  };
  const body = {
    headParams: { language: 'CN', originSystem: 'MCSP', timeZone: '', userCode: '', tenantCode: '', userKey: 'TEST_', transactionId: '' },
    pagination: null,
    restParams: {
      uid: user_data.uid || '', openId: user_data.openId || '', unionId: user_data.unionId || '',
      phone: '', actvId: String(actv_id), rootCode: 'XTE', appCode: 'XTE_SHG', imUserId: ''
    }
  };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000') return data.data;
    console.log(`  ❌ 签到注册失败: ${data.msg || ''}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 签到注册异常: ${e.message}`);
    return null;
  }
}

// 签到2 - 步骤2.5: initData
async function signin2Step2_5(bz, uc_access_token, actv_id, channel_id, user_data, im_user_data) {
  const url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/cmimp/activity/initData';
  const headers = {
    'User-Agent': sc_ua(),
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'appId': 'QLZZ9Fr7w2to',
    'apiKey': '3660663068894a0d9fea574c2673f3c0',
    'Origin': 'https://weixin.midea.com',
    'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
  };
  const body = {
    headParams: { language: 'CN', originSystem: 'MCSP', timeZone: '', userCode: '', tenantCode: '', userKey: 'TEST_', transactionId: '' },
    pagination: null,
    restParams: {
      actvId: String(actv_id), rootCode: 'XTE', appCode: 'XTE_SHG',
      userType: 1, openId: user_data.openId || '',
      templateId: '2', channelId: String(channel_id), wasLogin: true,
      imUserId: im_user_data.imUserId || '', uid: user_data.uid || '', unionId: user_data.unionId || '',
    }
  };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000') return data.data;
    return null;
  } catch (e) {
    return null;
  }
}

// 签到2 - 步骤3: 执行签到
async function signin2Step3(bz, uc_access_token, actv_id, user_data, im_user_data) {
  const url = 'https://weixin.midea.com/mscp_mscp/api/cms_api/activity-center-im-service/im-svr/im/game/page/sign';
  const headers = {
    'User-Agent': sc_ua(),
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'appId': 'QLZZ9Fr7w2to',
    'apiKey': '3660663068894a0d9fea574c2673f3c0',
    'Origin': 'https://weixin.midea.com',
    'Referer': 'https://weixin.midea.com/apps/h5-pro-wx-interaction-marketing/',
    'ucAccessToken': uc_access_token,
  };
  const body = {
    headParams: { language: 'CN', originSystem: 'MCSP', timeZone: '', userCode: '', tenantCode: '', userKey: 'TEST_', transactionId: '' },
    pagination: null,
    restParams: { gameId: 9, actvId: String(actv_id), rootCode: 'XTE', appCode: 'XTE_SHG' }
  };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000') {
      const d = data.data || {};
      if (d.result) {
        const prize = d.prizeDto || {};
        console.log(`  ✅ 签到成功: ${prize.name || '未知'}, 连续${d.consecutiveDays || 0}天`);
      } else {
        console.log(`  ⚠️ 今日已签到`);
      }
      return d;
    }
    console.log(`  ❌ 签到失败: ${data.msg || ''}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 签到异常: ${e.message}`);
    return null;
  }
}

// 完整签到流程
async function signin2(bz, uc_access_token) {
  console.log(`  ⏳ 签到流程开始...`);

  const user_data = await signin2Step1(bz, uc_access_token);
  if (!user_data) return null;

  let actv_id = null, channel_id = null;
  for (let i = 0; i < 3; i++) {
    const jwt_token_data = await signin2Step2_1(bz, uc_access_token, user_data);
    if (!jwt_token_data) continue;

    const jwt_token = typeof jwt_token_data === 'string' ? jwt_token_data : (jwt_token_data.jwtToken || JSON.stringify(jwt_token_data));
    console.log(`  ✅ 获取到 jwtToken`);

    const result = await signin2Step2_2(bz, uc_access_token, user_data, jwt_token);
    if (!result || !result.channel_id || !result.actv_id) continue;

    const actv_info = await signin2Step2_3(bz, result.actv_id, result.channel_id);
    if (actv_info) {
      actv_id = result.actv_id;
      channel_id = result.channel_id;
      console.log(`  ✅ 第${i + 1}次尝试成功: actvId=${actv_id}`);
      break;
    }
  }

  if (!actv_id || !channel_id) {
    actv_id = '401668349848950807';
    channel_id = '401668349999945746';
    console.log(`  ⚠️ 使用兜底值 actvId=${actv_id}`);
    await signin2Step2_3(bz, actv_id, channel_id);
  }

  const im_user_data = await signin2Step2_4(bz, user_data, actv_id);
  if (!im_user_data) return null;

  const init_data = await signin2Step2_5(bz, uc_access_token, actv_id, channel_id, user_data, im_user_data);
  if (init_data) {
    const lst = init_data[0]?.rollSignList || [];
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const item = lst.find(x => x.isToday === true) || lst.find(x => x.signDate === today);
    if (item && String(item.signStatus) === '3') {
      console.log(`  ✅ 今日已签到`);
      return { skipped: true };
    }
  }

  return await signin2Step3(bz, uc_access_token, actv_id, user_data, im_user_data);
}

// 打工收蛋 - 获取用户信息
async function getUserInfo(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/swan/getSwanByToken`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.get(url, { headers, timeout: 15000 });
    const data = resp.data;
    if ([0, 200, '0', '200'].includes(data.code)) return data.content;
    console.log(`  ❌ 获取用户信息失败: code=${data.code}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 获取用户信息异常: ${e.message}`);
    return null;
  }
}

// 打工收蛋 - 领取奖励
async function gainWorkPrize(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/swan/userGainWorkPrize`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.post(url, {}, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === 200) {
      const c = data.content;
      if (c && c.newValue != null) {
        const gained = (Number(c.newValue) || 0) - (Number(c.oldValue) || 0);
        console.log(`  ✅ 领取打工奖励成功: 贝壳+${gained} (现${c.newValue})`);
      } else {
        // code=200 但 content 为空 = 今日奖励已领取过, 属正常情况
        console.log(`  ✅ 领取打工奖励成功 (今日已领取过, 无新增)`);
      }
      return data.content || { emptyOk: true };
    }
    console.log(`  ❌ 领取失败: ${data.chnDesc || data.engDesc || ''}`);
    return null;
  } catch (e) {
    console.log(`  ❌ 领取异常: ${e.message}`);
    return null;
  }
}

// 打工收蛋流程
async function processWorkPrize(bz, uc_access_token, bearer_token) {
  const old_info = await getUserInfo(bz, uc_access_token, bearer_token);
  if (!old_info) return { success: false, increase: 0 };

  const old_shells = old_info.shellAmount || 0;
  console.log(`  👤 ${old_info.swanNick || '未知'} | 贝壳: ${old_shells}`);

  const prize_result = await gainWorkPrize(bz, uc_access_token, bearer_token);
  if (!prize_result) return { success: false, increase: 0 };

  await sleep(2000);
  const new_info = await getUserInfo(bz, uc_access_token, bearer_token);
  if (new_info) {
    const new_shells = new_info.shellAmount || 0;
    const increase = new_shells - old_shells;
    if (increase > 0) {
      console.log(`  ✅ 贝壳增加: +${increase}`);
      return { success: true, increase };
    }
  }
  return { success: true, increase: 0 };
}

// 养鹅 - 个人中心
async function getPersonalInfo(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/swan/getSwanByToken`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.get(url, { headers, timeout: 15000 });
    const data = resp.data;
    if ([0, 200, '0', '200'].includes(data.code)) {
      const c = data.content;
      const swan_nick = c.swanNick || '未知';
      const level_name = c.levelName || '';
      const level = c.level || 0;
      const growth_stage = c.growthStageName || '';
      const shell_amount = c.shellAmount || 0;

      let work_status = '未打工';
      if (c.startWorkingTime) {
        const start = new Date(c.startWorkingTime);
        const now = new Date();
        const diff_hours = (now - start) / 3600000;
        if (diff_hours < 9) {
          work_status = `工作中 (还需${(9 - diff_hours).toFixed(1)}h)`;
        } else {
          work_status = `可重新工作 (已${diff_hours.toFixed(1)}h)`;
        }
      }

      console.log(`  👤 ${swan_nick} | ${level_name} Lv${level} | ${growth_stage} | 贝壳:${shell_amount} | ${work_status}`);
      return { swanNick: swan_nick, levelName: level_name, level, growthStageName: growth_stage, shellAmount: shell_amount, startWorkingTime: c.startWorkingTime };
    }
    return null;
  } catch (e) {
    console.log(`  ❌ 个人中心异常: ${e.message}`);
    return null;
  }
}

// 养鹅 - 开始工作
async function swanStartWorking(bz, uc_access_token, bearer_token, growth_stage, start_working_time) {
  if (growth_stage && growth_stage !== '鹅仔期') {
    console.log(`  ⚠️ 当前阶段 ${growth_stage}，非鹅仔期，无法工作`);
    return null;
  }

  if (start_working_time) {
    const start = new Date(start_working_time);
    const diff_hours = (new Date() - start) / 3600000;
    if (diff_hours < 9) {
      console.log(`  ⚠️ 天鹅工作中，还需 ${(9 - diff_hours).toFixed(1)}h`);
      return null;
    }
  }

  const url = `${URLS}/api/web/mobile/swan/swanStartWorking`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.post(url, {}, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === 200) {
      console.log(`  ✅ 开始工作成功: ${data.chnDesc || ''}`);
      return data;
    }
    // 1004 = 今日已领取过工作奖励, 属每日正常循环
    if (data.code === 1004) {
      console.log(`  ℹ️ 今日打工奖励已领取过, 明日再开工`);
      return data;
    }
    console.log(`  ⚠️ 开始工作: code=${data.code} ${data.chnDesc || ''}`);
    return data;
  } catch (e) {
    console.log(`  ❌ 开始工作异常: ${e.message}`);
    return null;
  }
}

// 养鹅 - 领取额外奖励
async function swanGainPrizeByRule(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/swan/userGainPrizeByRule`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.post(url, {}, { headers, timeout: 15000 });
    const data = resp.data;
    if ([0, 200, '0', '200'].includes(data.code)) {
      const c = data.content;
      if (Array.isArray(c) && c.length > 0) {
        console.log(`  ✅ 养鹅额外奖励 ${c.length} 条`);
      } else {
        console.log(`  ✅ 无额外奖励`);
      }
    }
    return data;
  } catch (e) {
    console.log(`  ❌ 养鹅额外奖励异常: ${e.message}`);
    return null;
  }
}

// 养鹅 - 任务列表
async function rwlbSwan(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/swanPrize/queryPrizeRuleUserComplete`;
  const headers = hs(uc_access_token, bearer_token);
  const body = { ruleType: '1', ruleClass: '3' };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if ([0, 200, '0', '200'].includes(data.code)) {
      const list = data.content || [];
      console.log(`  ⏳ 养鹅任务 ${list.length} 个`);

      const uncompleted = list.filter(item => !item.isUserCompleted);
      if (uncompleted.length > 0) {
        console.log(`  ⏳ ${uncompleted.length} 个待完成`);
        for (const task of uncompleted) {
          const rule_id = String(task.id);
          console.log(`    → ${task.ruleName}`);

          await axios.post(`${URLS}/api/web/mobile/swanPrize/beginTask`, { ruleId: rule_id }, { headers, timeout: 10000 }).catch(() => {});
          await sleep(1000);
          await axios.post(`${URLS}/api/web/mobile/swanPrize/completeTask`, { ruleId: rule_id }, { headers, timeout: 10000 }).catch(() => {});
          console.log(`    ✅ ${task.ruleName}`);
        }
      } else {
        console.log(`  ✅ 养鹅任务全完成`);
      }
    }
    return data;
  } catch (e) {
    console.log(`  ❌ 养鹅任务异常: ${e.message}`);
    return null;
  }
}

// 养鹅 - 喂草
async function swanFeedGrass(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/swan/feedGrass`;
  const headers = hs(uc_access_token, bearer_token);
  let feed_count = 0;

  while (true) {
    try {
      const resp = await axios.post(url, {}, { headers, timeout: 15000 });
      const data = resp.data;

      if (data.code === 200) {
        feed_count++;
        const c = data.content || {};
        console.log(`  ✅ 第${feed_count}次喂草 | ${c.swanNick || ''} ${c.growthStageName || ''} | 青草:${c.grassAmount || 0}`);
        await randomSleep(5, 10);
      } else if (data.code === 400) {
        if (feed_count > 0) console.log(`  ✅ 共喂草 ${feed_count} 次`);
        else console.log(`  ⚠️ ${data.chnDesc || '青草不足'}`);
        break;
      } else {
        console.log(`  ⚠️ 喂草: code=${data.code} ${data.chnDesc || ''}`);
        break;
      }
    } catch (e) {
      console.log(`  ❌ 喂草异常: ${e.message}`);
      break;
    }
  }
}

// 精灵 - 任务列表
async function rwlb(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/avatarRule/queryPrizeRuleUserComplete`;
  const headers = hs(uc_access_token, bearer_token);
  const body = { ruleTypeId: '1', ruleClassId: '2', seq: 0 };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    if ([0, 200, '0', '200'].includes(data.code)) {
      const list = data.content || [];
      console.log(`  ⏳ 精灵任务 ${list.length} 个`);

      const uncompleted = list.filter(item => !item.isUserCompleted);
      if (uncompleted.length > 0) {
        console.log(`  ⏳ ${uncompleted.length} 个待完成`);
        for (const task of uncompleted) {
          const rid = String(task.id);
          const ti = task.timeInterval || 0;
          const wait = Math.max(1, ti) + Math.floor(Math.random() * 3) + 1;

          console.log(`    → ${task.ruleName} (等待 ${wait}s)`);

          await axios.post(`${URLS}/api/web/mobile/avatarRule/beginTask`, { ruleId: rid }, { headers, timeout: 10000 }).catch(() => {});
          await sleep(wait * 1000);
          await axios.post(`${URLS}/api/web/mobile/avatarRule/completeTask`, { ruleId: rid }, { headers, timeout: 10000 }).catch(() => {});
          console.log(`    ✅ ${task.ruleName}`);
        }
      } else {
        console.log(`  ✅ 精灵任务全完成`);
      }
    }
    return data;
  } catch (e) {
    console.log(`  ❌ 精灵任务异常: ${e.message}`);
    return null;
  }
}

// 精灵 - 领取额外奖励
async function avatarGainPrizeByRule(bz, uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/avatarRule/userGainPrizeByRule`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.post(url, {}, { headers, timeout: 15000 });
    const data = resp.data;
    if ([0, 200, '0', '200'].includes(data.code)) {
      const c = data.content;
      if (Array.isArray(c) && c.length > 0) {
        console.log(`  ✅ 精灵额外奖励 ${c.length} 条`);
      } else {
        console.log(`  ✅ 无额外奖励`);
      }
    }
    return data;
  } catch (e) {
    console.log(`  ❌ 精灵额外奖励异常: ${e.message}`);
    return null;
  }
}
// =====================

// ====== 通知 ======
async function dingtalkNotify(title, content) {
  if (!DD_BOT_TOKEN) return;
  try {
    const timestamp = String(Date.now());
    let url = `https://oapi.dingtalk.com/robot/send?access_token=${DD_BOT_TOKEN}`;
    if (DD_BOT_SECRET) {
      const crypto = require('crypto');
      const stringToSign = `${timestamp}\n${DD_BOT_SECRET}`;
      const sign = encodeURIComponent(crypto.createHmac('sha256', DD_BOT_SECRET).update(stringToSign).digest('base64'));
      url += `&timestamp=${timestamp}&sign=${sign}`;
    }
    await axios.post(url, {
      msgtype: 'markdown',
      markdown: { title, text: `## ${title}\n\n${content}` }
    }, { timeout: 10000 });
    console.log(`  ✅ 钉钉通知已发送`);
  } catch (e) {
    console.log(`  ❌ 钉钉通知失败: ${e.message}`);
  }
}
// ==================

// ====== 登录/令牌获取（可复用） ======
async function obtainTokens(ref, openid) {
  console.log(`  [1/3] 获取 wx.login code...`);
  const code = await yybGetCode(ref);
  if (!code) return null;

  console.log(`  [2/3] 尝试换取 ucAccessToken...`);
  const uc_access_token = await exchangeCodeForUcToken(code, openid);
  if (!uc_access_token) return null;

  console.log(`  [3/3] 获取 bearer_token...`);
  const bearer_token = await getBearerToken('', uc_access_token);
  if (!bearer_token) return null;

  return { uc_access_token, bearer_token };
}

async function doAllTasks(displayName, uc_access_token, bearer_token) {
  // 签到
  const signinResult = await signin2(displayName, uc_access_token);
  if (!signinResult) console.log(`  ⚠️ 签到可能失败`);

  // 个人中心
  const personal_info = await getPersonalInfo(displayName, uc_access_token, bearer_token);
  if (!personal_info) {
    console.log(`  ⚠️ 获取个人中心失败`);
  }

  // 打工收蛋
  const { success: work_ok } = await processWorkPrize(displayName, uc_access_token, bearer_token);
  if (!work_ok) console.log(`  ⚠️ 打工收蛋失败`);

  // 开始工作
  await swanStartWorking(displayName, uc_access_token, bearer_token, personal_info?.growthStageName, personal_info?.startWorkingTime);

  // 养鹅额外奖励
  await swanGainPrizeByRule(displayName, uc_access_token, bearer_token);

  // 精灵任务
  await rwlb(displayName, uc_access_token, bearer_token);

  // 精灵额外奖励
  await avatarGainPrizeByRule(displayName, uc_access_token, bearer_token);

  // 养鹅任务列表
  await rwlbSwan(displayName, uc_access_token, bearer_token);

  // 喂草
  await swanFeedGrass(displayName, uc_access_token, bearer_token);

  return { signinResult, personal_info };
}
// =============================

// ====== 主流程 ======
async function processAccount(account) {
  const ref = String(account.id || '');
  const nickname = account.nickname || account.alias || '未知';
  const openid = account.openid || '';
  const displayName = nickname || openid.slice(0, 16);
  console.log(`\n  📱 账号: ${displayName}`);

  // ---- 尝试从缓存获取令牌 ----
  let uc_access_token, bearer_token, fromCache = false;
  const cached = cacheLoad(openid);
  if (cached && cached.uc_access_token && cached.bearer_token) {
    uc_access_token = cached.uc_access_token;
    bearer_token = cached.bearer_token;
    fromCache = true;
    console.log(`  ✅ 使用缓存令牌`);
  }

  if (!uc_access_token || !bearer_token) {
    // 无缓存 → 直接登录
    fromCache = false;
    const tokens = await obtainTokens(ref, openid);
    if (!tokens) {
      failedCount++;
      return 'fail';
    }
    uc_access_token = tokens.uc_access_token;
    bearer_token = tokens.bearer_token;
    cacheSave(openid, tokens);
    console.log(`    ✅ 令牌已缓存`);
  }

  console.log(`  执行第一次任务...`);
  AUTH_FAILED = false;
  const first = await doAllTasks(displayName, uc_access_token, bearer_token);

  // 如果出现了 401/403 → 登录态失效，删缓存、重新获取变量并重跑
  if (AUTH_FAILED) {
    console.log(`  ⏳ 检测到 401，重新获取变量...`);
    cacheDelete(openid);

    const tokens = await obtainTokens(ref, openid);
    if (!tokens) {
      failedCount++;
      return 'fail';
    }
    uc_access_token = tokens.uc_access_token;
    bearer_token = tokens.bearer_token;
    cacheSave(openid, tokens);
    console.log(`    ✅ 变量已重新获取并缓存`);

    console.log(`  重新执行任务...`);
    await doAllTasks(displayName, uc_access_token, bearer_token);
    successCount++;
    return 'success';
  }

  successCount++;
  return 'success';
}

// ====== 主程序入口 ======
async function main() {
  console.log('='.repeat(56));
  console.log(`  ${APP_NAME} 合并版 (YYB版)`);
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log('='.repeat(56));

  if (!YYB_BASE) {
    console.log('\n❌ 未设置 YYB_BASE_URL 环境变量\n');
    console.log('  使用方法：');
    console.log('  ────────────────────────────────────────────');
    console.log('  export YYB_BASE_URL="http://192.168.22.214:3003"');
    console.log('  node 小天鹅_签到_YYB.js');
    console.log('  ────────────────────────────────────────────');
    process.exit(1);
  }

  console.log('\n[1/2] 获取 YYB 账号列表...');
  const accounts = await yybGetAccounts();
  if (!accounts.length) {
    console.log('❌ 没有可用的微信账号');
    console.log(`  请先在 YYB 服务 (${YYB_BASE}) 中添加账号`);
    return;
  }

  let filtered = accounts;
  if (YYB_REF) {
    filtered = accounts.filter(a => String(a.id) === YYB_REF || a.openid === YYB_REF || a.UIN === YYB_REF);
    if (!filtered.length) {
      console.log(`❌ 未找到 ref=${YYB_REF} 的账号`);
      return;
    }
    console.log(`✅ 指定账号, 共 1 个\n`);
  } else {
    console.log(`✅ 共 ${filtered.length} 个账号\n`);
  }

  for (let i = 0; i < filtered.length; i++) {
    console.log(`[${i + 1}/${filtered.length}] ${'='.repeat(40)}`);
    try {
      await processAccount(filtered[i]);
    } catch (e) {
      console.log(`  ❌ 账号执行异常: ${e.message}`);
      failedCount++;
    }
    if (i < filtered.length - 1) await sleep(3000);
  }

  // 汇总输出
  console.log('\n' + '='.repeat(56));
  console.log('  📊 执行汇总');
  console.log('='.repeat(56));
  console.log(`  ✅ 成功: ${successCount} 个`);
  console.log(`  ❌ 失败: ${failedCount} 个`);
  console.log(`  ⏭️  跳过: ${skippedCount} 个`);
  console.log('='.repeat(56));

  // 钉钉通知
  if (DD_BOT_TOKEN) {
    const notify_content = `✅ 成功: ${successCount} 个\n❌ 失败: ${failedCount} 个\n⏭️ 跳过: ${skippedCount} 个`;
    await dingtalkNotify(`${APP_NAME} 执行结果`, notify_content);
  }
}

main().catch(e => console.error(e));
