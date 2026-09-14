#!/usr/bin/env node
// name: 平安i动
'use strict';
/*
 * 平安i动 (Ping An iDong) 健康币脚本  —  平安i动.js
 * appid: wx340f915763f3ed2b   货币: 健康币
 *
 * ============================================================
 * 抓取字段总表：
 *  - 登录接口: POST https://platform.lifeapp.pingan.com.cn/user-session/external/wxMiniProgram/login
 *      Content-Type: application/x-www-form-urlencoded
 *      body: rsaResult=<URL编码的 base64>，其中 base64 = RSA_PKCS1v1.5( code + "+" + randomKey, 登录RSA公钥 )
 *      响应: DATA.tokenAesResult = 【裸 AES 密文】
 *            AES-128-CBC, key = Utf8.parse(randomKey)(16字节裸密钥, 由客户端 RSA 给服务端), iv = "123456789aasdfgh"(Utf8 裸 16 字节, 模块135 a 当固定IV)
 *            解密得 "authToken#signKey#degradeToken#userInfo"
 *  - 鉴权头(模块22 l(), 每个请求都带, 含未登录时空值): X-AppId,X-Timestamp,X-B3-TraceId,X-ReqID,
 *            X-Source=3, X-CV=60800, X-OS-Type=04, X-Token(登录前空), X-EncryptedUserID(登录前空)
 *           X-EncryptedUserID = AES-CBC( key=Utf8(degradeToken) 按字节数/4 选 AES-128/192/256, iv=Utf8("123456789aasdfgh") )
 *           加密 "userInfo + '_' + rand16"（零依赖纯 JS 实现，逐字节等同 crypto-js）
 *  - X-Sign=base64(SHA256( 去协议URL(含GET query) + "&" + 排序(全部headers,空值也算) + "&reqBody=" + (POST=body / GET=空串) + "&signKey="+signKey ))
 *           GET 与 POST 同样拼接 "&reqBody=" 段(GET 为空串); signKey 登录前为空
 *           注: 实测仅带 X-AppId/X-Timestamp/X-B3-TraceId/X-ReqID，不带 X-Sign/X-CV/X-Source/X-OS-Type
 *  - 健康币总额(必查): GET https://incubator.lifeapp.pingan.com.cn/health-core/ledong/home/getMyPageInfo
 *      -> DATA.balance（与小程序"我的健康币"页一致；兜底 /user-auth/wxMiniProgram/getUserInfo）
 *  - 每日签到: POST https://incubator.lifeapp.pingan.com.cn/health-core/ledong/healthStep/step/completeJgjStepSignInTask
 *          ( wrapper v(){return request(b)} 无参 → GET，无 body；token 失效时返回 CODE=10000「登录失效」)
 *          已签到时服务端返回非00或 MSG 含"已签到"；成功计入健康币
 *
 * 登录链路（优先级三段式，高优先级命中即跳过后续）：
 *   ① 兜底 TOKEN(PAID_TOKENS, JSON) 命中→直接复用，跳过登录且不写缓存
 *   ② 缓存(PAID_cookies.json) 有效→复用
 *   ③ 无兜底/缓存→YYB-Go-Enhanced(wxapp/getCode) 取 code→业务登录→写缓存
 *   ④ 都失败→判失败跳下一账号（同轮内对某账号 YYB 仅取一次 code）
 *
 * ── PAID_TOKENS 兜底 TOKEN 参数说明（最高优先级，配置即用、跳过登录）──
 *   需 4 个字段，缺一不可（每个请求都消费它们）：
 *     · authToken   → 请求头 X-Token（鉴权）
 *     · signKey     → 拼入 X-Sign 签名末尾（&signKey=...）
 *     · degradeToken→ 与 userInfo 一起算 X-EncryptedUserID（AES-CBC key）
 *     · userInfo    → 参与 X-EncryptedUserID 加密原文
 *   从哪里获取：
 *     真实登录响应 DATA.tokenAesResult 是【裸 AES 密文】，
 *     AES-128-CBC 解密（key = 登录时客户端 RSA 生成的 randomKey 十六字节裸密钥，
 *                       iv = "123456789aasdfgh" 十六字节），
 *     解密结果即用 '#' 分隔的四段：authToken#signKey#degradeToken#userInfo
 *   获取什么值 / 怎么填：
 *     把上面 4 段分别塞进一个 JSON 对象，再按「openid|JSON」一行一条：
 *       PAID_TOKENS=openid1|{"authToken":"aaa","signKey":"bbb","degradeToken":"ccc","userInfo":"ddd"}
 *       openid2|{"authToken":"...","signKey":"...","degradeToken":"...","userInfo":"..."}
 *     （openid 即你 yyb_go 里存活账号的 openid；多账号换行分隔）
 *   命中后脚本不再走 YYB 取号，也不写本地缓存；TOKEN 失效时自动回退到 ②/③ 重登。
 * ============================================================
 *
 * ── 账号获取（适配 YYB-Go-Enhanced）──
 *   环境变量：
 *     YYB_SERVER   必填，格式为 地址@账号ref，多账号一行一个；可在 ref 后用 # 添加备注
 *                  ql2 内建议使用 http://yyb-go:8000@ref
 *     PAID_NOTIFY  可选，默认 1；设为 0 时关闭青龙 notify.py 汇总通知
 *     PAID_ACCOUNT_DELAY 可选，账号间固定等待秒数；默认随机 10-18 秒，测试可设为 0
 *   登录链路优先级（命中即跳过后续）：
 *     ① 兜底 TOKEN(PAID_TOKENS) → 直接复用，跳过登录且不写缓存
 *     ② 缓存(PAID_cookies.json) 有效 → 复用
 *     ③ 无兜底/缓存 → getSingleCode 取 code → 业务登录 → 写缓存
 * ============================================================
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ============ 纯 JS AES（零依赖，逐字节等同 crypto-js；支持任意「4 的倍数」字节 key） ============
// 与小程序(模块200 c.c)一致：key = Utf8(degradeToken)，iv = Utf8("123456789aasdfgh")，
// AES-CBC + Pkcs7。crypto-js 按 key 字节数/4 选轮数(AES-128/192/256/...)，此处精确复刻。
const SBOX = (function () {
  function gfMul(a, b) { let p = 0, x = a & 0xff, y = b & 0xff; for (let i = 0; i < 8; i++) { if (y & 1) p ^= x; const hi = x & 0x80; x = (x << 1) & 0xff; if (hi) x ^= 0x1b; y >>= 1; } return p & 0xff; }
  function gfInv(a) { if (a === 0) return 0; for (let i = 1; i < 256; i++) if (gfMul(a, i) === 1) return i; return 0; }
  const arr = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { const inv = gfInv(i); let s = inv; for (let k = 1; k < 5; k++) s ^= ((inv << k) | (inv >>> (8 - k))) & 0xff; arr[i] = (s ^ 0x63) & 0xff; }
  return arr;
})();
const RCON = [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
function mul2(a) { let r = a << 1; if (r & 0x100) r ^= 0x11b; return r & 0xff; }
function mul3(a) { return mul2(a) ^ a; }
function wordAt(kb, i) { return (((kb[4 * i] || 0) << 24) | ((kb[4 * i + 1] || 0) << 16) | ((kb[4 * i + 2] || 0) << 8) | (kb[4 * i + 3] || 0)) >>> 0; }
function keyExpansion(keyBytes) {
  const keySize = keyBytes.length / 4;          // crypto-js 同款：keySize = 字节数/4（4 的倍数时为整数）
  const nRounds = keySize + 6;
  const ksRows = (nRounds + 1) * 4;
  const ks = [];
  for (let ksRow = 0; ksRow < ksRows; ksRow++) {
    if (ksRow < keySize) { ks[ksRow] = wordAt(keyBytes, ksRow); }
    else {
      let t = ks[ksRow - 1];
      if (!(ksRow % keySize)) {
        t = (((t << 8) | (t >>> 24)) >>> 0);
        t = ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
        t ^= (RCON[(ksRow / keySize) | 0] << 24); t = t >>> 0;
      } else if (keySize > 6 && (ksRow % keySize) === 4) {
        t = ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
      }
      ks[ksRow] = (ks[ksRow - keySize] ^ t) >>> 0;
    }
  }
  return { ks, nRounds };
}
function aesSubBytes(s) { for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]; }
function aesShiftRows(s) { for (let r = 1; r < 4; r++) { const t = [s[r], s[r + 4], s[r + 8], s[r + 12]]; for (let c = 0; c < 4; c++) s[r + 4 * c] = t[(c + r) % 4]; } }
function aesMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = 4 * c, a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = mul2(a0) ^ mul3(a1) ^ a2 ^ a3;
    s[i + 1] = a0 ^ mul2(a1) ^ mul3(a2) ^ a3;
    s[i + 2] = a0 ^ a1 ^ mul2(a2) ^ mul3(a3);
    s[i + 3] = mul3(a0) ^ a1 ^ a2 ^ mul2(a3);
  }
}
function aesAddRoundKey(s, ks, rnd) {
  for (let c = 0; c < 4; c++) { const k = ks[rnd * 4 + c] >>> 0; s[0 + 4 * c] ^= (k >>> 24) & 0xff; s[1 + 4 * c] ^= (k >>> 16) & 0xff; s[2 + 4 * c] ^= (k >>> 8) & 0xff; s[3 + 4 * c] ^= k & 0xff; }
}
function aesEncryptBlock(inp, ks, nRounds) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i];
  aesAddRoundKey(s, ks, 0);
  for (let rnd = 1; rnd < nRounds; rnd++) { aesSubBytes(s); aesShiftRows(s); aesMixColumns(s); aesAddRoundKey(s, ks, rnd); }
  aesSubBytes(s); aesShiftRows(s); aesAddRoundKey(s, ks, nRounds);
  return s;
}
function aesCbcEncrypt(plaintext, keyBuf, ivBuf) {
  const pad = 16 - (plaintext.length % 16);
  const data = Buffer.concat([plaintext, Buffer.alloc(pad, pad)]);
  const { ks, nRounds } = keyExpansion(keyBuf);
  const out = Buffer.alloc(data.length);
  let prev = Buffer.from(ivBuf);
  for (let off = 0; off < data.length; off += 16) {
    const block = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) block[i] = data[off + i] ^ prev[i];
    const enc = aesEncryptBlock(block, ks, nRounds);
    for (let i = 0; i < 16; i++) out[off + i] = enc[i];
    prev = Buffer.from(enc);
  }
  return out.toString('base64');
}

// ============ 配置（全局通用变量无前缀；专属变量用 PAID_ 前缀） ============
// 账号来源：YYB-Go-Enhanced，YYB_SERVER 每行格式为 地址@账号ref[#备注]。
const PAID_TOKENS = (process.env.PAID_TOKENS || '').trim();        // 多行 openid|{"authToken":..,"signKey":..,"degradeToken":..,"userInfo":..}
const PAID_DEBUG  = (process.env.PAID_DEBUG || '').trim() === '1'; // 仅 DEBUG=1 打噪声
const BARK_PUSH   = (process.env.BARK_PUSH || '').trim();
const NOTIFY_ENABLED = (process.env.PAID_NOTIFY || '1').trim() !== '0';
const ACCOUNT_DELAY = process.env.PAID_ACCOUNT_DELAY;
const NOTIFY_ON_FAIL_ONLY = (process.env.NOTIFY_ON_FAIL_ONLY || process.env.PAID_NOTIFY_ON_FAIL_ONLY || 'true').trim().toLowerCase() !== 'false'; // 全局无前缀（YYB 标准栈）；兼容旧 PAID_ 前缀

const APPID = 'wx340f915763f3ed2b';
const SCRIPT_VER = '2026-09-11 14:32';   // 更新脚本此值
const AES_PASS = '123456789aasdfgh';                               // 模块135常量 m.a
const LOGIN_PUBKEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDRxFgN1vGYDSkfH90SI9Ixr1wxyTah3+ShYIDvEL1cI4XCvXHfnBkGb6dQPsiNj1skENyF9zEEWv0jshvgpgNleDzd6vnJRf8LQtolFv4dWXzJwruGTCq6lYTM/K+4E8iaiXarD9z3fsR4nIUcu5QRRY1m//nLhRtxonva/ubO+QIDAQAB
-----END PUBLIC KEY-----`;
const CACHE_FILE = path.join(__dirname, 'PAID_cookies.json');

// ============================== 日志 ==============================
const W = (...a) => process.stdout.write(a.join(' ') + '\n');
const box = (s) => '║ ' + s;
const mask = (o) => (o && o.length > 6 ? o.slice(0, 3) + '***' + o.slice(-3) : o || '');
function dbg(...a){ if (PAID_DEBUG) W('[DBG]', ...a); }

function normalizeServer(raw){
  const value = String(raw || '').trim();
  if (!value) return '';
  return (/^https?:\/\//i.test(value) ? value : `http://${value}`).replace(/\/+$/, '');
}

function parseAccounts(raw){
  const accounts = [];
  String(raw || '').split(/\r?\n/).forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    const at = value.lastIndexOf('@');
    if (at <= 0 || at === value.length - 1) throw new Error(`YYB_SERVER第${index + 1}行格式错误，应为 地址@账号ref`);
    const server = normalizeServer(value.slice(0, at));
    const refPart = value.slice(at + 1).trim();
    const hash = refPart.indexOf('#');
    const ref = (hash >= 0 ? refPart.slice(0, hash) : refPart).trim();
    const note = (hash >= 0 ? refPart.slice(hash + 1) : '').trim();
    if (!server || !ref) throw new Error(`YYB_SERVER第${index + 1}行地址或账号ref为空`);
    accounts.push({ server, ref, note });
  });
  return accounts;
}

// ============================== 加密层 ==============================
function rand16(){ return 'x'.repeat(16).replace(/[x]/g, () => (16 * Math.random() | 0).toString(16)); }

// 登录响应 tokenAesResult 解密（模块200 v.b=function s 精确复刻）:
//   function s(e,t,n){ return AES.decrypt(e, n, { iv: i(t), Pkcs7, CBC }) }
//   登录调用 v.b(p, m.a, v.d(randomKey)) = s(p, m.a, v.d(randomKey))：
//     e=cipher, n(第2个AES参数=KEY)=v.d(randomKey)=Utf8.parse(randomKey),
//     t(用于 iv=i(t))=m.a="123456789aasdfgh" => iv=Utf8.parse("123456789aasdfgh")
//   => AES-128-CBC, key = randomKey(16字节裸密钥), iv = "123456789aasdfgh"(16字节固定IV)
//   （架构: 客户端生成 randomKey 经 RSA 给服务端, 服务端以其作 AES 密钥加密 token）
//   服务端产出为裸密文(前8字节非 Salted__)。已本地用真实 randomKey 验证解出
//   "authToken#signKey#degradeToken#userInfo..."(4段齐全)。
function decryptLoginToken(b64, randomKey){
  const ct = Buffer.from(b64, 'base64');
  const key = Buffer.from(randomKey, 'utf8').slice(0, 16); // randomKey 当 AES 密钥
  const iv  = Buffer.from(AES_PASS, 'utf8').slice(0, 16);  // 口令当固定 IV
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  if (pt.split('#').length >= 4) return pt;
  throw new Error('tokenAesResult 解密后字段不足: ' + pt);
}

// X-EncryptedUserID 加密（模块136 g.a = c.c(c.d(degradeToken), l.a, userInfo+"_"+rand16)）:
//   c.d = Utf8.parse; l.a = "123456789aasdfgh"(固定IV); c.c = AES(CBC, Pkcs7)。
//   用上面内联的纯 JS AES（零依赖，逐字节等同 crypto-js，支持任意「4 的倍数」字节 key）。
function encryptUserID(degradeToken, userInfo){
  if (!degradeToken) return '';                          // 登录前 degradeToken 为空 -> 空串
  const data = Buffer.from(String(userInfo) + '_' + rand16(), 'utf8');
  return aesCbcEncrypt(data, Buffer.from(degradeToken, 'utf8'), Buffer.from(AES_PASS, 'utf8'));
}

// 时间基准：App 所有业务请求 X-Timestamp 均为毫秒级(13位, Date.now())，
let TIME_ANCHOR = null; // { srvMs, localMs }
async function syncServerTime(){
  try {
    const r = await fetch('https://incubator.lifeapp.pingan.com.cn/', { method: 'HEAD' });
    const d = r.headers.get('date');
    if (d){ const srvMs = Date.parse(d); if (!isNaN(srvMs)){ TIME_ANCHOR = { srvMs, localMs: Date.now() }; dbg('SYNCTIME anchor=', new Date(srvMs).toISOString()); return; } }
  } catch (e){ dbg('SYNCTIME fail', e.message); }
}
function nowMs(){
  if (typeof globalThis !== 'undefined' && globalThis.__TS_OVERRIDE__ != null) return globalThis.__TS_OVERRIDE__; // 探针专用（毫秒值）
  if (TIME_ANCHOR) return TIME_ANCHOR.srvMs + (Date.now() - TIME_ANCHOR.localMs);
  return Date.now(); // 毫秒级，与真机一致
}

// 请求签名（模块136 m + 模块22 header builder 精确复刻）
// 参与签名的头(模块22 l()): X-AppId,X-B3-TraceId,X-CV,X-EncryptedUserID,X-OS-Type,X-ReqID,X-Source,X-Timestamp,X-Token
//   —— 全部按 JS 字母序排序拼入(空值也算); POST 额外拼 &reqBody=JSON; 末尾 &signKey=签名口令
function buildHeaders(method, fullUrl, bodyObj, auth){
  // ⚠️ 参与签名的头（模块22 l()：X-Sign 在 X-Source/X-CV/X-OS-Type「之前」计算，
  //    故这三者不进签名串，仅随请求发送）。签名集合 = X-AppId/X-Timestamp/X-B3-TraceId/
  //    X-ReqID/X-Token/X-EncryptedUserID（共6个，与 b(r) 排序后一致）。
  const headers = {
    'X-AppId': APPID,
    'X-Timestamp': String(nowMs()), // ⚠️ 毫秒级(13位, Date.now())：真机抓包确认，/ledong/ 严格按毫秒校验
    'X-B3-TraceId': rand16(),
    'X-ReqID': rand16(),
  };
  headers['X-Token'] = (auth && auth.authToken) ? auth.authToken : '';
  // 探针钩子：globalThis.__UID_OVERRIDE__ 可直接指定 X-EncryptedUserID 明文或密文（用于排查内部网关校验）
  if (typeof globalThis !== 'undefined' && globalThis.__UID_OVERRIDE__ != null){
    const ov = globalThis.__UID_OVERRIDE__;
    headers['X-EncryptedUserID'] = /^[A-Za-z0-9+/=]+$/.test(ov) && ov.length > 40 ? ov : encryptUserID(auth && auth.degradeToken || '', ov);
  } else {
    headers['X-EncryptedUserID'] = (auth && auth.degradeToken) ? encryptUserID(auth.degradeToken || '', auth.userInfo || '') : '';
  }
  const sortedKeys = Object.keys(headers).sort();
  const q = sortedKeys.map(k => k + '=' + headers[k]).join('&');
  const stripped = fullUrl.replace(/^https?:\/\//i, '');
  let signStr;
  if (method === 'GET'){
    // ⚠️  GET 也拼 &reqBody=(空串) 进签名
    signStr = stripped + '&' + q + '&reqBody=&signKey=' + (auth ? auth.signKey : '');
  } else {
    const bodyStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj || {});
    signStr = stripped + '&' + q + '&reqBody=' + bodyStr + '&signKey=' + (auth ? auth.signKey : '');
  }
  headers['X-Sign'] = crypto.createHash('sha256').update(signStr).digest('base64');
  dbg('SIGNSTR=', signStr);
  // 以下三头在签名之后才赋值，仅随请求发送、不参与签名
  headers['X-Source'] = '3';
  headers['X-CV'] = '60800';
  headers['X-OS-Type'] = '04';
  return headers;
}

// ============================== HTTP 层 ==============================
function serverUrl(serverType, apiPath){
  const sub = serverType.replace(/^SpringCloud_/, '').replace(/_internal$/, '');
  return `https://${sub}.lifeapp.pingan.com.cn${apiPath}`;
}

async function callApi(serverType, apiPath, { method = 'GET', data = null, auth = null } = {}){
  let url = serverUrl(serverType, apiPath);
  // GET: 参数拼进 URL query（ r += "?" + queryString），并参与签名
  if (method === 'GET' && data && Object.keys(data).length){
    const qs = new URLSearchParams(data).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = buildHeaders(method, url, method === 'GET' ? null : data, auth);
  const ct = (method === 'POST') ? 'application/x-www-form-urlencoded' : 'application/json'; // 真机 POST 用 x-www-form-urlencoded（空 body 也如此）
  const opts = { method, headers: Object.assign({ 'Content-Type': ct }, headers) };
  if (method === 'POST') opts.body = typeof data === 'string' ? data : JSON.stringify(data || {});
  dbg('REQ', method, url, opts.body || '');
  const resp = await fetch(url, opts);
  // 每次响应都从服务器 Date 头刷新时间锚点：即便启动预同步失败，首个成功的 /external/ 调用也会校正，
  // 后续严格验签接口即可用准时间（规避 NAS 本地钟漂移 → "手机时间不正确"）。
  const dh = resp.headers.get('date');
  if (dh){ const sm = Date.parse(dh); if (!isNaN(sm)){ TIME_ANCHOR = { srvMs: sm, localMs: Date.now() }; dbg('SYNCTIME anchor=', new Date(sm).toISOString()); } }
  const j = await resp.json().catch(() => ({}));
  dbg('RES', apiPath, JSON.stringify(j).slice(0, 600));
  return j;
}

// ============================== 缓存 / 账号 ==============================
function loadCache(){ try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } }
function saveCache(c){ fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); }
function tokensMap(){
  const m = {};
  PAID_TOKENS.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
    const i = line.indexOf('|'); if (i < 0) return;
    const openid = line.slice(0, i).trim(); const json = line.slice(i + 1).trim();
    try { m[openid] = JSON.parse(json); } catch {}
  });
  return m;
}

// 单账号单次取码：直接调用 YYB-Go-Enhanced /wxapp/getCode。
async function yybGetCode(account){
  const resp = await fetch(`${account.server}/wxapp/getCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: account.ref, app_id: APPID }),
  });
  const j = await resp.json().catch(() => ({}));
  const code = j && j.data && j.data.result && j.data.result.code;
  if (!resp.ok || Number(j.code) !== 0 || !code) throw new Error('YYB-Go-Enhanced取code失败: ' + String(j.message || j.msg || `HTTP ${resp.status}`).slice(0, 160));
  dbg('YYB getCode ok', mask(account.ref));
  return code;
}

function parseLogin(resp, randomKey){
  const u = (resp && (resp.DATA || resp.data || resp.result || {}));
  if (u.tokenAesResult){
    const plain = decryptLoginToken(u.tokenAesResult, randomKey);
    const parts = plain.split('#');
    if (parts.length >= 4) return { authToken: parts[0], signKey: parts[1], degradeToken: parts[2], userInfo: parts[3] };
    throw new Error('tokenAesResult 解密后字段不足: ' + plain);
  }
  if (u.encryptOpenId){ return { encryptOpenId: u.encryptOpenId }; } // 仅手机号绑定态，缺完整态
  throw new Error('登录响应无 tokenAesResult/encryptOpenId: ' + JSON.stringify(u).slice(0, 200));
}

async function doLogin(account){
  const code = await yybGetCode(account);
  if (!code) throw new Error('YYB 取 code 失败');
  const randomKey = rand16();
  const rsaResult = crypto.publicEncrypt({ key: LOGIN_PUBKEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(code + '+' + randomKey, 'utf8')).toString('base64');
  // 实测: /user-session 登录接口收 application/x-www-form-urlencoded (非 JSON)，
  // body=rsaResult=<URL编码的base64>，请求头仅带 x-appid/x-timestamp/x-b3-traceid/x-reqid（无 x-sign）。
  const url = 'https://platform.lifeapp.pingan.com.cn/user-session/external/wxMiniProgram/login';
  const body = 'rsaResult=' + encodeURIComponent(rsaResult);
  const headers = {
    'X-AppId': APPID,
    'X-Timestamp': String(nowMs()), // 与 buildHeaders 统一: 毫秒级
    'X-B3-TraceId': rand16(),
    'X-ReqID': rand16(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  dbg('REQ', 'POST', url, body);
  const resp = await fetch(url, { method: 'POST', headers, body });
  const j = await resp.json().catch(() => ({}));
  dbg('RES', '/user-session/external/wxMiniProgram/login', JSON.stringify(j).slice(0, 600));
  if (j.CODE !== '00'){
    // 仅如实回显服务端返回（客户端无法判断是 code 无效 / code2session 失败 / 用户未注册 / 风控）
    throw new Error('登录失败 CODE=' + j.CODE + ' MSG=' + (j.MSG || ''));
  }
  return parseLogin(j, randomKey);
}

// ============================== 业务 ==============================
// 健康币总额（与小程序"我的健康币"页一致；getUserCoins 读 DATA.balance）
//   主源: GET /health-core/ledong/home/getMyPageInfo；兜底: GET /user-auth/wxMiniProgram/getUserInfo
async function getCoinBalance(auth){
  const tryPath = async (server, api) => {
    const j = await callApi(server, api, { method: 'GET', auth });
    if (j.CODE !== '00') return null;
    const d = j.DATA || {};
    for (const k of ['balance', 'coinNum', 'totalCoin', 'healthCoin', 'coin']) {
      if (d[k] != null && d[k] !== '') return Number(d[k]);
    }
    return null;
  };
  let v = await tryPath('SpringCloud_incubator', '/health-core/ledong/home/getMyPageInfo');
  if (v == null) v = await tryPath('SpringCloud_platform', '/user-auth/wxMiniProgram/getUserInfo');
  return v == null ? 0 : v;
}

// 每日签到（POST /health-core/ledong/healthStep/step/completeJgjStepSignInTask，空 body，X-Timestamp 毫秒级）
//   返回 00=成功（计入健康币）；MSG 含"已签到"=今日已签；token 失效返回 CODE=10000「登录失效」
async function doSignIn(auth){
  const j = await callApi('SpringCloud_incubator', '/health-core/ledong/healthStep/step/completeJgjStepSignInTask',
    { method: 'POST', data: '', auth });
  return j;
}
function signAlready(j){
  const s = JSON.stringify(j);
  return /已签到|重复签到|今日已|今天已|already|repeat/i.test(s);
}

// 签到（时间戳/已修正，无需再扫描偏移；此处直接打签到接口）
async function signInSmart(auth){
  return await doSignIn(auth);
}

// 解析任务字段（不同接口字段名不一，做防御性取值）
function taskField(t, names, def){ for (const n of names){ if (t[n] !== undefined && t[n] !== null) return t[n]; } return def; }

// ============================== 单账号运行 ==============================
async function runOne(account, cache, tkmap){
  const openid = account.ref;
  const line = [];           // 本账号输出行
  let auth = null, src = '';
  let success = true, failMsg = '';

  try {
    // ① 兜底 TOKEN（最高优先级：命中即跳过登录、不写缓存，避免污染本地 cookie）
    if (tkmap[openid] && tkmap[openid].authToken){
      auth = tkmap[openid]; src = '兜底TOKEN→直接复用';
      dbg('用兜底TOKEN', openid);
    }
    // ② 缓存（PAID_cookies.json）
    if (!auth && cache[openid] && cache[openid].authToken){
      auth = cache[openid]; src = '缓存有效→复用';
      dbg('用缓存', openid);
    }
    // ③ YYB 登录（仅当无兜底TOKEN、无缓存、或登录首次调用失败）
    if (!auth){
      auth = await doLogin(account); src = 'YYB-Go-Enhanced 登录成功';
      cache[openid] = auth; saveCache(cache);
    }
    line.push('🔑 ' + (tkmap[openid] ? 'TOKENS 兜底有效' : (src.includes('缓存') ? '缓存有效→复用' : '缓存已失效')));
    if (src.includes('YYB')) line.push('✅ YYB-Go-Enhanced 登录成功（已更新缓存）');

    // 初始健康币（用户总币，与"我的健康币"页一致）
    const initBalance = await getCoinBalance(auth);
    line.push('💰 初始健康币: ' + initBalance);

    // 每日签到（最基础动作，独立于任务列表； completeJgjStepSignInTask 为无参 GET）
    //   签到接口严格校验 token：若返回「登录失效」说明缓存已过期 → 清缓存并重登一次（更新 auth 供后续领取用）
    let signCoin = 0, relogged = false;
    const signReport = (sj, tag) => {
      if (sj.CODE === '00'){
        const add = Number(taskField(sj.DATA || {}, ['prizeValue', 'coinNum', 'coin', 'prize', 'rewardValue'], 0));
        signCoin = add;
        line.push('✅ 签到成功' + (add ? ' +' + add + ' 健康币' : '') + (sj.MSG && sj.MSG !== '成功' ? '（' + sj.MSG + '）' : ''));
      } else if (signAlready(sj)){
        line.push('ℹ️ 今日已签到');
      } else {
        // 签到返回非00且非"已签到" → 视为该账号未完成，翻转 success（不可静默降级为 ℹ️）
        success = false; if (failMsg) failMsg += ' | ';
        failMsg = failMsg || ((tag ? tag + ' ' : '') + '签到返回 CODE=' + sj.CODE + ' ' + (sj.MSG || ''));
        line.push('❌' + (tag ? tag + ' ' : ' ') + '签到返回 CODE=' + sj.CODE + ' ' + (sj.MSG || ''));
      }
    };
    try {
      const sj = await signInSmart(auth);
      if (sj.CODE === '10000' && /登录失效|请重新登录/.test(sj.MSG || '') && !relogged){
        relogged = true;
        delete cache[openid]; saveCache(cache);
        auth = await doLogin(account); cache[openid] = auth; saveCache(cache);
        line.push('🔄 缓存失效，已重新 YYB 登录');
        signReport(await signInSmart(auth), '重登后');
      } else {
        signReport(sj, '');
      }
    } catch (e){ success = false; failMsg = e.message || String(e); line.push('❌ 签到异常 ' + failMsg); }

    // 末次余额
    const finalBalance = await getCoinBalance(auth);
    const todayAdd = finalBalance - initBalance;
    line.push(`💰 签到前 ${initBalance}｜本次增加 +${todayAdd >= 0 ? todayAdd : 0}｜当前 ${finalBalance}`);

  } catch (e){
    success = false; failMsg = e.message;
    line.push('❌ 失败: ' + e.message);
    // 运行时失效自愈：清缓存（下次重登）；不在本轮二次取 YYB
    if (cache[openid]) { delete cache[openid]; saveCache(cache); }
  }

  return { line, success, failMsg, openid };
}

// ============================== Bark ==============================
// Bark 推送（YYB 标准栈：BARK_PUSH 四态解析 + NOTIFY_ON_FAIL_ONLY；失败标题带 ⚠️ 标识）
// 四态：①纯 key→官方 /push(+device_key=key)；②官方完整 URL→提取 key；③自建完整 URL→原样不追加 /push；④已带 /push→原样用。
async function pushBark(title, body){
  if (!BARK_PUSH) return;
  const raw = BARK_PUSH.trim();
  let endpoint = raw, key = '';
  if (raw.indexOf('/') === -1){ endpoint = 'https://api.day.app/push'; key = raw; }
  else if (/\/push$/.test(raw)){ endpoint = raw; const m = raw.match(/\/([A-Za-z0-9]+)\/?$/); key = m ? m[1] : ''; }
  else if (raw.includes('api.day.app')){ const m = raw.match(/\/([A-Za-z0-9]+)\/?$/); key = m ? m[1] : ''; endpoint = 'https://api.day.app/push'; }
  else { endpoint = raw; } // 自建完整 URL 原样，不追加 /push
  const chunks = [];
  for (let i = 0; i < body.length; i += 4000) chunks.push(body.slice(i, i + 4000));
  for (let i = 0; i < chunks.length; i++){
    const t = chunks.length > 1 ? `${title} (${i + 1})` : title;
    const payload = { title: t, body: chunks[i], group: title, isArchive: 1 };
    if (key) payload.device_key = key;
    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) }).catch(() => {});
  }
}

function sendQingLongNotify(title, content){
  if (!NOTIFY_ENABLED) return;
  const py = String.raw`
import importlib.util, os, sys
for candidate in ['/ql/data/scripts/notify.py', '/ql/scripts/notify.py', os.path.join(os.getcwd(), 'notify.py')]:
    if not os.path.isfile(candidate):
        continue
    spec = importlib.util.spec_from_file_location('ql_notify', candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sender = getattr(module, 'send', None) or getattr(module, 'sendNotify', None)
    if callable(sender):
        sender(os.environ['PAID_NOTIFY_TITLE'], os.environ['PAID_NOTIFY_CONTENT'])
        sys.exit(0)
sys.exit(2)
`;
  try {
    const result = spawnSync(process.env.PYTHON_BIN || 'python3', ['-c', py], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PAID_NOTIFY_TITLE: title, PAID_NOTIFY_CONTENT: content },
    });
    if (result.status === 0) W('✅ 青龙通知模块调用完成');
    else W('⚠️ 青龙通知失败（不影响签到结果）');
  } catch { W('⚠️ 青龙通知异常（不影响签到结果）'); }
}

// ============================== 主流程 ==============================
async function main(){
  const raw = process.env.YYB_SERVER || '';
  if (!raw.trim()){ W('❌ 未配置 YYB_SERVER，格式：地址@账号ref，多账号一行一个'); process.exitCode = 1; return; }
  const configured = parseAccounts(raw);
  const tkmap = tokensMap();
  const accounts = [...configured];
  for (const ref of Object.keys(tkmap)) if (!accounts.some(a => a.ref === ref)) accounts.push({ server: '', ref, note: '兜底TOKEN' });
  if (!accounts.length){ W('❌ YYB_SERVER 中没有有效账号'); process.exitCode = 1; return; }

  await syncServerTime(); // 拉服务器时间锚点（规避 NAS 本地钟漂移 → "手机时间不正确"）

  const cache = loadCache();
  const total = accounts.length;
  W('╔══════════════════════════════════════════════╗');
  W('║       平安i动 健康币  账号数: ' + total + '            ║');
  W('╚══════════════════════════════════════════════╝');
  W('📌 脚本版本: ' + SCRIPT_VER + ' ｜ ' + new Date().toLocaleString('zh-CN', { hour12: false }));

  let okCount = 0; const notifyBlocks = [];
  for (let idx = 0; idx < accounts.length; idx++){
    const account = accounts[idx];
    const openid = account.ref;
    W('──────── 账号' + (idx + 1) + ' ────────');
    const r = await runOne(account, cache, tkmap);
    r.line.forEach(l => W(l));
    if (r.success) okCount++;
    const accountTitle = `【账号${idx + 1}${account.note ? ` · ${account.note}` : ''}】`;
    const signLine = r.line.find(l => /签到成功|今日已签到|签到返回|签到异常|失败:/.test(l));
    const coinLine = r.line.find(l => l.startsWith('💰 签到前'));
    notifyBlocks.push([
      accountTitle,
      r.success ? '✅ 执行成功' : '❌ 执行失败',
      signLine,
      coinLine,
    ].filter(Boolean).join('\n'));
    if (idx < accounts.length - 1){
      const configuredDelay = ACCOUNT_DELAY === undefined ? NaN : Number(ACCOUNT_DELAY);
      const s = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 10 + Math.floor(Math.random() * 9);
      if (s > 0){ W(`（等待 ${s}s）`); await new Promise(res => setTimeout(res, s * 1000)); }
    }
  }

  const allOk = okCount === total;
  W('══════════════════════════════════════════════');
  W('════ 完成 ' + (allOk ? '全部成功 ✅' : `存在失败 ❌ (${okCount}/${total})`));
  const summary = [
    `📅 执行时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `👥 账号总数：${total}`,
    `✅ 成功：${okCount}`,
    `❌ 失败：${total - okCount}`,
    '',
    ...notifyBlocks.flatMap((block, index) => index === notifyBlocks.length - 1 ? [block] : [block, '']),
  ].join('\n');
  const pushTitle = '平安i动签到';
  if (BARK_PUSH && (!NOTIFY_ON_FAIL_ONLY || !allOk)) await pushBark(pushTitle, summary);
  sendQingLongNotify(pushTitle, summary);
  if (!allOk) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { W('❌ 运行异常: ' + e.message); process.exit(1); });

module.exports = { doLogin, buildHeaders, callApi, decryptLoginToken, encryptUserID, serverUrl, rand16, APPID, AES_PASS, loadCache };
