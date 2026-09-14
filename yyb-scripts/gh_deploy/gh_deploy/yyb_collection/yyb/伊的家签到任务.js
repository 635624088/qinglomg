#!/usr/bin/env node
/**
 * 伊的家 签到+任务 (YYB版)
 *
 * 入口: 微信小程序搜索"伊的家"
 * 功能: 每日签到 + 完成任务中心任务
 *
 * 环境变量:
 *   YYB_BASE_URL  YYB 服务地址 (必填)
 *   YYB_REF       指定账号 ref (可选，默认遍历所有账号)
 */

const axios = require('axios');
const dayjs = require('dayjs');

// ====== YYB 配置 ======
const YYB_BASE = process.env.YYB_BASE_URL;
const YYB_REF = process.env.YYB_REF || '';
// ======================

// ====== 业务常量 ======
const APP_NAME = '伊的家';
const APPID = 'wx5d2eb35c8cf1c873';
const API_BASE = 'https://cim-api.yidejia.com';
const COMMON_HEADERS = {
  'Version': '3.61.0',
  'platform': 'wxa'
};
// ======================

let successCount = 0, failedCount = 0, skippedCount = 0;

// ====== YYB 接口封装 ======
async function yybGetAccounts() {
  const resp = await axios.get(`${YYB_BASE}/accounts`, { timeout: 10000 });
  const data = resp.data;
  if (data.code === 0) return data.data || [];
  console.log(`  [✗] 获取账号列表失败: ${data.msg || '未知错误'}`);
  return [];
}

async function yybGetCode(ref) {
  const resp = await axios.post(`${YYB_BASE}/wxapp/getCode`, { ref, app_id: APPID }, { timeout: 30000 });
  const data = resp.data;
  if (data.code === 0) {
    const result = data.data?.result || {};
    if (result.code) return result.code;
    console.log(`    [✗] getCode 返回中没有 code: ${JSON.stringify(result)}`);
    return null;
  }
  console.log(`    [✗] YYB getCode 失败: ${data.msg || '未知错误'}`);
  return null;
}
// =========================

