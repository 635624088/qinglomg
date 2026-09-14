#!/usr/bin/env node
/**
 * ========================================
 * 脚本名称: 小天鹅 - 蛋壳兑换 (YYB版)
 * 脚本版本: v1.0
 * 作者: 诗人
 * 更新日期: 2026-08-20
 * ========================================
 *
 * 【功能介绍】
 * 将小天鹅养鹅获得的蛋壳兑换为积分（兑换比例 1:2）
 * 兑换前后自动查询积分余额并显示变化
 *
 * 【环境变量】
 *   YYB_BASE_URL          YYB 服务地址 (必填)
 *   YYB_XTE               指定账号 ref，多个用英文逗号分隔 (可选，默认遍历所有账号，如 YYB_XTE="24,5,20")
 *   SHELL_EXCHANGE_COUNT  兑换蛋壳数量 (可选，默认 -1=全部兑换；>0=指定数量；0=不兑换)
 *
 * 【定时任务】
 *   cron: 30 7 * * *   (每天早上7:30执行，与签到养鹅精灵错开或合并)
 *
 * 【通知方式】
 * 青龙 sendNotify.js
 *
 * 【缓存机制】
 * 自动缓存 ucAccessToken / bearerToken / unionId / miniOpenId
 * 与"小天鹅签到yyb版.js"共用缓存目录(.小天鹅_cache)
 * ========================================
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ====== YYB 配置 ======
const YYB_BASE = process.env.YYB_BASE_URL;
const YYB_XTE = process.env.YYB_XTE || '';

// ====== 业务常量 ======
const APP_NAME = '小天鹅-蛋壳兑换';
const APPID = 'wx33856a6b31431c6e';
const URLS = 'https://littleswanmp.midea.com';
const SCRIPT_VERSION = 'v1.0';

// ====== 兑换配置 ======
const SHELL_EXCHANGE_COUNT = parseInt(process.env.SHELL_EXCHANGE_COUNT || '-1', 10);

// ====== 缓存配置（与签到共用） ======
const CACHE_DIR = '.小天鹅_cache';

// ====== 统计变量 ======
let successCount = 0, failedCount = 0, skippedCount = 0;
let results = {};
let accountStats = {};

// ====== 成功状态码 ======
const SUCCESS_CODES = [0, 200, '0', '200', '000000'];

// ====== 青龙通知 ======
function qlNotify(title, content) {
  // 通知统一由青龙 task_after.sh 推送，脚本内不再单独调用 sendNotify，避免重复推送
  console.log(`\n📢 [通知预览] ${title}\n${content}\n`);
}

// ====== 缓存功能 ======
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCacheFilePath(accountRef) {
  return path.join(CACHE_DIR, `${accountRef}.json`);
}

function readCache(accountRef) {
  try {
    const cacheFile = getCacheFilePath(accountRef);
    if (!fs.existsSync(cacheFile)) return null;
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  } catch { return null; }
}

function writeCache(accountRef, data) {
  try {
    ensureCacheDir();
    const cacheFile = getCacheFilePath(accountRef);
    const cacheData = { ...data, cachedAt: new Date().toISOString() };
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.log(`    ⚠️ 缓存写入失败: ${e.message}`);
    return false;
  }
}

function deleteCache(accountRef) {
  try {
    const cacheFile = getCacheFilePath(accountRef);
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    return true;
  } catch { return false; }
}

// ====== YYB 接口 ======
async function yybGetAccounts() {
  const resp = await axios.get(`${YYB_BASE}/accounts`, { timeout: 10000 });
  const data = resp.data;
  if (data.code === 0) return data.data || [];
  console.log(`  ❌ 获取账号列表失败: ${data.msg || '未知错误'}`);
  return [];
}

async function yybGetCode(ref) {
  try {
    const resp = await axios.post(`${YYB_BASE}/wxapp/getCode`, { ref, app_id: APPID }, { timeout: 30000 });
    const data = resp.data;
    if (data.code === 0) {
      const result = data.data?.result || {};
      if (result.code) return result.code;
      return null;
    }
    return null;
  } catch (e) {
    console.log(`    ⚠️ 获取code异常(ref=${ref}): ${e?.response?.data?.msg || e?.message || e}`);
    return null;
  }
}

// ====== 通用工具 ======
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ====== 登录（与签到脚本完全一致） ======
async function exchangeCodeForUcToken(jsCode) {
  const url = 'https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/app/login/wx/mini/getLoginInfo.do';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'xweb_xhr': '1',
    'Referer': `https://servicewechat.com/${APPID}/191/page-frame.html`,
  };
  const body = { jsCode: jsCode, platformType: 'WX_LS_MINI', loginMode: 1 };
  try {
    const resp = await axios.post(url, body, { headers, timeout: 15000 });
    const data = resp.data;
    const token = data.data?.ucAccessToken || data.ucAccessToken || null;
    if (token && token.length > 10) {
      console.log(`    ✅ 成功获取 ucAccessToken`);
      return {
        ucAccessToken: token,
        unionId: data.data?.unionId || data.unionId || '',
        miniOpenId: data.data?.openId || data.openId || ''
      };
    }
    return null;
  } catch { return null; }
}

async function getBearerToken(uc_access_token) {
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
    return null;
  } catch { return null; }
}

// ====== 积分查询 ======
async function getMemberIntegral(uc_access_token, unionId) {
  const url = 'https://mcsp.midea.com/api/cms_bff/mcsp-uc-mvip-bff/integral/getMemberIntegral.do';
  const headers = {
    'User-Agent': sc_ua(),
    'xweb_xhr': '1',
    'Content-Type': 'application/json',
    'ucAccessToken': uc_access_token,
    'Accept': '*/*',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': `https://servicewechat.com/${APPID}/148/page-frame.html`,
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };
  try {
    const resp = await axios.post(url, {
      pagination: {},
      restParams: { brand: 2, sourceSys: 'LSWX', unionId }
    }, { headers, timeout: 15000 });
    const data = resp.data;
    if (data.code === '000000' && data.data?.score) {
      return { score: parseInt(data.data.score, 10) || 0, raw: data.data };
    }
    return null;
  } catch { return null; }
}

