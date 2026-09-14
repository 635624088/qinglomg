#!/usr/bin/env node
/**
 * 上海工会 工惠通 · 智答闯关 1v1 PK 自动对战 (YYB版)
 *
 * 完整走 H5(PK) 的 Websocket 流程(from 解码 + HAR 逆向):
 *   matchlobby 连接 → startMatch("/1v1") 匹配 → 收到 to_room{roomId} →
 *   againstroom 连接 → open("/"+roomId) → set_player_info →
 *   每题 sync_question 直接下发正确答案 question.answers[0] → 找到对应选项 → submit_answer
 *
 * 环境变量:
 *   YYB_BASE_URL  YYB 服务地址 (必填)
 *   YYB_REF       指定账号 ref (可选, 默认遍历所有存活账号)
 *   GH_MAX_ANSWER 每题等待答案的秒数 (默认 8, 服务端计时到点会自动判超时交卷)
 *   GH_DELAY      账号间延迟秒数: 固定或 5-15 (默认 0)
 *   GH_MAX_FAIL   已弃用: 失败账号仅跳过, 不再熔断停止 (默认 3, 不再生效)
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');

// ====== YYB 配置 ======
const YYB_BASE = process.env.YYB_BASE_URL || 'http://172.17.0.1:18080';
const YYB_REF = process.env.YYB_REF || '';
// ======================

// ====== 业务常量 ======
const APPID = 'wx21fee1602f5ed3f7';
const GH_BASE = 'https://sgxmgl.shszgh.cn/renren-admin';
const GH_REFERER = `https://servicewechat.com/${APPID}/5/page-frame.html`;
const GH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B)';
const CS = 'cs.ouinternet.com:8084'; // 第三方 WS 服务器 (H5 csmacConfig)
const APP = 'whds0';
const MATCH_TYPE = '1v1';
const MAX_ANSWER_WAIT = Number(process.env.GH_MAX_ANSWER || '1');
const MAX_CONSECUTIVE_FAIL = Number(process.env.GH_MAX_FAIL || '3');
const GH_CONCURRENCY = Number(process.env.GH_CONCURRENCY || '4') || 4;
const TOKEN_CACHE = path.join(__dirname, 'gh_cache.json');
const BANK_FILE = path.join(__dirname, 'gh_pk_bank.json'); // PK 本地题库: {"题目":答案选项内容}
// ======================

let successCount = 0, failedCount = 0, skippedCount = 0, consecutiveFail = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function accountDelaySeconds() {
  const d = String(process.env.GH_DELAY || '').trim();
  if (!d) return 0;
  if (d.includes('-')) { const [lo, hi] = d.split('-').map(Number); return lo + Math.random() * (hi - lo); }
  return Number(d) || 0;
}

function cleanNickname(name) {
  if (!name) return '账号';
  return name.replace(/[^一-鿿\w-]/g, '').replace(/^[-_\s]+|[-_\s]+$/g, '') || '账号';
}

// ====== 本地 PK 题库 (题目→答案选项内容) ======
function readBank() { try { return JSON.parse(fs.readFileSync(BANK_FILE, 'utf-8')); } catch (e) { return {}; } }
function saveBank(bank) { fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 2), 'utf-8'); }

// ====== token 缓存 (复用 gh_task_yyb.js) ======
function readTokenCache() { try { return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf-8')); } catch (e) { return {}; } }
function writeTokenCache(ref, entry) {
  const c = readTokenCache(); c[ref] = entry;
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(c, null, 2), 'utf-8');
}

// ====== YYB 接口 ======
async function yybGetAccounts() {
  const resp = await axios.get(`${YYB_BASE}/accounts`, { timeout: 10000 });
  if (resp.data.code === 0) return resp.data.data || [];
  console.log(`  ❌ 获取账号列表失败: ${resp.data.msg || '未知错误'}`);
  return [];
}
async function yybGetCode(ref) {
  const resp = await axios.post(`${YYB_BASE}/wxapp/getCode`, { ref, app_id: APPID }, { timeout: 30000 });
  const data = resp.data;
  if (data.code === 0) {
    const result = data.data?.result || {};
    if (result.code) return result.code;
    return null;
  }
  return null;
}

// ====== GH 请求 ======
const http = axios.create({ httpsAgent: new https.Agent({ rejectUnauthorized: false, keepAlive: true }), timeout: 20000 });
async function ghReq(token, method, path, body, params) {
  const resp = await http({
    url: `${GH_BASE}${path}`, method, data: body, params,
    headers: { 'User-Agent': GH_UA, 'xweb_xhr': '1', 'Content-Type': 'application/json; charset=UTF-8', token, 'Referer': GH_REFERER },
  });
  const data = resp.data;
  if (![0, '0', null].includes(data.code)) throw new Error(`业务错误: ${data.msg || data.code}`);
  return data;
}
async function wxLogin(code, nickname) {
  const resp = await http.post(`${GH_BASE}/whds/center/wxLogin`, {
    code,
  }, { headers: { 'User-Agent': GH_UA, 'xweb_xhr': '1', 'Content-Type': 'application/json; charset=UTF-8', 'Referer': GH_REFERER }, timeout: 30000 });
  const data = resp.data;
  if (data.code !== 0) throw new Error(`wxLogin 失败: ${data.msg}`);
  const d = data.data || {};
  const m = String(d.token || '').match(/token=([^,]+)/);
  if (!m) throw new Error(`wxLogin 未返回 token`);
  return { token: m[1].trim(), openid: String(d.openid || '') };
}
const ghGetUserInfo = t => ghReq(t, 'GET', '/whds/user/getUserInfo').then(d => d.data || {});
const ghGetPkCount = t => ghReq(t, 'GET', '/whds/user/getPkCount').then(d => d.data || 0);

// ====== 登录 ======
async function getAuth(account) {
  const ref = String(account.id || '');
  const nickname = account.nickname || account.alias || '未知';
  const cache = readTokenCache();
  if (cache[ref] && cache[ref].token) {
    try {
      const ui = await ghGetUserInfo(cache[ref].token);
      const u = ui.userInfo || {};
      return { token: cache[ref].token, openid: u.openid || cache[ref].openid || account.openid || ref, nickname: u.nickname || u.realName || nickname, headUrl: u.headUrl || account.headUrl || '' };
    } catch (e) {}
  }
  const code = await yybGetCode(ref);
  if (!code) return null;
  const { token, openid } = await wxLogin(code, nickname);
  let n = nickname, h = '', o = openid;
  try { const ui = await ghGetUserInfo(token); n = ui.userInfo?.nickname || nickname; h = ui.userInfo?.headUrl || ''; o = ui.userInfo?.openid || openid; } catch (e) {}
  writeTokenCache(ref, { ref, token, nickname: n, openid: o, saved_at: new Date().toISOString() });
  return { token, openid: o, nickname: n, headUrl: h };
}
// =====================

// ====== WS 工具 (通用连接) ======
function connect(url, onMsg) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    ws.on('message', data => { if (onMsg) onMsg(String(data)); });
    ws.on('open', () => { done = true; resolve(ws); });
    ws.on('error', e => { if (!done) { done = true; reject(e); } });
    ws.on('close', () => {});
  });
}

// 发一条 JSON {cmd, txt?} 给 ws
function send(ws, cmd, txt) {
  const msg = txt !== undefined ? { cmd, txt } : { cmd };
  ws.send(JSON.stringify(msg));
}
// =====================

// ====== 单账号 PK ======
async function runPk(auth) {
  const { openid, nickname } = auth;
  const bank = readBank();
  const results = { correct: 0, missed: 0, recorded: 0, wrong: 0, total: 0 };

  console.log(`  · 匹配大厅连接中...`);
  const lobby = await connect(`wss://${CS}/matchlobby/${openid}/${APP}/${MATCH_TYPE}/0`, null);

  // 收到 to_room{roomId} 后用 resolve 通知; 轮询纠错房间 id
  let roomId = null;
  const roomPromise = new Promise((resolve) => {
    lobby.on('message', data => {
      const d = String(data);
      if (d.includes('"to_room"')) { try { const j = JSON.parse(d); roomId = j.txt; resolve(roomId); } catch (e) {} }
    });
  });

  console.log(`  · 发起 1v1 匹配...`);
  send(lobby, 'to_room', `MATCH:${MATCH_TYPE}`); // 握手; 让服务端进入匹配队列

  // 走 H5 实际: connect 到 /1v1/0 后直接就能被匹配, 无需额外命令。等 to_room
  send(lobby, 'set_player_info', JSON.stringify({ userId: openid, nickname, icon_url: auth.headUrl || 'https://sghdsp.sh-service.cn/whj/2026/sgLogo.png' }));

  roomId = await Promise.race([roomPromise, sleep(15000).then(() => null)]);
  if (!roomId) { console.log(`  ⚠️ 15s 内未匹配到对手`); lobby.close(); return null; }
  console.log(`  · 匹配成功, 进入房间 ${roomId}`);
  lobby.close();

  // 对 2 号连接的 room 不知道 id; 匹配到的房间在 to_room.txt. 现在对房间连接
  const room = await connect(`wss://${CS}/againstroom/${openid}/${APP}/${roomId}`, null);
  const sentInfo = new Promise((res) => room.on('open', () => { send(room, 'set_player_info', JSON.stringify({ userId: openid, nickname, icon_url: auth.headUrl || 'https://sghdsp.sh-service.cn/whj/2026/sgLogo.png' })); res(); }));

  // --- 主循环: 监听 sync_question, 读到正确答案立即选 + 交卷 ---
  let busy = false;
  let gameOver = false;

  room.on('message', raw => {
    const d = String(raw);
    if (!d.includes('{')) return;
    let msg;
    try { msg = JSON.parse(d); } catch (e) { return; }
    if (msg.cmd !== 'sync_data') return;
    let data;
    try { data = JSON.parse(msg.txt); } catch (e) { return; }

    if (data.cmd === 'sync_question' && data.question) {
      answerQuestion(room, openid, data.question, bank, results);
    } else if (data.cmd === 'sync_game_result') {
      gameOver = true;
    }
  });

  // 等游戏自然结束(sync_game_result)或超时兜底
  const overAt = Date.now() + 60000;
  while (!gameOver && Date.now() < overAt) await sleep(1000);
  room.close();
  saveBank(bank);

  console.log(`  · PK 结束: 答对 ${results.correct} / 见 ${results.total}, 新记录 ${results.recorded}, 判错 ${results.wrong}`);
  return results;
}

// 对一题: find 正确答案选项 → 回写题库 → submit_answer
async function answerQuestion(room, openid, q, bank, results) {
  results.total++;
  const rightContent = Array.isArray(q.answers) ? q.answers[0] : (q.answer || '');
  const opts = Array.isArray(q.options) ? q.options : [];
  // 本地题库命中的正解优先(可能含人工修正), 否则服务端答案
  const chosen = (bank[q.content] && opts.find(o => o.content === bank[q.content])) || opts.find(o => o.content === rightContent) || null;

  // 交卷内容 = 选中选项的 content
  const content = chosen ? chosen.content : (opts[0] ? opts[0].content : '');
  await sleep(500 + Math.random() * 300); // 0.5-0.8s 模拟看题
  send(room, 'submit_answer', JSON.stringify({ userId: openid, contents: [content] }));

  // 记录: 无论对错都把服务端正解写进本地题库(幂等)
  if (rightContent && bank[q.content] !== rightContent) { bank[q.content] = rightContent; results.recorded++; }
  if (chosen && chosen.content === rightContent) results.correct++; else if (content) results.wrong++;
}

// ====== 并发执行 (固定并发池) ======
function runInPool(items, worker, concurrency) {
  return new Promise((resolve) => {
    const total = items.length;
    const out = new Array(total);
    let idx = 0, done = 0;
    if (total === 0) { resolve([]); return; }
    function next() {
      if (idx >= total) return;
      const cur = idx++;
      worker(items[cur], cur)
        .then(r => { if (r) out[cur] = r; })
        .catch(e => { out[cur] = { error: e.message }; })
        .finally(() => { done++; if (done >= total) resolve(out.filter(Boolean)); else next(); });
    }
    const start = Math.min(concurrency, total);
    for (let k = 0; k < start; k++) next();
  });
}

// ====== 账号处理 ======
async function processAccount(account) {
  const ref = String(account.id || '');
  const nickname = account.nickname || account.alias || '未知';
  console.log(`\n  📱 账号: ${nickname}`);

  const auth = await getAuth(account);
  if (!auth) { skippedCount++; return null; }

  // 剩余 PK 次数
  try {
    const cnt = await ghGetPkCount(auth.token);
    if (cnt <= 0) { console.log(`  · 今日 PK 已用完, 跳过`); skippedCount++; return { nickname, skipped: '今日PK次数已用完' }; }
  } catch (e) { console.log(`  ⚠️ 获取 PK 次数失败: ${e.message}`); }

  try { const r = await runPk(auth); r.nickname = nickname; successCount++; return r; }
  catch (e) { console.log(`  ❌ PK 异常: ${e.message}`); failedCount++; return { nickname, error: e.message }; }
}

async function main() {
  console.log('='.repeat(56));
  console.log(`  工惠通 智答闯关 PK 对战 (YYB版)`);
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log('='.repeat(56));
  if (!YYB_BASE) { console.log('\n❌ 未设置 YYB_BASE_URL'); process.exit(1); }

  console.log('\n[1/2] 获取 YYB 账号列表...');
  const accounts = await yybGetAccounts();
  if (!accounts.length) { console.log('❌ 无可用账号'); return; }
  let filtered = accounts;
  if (YYB_REF) {
    filtered = filtered.filter(a => String(a.id) === YYB_REF || a.openid === YYB_REF);
    if (!filtered.length) { console.log(`❌ 未找到 ref=${YYB_REF}`); return; }
    console.log(`✅ 指定账号\n`);
  } else {
    filtered = filtered.filter(a => String(a.status) === 'alive');
    console.log(`✅ 共 ${filtered.length} 个账号\n`);
  }

  console.log(`· 并发模式: GH_CONCURRENCY=${GH_CONCURRENCY}`);
  const results = await runInPool(filtered, processAccount, GH_CONCURRENCY);

  console.log('\n' + '='.repeat(56));
  console.log(`  ✅ 成功: ${successCount}  失败: ${failedCount}  跳过: ${skippedCount}`);
  console.log('='.repeat(56));
  for (const r of results) {
    if (r.error) console.log(`  ${r.nickname}: 失败 ${r.error}`);
    else if (r.skipped) console.log(`  ${r.nickname}: ${r.skipped}`);
    else console.log(`  ${r.nickname}: 答对 ${r.correct}` + (r.total ? `/${r.total}` : '') + ` 记录${r.recorded} 判错${r.wrong}`);
  }
}

main().catch(e => console.error(e));