// ====== 业务接口 ======
// ponytail: 登录返回 token，失败返回 null
async function loginWithCode(code) {
  try {
    const resp = await axios.post(`${API_BASE}/mall/api/user/login-by-wxa/v2`, {
      code,
      sign: '',
      source_module: '',
      rd_session_key: '',
      cpsid: 0,
      cps_customer_id: 0,
      extra_data_json: '{}',
      login_type: ''
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const token = resp.data?.data?.app_token || resp.data?.data?.new_token || resp.data?.data?.token;
    if (token) return token;
    console.log(`    [✗] 登录失败: ${JSON.stringify(resp.data).slice(0, 200)}`);
    return null;
  } catch (e) {
    console.log(`    [✗] 登录异常: ${e.message}`);
    return null;
  }
}

// ponytail: 签到，成功返回 true
async function doSign(token) {
  try {
    const resp = await axios.post(`${API_BASE}/community/user/sign`, {}, {
      headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json', Token: token },
      timeout: 15000
    });
    if (resp.data?.code === 0) {
      const rewards = resp.data.data?.reward || [];
      if (rewards.length > 0) {
        console.log(`    [✓] 签到成功, 奖励: ${JSON.stringify(rewards)}`);
      } else {
        console.log(`    [✓] 签到成功`);
      }
      return true;
    }
    console.log(`    [✗] 签到失败: ${resp.data?.message || '未知错误'}`);
    return false;
  } catch (e) {
    console.log(`    [✗] 签到异常: ${e.message}`);
    return false;
  }
}

// ponytail: 获取任务列表
async function getMissionList(token) {
  try {
    const resp = await axios.get(`${API_BASE}/community/mission`, {
      headers: { ...COMMON_HEADERS, Token: token },
      timeout: 15000
    });
    if (resp.data?.code === 0) {
      return resp.data.data || {};
    }
    console.log(`    [✗] 获取任务列表失败: ${resp.data?.message || '未知错误'}`);
    return null;
  } catch (e) {
    console.log(`    [✗] 获取任务列表异常: ${e.message}`);
    return null;
  }
}

// ponytail: 完成任务
async function completeMission(token, action, title) {
  try {
    const resp = await axios.post(`${API_BASE}/community/mission/complete`,
      { action },
      {
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json', Token: token },
        timeout: 15000
      }
    );
    if (resp.data?.code === 0) {
      console.log(`    [✓] 完成任务: ${title}`);
      return true;
    }
    console.log(`    [⚠] 任务 ${title} 失败: ${resp.data?.message || '未知错误'}`);
    return false;
  } catch (e) {
    console.log(`    [⚠] 任务 ${title} 异常: ${e.message}`);
    return false;
  }
}

async function processAccount(account) {
  const ref = String(account.id || '');
  const nickname = account.nickname || '未知';
  const openid = account.openid || '';
  const displayName = nickname || openid.slice(0, 16);
  console.log(`\n  📱 账号: ${displayName}`);

  console.log(`  [1/4] 获取 wx.login code...`);
  const code = await yybGetCode(ref);
  if (!code) {
    console.log(`  [✗] 获取 code 失败, 跳过此账号`);
    skippedCount++;
    return 'skip';
  }

  console.log(`  [2/4] 登录 ${APP_NAME}...`);
  const token = await loginWithCode(code);
  if (!token) {
    failedCount++;
    return 'fail';
  }
  console.log(`    [✓] 登录成功`);

  console.log(`  [3/4] 执行签到...`);
  await doSign(token);
  await sleep(1000);

  console.log(`  [4/4] 执行任务中心任务...`);
  const missions = await getMissionList(token);
  if (!missions) {
    console.log(`    [✗] 获取任务列表失败`);
    failedCount++;
    return 'fail';
  }

  // 提取所有未完成的任务 (daily + stage)
  const allTasks = [
    ...(missions.daily || []),
    ...(missions.stage || [])
  ].filter(t => !t.complete && t.action);

  if (allTasks.length === 0) {
    console.log(`    [✓] 所有任务已完成`);
  } else {
    console.log(`    [→] 找到 ${allTasks.length} 个待完成任务`);
    let completed = 0;
    for (const task of allTasks) {
      await sleep(800);
      const ok = await completeMission(token, task.action, task.title);
      if (ok) completed++;
    }
    console.log(`    [📊] 完成 ${completed}/${allTasks.length} 个任务`);
  }

  successCount++;
  return 'success';
}

async function main() {
  console.log('='.repeat(56));
  console.log(`  ${APP_NAME} 签到+任务 (YYB版)`);
  console.log(`  时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`);
  console.log('='.repeat(56));

  if (!YYB_BASE) {
    console.log('[✗] 缺少环境变量 YYB_BASE_URL');
    return;
  }

  console.log('\n[1/2] 获取 YYB 账号列表...');
  const accounts = await yybGetAccounts();
  if (!accounts.length) {
    console.log('[✗] 没有可用的微信账号');
    console.log(`  请先在 YYB 服务 (${YYB_BASE}) 中添加账号`);
    return;
  }

  let filtered = accounts;
  if (YYB_REF) {
    filtered = accounts.filter(a => String(a.id) === YYB_REF || a.openid === YYB_REF);
    if (!filtered.length) {
      console.log(`[✗] 未找到 ref=${YYB_REF} 的账号`);
      return;
    }
    console.log(`[✓] 指定账号, 共 1 个\n`);
  } else {
    console.log(`[✓] 共 ${filtered.length} 个账号\n`);
  }

  console.log('[2/2] 开始执行任务...');
  for (let i = 0; i < filtered.length; i++) {
    console.log(`[${i + 1}/${filtered.length}] ${'='.repeat(40)}`);
    try {
      await processAccount(filtered[i]);
    } catch (e) {
      console.log(`  [✗] 账号执行异常: ${e.message}`);
      failedCount++;
    }
    if (i < filtered.length - 1) await sleep(2000);
  }

  // 汇总输出
  console.log('\n' + '='.repeat(56));
  console.log('  📊 执行汇总');
  console.log('='.repeat(56));
  console.log(`  ✅ 成功: ${successCount} 个`);
  console.log(`  ❌ 失败: ${failedCount} 个`);
  console.log(`  ⏭️  跳过: ${skippedCount} 个`);
  console.log('='.repeat(56));
  console.log('  全部任务执行完毕!');
  console.log('='.repeat(56));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(e => console.error(e));
