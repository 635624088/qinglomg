#!/usr/bin/env node
// name: 交个朋友签到
// cron: 39 8 * * *
/**
 * 交个朋友会员中心（iyouke 平台）每日签到
 *
 * 环境变量：
 * - YYB_SERVER   必填；YYB-Go-Enhanced地址@账号标识，多账号每行一条
 * - JGPY_NOTIFY  可选；默认1，设为0关闭青龙通知
 *
 * 业务接口：smp-api.iyouke.com/dtapi
 * 仅执行登录、签到开关查询、签到状态查询与每日签到；不补签、不兑换积分。
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_NAME = '交个朋友签到';
const APP_ID = 'wx3b294e7a0ba29bc3';
const APP_VERSION = '2.19.1';
const PAGE_VERSION = '91';
const API_BASE = 'https://smp-api.iyouke.com/dtapi';
const NOTIFY_ENABLED = (process.env.JGPY_NOTIFY || '1') !== '0';
const fetchFn = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const results = [];

function normalizeServer(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return (/^https?:\/\//i.test(value) ? value : `http://${value}`).replace(/\/+$/, '');
}

function parseAccounts(raw) {
  const accounts = [];
  String(raw || '').split(/\r?\n/).forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    const at = value.lastIndexOf('@');
    if (at <= 0 || at === value.length - 1) {
      throw new Error(`YYB_SERVER第${index + 1}行格式错误，应为 地址@账号标识`);
    }
    const server = normalizeServer(value.slice(0, at));
    const refPart = value.slice(at + 1).trim();
    const hash = refPart.indexOf('#');
    const ref = (hash >= 0 ? refPart.slice(0, hash) : refPart).trim();
    const note = (hash >= 0 ? refPart.slice(hash + 1) : '').trim();
    if (!server || !ref) throw new Error(`YYB_SERVER第${index + 1}行地址或账号标识为空`);
    accounts.push({ server, ref, note });
  });
  return accounts;
}

function compact(value, max = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function requestJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: compact(text) }; }
    return { status: response.status, ok: response.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

async function getWxCode(account) {
  const response = await requestJson(`${account.server}/wxapp/getCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: account.ref, app_id: APP_ID }),
  });
  const code = response.data?.data?.result?.code || response.data?.data?.code || response.data?.code;
  if (!response.ok || Number(response.data?.code) !== 0 || !code) {
    const message = response.data?.message || response.data?.msg || compact(response.data);
    throw new Error(`YYB-Go取code失败: ${message || `HTTP ${response.status}`}`);
  }
  return code;
}

function apiHeaders(token = '') {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MicroMessenger/7.0.20 MiniProgramEnv/Windows',
    Referer: `https://servicewechat.com/${APP_ID}/${PAGE_VERSION}/page-frame.html`,
    appId: APP_ID,
    version: APP_VERSION,
    envVersion: 'release',
    'xy-extra-data': `appid=${APP_ID};version=${APP_VERSION};envVersion=release;senceId=1005`,
    xweb_xhr: '1',
  };
  if (token) headers.Authorization = token;
  return headers;
}

function businessOk(data) {
  return data && data.success !== false && Number(data.error || 0) === 0;
}

function businessMessage(data) {
  return data?.errorMsg || data?.error_msg || data?.message || compact(data) || '未知错误';
}

async function api(pathname, token, query = '', method = 'GET', body = null) {
  const response = await requestJson(`${API_BASE}${pathname}${query ? `?${query}` : ''}`, {
    method,
    headers: apiHeaders(token),
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  return response;
}

async function login(account) {
  const code = await getWxCode(account);
  const response = await api('/appLogin', '', '', 'POST', { appType: 1, principal: code });
  const data = response.data || {};
  if (!response.ok || !businessOk(data) || !data.access_token) {
    throw new Error(`登录失败: ${businessMessage(data)}`);
  }
  return { token: `bearer${data.access_token}`, registered: Boolean(data.userId) };
}

async function points(token) {
  const response = await api('/pointsSign/user/pointsInfo/query', token);
  if (!response.ok || !businessOk(response.data)) {
    throw new Error(`读取签到状态失败: ${businessMessage(response.data)}`);
  }
  return response.data.data || {};
}

async function runAccount(account, index) {
  const label = account.note || `账号${index}`;
  console.log(`\n===== ${label} =====`);
  try {
    const session = await login(account);
    if (!session.registered) {
      const message = '未注册/未绑定交个朋友会员，跳过';
      console.log(`⚠️ ${message}`);
      results.push({ index, label, status: 'skip', message });
      return;
    }
    console.log('✅ 登录成功');

    const enabled = await api('/pointsSign/config/queryShopSignEnable', session.token);
    if (!enabled.ok || !businessOk(enabled.data)) {
      throw new Error(`读取签到开关失败: ${businessMessage(enabled.data)}`);
    }
    if (enabled.data.data === false) {
      const message = '店铺未开启每日签到，跳过';
      console.log(`⚠️ ${message}`);
      results.push({ index, label, status: 'skip', message });
      return;
    }

    const before = await points(session.token);
    if (before.signTodayResult) {
      const message = `今日已签到｜积分 ${before.pointsNums ?? '-'}｜连续 ${before.seriesDays ?? '-'} 天`;
      console.log(`✅ ${message}`);
      results.push({ index, label, status: 'success', message });
      return;
    }

    const calendar = await api('/pointsSign/user/sign/list', session.token, 'v4Flag=true');
    if (!calendar.ok || !businessOk(calendar.data)) {
      throw new Error(`读取签到日历失败: ${businessMessage(calendar.data)}`);
    }
    const today = (Array.isArray(calendar.data.data) ? calendar.data.data : []).find((item) => item?.isToday);
    if (!today?.dateStr) throw new Error('签到日历中未找到今天的日期');
    if (Number(today.daySignStatus) === 2) {
      const message = `今日已签到｜积分 ${before.pointsNums ?? '-'}｜连续 ${before.seriesDays ?? '-'} 天`;
      console.log(`✅ ${message}`);
      results.push({ index, label, status: 'success', message });
      return;
    }

    const date = String(today.dateStr).replace(/-/g, '%2F');
    const signed = await api('/pointsSign/user/sign', session.token, `date=${date}`);
    if (!signed.ok || !businessOk(signed.data)) {
      throw new Error(`签到失败: ${businessMessage(signed.data)}`);
    }
    const reward = Number(signed.data?.data?.signReward || 0) + Number(signed.data?.data?.extraSignReward || 0);
    const after = await points(session.token);
    if (!after.signTodayResult) throw new Error('签到接口返回成功，但复查仍显示今日未签到');
    const message = `签到成功｜本次 +${reward} 积分｜当前 ${after.pointsNums ?? '-'}｜连续 ${after.seriesDays ?? '-'} 天`;
    console.log(`✅ ${message}`);
    results.push({ index, label, status: 'success', message });
  } catch (error) {
    const message = compact(error?.message || error);
    console.log(`❌ ${message}`);
    results.push({ index, label, status: 'failed', message });
  }
}

function findNotifyPy() {
  return [
    '/ql/data/scripts/notify.py',
    '/ql/scripts/notify.py',
    path.join(__dirname, 'notify.py'),
  ].find((file) => require('fs').existsSync(file));
}

function notify() {
  if (!NOTIFY_ENABLED) return;
  const notifyPy = findNotifyPy();
  if (!notifyPy) return console.log('⚠️ 未找到青龙 notify.py，跳过通知');
  const success = results.filter((item) => item.status === 'success').length;
  const skip = results.filter((item) => item.status === 'skip').length;
  const failed = results.filter((item) => item.status === 'failed').length;
  const content = [
    `汇总：成功 ${success}｜跳过 ${skip}｜失败 ${failed}`,
    '',
    ...results.map((item) => `账号${item.index}${item.label ? `[${item.label}]` : ''}：${item.message}`),
  ].join('\n');
  const code = 'import importlib.util,sys; p=sys.argv[1]; s=importlib.util.spec_from_file_location("ql_notify",p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); f=getattr(m,"send",None) or getattr(m,"sendNotify",None); f(sys.argv[2],sys.argv[3])';
  const proc = spawnSync('python3', ['-c', code, notifyPy, SCRIPT_NAME, content], { encoding: 'utf8', timeout: 60000 });
  if (proc.error || proc.status !== 0) console.log(`⚠️ 通知发送失败，不影响签到结果: ${compact(proc.stderr || proc.error?.message)}`);
  else console.log('✅ 青龙通知模块调用完成');
}

!(async () => {
  const accounts = parseAccounts(process.env.YYB_SERVER);
  if (!accounts.length) throw new Error('未找到 YYB_SERVER，请按 地址@账号标识 每行一条配置');
  console.log(`${SCRIPT_NAME}｜共 ${accounts.length} 个账号`);
  for (let i = 0; i < accounts.length; i += 1) {
    await runAccount(accounts[i], i + 1);
    if (i < accounts.length - 1) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
})()
  .catch((error) => {
    console.log(`❌ 脚本初始化失败: ${compact(error?.message || error)}`);
    results.push({ index: 0, label: '初始化', status: 'failed', message: compact(error?.message || error) });
  })
  .finally(() => {
    notify();
    const failed = results.filter((item) => item.status === 'failed').length;
    const success = results.filter((item) => item.status === 'success').length;
    const skip = results.filter((item) => item.status === 'skip').length;
    console.log(`\n汇总：成功 ${success}｜跳过 ${skip}｜失败 ${failed}`);
    if (failed) process.exitCode = 1;
  });
