/*
 * yanghe_guess.js
 * 洋河会员中心「活动2 竞猜 + 幸运袋抽奖」自动参与脚本（v10 — 多账号 + YYB 自动续期 + 竞猜后抽奖）
 * ---------------------------------------------------------------
 * 核心能力（2026-08-08 打通）：
 *   1) 多账号：从 YYB 桥接(http://<LAN_IP>) 拉全部 alive 微信账号(默认18个)，
 *      或读 YANGHE_ACCOUNTS 环境变量(JSON [{name,uin}])；
 *   2) 每个账号自动续期：YYB /wxapp/getCode(appid=wxa4236ac81be86154) -> 洋河 login(jsCode)
 *      -> 裸 JWT(HS256,60min) -> getMemberInfo 取 memberId；token 过期每次运行自动重刷，零维护；
 *   3) 拉题(同 round 全账号共用题目) + 按 YANGHE_GUESS_PLAN 逐场指定答案 + 单题提交。
 *
 * 关键网络约束：
 *   洋河 user/member.chinayanghe.com 用老 nginx/1.12.2 + 不安全旧版 TLS 重协商，
 *   现代 OpenSSL 默认禁用 -> 故 https 请求必须开 SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION。
 *   YYB 桥接为纯 http(无 TLS)，无此问题。
 *
 * 登录/刷新端点（HAR #43 抓到，已实测）：
 *   POST https://member.chinayanghe.com/gateway/auth/login?jsCode=<jsCode>
 *   头: currentVersion/curTimestamp/memberId(空)/User-Agent/Referer(appid wxa4236ac81be86154)
 *   body: {}  响应: {"success":true,"resultBody":{"token":"eyJ...","openId":null,...}}
 *   jsCode 一次性/5min 有效，失效时 resultBody=null(errCode 仍0) -> 以 token 是否非空判成功。
 *
 * YYB 桥接接口（ccc 版，token 可选，本环境免鉴权）：
 *   GET  {base}/accounts                       -> data:[{id,uin,openid,alias,status}]
 *   POST {base}/wxapp/getCode  {"ref":<uin>,"app_id":<appid>}
 *        -> data:{openid, result:{code:"0b1...", errMsg:"login:ok"}}
 *
 * 配置（青龙环境变量）：
 *   YYB_BRIDGE_BASE_URL   默认 http://<LAN_IP>
 *   YYB_WX_APP_ID         默认 wxa4236ac81be86154（洋河小程序 appid）
 *   YANGHE_ACCOUNTS       （可选）JSON 数组 [{name,uin}]；缺省=从 YYB 自动拉全部 alive
 *   YANGHE_API_BASE       默认 https://user.chinayanghe.com（getMemberInfo/题目/提交 域名）
 *   YANGHE_LOGIN_URL      默认 https://member.chinayanghe.com/gateway/auth/login
 *   YANGHE_MEMBER_INFO_URL默认 {API_BASE}/gateway/api-member/member/getMemberInfo
 *   YANGHE_QUESTIONS_URL  题目列表 GET（全URL，含 activityCode）；（无则用本地 fixture）
 *   YANGHE_API_URL        提交 POST 全URL（默认 {API_BASE}/gateway/api-world-cup-center/suchao/submitAnswer）
 *   YANGHE_ACTIVITY_CODE  S2C0D2T6CJ
 *   YANGHE_GUESS_PLAN     按场次顺序答案表，逗号分隔，如 "A,C,B"(第1场A/第2场C/第3场B)
 *   YANGHE_FORCE_RESEND   默认空；=1 时忽略"已答"、强制重提(改已提交场次的答案)
 *   YANGHE_GUESS_OPTION   （兜底）全局固定答案；PLAN 缺失某位置/未设时生效，默认 A
 *   YANGHE_APP_VERSION    currentVersion（默认 4.4.421）
 *   YANGHE_API_HEADERS    JSON 额外/覆盖请求头
 *   PUSH_PLUS_TOKEN       PushPlus 微信推送(批次汇总/失败告警)
 *   抽奖（幸运袋）配置：
 *   YANGHE_LOTTERY_ENABLE   抽奖总开关：=1 开启；不设/设其他值 → 完全关闭（连查询都不跑）。默认关闭，需要时用自己开。
 *   YANGHE_LOTTERY_QUERY_URL  查询可用奖品卡 URL（默认 {API_BASE}/gateway/api-lottery/marketingLotteryLuckyBag/queryAvailablePrizeCard3，已实测）
 *   YANGHE_LOTTERY_DRAW_URL   抽奖项 URL（Fiddler 抓包已补全：marketingLotteryDrawMain/directDraw）
 *   查询我的奖品（中奖记录）：
 *   YANGHE_PRIZES_URL   我的奖品查询 URL（默认 api-lottery/marketingLotteryPrizeRecord/
 *                        getPrizeRec<OPENID>，已抓包确认）。GET + query 参数；
 *                        响应 resultBody.list 为奖品数组（外层 total/pageNum/pageSize/pages/size）。
 *   逻辑：开关开启后，竞猜提交后自动 queryLottery；count>0 即代表本场竞猜对了、获得抽奖机会，随即抽奖直到抽完。
 *
 * 诊断：
 *   node yanghe_guess.js --check   刷新全部账号+拉题+预览答案（抽奖开关关闭时跳过抽奖查询）
 *   node yanghe_guess.js --plan    仅预览本轮答案表(不刷新/不提交)
 *   node yanghe_guess.js --accounts 仅列出 YYB 账号
 *   node yanghe_guess.js --lottery 仅抽奖（不提交竞猜）：开关开启时对每个已注册账号查可用次数并抽取；开关关闭时直接提示退出
 *   node yanghe_guess.js --prizes  查询我的奖品（中奖记录，不依赖抽奖开关；可用 YANGHE_PRIZES_URL 覆盖接口地址）
 *   node yanghe_guess.js --refresh --code=<jsCode>  单码测 login 端点
 *   正常运行(无参数)：刷新全部账号 -> 拉题 -> 按 PLAN 提交未答题 -> (开关开启且竞猜对了)抽奖 -> PushPlus 汇总
 * ---------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const STATE_FILE = path.join(__dirname, '.yanghe_guess_state.json');
const FIXTURE = path.join(__dirname, '.yanghe_questions.json');

// 放行洋河老服务器（unsafe legacy renegotiation）
const TLS_AGENT = new https.Agent({
  secureOptions: crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
});

const YYB_BASE = process.env.YYB_BRIDGE_BASE_URL || 'http://<LAN_IP>';
const YYB_APPID = process.env.YYB_WX_APP_ID || 'wxa4236ac81be86154';
const API_BASE = process.env.YANGHE_API_BASE || 'https://user.chinayanghe.com';
const LOGIN_URL = process.env.YANGHE_LOGIN_URL || 'https://member.chinayanghe.com/gateway/auth/login';
const MEMBER_INFO_URL = process.env.YANGHE_MEMBER_INFO_URL || (API_BASE + '/gateway/api-member/member/getMemberInfo');
const SUBMIT_URL = process.env.YANGHE_API_URL || (API_BASE + '/gateway/api-world-cup-center/suchao/submitAnswer');
const QUESTIONS_URL = process.env.YANGHE_QUESTIONS_URL;
const ACTIVITY_CODE = process.env.YANGHE_ACTIVITY_CODE || 'S2C0D2T6CJ';
// 抽奖（幸运袋）端点：查询可用奖品卡（已验证）；抽奖项待用户 Fiddler 抓包补全（env 配置）。
const LOTTERY_QUERY_URL = process.env.YANGHE_LOTTERY_QUERY_URL || (API_BASE + '/gateway/api-lottery/marketingLotteryLuckyBag/queryAvailablePrizeCard3');
// 抽奖项端点：来自 2026-08-10 用户 Fiddler 抓包（之前 71 候选穷举全 404 未命中，现已确认）
//   POST /gateway/api-lottery/marketingLotteryDrawMain/directDraw  form-urlencoded
//   body = memberId=<mid>&activityCode=<code>  → 响应 resultBody.prizeLevelRes.level（"谢谢参与"/奖品名）
const LOTTERY_DRAW_URL = process.env.YANGHE_LOTTERY_DRAW_URL || (API_BASE + '/gateway/api-lottery/marketingLotteryDrawMain/directDraw');
// 查询我的奖品（中奖记录）：GET {PRIZES_URL}?pageSize=20&memberId=<mid>&activityCode=<code>&pageNum=1
//   已抓包确认（2026-08-10 de5dfbed...har）：GET + query 参数；memberId 同时放 query 与 header（header 必带）。
//   响应 resultBody.list 为奖品数组（外层 total/pageNum/pageSize/pages/size）。可用 env YANGHE_PRIZES_URL 覆盖。
const PRIZES_URL = process.env.YANGHE_PRIZES_URL || (API_BASE + '/gateway/api-lottery/marketingLotteryPrizeRecord/getPrizeRec<OPENID>');
// 抽奖总开关：青龙环境变量 YANGHE_LOTTERY_ENABLE=1 才开启；不设/设其他值 → 完全关闭（连查询都不跑）
const LOTTERY_ENABLE = process.env.YANGHE_LOTTERY_ENABLE === '1';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- JWT 解码（仅读 payload，不验签） ----------------
function decodeJwt(token) {
  try {
    const seg = (token || '').split('.');
    if (seg.length < 2) return null;
    let b64 = seg[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) { return null; }
}
function jwtExpInfo(token) {
  const p = decodeJwt(token);
  if (!p || !p.exp) return null;
  const now = Math.floor(Date.now() / 1000);
  const left = p.exp - now;
  return { exp: p.exp, leftSec: left, expired: left <= 0 };
}

function isAuthFailure(status, text) {
  if (status === 401) return true;
  try {
    const j = JSON.parse(text);
    const msg = String(j.errorMsg || j.message || '').toLowerCase();
    const code = j.errCode;
    if (/token|expire|login|invalid|授权|失效|过期|未登录|请登录/.test(msg)) return true;
    if ([401, 1001, 1002, 1003, 1004, 40001, 40002].includes(code)) return true;
  } catch (e) {}
  return false;
}

// ---------------- 通用 HTTP（兼容老 TLS 服务器） ----------------
function httpReq(method, url, headers, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 解析失败: ' + url)); }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const h = Object.assign({}, headers);
    if (body && !h['Content-Length'] && !h['content-length']) {
      h['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({ Host: u.hostname }, h),
      timeout: timeoutMs,
    };
    if (isHttps) opts.agent = TLS_AGENT;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------- 推送（PushPlus） ----------------
async function pushPlus(title, content) {
  const token = process.env.PUSH_PLUS_TOKEN || '';
  if (!token) return null;
  const body = JSON.stringify({ token, title, content, template: 'txt' });
  try {
    const r = await httpReq('POST', 'https://www.pushplus.plus/send', { 'Content-Type': 'application/json' }, body);
    return JSON.parse(r.text);
  } catch (e) { console.log('[push] 推送失败:', e.message); return null; }
}

// ---------------- 洋河鉴权头 ----------------
function buildHeaders(ov) {
  ov = ov || {};
  const headers = {
    'content-type': 'application/json',
    'currentVersion': process.env.YANGHE_APP_VERSION || '4.4.422',
    'curTimestamp': process.env.YANGHE_CUR_TS || String(Date.now()),
    'memberId': ov.memberId || process.env.YANGHE_MEMBER_ID || '',
  };
  const authName = process.env.YANGHE_AUTH_HEADER_NAME || 'Authorization';
  const authPrefix = process.env.YANGHE_AUTH_PREFIX || '';
  const token = (ov.token != null ? ov.token : (process.env.YANGHE_API_TOKEN || ''));
  if (token) headers[authName] = authPrefix + token;
  if (process.env.YANGHE_API_HEADERS) {
    try { Object.assign(headers, JSON.parse(process.env.YANGHE_API_HEADERS)); } catch (e) {}
  }
  if (ov.extra) Object.assign(headers, ov.extra);
  return headers;
}

// ---------------- 洋河鉴权头（form-urlencoded 版，抽奖接口用） ----------------
function formHeaders(ov) {
  ov = ov || {};
  const h = {
    'content-type': 'application/x-www-form-urlencoded',
    'currentVersion': process.env.YANGHE_APP_VERSION || '4.4.422',
    'curTimestamp': process.env.YANGHE_CUR_TS || String(Date.now()),
    'memberId': ov.memberId || '',
    // 以下两项与 2026-08-10 抓包一致（微信小程序 webview 默认头；缺了个别接口会 401/风控）
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b57) NetType/WIFI Language/zh_CN',
    'Referer': 'https://servicewechat.com/wxa4236ac81be86154/833/page-frame.html',
  };
  const authName = process.env.YANGHE_AUTH_HEADER_NAME || 'Authorization';
  if (ov.token) h[authName] = ov.token;
  if (process.env.YANGHE_API_HEADERS) {
    try { Object.assign(h, JSON.parse(process.env.YANGHE_API_HEADERS)); } catch (e) {}
  }
  return h;
}

// ---------------- YYB 桥接 ----------------
async function yybGetAccounts() {
  try {
    const r = await httpReq('GET', `${YYB_BASE}/accounts`);
    // 关键：uin 是 17 位整数，超出 JS Number 安全范围(JSON.parse 会丢精度导致 404)。
    // 先把 "uin":数字 改成 "uin":"数字" 保证按字符串精确保留。
    const txt = r.text.replace(/"uin":(\d+)/g, '"uin":"$1"');
    const j = JSON.parse(txt);
    const all = j.data || [];
    const alive = all.filter(a => a.status === 'alive').map(a => ({ ...a, uin: String(a.uin) }));
    console.log(`[yyb] /accounts 共 ${all.length} 个，alive ${alive.length} 个`);
    return alive;
  } catch (e) { console.log('[yyb] 取账号失败:', e.message); return []; }
}

// 取 jsCode（带重试，部分账号首次调用偶发空响应）
async function yybGetCode(uin, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await httpReq('POST', `${YYB_BASE}/wxapp/getCode`,
        { 'Content-Type': 'application/json' },
        JSON.stringify({ ref: String(uin), app_id: YYB_APPID }), 45000);
      let j;
      try { j = JSON.parse(r.text); } catch (e) { j = null; }
      if (j && j.data && j.data.result && j.data.result.code) {
        return j.data.result.code;
      }
      if (r.status === 401 || r.status === 409) {
        console.log(`[yyb] getCode uin=${uin} 确定失败(HTTP ${r.status})，放弃重试`);
        return null;
      }
      console.log(`[yyb] getCode uin=${uin} 第${t}次 无code: ${r.text.slice(0, 120)}`);
    } catch (e) { console.log(`[yyb] getCode uin=${uin} 第${t}次 异常: ${e.message}`); }
    if (t < tries) await sleep(1500);
  }
  return null;
}

// ---------------- 洋河 login：jsCode -> JWT ----------------
async function refreshTokenViaLogin(jsCode, memberId) {
  if (!jsCode) return null;
  const url = `${LOGIN_URL}?jsCode=${encodeURIComponent(jsCode)}`;
  const headers = {
    'content-type': 'application/json',
    'currentVersion': process.env.YANGHE_APP_VERSION || '4.4.421',
    'curTimestamp': String(Date.now()),
    'memberId': memberId || '',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b57) NetType/WIFI Language/zh_CN',
    'Referer': 'https://servicewechat.com/wxa4236ac81be86154/832/page-frame.html',
  };
  try {
    const r = await httpReq('POST', url, headers, '{}');
    const j = JSON.parse(r.text);
    const token = j.resultBody && j.resultBody.token;
    if (token) {
      const info = jwtExpInfo(token);
      const sub = (decodeJwt(token) || {}).sub;
      console.log(`[login] ✅ 新 token exp=${info ? new Date(info.exp * 1000).toLocaleString('zh-CN') : '?'} 剩余${info ? info.leftSec + 's' : '?'} sub=${sub}`);
      return token;
    }
    console.log('[login] 响应无 token（jsCode 可能已失效）:', JSON.stringify(j.resultBody));
    return null;
  } catch (e) { console.log('[login] 请求失败:', e.message); return null; }
}

// ---------------- getMemberInfo：token -> {memberId, registered} ----------------
// 注意：仅微信授权但未注册洋河会员的账号，memberVo.member=false 且 memberId=null，
// 这类账号无法提交竞猜(后端 500)，需先在洋河小程序用该微信完成注册/首猜。
async function getMemberInfo(token) {
  try {
    const r = await httpReq('POST', MEMBER_INFO_URL, buildHeaders({ token, memberId: '' }), '{}');
    const j = JSON.parse(r.text);
    const mv = j.resultBody && j.resultBody.memberVo;
    const memberId = (mv && mv.memberId) || '';
    const registered = !!(mv && mv.member === true && memberId);
    return { memberId, registered };
  } catch (e) { console.log('[member] 取 memberInfo 失败:', e.message); return { memberId: '', registered: false }; }
}

// ---------------- 抽奖（幸运袋） ----------------
// 接口说明（已实测）：
//   查询可用奖品卡(抽奖机会)：POST {LOTTERY_QUERY_URL}  form-urlencoded
//     body = memberId=<mid>&activityCode=<code>
//     响应 resultBody = { count:<整数>, endDate:<日期|null> }
//     注：count>0 即代表本场竞猜对了、获得了抽奖机会（"竞猜对了就可以抽奖"）。
//   抽奖项：POST {LOTTERY_DRAW_URL}（待用户 Fiddler 抓包补全 URL + 必要 body 字段）
//     body 默认同样 memberId+activityCode，若抓包发现还需 roundId/prizeCardId 等再补。
function lotteryBody(memberId) {
  return `memberId=${encodeURIComponent(memberId)}&activityCode=${encodeURIComponent(ACTIVITY_CODE)}`;
}
async function queryLottery(token, memberId) {
  try {
    const r = await httpReq('POST', LOTTERY_QUERY_URL, formHeaders({ token, memberId }), lotteryBody(memberId), 15000);
    let j;
    try { j = JSON.parse(r.text); } catch (e) { j = null; }
    const rb = (j && j.resultBody) || {};
    // queryAvailablePrizeCard(无后缀) 返回 resultBody 是数字；带3后缀返回 {count,...}
    const count = (typeof rb === 'number') ? rb : (rb.count || 0);
    return { count: Number(count) || 0, endDate: rb.endDate || null, raw: j };
  } catch (e) { console.log('[lottery] 查询失败:', e.message); return { count: 0, endDate: null, raw: null }; }
}
async function drawLotteryOnce(token, memberId) {
  if (!LOTTERY_DRAW_URL) {
    console.log('[lottery] ⚠️ 未配置 YANGHE_LOTTERY_DRAW_URL，无法抽奖（仅查询）。请在青龙环境变量填抽奖项 URL。');
    return { ok: false, reason: 'no_draw_url', raw: null };
  }
  try {
    const r = await httpReq('POST', LOTTERY_DRAW_URL, formHeaders({ token, memberId }), lotteryBody(memberId), 15000);
    let j, ok = false;
    try { j = JSON.parse(r.text); ok = r.status === 200 && j.success === true && j.errCode === 0; } catch (e) {}
    return { ok, status: r.status, raw: j, text: r.text };
  } catch (e) { console.log('[lottery] 抽奖请求异常:', e.message); return { ok: false, reason: 'req_err', text: e.message }; }
}
// 查询 + 抽奖（draw=true 才真正抽，=false 仅报告可用数）
async function doLottery(token, memberId, name, draw) {
  if (!LOTTERY_ENABLE) {
    console.log(`[lottery] 抽奖开关未开启（YANGHE_LOTTERY_ENABLE ≠ 1），已跳过。如需抽奖请在青龙环境变量设 YANGHE_LOTTERY_ENABLE=1`);
    return { drawn: 0, available: 0, disabled: true };
  }
  const q = await queryLottery(token, memberId);
  console.log(`[lottery] ${name} 可用抽奖次数(count)=${q.count}${q.endDate ? ' endDate=' + q.endDate : ''}`);
  if (q.count <= 0) return { drawn: 0, available: 0 };
  if (!draw) return { drawn: 0, available: q.count };
  let drawn = 0;
  for (let i = 0; i < q.count; i++) {
    const r = await drawLotteryOnce(token, memberId);
    let prize = '';
    try {
      const rb = (r.raw && r.raw.resultBody) || {};
      const lvl = rb.prizeLevelRes && rb.prizeLevelRes.level;
      prize = lvl ? ('🎁' + lvl) : (r.text ? r.text.slice(0, 100) : '');
    } catch (e) { if (r.text) prize = r.text.slice(0, 100); }
    console.log(`[lottery] ${name} 抽奖#${i + 1} HTTP ${r.status || '-'} ${r.ok ? '✅' : '❌'} ${prize}`);
    if (!r.ok) break;
    drawn++;
    await sleep(1000);
  }
  console.log(`[lottery] ${name} 本次抽 ${drawn} 次（可用 ${q.count}）`);
  return { drawn, available: q.count };
}

// ---------------- 查询我的奖品（中奖记录） ----------------
// GET {PRIZES_URL}?pageSize=20&memberId=<mid>&activityCode=<code>&pageNum=1
// 抓包确认（2026-08-10）：method=GET，memberId 同时放在 query 与 header（header 必带）；
// 响应 resultBody.list 为奖品数组（外层 total/pageNum/pageSize/pages/size）。
// 本函数对多种响应形态做兼容解析并打印原始响应便于纠偏。
function prizeItemText(p) {
  if (!p || typeof p !== 'object') return '(空)';
  const name = p.prizeName || p.prizeLevel || p.prizeLevelName || p.level || p.name || p.prizeTitle || '(未命名奖品)';
  const time = p.gmtCreate || p.createTime || p.winTime || p.getTime || p.time || '';
  const code = p.prizeCode || p.code || '';
  return `${name}${code ? ' [' + code + ']' : ''}${time ? ' @' + time : ''}`;
}
async function queryMyPrizes(token, memberId) {
  try {
    const qs = new URLSearchParams({
      pageSize: String(process.env.YANGHE_PRIZES_PAGE_SIZE || '20'),
      memberId: memberId || '',
      activityCode: ACTIVITY_CODE,
      pageNum: '1',
    }).toString();
    const url = PRIZES_URL + (PRIZES_URL.includes('?') ? '&' : '?') + qs;
    // 复用 formHeaders（含 memberId 头 + UA/Referer + Authorization），并改 content-type 为 application/json（与抓包一致）
    const h = formHeaders({ token, memberId });
    h['content-type'] = 'application/json';
    const r = await httpReq('GET', url, h, null, 15000);
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) {}
    console.log(`[prizes] HTTP ${r.status} raw=${r.text.slice(0, 600)}`);
    if (r.status === 404) {
      console.log('[prizes] ⚠️ 404：URL 可能不对，请用 YANGHE_PRIZES_URL 指定正确的「我的奖品」接口（最好抓包确认）。');
      return { count: 0, list: [], raw: j, notFound: true };
    }
    const rb = (j && j.resultBody) || (j && j.data) || null;
    let list = null;
    if (Array.isArray(rb)) list = rb;
    else if (rb && typeof rb === 'object') list = rb.list || rb.prizeList || rb.prizeRecordList || rb.records || rb.data || rb.prizeRecords || rb.myPrizeList || null;
    if (list && Array.isArray(list)) {
      const total = (rb && rb.total != null ? Number(rb.total) : list.length) || list.length;
      console.log(`[prizes] ✅ 共 ${total} 条中奖记录（本页 ${list.length}）：`);
      list.forEach((p, i) => console.log(`   ${i + 1}. ${prizeItemText(p)}`));
      return { count: total, list, raw: j };
    }
    console.log('[prizes] 未识别到奖品列表（resultBody 形态需确认），原始响应见上。');
    return { count: 0, list: [], raw: j };
  } catch (e) { console.log('[prizes] 查询失败:', e.message); return { count: 0, list: [], raw: null }; }
}

// ---------------- 拉取题目 ----------------
async function fetchQuestions(headers) {
  if (QUESTIONS_URL) {
    const h = headers || buildHeaders({});
    console.log(`[questions] GET ${QUESTIONS_URL}`);
    try {
      const r = await httpReq('GET', QUESTIONS_URL, h);
      console.log(`[questions] -> HTTP ${r.status}`);
      if (isAuthFailure(r.status, r.text)) {
        console.log('[questions] 鉴权失败，回退 fixture');
      } else {
        try { return j2rb(r.text); } catch (e) { console.log('[questions] 非JSON:', r.text.slice(0, 300)); }
      }
    } catch (e) { console.log('[questions] GET 失败:', e.message, '-> 回退 fixture'); }
  }
  try {
    const txt = fs.readFileSync(FIXTURE, 'utf8');
    console.log(`[questions] 读本地 fixture ${path.basename(FIXTURE)}`);
    return j2rb(txt);
  } catch (e) {
    console.log('[warn] 未配置 YANGHE_QUESTIONS_URL 且无 fixture');
    return null;
  }
}
function j2rb(txt) {
  const j = JSON.parse(txt);
  return j.resultBody || j.data || j;
}

function parseQuestions(rb) {
  const meta = { roundId: rb.roundId, roundCode: rb.roundCode, roundName: rb.roundName, restTime: rb.restTime, status: rb.status };
  const questions = (rb.questionList || []).map((q, i) => ({
    id: q.questionId, index: i, name: q.questionName, type: q.questionType,
    answered: q.userAnswerStatus === 1, answerCode: q.userAnswerCode,
    answerList: (q.answerList || []).map(a => ({ code: a.answerCode, desc: a.answerDescribe })),
  }));
  return { meta, questions };
}

function pickAnswer(q) {
  const plan = (process.env.YANGHE_GUESS_PLAN || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (q.index != null && plan[q.index] && ['A', 'B', 'C'].includes(plan[q.index])) return plan[q.index];
  const fixed = (process.env.YANGHE_GUESS_OPTION || '').toUpperCase();
  if (fixed && ['A', 'B', 'C'].includes(fixed)) return fixed;
  const a0 = q.answerList[0];
  return a0 ? a0.code : '';
}

// ---------------- 单账号答题 ----------------
async function runAccount(acc, force, doSubmit) {
  const uin = acc.uin;
  const name = acc.name || acc.alias || String(uin);
  console.log(`\n===== 账号 ${name} (uin=${uin}) =====`);
  const jsCode = await yybGetCode(uin);
  if (!jsCode) { console.log(`[${name}] ❌ 无法获取 jsCode，跳过`); return { ok: false, reason: 'no_code' }; }
  const token = await refreshTokenViaLogin(jsCode, '');
  if (!token) { console.log(`[${name}] ❌ 登录失败，跳过`); return { ok: false, reason: 'login_fail' }; }
  const info = jwtExpInfo(token);
  const openid = (decodeJwt(token) || {}).sub;
  const mi = await getMemberInfo(token);
  const memberId = mi.memberId;
  console.log(`[${name}] token exp=${info ? new Date(info.exp * 1000).toLocaleString('zh-CN') : '?'} openid=${openid} memberId=${memberId} 注册=${mi.registered ? '是' : '否'}`);
  if (!mi.registered) {
    console.log(`[${name}] ⚠️ 该微信尚未注册为洋河会员(memberId 空)，跳过提交。请先在洋河小程序用此微信授权完成注册/首猜。`);
    return { ok: false, reason: 'not_registered' };
  }

  const rb = await fetchQuestions(buildHeaders({ token, memberId }));
  if (!rb) { console.log(`[${name}] 无法拉题，跳过`); return { ok: false, reason: 'no_questions' }; }
  const { meta, questions } = parseQuestions(rb);
  console.log(`[${name}] ${meta.roundName} 共${questions.length}题`);
  const pending = questions.filter(q => !q.answered || force);
  if (pending.length === 0) {
    console.log(`[${name}] 本轮全部已答，跳过`);
    return { ok: true, submitted: 0 };
  }
  const answers = pending.map(q => {
    const code = pickAnswer(q);
    const ua = q.answerList.find(a => a.code === code);
    console.log(`[${name}] 第${q.index + 1}场 #${q.id} ${q.name} -> ${code} (${ua ? ua.desc : ''})`);
    return { questionId: q.id, answerCode: code, userAnswer: ua ? ua.desc : '' };
  });

  if (!doSubmit) {
    console.log(`[${name}] --check 模式，仅预览，不提交`);
    const lot = await doLottery(token, memberId, name, false);
    return { ok: true, submitted: 0, preview: true, lottery: lot };
  }

  // 提交
  const bodyTpl = process.env.YANGHE_API_BODY ||
    '{"questionId":{{QID}},"userAnswerCode":"{{OPTION}}","userAnswer":"{{USER_ANSWER}}","activityCode":"{{ACTIVITY_CODE}}"}';
  let submitted = 0, authFail = false;
  for (const a of answers) {
    const body = bodyTpl
      .replace(/\{\{QID\}\}/g, a.questionId)
      .replace(/\{\{OPTION\}\}/g, a.answerCode)
      .replace(/\{\{USER_ANSWER\}\}/g, a.userAnswer || '')
      .replace(/\{\{ACTIVITY_CODE\}\}/g, ACTIVITY_CODE);
    console.log(`[${name}] POST submit #${a.questionId} -> ${a.answerCode}`);
    try {
      const r = await httpReq('POST', SUBMIT_URL, buildHeaders({ token, memberId }), body);
      let ok = false;
      try { const j = JSON.parse(r.text); ok = r.status === 200 && j.success === true && j.errCode === 0; } catch (e) {}
      console.log(`[${name}] -> HTTP ${r.status} ${r.text.slice(0, 120)}`);
      if (!ok) {
        if (isAuthFailure(r.status, r.text)) { authFail = true; }
        console.log(`[${name}] ⚠️ 提交失败(HTTP ${r.status})，停止本账号后续提交`);
        break;
      }
      submitted++;
    } catch (e) { console.log(`[${name}] 提交异常:`, e.message); break; }
    await sleep(800);
  }
  if (authFail) {
    console.log(`[${name}] ⚠️ 提交鉴权失败（token 失效？）`);
    return { ok: false, reason: 'auth_fail', submitted };
  }
  console.log(`[${name}] ✅ 提交 ${submitted} 题`);
  // 抽奖（幸运袋）：提交后可抽奖；count>0 即代表本场竞猜对了获得抽奖机会
  const lot = await doLottery(token, memberId, name, doSubmit);
  return { ok: true, submitted, lottery: lot };
}

// ---------------- 主流程 ----------------
async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');

  // --refresh：单码测 login（诊断）
  if (args.includes('--refresh')) {
    const m = args.find(a => a.startsWith('--code='));
    const code = m ? m.slice('--code='.length) : process.env.YANGHE_JSCODE;
    if (!code) { console.log('[refresh] 用法: --refresh --code=<jsCode>'); process.exit(1); }
    const tok = await refreshTokenViaLogin(code, '');
    console.log(tok ? '[refresh] ✅ ' + tok.slice(0, 40) : '[refresh] ❌ 无 token');
    process.exit(0);
  }

  // 收集账号
  let accounts = [];
  const accEnv = process.env.YANGHE_ACCOUNTS;
  if (accEnv && accEnv.trim()) {
    try { accounts = JSON.parse(accEnv); console.log(`[accounts] 从 YANGHE_ACCOUNTS 读取 ${accounts.length} 个`); }
    catch (e) { console.log('[warn] YANGHE_ACCOUNTS 解析失败:', e.message); }
  }
  if (!accounts.length && process.env.YYB_BRIDGE_BASE_URL) {
    accounts = await yybGetAccounts();
  }

  // --accounts：仅列出
  if (args.includes('--accounts')) {
    accounts.forEach(a => console.log(`  id=${a.id} uin=${a.uin} ${a.status} ${a.alias} openid=${a.openid}`));
    process.exit(0);
  }

  // legacy 单账号兜底（无 YYB、有 YANGHE_AUTH）
  if (!accounts.length && process.env.YANGHE_AUTH) {
    console.log('[info] 无 YYB/ACCOUNTS，走单账号 legacy 模式');
    accounts = [{ uin: 'legacy', name: 'legacy' }];
  }
  if (!accounts.length) {
    console.log('[error] 无账号来源（YYB_ACCOUNTS / YYB_BRIDGE / YANGHE_AUTH）');
    process.exit(1);
  }

  console.log(`===== 洋河竞猜 v9 多账号（共 ${accounts.length} 个账号，mode=${isCheck ? 'CHECK' : 'RUN'}）=====`);
  console.log('[info] YANGHE_GUESS_PLAN =', process.env.YANGHE_GUESS_PLAN || '(空→默认A)');
  console.log('[info] YANGHE_FORCE_RESEND =', process.env.YANGHE_FORCE_RESEND === '1' ? '1' : '关');

  // --plan：仅预览答案表
  if (args.includes('--plan')) {
    const rb = await fetchQuestions();
    if (!rb) { console.log('[plan] 无法拉题'); process.exit(0); }
    const { meta, questions } = parseQuestions(rb);
    console.log(`[plan] ${meta.roundName} 答案表预览`);
    questions.forEach(q => {
      if (q.answered && process.env.YANGHE_FORCE_RESEND !== '1') {
        console.log(`   - 第${q.index + 1}场 #${q.id} ${q.name} [已答:${q.answerCode}]`);
      } else {
        const code = pickAnswer(q);
        const ua = q.answerList.find(a => a.code === code);
        console.log(`   - 第${q.index + 1}场 #${q.id} ${q.name} -> ${code} (${ua ? ua.desc : ''})`);
      }
    });
    process.exit(0);
  }

  // --lottery：仅抽奖（不提交竞猜）。对每个已注册账号查询可用抽奖次数并抽取。
  if (args.includes('--lottery')) {
    if (!LOTTERY_ENABLE) {
      console.log('[lottery] ⚠️ 抽奖开关未开启（YANGHE_LOTTERY_ENABLE ≠ 1），--lottery 不会抽奖。请在青龙环境变量设 YANGHE_LOTTERY_ENABLE=1 后再运行。');
      process.exit(0);
    }
    let totalDrawn = 0, avail = [], skippedL = [];
    for (const acc of accounts) {
      const uin = acc.uin;
      const name = acc.name || acc.alias || String(uin);
      console.log(`\n===== 抽奖 账号 ${name} =====`);
      const jsCode = await yybGetCode(uin);
      if (!jsCode) { console.log(`[${name}] ❌ 取码失败`); skippedL.push(name); await sleep(1500); continue; }
      const token = await refreshTokenViaLogin(jsCode, '');
      if (!token) { console.log(`[${name}] ❌ 登录失败`); skippedL.push(name); await sleep(1500); continue; }
      const mi = await getMemberInfo(token);
      if (!mi.registered) { console.log(`[${name}] ⚠️ 未注册，跳过`); skippedL.push(name); await sleep(1500); continue; }
      const lot = await doLottery(token, mi.memberId, name, true);
      totalDrawn += (lot.drawn || 0);
      if ((lot.available || 0) > (lot.drawn || 0)) avail.push(`${name}:剩${(lot.available || 0) - (lot.drawn || 0)}`);
      await sleep(1500);
    }
    const lsummary = `抽奖模式 账号数=${accounts.length} 抽中=${totalDrawn}` +
      (avail.length ? ` 仍有可用=${avail.join(',')}` : ' 仍有可用=无') +
      (skippedL.length ? ` 跳过=${skippedL.join(',')}` : '');
    console.log('\n===== 抽奖汇总 =====');
    console.log(lsummary);
    if (!isCheck) await pushPlus('🎁 洋河抽奖批次完成', lsummary);
    console.log('[done]');
    process.exit(0);
  }

  // --prizes：查询我的奖品（中奖记录）。不依赖抽奖开关；需有效 JWT（走 YYB 取码→登录）。
  if (args.includes('--prizes')) {
    if (!PRIZES_URL) {
      console.log('[prizes] ⚠️ 未配置 YANGHE_PRIZES_URL，无法查询。请设置该环境变量为「我的奖品」接口 URL。');
      process.exit(0);
    }
    let total = 0;
    for (const acc of accounts) {
      const uin = acc.uin;
      const name = acc.name || acc.alias || String(uin);
      console.log(`\n===== 查询奖品 账号 ${name} =====`);
      const jsCode = await yybGetCode(uin);
      if (!jsCode) { console.log(`[${name}] ❌ 取码失败`); await sleep(1500); continue; }
      const token = await refreshTokenViaLogin(jsCode, '');
      if (!token) { console.log(`[${name}] ❌ 登录失败`); await sleep(1500); continue; }
      const mi = await getMemberInfo(token);
      if (!mi.registered) { console.log(`[${name}] ⚠️ 未注册，跳过`); await sleep(1500); continue; }
      const res = await queryMyPrizes(token, mi.memberId);
      total += (res.count || 0);
      await sleep(1500);
    }
    console.log(`\n===== 奖品查询汇总 总记录数=${total} =====`);
    console.log('[done]');
    process.exit(0);
  }

  const force = process.env.YANGHE_FORCE_RESEND === '1';
  let totalSubmitted = 0, totalDrawn = 0, failed = [], skipped = [];
  for (const acc of accounts) {
    const r = await runAccount(acc, force, !isCheck);
    if (r && r.ok) { totalSubmitted += (r.submitted || 0); totalDrawn += (r.lottery && r.lottery.drawn) || 0; }
    else if (r && r.reason === 'not_registered') skipped.push(`${acc.name || acc.uin}`);
    else if (r && r.reason) failed.push(`${acc.name || acc.uin}:${r.reason}`);
    await sleep(1500);
  }

  const summary = `账号数=${accounts.length} 成功提交题数=${totalSubmitted} 抽奖抽中=${totalDrawn}` +
    (skipped.length ? ` 未注册跳过=${skipped.join(',')}` : '') +
    (failed.length ? ` 失败=${failed.join(',')}` : ' 失败=无');
  console.log('\n===== 批次汇总 =====');
  console.log(summary);
  if (!isCheck) await pushPlus('🎯 洋河竞猜批次完成', summary);
  console.log('[done]');
}

main().catch(e => { console.log('[error]', e.message); process.exit(1); });
