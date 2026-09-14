#!/usr/bin/env node
// name: Babycare官方旗舰店
// cron: 41 8 * * *
/**
 * Babycare官方旗舰店 - 微信小程序每日签到（YYB-Go-Enhanced 版）
 *
 * 环境变量：
 * - YYB_SERVER       必填；每行：YYB-Go-Enhanced地址@账号标识#备注
 *                    示例：http://yyb-go:8000@wxid_xxx#账号1
 * - BABYCARE_NOTIFY  可选；默认1，设为0关闭青龙通知
 * - BABYCARE_CACHE   可选；token缓存文件路径
 *
 * 多账号请在 YYB_SERVER 中逐行填写。脚本直接调用 /wxapp/getCode，
 * 不依赖 getCode.js、yyb.js、WX_ID 或 babycare 等额外账号变量。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const fetchFn = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));

const APP_ID = 'wxab5642d7bced2dcc';
const API_BASE = 'https://api.bckid.com.cn';
const LOGIN_API = '/common/front/login/wxMina';
const SIGN_INFO_API = '/operation/front/bonus/userSign/v3/getSignInfo';
const SIGN_API = '/operation/front/bonus/userSign/v3/sign';
const NOTIFY_ENABLED = (process.env.BABYCARE_NOTIFY || '1') !== '0';
const CACHE_FILE = process.env.BABYCARE_CACHE || (
  process.platform === 'linux' && fs.existsSync('/ql/data/config')
    ? '/ql/data/config/babycare_token_cache.json'
    : path.join(os.tmpdir(), 'babycare_token_cache.json')
);

const UA =
  'Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/134.0.6998.136 ' +
  'Mobile Safari/537.36 MicroMessenger/8.0.48.2580(0x28003036) MiniProgramEnv/android';

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
      throw new Error(`YYB_SERVER第${index + 1}行格式错误，应为 地址@账号标识#备注`);
    }
    const server = normalizeServer(value.slice(0, at));
    const accountPart = value.slice(at + 1).trim();
    const hash = accountPart.indexOf('#');
    const ref = (hash >= 0 ? accountPart.slice(0, hash) : accountPart).trim();
    const note = (hash >= 0 ? accountPart.slice(hash + 1) : '').trim();
    if (!server || !ref) throw new Error(`YYB_SERVER第${index + 1}行地址或账号标识为空`);
    accounts.push({ server, ref, note });
  });
  return accounts;
}

function brief(value, max = 160) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function messageOf(data) {
  return data?.message || data?.msg || data?.errorMessage || brief(data);
}

function isOk(data) {
  return String(data?.code) === '200';
}

function isAlreadySigned(message) {
  return /已签|已经签|签到过|重复|已完成|already/i.test(String(message || ''));
}

function isAuthError(data) {
  const text = `${data?.code || ''} ${messageOf(data)}`;
  return /401|403|登录|token|未授权|未登录|失效|过期|重新/i.test(text);
}

function isNotRegistered(message) {
  return /未注册|未绑定|请先注册|请先绑定|not regist/i.test(String(message || ''));
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.log(`⚠️ token缓存写入失败（不影响本次签到）：${error.message || error}`);
  }
}

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`${url} HTTP ${response.status}: ${brief(text)}`); }
    return { status: response.status, data };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${url} 请求超时`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getWxCode(server, ref) {
  const response = await postJson(`${server}/wxapp/getCode`, {
    ref,
    app_id: APP_ID,
  });
  const data = response.data || {};
  const code = data?.data?.result?.code || '';
  if (response.status >= 200 && response.status < 300 && Number(data.code) === 0 && code) return code;
  throw new Error(`YYB-Go-Enhanced取code失败: ${messageOf(data) || `HTTP ${response.status}`}`);
}

class BabycareAccount {
  constructor(account, index) {
    this.account = account;
    this.index = index;
    this.token = '';
    this.loginStatus = null;
    this.deviceId = `d_${crypto.createHash('md5').update(account.ref).digest('hex').slice(0, 16)}`;
  }

  label() {
    return `账号${this.index}${this.account.note ? `（${this.account.note}）` : ''}`;
  }

  async request(apiPath, body = {}, authenticated = true) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Referer: `https://servicewechat.com/${APP_ID}/0/page-frame.html`,
      xweb_xhr: '1',
      'user-agent-bckid': `bckid; miniProgram; 1.0.0; ${this.deviceId}; ; ;1002;`,
    };
    if (authenticated && this.token) headers.Authorization = this.token;
    const response = await postJson(`${API_BASE}${apiPath}`, body, headers);
    if (response.data && typeof response.data === 'object') return response.data;
    throw new Error(`${apiPath} HTTP ${response.status}: ${brief(response.data)}`);
  }

  async login() {
    const code = await getWxCode(this.account.server, this.account.ref);
    console.log('✅ YYB-Go-Enhanced获取wx.login code成功');
    const data = await this.request(LOGIN_API, { code, wxAppId: APP_ID }, false);
    if (!isOk(data)) throw new Error(`登录失败: ${messageOf(data)}`);
    const loginBody = data?.body || {};
    this.loginStatus = loginBody.loginStatus;
    this.token = String(loginBody.token || '');
    if (!this.token) throw new Error(`登录成功响应未返回token: ${brief(data)}`);
    // 真机确认：loginStatus=2 表示微信账号正常，但尚未注册 Babycare 会员。
    if (this.loginStatus === false || this.loginStatus === 0 || this.loginStatus === '0' ||
        this.loginStatus === 2 || this.loginStatus === '2') {
      const cache = readCache();
      delete cache[this.account.ref];
      writeCache(cache);
      const error = new Error('Babycare会员未注册或未激活，请先在小程序完成会员注册');
      error.accountSkipped = true;
      throw error;
    }
    const cache = readCache();
    cache[this.account.ref] = { token: this.token, updatedAt: new Date().toISOString() };
    writeCache(cache);
    console.log(`✅ Babycare登录成功${this.loginStatus !== undefined && this.loginStatus !== null ? `（loginStatus=${brief(this.loginStatus, 24)}）` : ''}`);
  }

  async getSignInfo(log = true) {
    const data = await this.request(SIGN_INFO_API);
    if (!isOk(data)) return { ok: false, data, authError: isAuthError(data) };
    const info = data.body || data.data || {};
    const signed = Number(info.todaySignd) === 1;
    if (log) {
      console.log(`ℹ️ 当前状态：今日${signed ? '已签到' : '未签到'}，本轮连签 ${Number(info.signDaysCountMod || 0)}/${Number(info.maxSignDay || 7)} 天`);
    }
    return { ok: true, signed, info, data };
  }

  async ensureLogin() {
    const cached = readCache()[this.account.ref] || {};
    if (cached.token) {
      this.token = cached.token;
      const state = await this.getSignInfo(false).catch(() => ({ ok: false }));
      if (state.ok) {
        console.log('✅ 缓存token有效');
        return state;
      }
      console.log('⚠️ 缓存token失效，重新登录');
      this.token = '';
    }
    await this.login();
    return this.getSignInfo(false);
  }

  async sign(retry = true) {
    const data = await this.request(SIGN_API);
    const message = messageOf(data);
    if (!isOk(data) && !isAlreadySigned(message)) {
      if (isNotRegistered(message)) return { status: 'skipped', detail: `${message}，请先在小程序注册会员` };
      if (retry && isAuthError(data)) {
        console.log('⚠️ 会话失效，重新登录后重试');
        this.token = '';
        await this.login();
        return this.sign(false);
      }
      return { status: 'failed', detail: `签到接口失败：${message}` };
    }

    const after = await this.getSignInfo(false);
    if (after.ok && after.signed) {
      const days = Number(after.info.signDaysCountMod || 0);
      return { status: isAlreadySigned(message) ? 'already' : 'success', detail: `今日已签到，本轮连签 ${days} 天` };
    }
    return { status: 'failed', detail: `签到请求返回${isOk(data) ? '成功' : '已签到'}，但签到后状态未确认` };
  }

  async run() {
    console.log(`\n━━━ ${this.label()} ━━━`);
    try {
      const before = await this.ensureLogin();
      if (!before.ok) {
        const message = messageOf(before.data);
        if (isNotRegistered(message)) return { status: 'skipped', detail: `${message}，请先在小程序注册会员` };
        console.log(`⚠️ 读取签到状态失败：${message}；继续调用签到接口核验`);
        return this.sign();
      }
      console.log(`ℹ️ 当前状态：今日${before.signed ? '已签到' : '未签到'}，本轮连签 ${Number(before.info.signDaysCountMod || 0)}/${Number(before.info.maxSignDay || 7)} 天`);
      if (before.signed) return { status: 'already', detail: `今日已签到，本轮连签 ${Number(before.info.signDaysCountMod || 0)} 天` };
      return this.sign();
    } catch (error) {
      if (error?.accountSkipped) return { status: 'skipped', detail: error.message };
      return { status: 'failed', detail: error.message || String(error) };
    }
  }
}

function sendQingLongNotify(title, content) {
  if (!NOTIFY_ENABLED) return console.log('ℹ️ BABYCARE_NOTIFY=0，已关闭青龙通知');
  const py = String.raw`
import importlib.util, os, sys
paths = ['/ql/data/scripts/notify.py', '/ql/scripts/notify.py', os.path.join(os.getcwd(), 'notify.py')]
for candidate in paths:
    if not os.path.isfile(candidate):
        continue
    spec = importlib.util.spec_from_file_location('ql_notify', candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sender = getattr(module, 'send', None) or getattr(module, 'sendNotify', None)
    if callable(sender):
        sender(os.environ['BC_NOTIFY_TITLE'], os.environ['BC_NOTIFY_CONTENT'])
        print('notify.py调用完成')
        sys.exit(0)
print('未找到可用的青龙notify.py', file=sys.stderr)
sys.exit(2)
`;
  try {
    const result = spawnSync(process.env.PYTHON_BIN || 'python3', ['-c', py], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, BC_NOTIFY_TITLE: title, BC_NOTIFY_CONTENT: content },
    });
    if (result.status === 0) console.log('✅ 青龙通知模块调用完成');
    else console.log(`⚠️ 青龙通知失败（不影响签到结果）：${brief(result.stderr || result.stdout || `exit ${result.status}`)}`);
  } catch (error) {
    console.log(`⚠️ 青龙通知异常（不影响签到结果）：${error.message || error}`);
  }
}

(async () => {
  const raw = process.env.YYB_SERVER || '';
  if (!raw.trim()) throw new Error('未设置YYB_SERVER；格式：地址@账号标识#备注，多账号每行一条');
  const accounts = parseAccounts(raw);
  if (!accounts.length) throw new Error('YYB_SERVER中没有有效账号');

  console.log(`🚀 Babycare官方旗舰店签到开始｜共 ${accounts.length} 个账号`);
  const results = [];
  const counts = { success: 0, already: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < accounts.length; i++) {
    const task = new BabycareAccount(accounts[i], i + 1);
    const result = await task.run();
    counts[result.status]++;
    const icon = { success: '✅', already: '✅', skipped: '⚠️', failed: '❌' }[result.status];
    console.log(`${icon} ${result.detail}`);
    results.push(`【${task.label()}】\n${icon} ${result.detail}`);
    if (i < accounts.length - 1) await new Promise(resolve => setTimeout(resolve, 1500 + Math.floor(Math.random() * 1500)));
  }

  const summary = `成功 ${counts.success}｜已签 ${counts.already}｜跳过 ${counts.skipped}｜失败 ${counts.failed}`;
  console.log(`\n📊 ${summary}`);
  sendQingLongNotify('Babycare官方旗舰店', [`📊 ${summary}`, '', ...results].join('\n'));
  if (counts.failed > 0) process.exitCode = 1;
})().catch(error => {
  console.error(`❌ 脚本异常：${error.message || error}`);
  sendQingLongNotify('Babycare官方旗舰店', `❌ 脚本异常：${error.message || error}`);
  process.exitCode = 1;
});