// ====== 蛋壳业务接口 ======
async function getShellAmount(uc_access_token, bearer_token) {
  const url = `${URLS}/api/web/mobile/swan/getSwanByToken`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.get(url, { headers, timeout: 15000 });
    const data = resp.data;
    if (SUCCESS_CODES.includes(data.code)) {
      return data.content?.shellAmount || 0;
    }
    return -1;
  } catch {
    return -1;
  }
}

async function exchangeShell(uc_access_token, bearer_token, count) {
  const url = `${URLS}/api/web/mobile/swan/resource/shell:exchange`;
  const headers = hs(uc_access_token, bearer_token);
  try {
    const resp = await axios.post(url, { value: count }, { headers, timeout: 15000 });
    const data = resp.data;
    if (SUCCESS_CODES.includes(data.code) && data.content === true) {
      return { success: true, data };
    }
    return { success: false, data, error: data.engDesc || data.chnDesc || `code=${data.code}` };
  } catch (e) {
    return { success: false, data: null, error: e?.message || '请求异常' };
  }
}

// ====== 账号处理 ======
async function processAccount(account) {
  const openid = account.openid || '';
  const ref = openid;   // YYB /wxapp/getCode 的 ref 必须是 openid（字符串），不能用账号 id
  const nickname = account.nickname || account.alias || '未知';
  const displayName = nickname || openid.slice(0, 16);

  console.log(`\n  📱 账号: ${displayName}`);

  accountStats[displayName] = { shellBefore: 0, shellExchanged: 0, pointBefore: -1, pointAfter: -1, pointActual: 0 };

  const cache = readCache(ref);
  let unionId = cache?.unionId || '';
  let uc_access_token = null, bearer_token = null;
  let cacheValid = false;

  // 优先使用缓存（缓存存在即尝试，失效才重新获取）
  if (cache && cache.ucAccessToken) {
    uc_access_token = cache.ucAccessToken;

    if (cache.bearerToken) {
      bearer_token = cache.bearerToken;
      const t = await getShellAmount(uc_access_token, bearer_token);
      if (t >= 0) {
        console.log(`  ✅ 缓存 bearer 有效，蛋壳余额: ${t}`);
        cacheValid = true;
      } else {
        console.log(`  ⚠️ 缓存 bearer 无效，尝试换新...`);
        bearer_token = null;
      }
    }
  }

  // 缓存有 uc 但无 bearer → 换取新 bearer
  if (uc_access_token && !bearer_token) {
    bearer_token = await getBearerToken(uc_access_token);
    if (bearer_token) {
      console.log(`  ✅ 新 bearer_token 获取成功`);
      writeCache(ref, { nickname: displayName, openid: openid, ucAccessToken: uc_access_token, bearerToken: bearer_token });
      console.log(`  💾 缓存已刷新`);
      cacheValid = true;
    } else {
      console.log(`  ⚠️ ucAccessToken 换取 bearer 失败，走重新登录`);
      deleteCache(ref);
      uc_access_token = null;
    }
  }

  // 缓存完全失效 → 重新登录
  if (!cacheValid) {
    console.log(`  [1/3] 获取 wx.login code...`);
    const code = await yybGetCode(ref);
    if (!code) {
      results[displayName] = { success: false, detail: '获取code失败' };
      failedCount++; return;
    }
    console.log(`  [2/3] 尝试换取 ucAccessToken...`);
    const loginResult = await exchangeCodeForUcToken(code);
    if (!loginResult) {
      results[displayName] = { success: false, detail: '获取ucAccessToken失败' };
      failedCount++; return;
    }
    uc_access_token = loginResult.ucAccessToken;
    unionId = loginResult.unionId;
    const miniOpenId = loginResult.miniOpenId;
    console.log(`  [3/3] 获取 bearer_token...`);
    bearer_token = await getBearerToken(uc_access_token);
    if (!bearer_token) {
      results[displayName] = { success: false, detail: '获取bearer_token失败' };
      failedCount++; return;
    }
    writeCache(ref, { nickname: displayName, openid: openid, ucAccessToken: uc_access_token, bearerToken: bearer_token, unionId, miniOpenId });
    console.log(`  💾 缓存已保存`);
  }

  // ====== 执行蛋壳兑换 ======
  console.log(`  ⏳ 查询蛋壳余额...`);
  const shellBefore = await getShellAmount(uc_access_token, bearer_token);
  if (shellBefore < 0) {
    console.log(`  ❌ 查询蛋壳余额失败`);
    results[displayName] = { success: false, detail: '查询余额失败' };
    failedCount++; return;
  }

  accountStats[displayName].shellBefore = shellBefore;
  console.log(`  🥚 当前蛋壳: ${shellBefore}`);

  // ====== 查询兑换前积分 ======
  if (!unionId) {
    console.log(`  ⚠️ 缓存无 unionId，尝试重新登录获取...`);
    const code = await yybGetCode(ref);
    if (code) {
      const lr = await exchangeCodeForUcToken(code);
      if (lr?.unionId) unionId = lr.unionId;
    }
  }
  if (unionId) {
    const pointRes = await getMemberIntegral(uc_access_token, unionId);
    if (pointRes) {
      accountStats[displayName].pointBefore = pointRes.score;
      console.log(`  💎 当前积分: ${pointRes.score}`);
    } else {
      console.log(`  ⚠️ 积分查询失败(unionId=${unionId})`);
    }
  } else {
    console.log(`  ⚠️ 无 unionId，跳过积分查询`);
  }

  // 判断兑换数量
  let exchangeCount = 0;
  if (SHELL_EXCHANGE_COUNT === 0) {
    console.log(`  ℹ️ SHELL_EXCHANGE_COUNT=0，不兑换`);
    results[displayName] = { success: true, detail: '配置为不兑换' };
    skippedCount++;
    return;
  } else if (SHELL_EXCHANGE_COUNT > 0) {
    exchangeCount = Math.min(SHELL_EXCHANGE_COUNT, Math.floor(shellBefore));
    if (exchangeCount < SHELL_EXCHANGE_COUNT) {
      console.log(`  ⚠️ 自定义数量(${SHELL_EXCHANGE_COUNT})超过余额，按余额兑换: ${exchangeCount}`);
    }
  } else {
    // 默认 -1：全部兑换
    exchangeCount = Math.floor(shellBefore);
  }

  if (exchangeCount <= 0) {
    console.log(`  ℹ️ 蛋壳余额为 0，无需兑换`);
    results[displayName] = { success: true, detail: '蛋壳为0' };
    skippedCount++;
    return;
  }

  console.log(`  🔄 开始兑换 ${exchangeCount} 蛋壳 (预计 +${exchangeCount * 2} 积分)...`);
  const exchangeResult = await exchangeShell(uc_access_token, bearer_token, exchangeCount);

  if (!exchangeResult.success) {
    console.log(`  ❌ 兑换失败: ${exchangeResult.error}`);
    results[displayName] = { success: false, detail: `兑换失败: ${exchangeResult.error}` };
    failedCount++;
    return;
  }

  console.log(`  ✅ 兑换请求成功，校验余额...`);
  await sleep(1500);

  const shellAfter = await getShellAmount(uc_access_token, bearer_token);
  let shellAfterDisplay = shellAfter;
  if (shellAfter < 0) {
    console.log(`  ⚠️ 兑换后余额查询失败，但接口返回成功，视为兑换成功`);
    accountStats[displayName].shellExchanged = exchangeCount;
    shellAfterDisplay = shellBefore - exchangeCount;
  } else {
    const actualReduced = shellBefore - shellAfter;
    const diffOk = actualReduced >= exchangeCount - 1 && actualReduced <= exchangeCount + 1;
    if (diffOk) {
      console.log(`  ✅ 余额校验通过: ${shellBefore} → ${shellAfter} (减少 ${actualReduced})`);
      accountStats[displayName].shellExchanged = actualReduced;
    } else {
      console.log(`  ⚠️ 余额变化异常: ${shellBefore} → ${shellAfter} (期望减少 ${exchangeCount})`);
      accountStats[displayName].shellExchanged = exchangeCount;
    }
  }

  // ====== 查询兑换后积分 ======
  let pointBefore = accountStats[displayName].pointBefore;
  let pointAfter = -1;
  if (unionId) {
    await sleep(1000);
    const pointRes2 = await getMemberIntegral(uc_access_token, unionId);
    if (pointRes2) {
      pointAfter = pointRes2.score;
      accountStats[displayName].pointAfter = pointAfter;
      if (pointBefore >= 0) {
        accountStats[displayName].pointActual = pointAfter - pointBefore;
        console.log(`  💎 积分变化: ${pointBefore} → ${pointAfter} (+${pointAfter - pointBefore})`);
      } else {
        console.log(`  💎 兑换后积分: ${pointAfter}`);
      }
    } else {
      console.log(`  ⚠️ 兑换后积分查询失败`);
    }
  }

  // ====== 汇总展示 ======
  const actualShell = accountStats[displayName].shellExchanged;
  const finalShell = shellAfterDisplay;
  if (pointBefore >= 0 && pointAfter >= 0) {
    const delta = pointAfter - pointBefore;
    console.log(`  ✅ 兑换完成: 蛋壳${shellBefore}-${actualShell}=${finalShell}，兑换${actualShell}蛋壳 → +${delta}积分，积分${pointBefore}+${delta}=${pointAfter}`);
  } else {
    console.log(`  ✅ 兑换完成: 蛋壳${shellBefore}-${actualShell}=${finalShell}，兑换${actualShell}蛋壳`);
  }

  results[displayName] = { success: true, detail: '' };
  successCount++;
}

