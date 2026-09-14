#!/usr/bin/env node
/**
 * 南航签到_YYB.js —— 南方航空小程序「天天签到」自动签到
 * ---------------------------------------------------------------
 * 呆呆面板适配版 2026-09-08，按 StormSniffer 抓包契约编写并实测打通。
 * 本机适配版 2026-09-08：去除 _yyb_common 依赖，改为零依赖（Node 内置 https），
 * 通知走面板同目录 sendNotify.js；账号默认遍历 YYB 网关全部存活账号。
 * 存放目录：/ql/data/scripts/gh_deploy/yyb_collection/yyb/
 *
 * 鉴权链路（实测，区别于 H5 的公众号网页授权，走 yyb 账号池）：
 *   1) yyb /wxapp/getCode 用南航公众号 appid（wxe1f910106e3dfff4）取 oauth code
 *   2) GET /wechat-mico/sso/oauth/login/redirect?channel=csair&ssoJsonParam=...&code=...&state=base
 *      -> 302，Set-Cookie 下发 wx_openId / cs1246643sso / TOKEN / unionId 等整套会员会话
 *   3) 携带该 Cookie 调 marketing-tools 接口完成签到
 *
 * 签到契约（HAR 实证）：
 *   GET  /marketing-tools/sign/getSignCalendarNew?startQueryDate=YYYYMM01&endQueryDate=YYYYMM末
 *       -> data.dateList 为已签到日期数组（'YYYY-MM-DD'）
 *   POST /marketing-tools/activity/join  body {"activityType":"sign","channel":"mini","entrance":1}
 *       -> respCode 0000 + data.result='签到成功'；respCode 0150='签到中，请稍等。'（今日已签）
 *   活动时间窗：signTimeRange 08:00:00-23:59:59（任务定时须在 08:00 之后）
 *
 * 环境变量约定：
 *   CSAIR_REF  本脚本专属账号过滤（仅精确匹配 yyb 账号 id / uin / openid，逗号分隔），
 *              优先于全局 YYB_REF；不配置则跑全部存活账号
 *   YYB_BASE_URL  YYB 网关地址（面板已配置，如 http://172.17.0.1:18080）
 *   YYB_REF    全局账号过滤（可选）
 *
 * 用法：
 *   node 南航签到_YYB.js            签到（默认）
 *   node 南航签到_YYB.js --check    只查签到状态，不签到
 *   node 南航签到_YYB.js --accounts 仅列出 YYB 存活账号
 * ---------------------------------------------------------------
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const MP_APPID = 'wx729238547ac7a14c';      // 南方航空小程序（UA 用）
const GZH_APPID = 'wxe1f910106e3dfff4';     // 南航公众号（SSO oauth code 用，抓包实证）
const BASE_URL = 'https://wxapi.csair.com';
const H5_REFERER = 'https://wxapi.csair.com/h5/sign/';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.76(0x18004c37) NetType/WIFI Language/zh_CN miniProgram/' + MP_APPID;

const YYB_BASE = (process.env.YYB_BASE_URL || 'http://172.17.0.1:18080').replace(/\/+$/, '');
const CSAIR_REF = (process.env.CSAIR_REF || '').trim();

const CHECK_ONLY = process.argv.includes('--check');
const LIST_ONLY = process.argv.includes('--accounts');

// ================= 基础工具（零依赖实现） =================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timeFmt(fmt) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const m = {
    yyyy: d.getFullYear(),
    MM: p(d.getMonth() + 1),
    dd: p(d.getDate()),
    HH: p(d.getHours()),
    mm: p(d.getMinutes()),
    ss: p(d.getSeconds()),
  };
  return String(fmt).replace(/yyyy|MM|dd|HH|mm|ss/g, (k) => m[k]);
}

/** 当月起止日期，如 20260901 / 20260930（getSignCalendarNew 的查询范围） */
function monthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const p = (n) => String(n).padStart(2, '0');
  return {
    start: `${y}${p(m + 1)}01`,
    end: `${y}${p(m + 1)}${p(new Date(y, m + 1, 0).getDate())}`,
  };
}

/**
 * 底层 HTTP 请求：不跟随 302（SSO 依赖 Set-Cookie 原始响应）
 * 返回 { status, headers, text }
 */
function httpReq(method, urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const opts = {
      method: method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: headers || {},
      timeout: timeoutMs || 30000,
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** JSON 接口请求：返回 { status, headers, data(JSON或null), text } */
async function reqJson(method, urlStr, headers, body, timeoutMs) {
  const r = await httpReq(method, urlStr, headers, body, timeoutMs);
  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch (e) {
    data = null;
  }
  return Object.assign(r, { data });
}

// ================= YYB 网关封装 =================

function accName(a) {
  return (a.alias && String(a.alias).trim()) || (a.nickname && String(a.nickname).trim()) || ('账号' + a.id);
}

async function yybGetAccounts() {
  const r = await reqJson('GET', `${YYB_BASE}/accounts`, {}, null, 10000);
  const d = r.data;
  if (d && d.code === 0 && Array.isArray(d.data)) {
    return d.data.filter((a) => !a.status || a.status === 'alive');
  }
  console.log(`[yyb] 获取账号列表失败: ${r.text.slice(0, 150)}`);
  return [];
}

async function yybGetCode(ref, appId) {
  const body = JSON.stringify({ ref: ref, app_id: appId });
  const r = await reqJson(
    'POST',
    `${YYB_BASE}/wxapp/getCode`,
    { 'Content-Type': 'application/json' },
    body,
    30000
  );
  const d = r.data;
  if (d && d.code === 0) {
    const result = (d.data && d.data.result) || {};
    if (result.code) return result.code;
    console.log(`[yyb] getCode 返回中没有 code: ${JSON.stringify(result).slice(0, 150)}`);
    return null;
  }
  console.log(`[yyb] getCode 失败: ${d ? d.msg || JSON.stringify(d).slice(0, 150) : r.text.slice(0, 150)}`);
  return null;
}

/** 通知：优先面板同目录 sendNotify.js，失败不影响任务结果 */
async function notify(title, content) {
  let send = null;
  try {
    const m = require('./sendNotify');
    if (m && typeof m.sendNotify === 'function') send = m.sendNotify;
  } catch (e) {
    /* 找不到通知模块就只打日志 */
  }
  if (send) {
    await send(title, content);
  } else {
    console.log('[notify] 未找到 sendNotify 模块，仅控制台输出');
  }
}

// ================= 账号过滤 =================

/**
 * 精确账号过滤：REF 里的每个关键词只与 id/uin/openid 完全相等时才命中
 * （不做子串匹配，避免数字 id 误伤）
 */
function filterByExactRef(accounts, ref) {
  if (!ref) return accounts;
  const keys = ref.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return accounts;
  const matched = accounts.filter((a) => {
    const id = String(a.id || '').toLowerCase();
    const uin = String(a.uin || '');
    const openid = String(a.openid || '').toLowerCase();
    return keys.some((k) => id === k || uin === k || openid === k);
  });
  console.log(`[accounts] 精确过滤：${accounts.length} -> ${matched.length}（关键词: ${ref}）`);
  return matched;
}

// ================= 签到任务 =================

class CsairTask {
  constructor(account, index) {
    this.account = account;
    this.ref = String(account.id);
    this.name = accName(account);
    this.index = index;
    this.cookie = null;
    this.ok = false;
    this.msg = '';
  }

  log(msg) {
    console.log(`账号[${this.index}] ${this.name}: ${msg}`);
  }

  /** oauth code -> SSO 302 -> 全量 Cookie（code 失效自动换新重试一次） */
  async ssoLogin() {
    const ssoJsonParam = encodeURIComponent(
      JSON.stringify({
        redirectUrl: 'https://wxapi.csair.com/h5/sign/#/signTools?status=true&utm_channel=miniHome',
      })
    );
    for (let attempt = 1; attempt <= 2; attempt++) {
      const code = await yybGetCode(this.ref, GZH_APPID);
      if (!code) {
        this.log('取公众号 oauth code 失败❌');
        return false;
      }
      const r = await httpReq(
        'GET',
        `${BASE_URL}/wechat-mico/sso/oauth/login/redirect?channel=csair&ssoJsonParam=${ssoJsonParam}&code=${encodeURIComponent(code)}&state=base`,
        {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: H5_REFERER,
        },
        null,
        30000
      );
      if (r.status === 302 || r.status === 200) {
        const setCookies = (r.headers && r.headers['set-cookie']) || [];
        const list = Array.isArray(setCookies) ? setCookies : [setCookies];
        const jar = [];
        for (const c of list) {
          const kv = String(c).split(';')[0].trim();
          if (kv && kv.includes('=')) jar.push(kv);
        }
        if (jar.length) {
          this.cookie = jar.join('; ');
          const names = jar.map((x) => x.split('=')[0]).join(',');
          this.log(`SSO 登录成功，会话 Cookie：${names}`);
          return true;
        }
      }
      this.log(`SSO 登录失败(HTTP ${r.status})${attempt < 2 ? '，换 code 重试' : '：' + r.text.slice(0, 120)}`);
      if (attempt < 2) await sleep(2000);
    }
    this.msg = 'SSO失败(疑似未授权南航，需微信手动登录一次)';
    return false;
  }

  h5Headers(extra) {
    return Object.assign(
      {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: H5_REFERER,
        Cookie: this.cookie,
      },
      extra || {}
    );
  }

  /** 查询签到日历，返回日历对象（含 dateList 已签到日期数组 'YYYY-MM-DD'），失败返回 null */
  async getSignCalendar() {
    const { start, end } = monthRange();
    const r = await reqJson(
      'GET',
      `${BASE_URL}/marketing-tools/sign/getSignCalendarNew?type=APPTYPE&chanel=ss&lang=zh&startQueryDate=${start}&endQueryDate=${end}`,
      this.h5Headers(),
      null
    );
    const d = (r.data || {}).data;
    if (d && Array.isArray(d.dateList)) return d;
    this.log(`查询签到日历失败: ${(r.data ? JSON.stringify(r.data) : r.text).slice(0, 180)}`);
    return null;
  }

  /** 执行签到 */
  async doSign() {
    // 模拟 H5 真实链路：join 前先 activity/load
    await reqJson(
      'POST',
      `${BASE_URL}/marketing-tools/activity/load?type=APPTYPE&chanel=ss&lang=zh`,
      this.h5Headers({ 'Content-Type': 'application/json' }),
      JSON.stringify({ activityType: 'sign', channel: 'mini' })
    );

    const r = await reqJson(
      'POST',
      `${BASE_URL}/marketing-tools/activity/join?type=APPTYPE&chanel=ss&lang=zh`,
      this.h5Headers({ 'Content-Type': 'application/json' }),
      JSON.stringify({ activityType: 'sign', channel: 'mini', entrance: 1 })
    );
    const d = r.data || {};
    const code = String(d.respCode != null ? d.respCode : '');
    const data = d.data || {};
    if (code === '0000' && data.result) {
      const award = data.award && data.award.awardName ? `，获得「${data.award.awardName}」` : '';
      this.log(`签到成功${award}`);
      this.msg = '签到成功' + award;
      return true;
    }
    if (code === '0150') {
      // 抓包实证：重复签到时 respCode=0150, respMsg=签到中，请稍等。
      this.log(`今日已签到（${d.respMsg}）`);
      this.msg = '今日已签到';
      return true;
    }
    this.log(`签到失败: ${d.respMsg || JSON.stringify(d).slice(0, 200)}`);
    this.msg = String(d.respMsg || '未知错误').slice(0, 50);
    return false;
  }

  /** 查金币余额（仅金币类活动有值，里程活动返回 '--'） */
  async getCoinBalance() {
    try {
      const r = await reqJson(
        'GET',
        `${BASE_URL}/marketing-tools/sign/getSignUserCoinBalance?type=APPTYPE&chanel=ss&lang=zh`,
        this.h5Headers(),
        null
      );
      const v = (r.data || {}).data;
      if (v != null && v !== '--' && !isNaN(Number(v))) return Number(v);
    } catch (e) {
      /* 查不到就算了 */
    }
    return null;
  }

  async run() {
    // 随机延迟 5-20s，模拟人工操作
    const delay = Math.floor(Math.random() * 16 + 5) * 1000;
    console.log(`账号[${this.index}] ${this.name}: 随机延迟 ${delay / 1000}s`);
    await sleep(delay);

    if (!(await this.ssoLogin())) {
      this.msg = this.msg || 'SSO登录失败(疑似未授权南航，需微信手动登录一次)';
      return false;
    }

    const cal = await this.getSignCalendar();
    const today = timeFmt('yyyy-MM-dd');
    if (cal && cal.dateList.includes(today)) {
      this.log(`今日(${today})已签到，本月已签 ${cal.dateList.length} 天`);
      this.msg = `今日已签到（本月已签 ${cal.dateList.length} 天）`;
      this.ok = true;
      return true;
    }

    if (CHECK_ONLY) {
      this.log(`--check 模式：今日(${today})未签到`);
      this.ok = true;
      return true;
    }

    this.ok = await this.doSign();
    if (this.ok) {
      const coin = await this.getCoinBalance();
      if (coin != null) this.msg += `，金币余额 ${coin}`;
      if (cal) this.msg += `（本月已签 ${cal.dateList.length + 1} 天）`;
    }
    if (this.ok && !this.msg) this.msg = '签到成功';
    return this.ok;
  }
}

// ================= 主流程 =================

(async () => {
  console.log(`[info] YYB_BASE = ${YYB_BASE}`);
  if (CSAIR_REF) console.log(`[info] CSAIR_REF = ${CSAIR_REF}（本脚本专属精确过滤）`);
  if (CHECK_ONLY) console.log('[info] --check 模式：只查询，不签到');

  let accounts = await yybGetAccounts();
  if (LIST_ONLY) {
    accounts.forEach((a) => console.log(`${a.id}\t${accName(a)}\t${a.openid}`));
    process.exit(0);
  }

  accounts = filterByExactRef(accounts, CSAIR_REF || process.env.YYB_REF || '');
  if (!accounts.length) {
    console.log('[accounts] 过滤后无账号，退出');
    process.exit(CSAIR_REF || process.env.YYB_REF ? 0 : 1);
  }
  console.log(`[accounts] 本次处理 ${accounts.length} 个账号`);

  let success = 0;
  let failed = 0;
  const lines = [];
  for (let i = 0; i < accounts.length; i++) {
    const t = new CsairTask(accounts[i], i + 1);
    try {
      const ok = await t.run();
      if (ok) success++;
      else failed++;
      lines.push(`${ok ? '✅' : '❌'} ${accName(accounts[i])}: ${t.msg || (ok ? '成功' : '失败')}`);
    } catch (e) {
      failed++;
      lines.push(`❌ ${accName(accounts[i])}: 异常 ${e && e.message ? e.message : e}`);
      console.log(`账号[${i + 1}] ${accName(accounts[i])} 异常: ${e && e.message ? e.message : e}`);
    }
  }

  const title = `南航签到${CHECK_ONLY ? '(仅查询)' : ''} 成功${success} 失败${failed}`;
  const summary = `${title}\n` + lines.join('\n');
  console.log('\n' + summary);
  try {
    await notify('南航签到', summary);
  } catch (e) {
    console.log('[notify] 通知发送失败（不影响任务结果）:', e.message);
  }

  process.exit(failed > 0 && success === 0 ? 1 : 0);
})().catch((e) => {
  console.log('[fatal]', e && e.stack ? e.stack : e);
  process.exit(1);
});