// ====== 主流程 ======
async function main() {
  console.log('='.repeat(56));
  console.log(`  ${APP_NAME} (YYB版) ${SCRIPT_VERSION}`);
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
  if (SHELL_EXCHANGE_COUNT === -1) {
    console.log(`  兑换策略: 全部兑换`);
  } else if (SHELL_EXCHANGE_COUNT === 0) {
    console.log(`  兑换策略: 不兑换(仅查询)`);
  } else {
    console.log(`  兑换策略: 自定义 ${SHELL_EXCHANGE_COUNT} 蛋壳`);
  }
  console.log('='.repeat(56));

  if (!YYB_BASE) {
    console.log('\n❌ 未设置 YYB_BASE_URL 环境变量\n');
    process.exit(1);
  }

  console.log('\n[1/2] 获取 YYB 账号列表...');
  const accounts = await yybGetAccounts();
  if (!accounts.length) {
    console.log('❌ 没有可用的微信账号');
    return;
  }

  let filtered = accounts;
  if (YYB_XTE) {
    const refs = YYB_XTE.split(',').map(s => s.trim()).filter(Boolean);
    filtered = accounts.filter(a => refs.some(r => String(a.id) === r || a.openid === r));
    if (!filtered.length) {
      console.log(`❌ 未找到 ref=${YYB_XTE} 的账号`);
      return;
    }
    console.log(`✅ 指定账号, 共 ${filtered.length} 个\n`);
  } else {
    console.log(`✅ 共 ${filtered.length} 个账号\n`);
  }

  const originalOrder = filtered.map(a => a.nickname || a.alias || a.openid || '未知');
  const shuffled = [...filtered];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  console.log(`🔀 执行顺序已随机打乱\n`);

  for (let i = 0; i < shuffled.length; i++) {
    console.log(`[${i + 1}/${shuffled.length}] ${'='.repeat(40)}`);
    try {
      await processAccount(shuffled[i]);
    } catch (e) {
      console.log(`  ❌ 账号处理异常(已跳过): ${e?.message || e}`);
      const name = shuffled[i]?.nickname || shuffled[i]?.alias || String(shuffled[i]?.openid || (i + 1)).slice(0, 16);
      results[name] = { success: false, detail: (e?.message || String(e)).slice(0, 50) };
      failedCount++;
    }
    if (i < shuffled.length - 1) await randomSleep(8, 15);
  }

  // 汇总
  console.log('\n' + '='.repeat(56));
  console.log('  🎊 执行完成');
  console.log('='.repeat(56));

  const successList = [];
  const failList = [];
  const failDetail = [];
  let totalShellExchanged = 0, totalPointActual = 0;

  for (const name of originalOrder) {
    if (results[name]) {
      if (results[name].success) {
        successList.push(name);
        const stat = accountStats[name] || {};
        totalShellExchanged += stat.shellExchanged || 0;
        totalPointActual += stat.pointActual || 0;
      } else {
        failList.push(name);
        failDetail.push(`${name}: ${results[name].detail}`);
      }
    }
  }

  console.log(`  ✅ 成功: ${successList.length} 个`);
  console.log(`  ❌ 失败: ${failList.length} 个`);
  console.log(`  ⏭️ 跳过: ${skippedCount} 个`);
  console.log(`  🥚 兑换蛋壳: ${totalShellExchanged}`);
  console.log(`  💎 实际积分: +${totalPointActual}`);
  console.log('='.repeat(56));

  let notifyContent = `${APP_NAME} ${SCRIPT_VERSION} 执行完成\n`;
  notifyContent += `执行时间: ${new Date().toLocaleString('zh-CN')}\n`;
  notifyContent += `${'='.repeat(30)}\n`;
  notifyContent += `📊 账号总数: ${filtered.length}\n`;
  notifyContent += `✅ 成功: ${successList.length}\n`;
  notifyContent += `❌ 失败: ${failList.length}\n`;
  notifyContent += `⏭️ 跳过: ${skippedCount}\n`;
  notifyContent += `🥚 兑换蛋壳: ${totalShellExchanged}\n`;
  notifyContent += `💎 实际积分: +${totalPointActual}\n`;

  if (successList.length > 0) {
    notifyContent += `\n✅ 成功账号明细:\n`;
    for (const name of successList) {
      const stat = accountStats[name] || {};
      if (stat.shellExchanged > 0) {
        const b = stat.pointBefore || 0;
        const a = stat.pointAfter || 0;
        const d = stat.pointActual || 0;
        if (b >= 0 && a >= 0) {
          const finalShell = stat.shellBefore - stat.shellExchanged;
          notifyContent += `  ✅ ${name}: 蛋壳${stat.shellBefore}-${stat.shellExchanged}=${finalShell}，兑换${stat.shellExchanged}蛋壳 → +${d}积分，积分${b}+${d}=${a}\n`;
        } else {
          notifyContent += `  ✅ ${name}: 兑换${stat.shellExchanged}蛋壳\n`;
        }
      } else {
        notifyContent += `  ✅ ${name}: ${results[name].detail || '无需兑换'}\n`;
      }
    }
  }

  if (failDetail.length > 0) {
    notifyContent += `\n❌ 失败详情:\n  ${failDetail.join('\n  ')}\n`;
  }

  qlNotify(APP_NAME, notifyContent);
}

main().catch((e) => {
  console.error(e);
  qlNotify(`${APP_NAME} 异常`, `脚本执行异常: ${e.message}`);
});
