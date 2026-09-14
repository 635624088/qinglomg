/*
知了快看 - 多号免登版
环境变量:
KK_USERS: 知了快看账号列表,逗号或换行分隔(必填)
KK_MINUTES: 单账号阅读时长上限(分钟), 默认30
*/
const $ = new Env('知了快看');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const { log } = console;
const Notify = 1;
const debug = 0;

// ==================== 知了快看配置 ====================
const APPID = 'wxdb76b366c1f1b2e4';
const LEMON = 'https://lemon-api.52leho.com';
const APP_PKG = 'new.liao.view';
const UA = 'android';

// APK签名证书SPKI的base64urlsafe (固定常量)
const SPKI_B64 = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1E_mX-gaRQSNkmvPplyoSaa2k019s5jvfkw940Tf_gmjmxDQPyqJOePqK9gvA4lM0tdU5vGCCcQB6PgdgfIyhzs20kJzWSHtNJ0TvcM4f269UGVpZ0Ju8ErIy_ST6bFJLKLZzLewcttJUPwfvbeMtlKzDXa74zRkQqHS9MGZ4inKaFFILtOwFtJYHRzYRU5ctUP790FcxevpFK-q15AXS3kRARqLmPUeh_BQUSqOZwMsMtMWyz56-c6ZBsLWKFGehfVjfZcAGVjeZ3nsEesXQf8J3xFFgULu9sj0OuYgjolaRTdO9RJ-DMUWDwjdUAJLwaHPWZF2GsrixncrL9S8VQIDAQAB";

const VERSION2_KEY = "jdvylqchJZrfw0o2DgAbsmCGUapF1YChc";
const VERSION6_KEY = "zWpfzystJLrfw7o3SgGlMmGGPupK2YLhB";
const VERSION15_KEY = "AAAAB3NzaC1yc2EAAAADAQABAAABAQC1WAth281wjZj5XhGU9Iza5EXzOy5U/AKgGxF14svnCEWrTH6i3lZd+lMTFLvTakGI5l1RJmutFRku6CvDVCEc7dJURVWsrgQTFNBuu0t5WOkoUY0zNa05pejDmBC4w4MscH2OexCrKfHNEYi/FpjBJv1bwjU0luxt/cvsjBjlthgY47I4KNy+T953CpBiYQmkSJZUBzsN2Zz+jEA+CvLEK9BPHBlKcz0GupalgnHHSnS/JoUz8+RTjZr1O2sjSyrcg0LL+vWeCnJN07Uv4jJaTDqc6Ig1Mw+TJrrsARxoA+Frc66Qo7GFxACimuJ1LeCc9iFlMzZNZly3JxYAR019";

const RND = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 运行参数
const BRUSH_INTERVAL = 8;
const READTIME_SECONDS = 300;
const BRUSH_SUBMIT_SECONDS = 60;
let MINUTES = parseInt(process.env.KK_MINUTES || '30');
const WITHDRAW_TARGET = parseFloat(process.env.KK_WITHDRAW_TARGET || '1.5');
let KK_USERS = ($.isNode() ? process.env.KK_USERS : $.getdata("KK_USERS")) || "";
let uidList = [];
let msg = '';
var hours = new Date().getMonth();
var timestamp = Math.round(new Date().getTime()).toString();

// ==================== 加密/解密 ====================
function uzw(c) {
    let b64 = SPKI_B64;
    let s = b64.substring(9);
    s = s.substring(0, s.length - 5);
    s = s.substring(s.length - 36);
    s = s.substring(0, s.length - (c.charCodeAt(0) % 10));
    return s;
}

function desKeyFor(c) {
    return CryptoJS.enc.Utf8.parse(uzw(c).substring(0, 8));
}

function aesKey() {
    return CryptoJS.enc.Utf8.parse(uzw("a").substring(0, 16));
}

// URLEncoder (Java风格)
function _jenc(v) {
    let bs = Buffer.from(String(v), 'utf-8');
    let out = '';
    for (let b of bs) {
        if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 46 || b === 95 || b === 126) {
            out += String.fromCharCode(b);
        } else if (b === 0x20) {
            out += '+';
        } else {
            out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return out;
}

function encParamsStr(params) {
    return Object.entries(params).filter(([k, v]) => String(v).length > 0).map(([k, v]) => k + '=' + _jenc(v)).join('&');
}

// ar.aor: DES/CBC/PKCS5Padding
function arAor(keyStr, paramsStr) {
    let md5k = CryptoJS.MD5(CryptoJS.enc.Utf8.parse(keyStr)).toString();
    let md5kBytes = CryptoJS.enc.Hex.parse(md5k);
    let md5k8 = md5kBytes.clone();
    md5k8.sigBytes = 8;
    md5k8.words.length = 2;
    // urlsafe base64 of first 8 bytes
    let str3 = CryptoJS.enc.Base64.stringify(md5k8).replace(/\+/g, '-').replace(/\//g, '_');
    let iv = CryptoJS.enc.Utf8.parse(str3.substring(0, 8));
    let desKey = CryptoJS.enc.Utf8.parse(keyStr.substring(0, 8));
    let encrypted = CryptoJS.DES.encrypt(CryptoJS.enc.Utf8.parse(paramsStr), desKey, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    });
    let ctB64 = encrypted.ciphertext.toString(CryptoJS.enc.Base64).replace(/\+/g, '-').replace(/\//g, '_');
    return str3 + ctB64;
}

// mou.aor: c + inner + random tail
function mouAor(c, inner) {
    let i = (c.charCodeAt(0) % 10) % 3;
    let tail = '';
    for (let j = 0; j < i; j++) tail += RND[Math.floor(Math.random() * RND.length)];
    return c + inner + tail;
}

// og(str): 完整加密
function encryptStr(plaintext) {
    let cFtr = RND[Math.floor(Math.random() * RND.length)];
    let key = uzw(cFtr);
    let inner = arAor(key, plaintext);
    return mouAor(cFtr, inner);
}

function buildParam(params, extra) {
    let p = Object.assign({}, params);
    if (extra) Object.assign(p, extra);
    return encryptStr(encParamsStr(p));
}

// 签名: MD5(sorted key=value + secret)
function signSortedMd5(params, tail) {
    tail = tail || VERSION2_KEY;
    let keys = Object.keys(params).filter(k => k !== 'sign').sort();
    let s = keys.map(k => k + '=' + params[k]).join('');
    return CryptoJS.MD5(s + tail).toString();
}

function tokenSortedMd5(params, tail) {
    tail = tail || VERSION6_KEY;
    let keys = Object.keys(params).filter(k => k !== 'token').sort();
    let s = keys.map(k => k + '=' + params[k]).join('');
    return CryptoJS.MD5(s + tail).toString();
}

function makeJwt(claims, key) {
    key = key || VERSION15_KEY;
    let header = CryptoJS.enc.Base64url.stringify(
        CryptoJS.enc.Utf8.parse(JSON.stringify({ typ: "JWT", alg: "HS512" }))
    ).replace(/=+$/, '');
    let sortedClaims = {};
    Object.keys(claims).filter(k => claims[k] !== '').sort().forEach(k => sortedClaims[k] = _jenc(claims[k]));
    let payload = CryptoJS.enc.Base64url.stringify(
        CryptoJS.enc.Utf8.parse(JSON.stringify(sortedClaims))
    ).replace(/=+$/, '');
    let signingInput = header + '.' + payload;
    let sig = CryptoJS.HmacSHA512(signingInput, CryptoJS.enc.Utf8.parse(key));
    let sigB64 = CryptoJS.enc.Base64url.stringify(sig).replace(/=+$/, '');
    return signingInput + '.' + sigB64;
}

// 解密响应: AES/ECB
function decResp(text) {
    text = text.trim();
    if (text.startsWith('{')) {
        try { return JSON.parse(text); } catch (e) {}
    }
    let raw = CryptoJS.enc.Base64.parse(text);
    let key = aesKey();
    let decrypted = CryptoJS.AES.decrypt(
        CryptoJS.lib.CipherParams.create({ ciphertext: raw }),
        key,
        { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    let plain = decrypted.toString(CryptoJS.enc.Utf8);
    return JSON.parse(plain);
}

// 解密zqkd_param (用于反向解析)
function decParam(val) {
    let cFtr = val[0];
    let rest = val.substring(1);
    let i = (cFtr.charCodeAt(0) % 10) % 3;
    if (i) rest = rest.substring(0, rest.length - i);
    let str3 = rest.substring(0, 12);
    let body = rest.substring(12);
    let iv = CryptoJS.enc.Utf8.parse(str3.substring(0, 8));
    let desKey = CryptoJS.enc.Utf8.parse(uzw(cFtr).substring(0, 8));
    let raw = CryptoJS.enc.Base64.parse(body.replace(/-/g, '+').replace(/_/g, '/'));
    let decrypted = CryptoJS.DES.decrypt(
        CryptoJS.lib.CipherParams.create({ ciphertext: raw }),
        desKey,
        { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );
    let plain = decrypted.toString(CryptoJS.enc.Utf8);
    let out = {};
    for (let seg of plain.split('&')) {
        if (!seg) continue;
        let idx = seg.indexOf('=');
        if (idx >= 0) out[seg.substring(0, idx)] = seg.substring(idx + 1);
    }
    return out;
}

// ==================== 设备信息 ====================
let DEVICE = {
    access: "WIFI", androidid: "00907b0b04beb83d",
    app_version: "1.7.5", "app-version": "1.7.5",
    app_device_id: "5RSUgUUsmJw", app_name: "new_liao_view",
    app_pkg: "new.liao.view", channel: "c1006", channel_code: "c1006",
    dev_mode: "1", device_brand: "OnePlus", device_id: "49443231",
    device_model: "LE2110", device_platform: "android", device_type: "android",
    dpi: "3.0", inner_version: "202608191646", is_debug: "0",
    language: "zh-CN", memory: "10", mi: "0", mobile_type: "1",
    network_type: "WIFI", oaid: "BF931C48C0814E07AAB062D928DD76A1870155a4c96f42012bff4c72f9fbd3d0",
    openudid: "00907b0b04beb83d", os_api: "33",
    os_version: "LE2110_13.1.0.190(CN01)", phone_sim: "2",
    resolution: "1080x2249", rom_version: "LE2110_13.1.0.190(CN01)",
    s_ad: "", s_im: "", sim: "2",
    sm_device_id: "20260717163158439064ba8464b6f6b550947be8cc593a012baacd27f6fceb",
    storage: "221.28", uid: "", account: "", union_id: "", user_cert: "1",
    version_code: "45", zqkey: "", zqkey_id: "",
};
let DEVICE_DEFAULT = Object.assign({}, DEVICE);

// 账号凭据 (登录后填充)
let AUTH = {};
let SESSION = "";

function resetAuth() {
    AUTH = {};
    SESSION = "";
    DEVICE = Object.assign({}, DEVICE_DEFAULT);
}

// ==================== HTTP层 ====================
function captureSession(resp) {
    let cookies = resp.headers['set-cookie'] || [];
    if (!Array.isArray(cookies)) cookies = [cookies];
    for (let c of cookies) {
        let head = c.split(';')[0].trim();
        if (head.toLowerCase().startsWith('phpsessid=')) {
            let val = head.substring('PHPSESSID='.length);
            if (val && val !== SESSION) {
                SESSION = val;
                log('→ 会话已建立');
            }
            return;
        }
    }
}

async function httpPost(path, taskKey, runtimeExtra, signMode) {
    signMode = signMode || getSignMode(taskKey);
    let params = getTaskParams(taskKey);
    if (runtimeExtra) Object.assign(params, runtimeExtra);

    let common = Object.assign({}, DEVICE, AUTH);
    common.request_time = String(Math.floor(Date.now() / 1000));
    if (!common.uid) { delete common.uid; delete common.account; }

    let zq;
    if (signMode === 'md5') {
        common.sign = signSortedMd5(Object.assign({}, common, params));
        zq = buildParam(common, params);
    } else if (signMode === 'jwt') {
        common.token = makeJwt(Object.assign({}, common, params));
        zq = buildParam(common, params);
    } else if (signMode === 'token') {
        common.token = tokenSortedMd5(Object.assign({}, common, params));
        zq = buildParam(common, params);
    } else {
        zq = buildParam(common, params);
    }

    let url = LEMON + path;
    let data = 'zqkd_param=' + encodeURIComponent(zq);
    let headers = {
        'User-Agent': UA, 'device-platform': 'android', 'app-pkg': APP_PKG,
        'Accept-Encoding': 'gzip', 'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (SESSION) headers['Cookie'] = 'PHPSESSID=' + SESSION;

    if (debug) log('[调试] POST ' + url + ' sign=' + (common.sign || common.token || 'none'));

    try {
        let resp = await axios.post(url, data, { headers, timeout: 30000, validateStatus: s => s < 600 });
        captureSession(resp);
        let text = resp.data;
        if (typeof text === 'object') return text;
        return decResp(text);
    } catch (e) {
        log('  ✖ 网络异常: ' + e.message);
        return { success: false, error: e.message };
    }
}

async function httpGet(path, taskKey, runtimeExtra) {
    let signMode = getSignMode(taskKey);
    let params = getTaskParams(taskKey);
    if (runtimeExtra) Object.assign(params, runtimeExtra);

    let common = Object.assign({}, DEVICE, AUTH);
    common.request_time = String(Math.floor(Date.now() / 1000));
    if (!common.uid) { delete common.uid; delete common.account; }

    let zq;
    if (signMode === 'md5') {
        common.sign = signSortedMd5(Object.assign({}, common, params));
        zq = buildParam(common, params);
    } else if (signMode === 'jwt') {
        common.token = makeJwt(Object.assign({}, common, params));
        zq = buildParam(common, params);
    } else {
        zq = buildParam(common, params);
    }

    let url = LEMON + path + '?zqkd_param=' + encodeURIComponent(zq);
    let headers = { 'User-Agent': UA, 'device-platform': 'android', 'app-pkg': APP_PKG, 'Accept-Encoding': 'gzip' };
    if (SESSION) headers['Cookie'] = 'PHPSESSID=' + SESSION;

    try {
        let resp = await axios.get(url, { headers, timeout: 30000, validateStatus: s => s < 600 });
        captureSession(resp);
        let text = resp.data;
        if (typeof text === 'object') return text;
        return decResp(text);
    } catch (e) {
        log('  ✖ 网络异常: ' + e.message);
        return { success: false, error: e.message };
    }
}

// ==================== 任务配置 ====================
const TASK_CFG = {
    login: { sign_mode: 'md5', params: { ab_type: '', action: 'login', platform: '3', appid: APPID, is_new_version: '0' } },
    scoreTime: { sign_mode: 'md5', params: { type: '1', time: String(BRUSH_SUBMIT_SECONDS) } },
    readTime: { sign_mode: 'md5', params: { type: '2', time: String(READTIME_SECONDS) } },
    readScore: { sign_mode: 'md5', params: {} },
    readWithdraw: { sign_mode: 'md5', params: { type: '2' } },
    userinfo: { sign_mode: 'md5', params: {}, method: 'GET' },
    userdata: { sign_mode: 'md5', params: {}, method: 'GET' },
    bonusWithdraw: { sign_mode: 'jwt', params: { type: '61' } },
    getPaymentList: { sign_mode: 'jwt', params: {} },
    redWithdraw: { sign_mode: 'jwt', params: { type: '__DYNAMIC__', score: '__DYNAMIC__' } },
    getTaskList: { sign_mode: 'jwt', params: { install_alipay: '1' } },
    machine: { sign_mode: 'md5', params: {} },
    configInfo: { sign_mode: 'none', params: {}, method: 'GET' },
    configAudit: { sign_mode: 'jwt', params: {} },
    configDid: { sign_mode: 'jwt', params: {} },
    countStart: { sign_mode: 'md5', params: {} },
    getinfo: { sign_mode: 'none', params: {}, method: 'GET' },
    mediaConfig: { sign_mode: 'none', params: {}, method: 'GET' },
    appUpdate: { sign_mode: 'jwt', params: {} },
    readRewardClaim: { sign_mode: 'md5', params: { action: 'task_score_optimize', param: '', video_id: '0', media_extra: '', extra: '' } },
    readWithdrawClaim: { sign_mode: 'md5', params: { action: 'read_withdraw', param: '', video_id: '0', media_extra: '', extra: '' } },
};

function getSignMode(taskKey) {
    return (TASK_CFG[taskKey] || {}).sign_mode || 'none';
}

function getTaskParams(taskKey) {
    return Object.assign({}, (TASK_CFG[taskKey] || {}).params || {});
}

function brief(r) {
    if (!r || typeof r !== 'object') return String(r).substring(0, 80);
    let code = r.code || r.error_code;
    let m = r.message || '';
    if (code == 0 || m === '执行成功' || m === 'success') return '成功';
    if (m) return m;
    return JSON.stringify(r).substring(0, 80);
}

function toFloat(v) {
    try { return parseFloat(v); } catch (e) { return null; }
}

// ==================== Bot ====================
class Bot {
    constructor() {
        this.totalSeconds = 0;
        this.username = '';
        this.stats = { cash_gained: 0, withdraw_amount: 0, withdraw_ok: false };
    }

    async loginWithWechatCode(code) {
        let r = await httpPost('/v3/user/auth/login.json', 'login', { code: code });
        if (r.success && r.items) {
            let items = r.items;
            AUTH.uid = String(items.uid || '');
            AUTH.account = AUTH.uid;
            AUTH.union_id = items.union_id || '';
            AUTH.zqkey = items.zqkey || items.token || '';
            AUTH.zqkey_id = items.zqkey_id || items.token_id || '';
            AUTH.user_cert = items.user_cert || '1';
            log('✔ 认证成功: uid=' + AUTH.uid);
            return true;
        }
        log('✖ 认证失败: ' + brief(r));
        return false;
    }

    async getUserinfo() {
        let r = await httpGet('/v3/user/userinfo.json', 'userinfo');
        let items = r.items || {};
        this.username = items.nickname || '';
        return { nickname: this.username, treasury: toFloat(items.mini_balance), raw: r };
    }

    async getCashBalance() {
        try {
            let r = await httpGet('/v15/user/userdata.json', 'userdata');
            let items = r.items || {};
            let bal = toFloat(items.mini);
            if (bal !== null) return bal;
        } catch (e) {}
        try {
            let u = await this.getUserinfo();
            return u.treasury;
        } catch (e) { return null; }
    }

    async readTimeOnce() {
        return await httpPost('/v18/feed/readTime.json', 'readTime');
    }

    async scoreTimeOnce() {
        return await httpPost('/v18/feed/scoreTime.json', 'scoreTime');
    }

    async queryCashTask() {
        let r = await httpPost('/v18/task/readWithdraw.json', 'readWithdraw', { type: '2' });
        let items = r.items || {};
        let lst = items.list || [];
        let milestones = lst.map(m => ({
            score: m.score, value: parseInt(m.value || 0),
            status: parseInt(m.status || 0), title: m.title || ''
        }));
        let claimable = milestones.filter(m => m.status === 1);
        let allDone = milestones.length > 0 && !milestones.some(m => m.status === 0);
        return { milestones, claimable, all_done: allDone, title: items.title || '' };
    }

    async claimAllCashStages() {
        let gained = 0;
        let attempts = 0;
        const MAX_ATTEMPTS = 60;
        const rateKeys = ['不要着急', '着急', '频繁', '太快', '过快', '稍后', '稍等', '稍候', '请稍', 'retry', 'limit', '操作过快', 'too frequent', 'rate'];
        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            let info = await this.queryCashTask();
            if (!info.claimable.length) {
                let left = info.milestones.filter(m => m.status === 0).length;
                log('  → 无待领阶段 (剩余 ' + left + ' 未达成)');
                break;
            }
            let g = await httpPost('/v5/CommonReward/toGetReward.json', 'readWithdrawClaim', {
                media_extra: JSON.stringify({
                    media_app_id: "sspJA8HT1eIS373e", media_scene_id: "010",
                    media_slot_id: "20120118", media_verify: "",
                    position_id: "1032", slot_platform: "BQT",
                    slot_price: String(Math.round(Math.random() * 19999.9 + 20000, 1)),
                    slot_type: "RewardVideo", tactics_mold: "bidding"
                })
            });
            let gItems = g.items || {};
            let sc = gItems.score;
            if (g.success || g.error_code == 0) {
                let amt = parseFloat(sc) || 0;
                gained += amt;
                log('  → 到账 +' + sc + '元 (累计 ' + gained.toFixed(2) + '元)');
                await this.maybeWithdraw(false);
                continue;
            }
            let m = String(g.message || '');
            if (rateKeys.some(k => m.includes(k))) {
                let wait = 15 + Math.random() * 5;
                log('  → 频率限制, ' + wait.toFixed(0) + 's 后重试');
                await $.wait(wait * 1000);
                continue;
            }
            log('  → 领取失败: ' + m);
            break;
        }
        if (gained) log('→ 本轮共到账 ' + gained.toFixed(2) + ' 元');
        this.stats.cash_gained = gained;
        return gained;
    }

    async brushUntilStagesFull(capMinutes) {
        let total = 12;
        let n = 0;
        let lastReachable = -1;
        let stable = 0;
        let capRounds = Math.max(10, Math.floor((capMinutes || MINUTES) * 60 / Math.max(READTIME_SECONDS, 1)));
        log('→ 任务目标: 12阶段全满 | 每' + BRUSH_INTERVAL + 's上报' + READTIME_SECONDS + 's | 上限' + capRounds + '轮');
        while (n < capRounds) {
            let r = await this.readTimeOnce();
            let ok = r.success || r.code == 0 || r.code == 200 || r.data || r.items;
            n++;
            if (n % 2 === 0 || !ok) {
                let info = await this.queryCashTask();
                let reachable = info.milestones.filter(m => m.status !== 0).length;
                let claimN = info.claimable.length;
                log('  轮次 ' + n + ': ' + brief(r) + ' | 进度 ' + reachable + '/' + total + ' | 可领 ' + claimN);
                if (reachable >= total) {
                    log('→ 12阶段已全部达成, 停止上报');
                    break;
                }
                if (reachable === lastReachable) {
                    stable++;
                    if (stable >= 3) {
                        log('→ 进度稳定于 ' + reachable + ' (疑似上限), 转结算');
                        break;
                    }
                } else {
                    stable = 0;
                    lastReachable = reachable;
                }
            } else {
                log('  轮次 ' + n + ': ' + brief(r));
            }
            if (!ok) log('  ⚠ 上报未确认');
            await $.wait(BRUSH_INTERVAL * 1000);
        }
        log('→ 阅读结束, 共 ' + n + ' 轮');
    }

    async withdrawCash(amountYuan, username) {
        let cents = Math.round(parseFloat(amountYuan) * 100);
        if (cents <= 0) { log('  → 提取金额无效'); return false; }
        let common = Object.assign({}, DEVICE, AUTH);
        common.request_time = String(Math.floor(Date.now() / 1000));
        let business = { score: String(cents), type: '61', username: username || '' };
        let allp = Object.assign({}, common, business);
        let token = makeJwt(Object.assign({}, allp));
        allp.token = token;
        let zq = buildParam(allp);
        let url = LEMON + '/v17/UserRed/bonusWithdraw.json';
        let data = 'zqkd_param=' + encodeURIComponent(zq);
        let headers = {
            'User-Agent': UA, 'device-platform': 'android', 'app-pkg': APP_PKG,
            'Accept-Encoding': 'gzip', 'Content-Type': 'application/x-www-form-urlencoded',
        };
        if (SESSION) headers['Cookie'] = 'PHPSESSID=' + SESSION;
        try {
            let resp = await axios.post(url, data, { headers, timeout: 30000, validateStatus: s => s < 600 });
            captureSession(resp);
            let r = decResp(resp.data);
            if (r.success || r.error_code == 0) {
                log('  → 提取成功: ' + amountYuan + '元 → 微信');
                this.stats.withdraw_amount += parseFloat(amountYuan);
                this.stats.withdraw_ok = true;
                return true;
            }
            log('  → 提取失败: ' + brief(r));
            return false;
        } catch (e) {
            log('  → 提取异常: ' + e.message);
            return false;
        }
    }

    async maybeWithdraw(taskEnded) {
        let bal = await this.getCashBalance();
        if (bal === null) { log('  → 余额查询失败'); return false; }
        if (taskEnded) {
            if (bal > 0.1) {
                log('  → 结束, 余额 ' + bal + '元 > 0.1, 发起提取');
                return await this.withdrawCash(bal, this.username);
            }
            log('  → 结束, 余额 ' + bal + '元 <= 0.1, 跳过');
            return false;
        }
        if (bal >= 0.8) {
            log('  → 余额 ' + bal + '元 >= 0.8, 发起提取');
            return await this.withdrawCash(bal, this.username);
        }
        log('  → 余额 ' + bal + '元 < 0.8, 暂不提取');
        return false;
    }

    async getRedPaymentList() {
        let common = Object.assign({}, DEVICE, AUTH);
        common.request_time = String(Math.floor(Date.now() / 1000));
        let business = {};
        let allp = Object.assign({}, common, business);
        let token = makeJwt(Object.assign({}, allp));
        allp.token = token;
        let zq = buildParam(allp);
        let url = LEMON + '/v17/UserRed/getPaymentList.json';
        let data = 'zqkd_param=' + encodeURIComponent(zq);
        let headers = {
            'User-Agent': UA, 'device-platform': 'android', 'app-pkg': APP_PKG,
            'Accept-Encoding': 'gzip', 'Content-Type': 'application/x-www-form-urlencoded'
        };
        if (SESSION) headers['Cookie'] = 'PHPSESSID=' + SESSION;
        try {
            let resp = await axios.post(url, data, { headers, timeout: 30000, validateStatus: s => s < 600 });
            captureSession(resp);
            let r = decResp(resp.data);
            if (r.success || r.error_code == 0) {
                return r.items || {};
            }
            return {};
        } catch (e) {
            return {};
        }
    }

    async redWithdraw(amountYuan) {
        let items = await this.getRedPaymentList();
        let bal = items.red;
        let balF = parseFloat(bal);
        if (isNaN(balF)) {
            let fallback = await this.getCashBalance();
            if (fallback !== null) {
                balF = fallback;
                log('  → 支付列表未返回, 用钱包余额 ' + fallback + '元兜底');
            }
        }
        let redPay = items.red_payment || [];
        if (bal !== undefined) {
            log('\n→ 红包: ' + bal + '元 | 目标提取: ' + amountYuan + '元');
        } else {
            log('\n→ 红包余额未返回(沿用档位), 目标提取: ' + amountYuan + '元');
        }
        // 抓包实证红包提现档位
        let TIERS = { 0.3: ['40', '30'], 1.5: ['41', '150'], 10.0: ['42', '1000'] };
        let target = null;
        for (let p of redPay) {
            if (Math.abs(parseFloat(p.money) - amountYuan) < 1e-6) {
                target = p; break;
            }
        }
        if (!target) {
            let best = Object.keys(TIERS).map(Number).reduce((a, b) =>
                Math.abs(b - amountYuan) < Math.abs(a - amountYuan) ? b : a);
            if (Math.abs(best - amountYuan) < 1e-6) {
                target = { type: TIERS[best][0], score: TIERS[best][1], money: best };
            }
        }
        if (!target) {
            log('  → 未找到金额 ' + amountYuan + '元的提取档位');
            return false;
        }
        let typ = String(target.type);
        let score = String(target.score);
        let amt = target.money;
        if (!isNaN(balF) && balF + 1e-9 < amt) {
            log('  → 红包余额不足 ' + balF + '元 < ' + amt + '元, 跳过');
            return false;
        }
        log('  → 选档 type=' + typ + '/score=' + score);
        let common = Object.assign({}, DEVICE, AUTH);
        common.request_time = String(Math.floor(Date.now() / 1000));
        let business = { type: typ, score: score, username: this.username || '' };
        let allp = Object.assign({}, common, business);
        let token = makeJwt(Object.assign({}, allp));
        allp.token = token;
        let zq = buildParam(allp);
        let url = LEMON + '/v17/UserRed/redWithdraw.json';
        let data = 'zqkd_param=' + encodeURIComponent(zq);
        let headers = {
            'User-Agent': UA, 'device-platform': 'android', 'app-pkg': APP_PKG,
            'Accept-Encoding': 'gzip', 'Content-Type': 'application/x-www-form-urlencoded'
        };
        if (SESSION) headers['Cookie'] = 'PHPSESSID=' + SESSION;
        try {
            let resp = await axios.post(url, data, { headers, timeout: 30000, validateStatus: s => s < 600 });
            captureSession(resp);
            let r = decResp(resp.data);
            if (r.success || r.error_code == 0) {
                log('  → 红包提取成功: ' + amt + '元 → 微信 (单号' + ((r.items || {}).order_id || '') + ')');
                this.stats.withdraw_amount += parseFloat(amt);
                this.stats.withdraw_ok = true;
                return true;
            }
            log('  → 红包提取失败: ' + brief(r));
            return false;
        } catch (e) {
            log('  → 红包提取异常: ' + e.message);
            return false;
        }
    }

    async maybeWithdrawTarget() {
        return await this.redWithdraw(WITHDRAW_TARGET);
    }

    // 启动初始化序列
    async initSequence() {
        let seq = [
            () => httpGet('/v15/config/info.json', 'configInfo'),
            () => httpGet('/v3/user/getinfo.json', 'getinfo'),
            () => httpPost('/v15/config/audit.json', 'configAudit'),
            () => httpGet('/v15/config/media_config.json', 'mediaConfig'),
            () => httpPost('/v15/config/did.json', 'configDid'),
            () => httpPost('/v6/count/start.json', 'countStart'),
        ];
        for (let fn of seq) {
            try { await fn(); } catch (e) {}
            await $.wait(500 + Math.random() * 1000);
        }
    }

    async run() {
        // 启动初始化
        await this.initSequence();

        // 取昵称
        try {
            let ui = await this.getUserinfo();
            log('→ 用户: ' + this.username + ' | 钱包: ' + (ui.treasury || '未知') + '元');
        } catch (e) {
            log('⚠ 用户信息获取失败: ' + e.message);
        }

        // 主流程: 刷到12阶段填满 -> 领取 -> 判定 -> 收尾提现
        let lastClaimed = -1, lastReachable = -1, stuck = 0;
        for (let cycle = 0; cycle < 12; cycle++) {
            try { await httpPost('/v17/TaskScoreOptimize/getTaskList.json', 'getTaskList'); } catch (e) {}
            try { await httpPost('/v15/config/machine.json', 'machine'); } catch (e) {}

            // 刷时长
            await this.brushUntilStagesFull(MINUTES);

            // 领取
            log('\n----------- 第' + (cycle + 1) + '轮结算 -----------');
            await this.claimAllCashStages();

            // 判定
            let info = await this.queryCashTask();
            let claimed = info.milestones.filter(m => m.status === 2).length;
            let reachable = info.milestones.filter(m => m.status !== 0).length;
            log('→ 进度 #' + (cycle + 1) + ': 已领 ' + claimed + '/12 | 可达 ' + reachable + '/12');
            if (info.all_done || claimed >= 12) {
                log('→ 12阶段全部结算完成');
                break;
            }
            if (claimed === lastClaimed && reachable === lastReachable) {
                stuck++;
                if (stuck >= 2) { log('→ 连续无新增, 停止'); break; }
            } else { stuck = 0; }
            lastClaimed = claimed;
            lastReachable = reachable;
        }

        // 收尾提现
        let info = await this.queryCashTask();
        let allDone = info.all_done || info.milestones.filter(m => m.status === 2).length >= 12;
        log('\n→ 结束判定: 全部完成=' + allDone);
        await this.maybeWithdraw(allDone);

        // 红包余额提现(目标金额)
        try { await this.maybeWithdrawTarget(); } catch (e) { log('→ 红包提取异常: ' + e.message); }

        log('✔ 账号处理完成');

        // 通知
        let bal = await this.getCashBalance();
        let balStr = bal !== null ? bal + '元' : '未知';
        msg += '\n账号: ' + (this.username || AUTH.uid || '未知') + '\n';
        msg += '阅读领现金: ' + this.stats.cash_gained.toFixed(2) + '元\n';
        msg += '提现: ' + (this.stats.withdraw_ok ? this.stats.withdraw_amount + '元' : '未提现') + '\n';
        msg += '钱包余额: ' + balStr;
    }
}

// ==================== 入口 ====================
async function checkEnvs() {
    if (!KK_USERS) { log('✖ 未配置 KK_USERS 账号列表'); return false; }
    uidList = KK_USERS.replace(/\\n/g, '\n').replace(/,/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
    if (uidList.length === 0) { log('✖ KK_USERS 解析为空'); return false; }
    return true;
}

function addNotifyStr(str, isLog) {
    if (isLog !== false) log(str);
    msg += str + '\n';
}

async function SendMsg(message) {
    if (!message) return;
    if (Notify > 0) {
        if ($.isNode()) {
            try {
                let notify = require('./sendNotify');
                await notify.sendNotify($.name, message);
            } catch (e) {
                log('通知发送失败(无sendNotify): ' + e.message);
            }
        } else { $.msg(message); }
    } else { log(message); }
}

!(async () => {
    if (typeof $request !== "undefined") {
        await GetRewrite();
    } else {
        if (!(await checkEnvs())) return;
        log('\n┌─────────────────────────────────┐');
        log('  知了快看 · 多号任务  v2.3.1');
        log('  运行时间: ' + new Date(Date.now() + 8 * 3600 * 1000).toLocaleString());
        log('└─────────────────────────────────┘\n');
        log('★★★ 知了快看 - 多号任务 ★★★\n');

        log('本次运行账号数: ' + uidList.length + '\n');

        for (let index = 0; index < uidList.length; index++) {
            let num = index + 1;
            addNotifyStr('\n----------- 账号 #' + num + ' -----------\n', true);
            let uid = uidList[index];
            log('账号ID: ' + uid);

            // UID 直登: 设置凭据, session 由服务端首次请求自动下发
            resetAuth();
            AUTH.uid = uid;
            AUTH.account = uid;
            AUTH.user_cert = '0';
            log('→ 免登认证: ' + uid);

            let bot = new Bot();
            bot.uid = uid;

            // 跑任务 ((每个账号独立执行, 单个账号异常不影响后续账号))
            try {
                await bot.run();
            } catch (e2) {
                let errMsg2 = (e2 && e2.stack) || (e2 && e2.message) || String(e2);
                log('\n✖ 账号 #' + num + ' (' + uid + ') 异常: ' + errMsg2);
                addNotifyStr('[第' + num + '个账号 ' + uid + '] 执行失败: ' + errMsg2, false);
            }

            if (index < uidList.length - 1) {
                let wait = 30 + Math.random() * 30;
                log('\n→ 间隔 ' + wait.toFixed(0) + 's 后处理下一账号 ...');
                await $.wait(wait * 1000);
            }
        }

        await SendMsg(msg);
    }
})().catch((e) => log(e)).finally(() => $.done());

function Env(t, e) {
    "undefined" != typeof process && JSON.stringify(process.env).indexOf("GITHUB") > -1 && process.exit(0);

    class s {
        constructor(t) {
            this.env = t
        }

        send(t, e = "GET") {
            t = "string" == typeof t ? {
                url: t
            } : t;
            let s = this.get;
            return "POST" === e && (s = this.post), new Promise((e, i) => {
                s.call(this, t, (t, s, r) => {
                    t ? i(t) : e(s)
                })
            })
        }

        get(t) {
            return this.send.call(this.env, t)
        }

        post(t) {
            return this.send.call(this.env, t, "POST")
        }
    }

    return new class {
        constructor(t, e) {
            this.name = t, this.http = new s(this), this.data = null, this.dataFile = "box.dat", this.logs = [], this.isMute = !1, this.isNeedRewrite = !1, this.logSeparator = "\n", this.startTime = (new Date).getTime(), Object.assign(this, e), this.log("", `🔔${this.name}, 开始!`)
        }

        isNode() {
            return "undefined" != typeof module && !!module.exports
        }

        isQuanX() {
            return "undefined" != typeof $task
        }

        isSurge() {
            return "undefined" != typeof $httpClient && "undefined" == typeof $loon
        }

        isLoon() {
            return "undefined" != typeof $loon
        }

        toObj(t, e = null) {
            try {
                return JSON.parse(t)
            } catch {
                return e
            }
        }

        toStr(t, e = null) {
            try {
                return JSON.stringify(t)
            } catch {
                return e
            }
        }

        getjson(t, e) {
            let s = e;
            const i = this.getdata(t);
            if (i) try {
                s = JSON.parse(this.getdata(t))
            } catch { }
            return s
        }

        setjson(t, e) {
            try {
                return this.setdata(JSON.stringify(t), e)
            } catch {
                return !1
            }
        }

        getScript(t) {
            return new Promise(e => {
                this.get({
                    url: t
                }, (t, s, i) => e(i))
            })
        }

        runScript(t, e) {
            return new Promise(s => {
                let i = this.getdata("@chavy_boxjs_userCfgs.httpapi");
                i = i ? i.replace(/\n/g, "").trim() : i;
                let r = this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");
                r = r ? 1 * r : 20, r = e && e.timeout ? e.timeout : r;
                const [o, h] = i.split("@"), n = {
                    url: `http://${h}/v1/scripting/evaluate`,
                    body: {
                        script_text: t,
                        mock_type: "cron",
                        timeout: r
                    },
                    headers: {
                        "X-Key": o,
                        Accept: "*/*"
                    }
                };
                this.post(n, (t, e, i) => s(i))
            }).catch(t => this.logErr(t))
        }

        loaddata() {
            if (!this.isNode()) return {}; {
                this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path");
                const t = this.path.resolve(this.dataFile),
                    e = this.path.resolve(process.cwd(), this.dataFile),
                    s = this.fs.existsSync(t),
                    i = !s && this.fs.existsSync(e);
                if (!s && !i) return {}; {
                    const i = s ? t : e;
                    try {
                        return JSON.parse(this.fs.readFileSync(i))
                    } catch (t) {
                        return {}
                    }
                }
            }
        }

        writedata() {
            if (this.isNode()) {
                this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path");
                const t = this.path.resolve(this.dataFile),
                    e = this.path.resolve(process.cwd(), this.dataFile),
                    s = this.fs.existsSync(t),
                    i = !s && this.fs.existsSync(e),
                    r = JSON.stringify(this.data);
                s ? this.fs.writeFileSync(t, r) : i ? this.fs.writeFileSync(e, r) : this.fs.writeFileSync(t, r)
            }
        }

        lodash_get(t, e, s) {
            const i = e.replace(/\[(\d+)\]/g, ".$1").split(".");
            let r = t;
            for (const t of i)
                if (r = Object(r)[t], void 0 === r) return s;
            return r
        }

        lodash_set(t, e, s) {
            return Object(t) !== t ? t : (Array.isArray(e) || (e = e.toString().match(/[^.[\]]+/g) || []), e.slice(0, -1).reduce((t, s, i) => Object(t[s]) === t[s] ? t[s] : t[s] = Math.abs(e[i + 1]) >> 0 == +e[i + 1] ? [] : {}, t)[e[e.length - 1]] = s, t)
        }

        getdata(t) {
            let e = this.getval(t);
            if (/^@/.test(t)) {
                const [, s, i] = /^@(.*?)\.(.*?)$/.exec(t), r = s ? this.getval(s) : "";
                if (r) try {
                    const t = JSON.parse(r);
                    e = t ? this.lodash_get(t, i, "") : e
                } catch (t) {
                    e = ""
                }
            }
            return e
        }

        setdata(t, e) {
            let s = !1;
            if (/^@/.test(e)) {
                const [, i, r] = /^@(.*?)\.(.*?)$/.exec(e), o = this.getval(i),
                    h = i ? "null" === o ? null : o || "{}" : "{}";
                try {
                    const e = JSON.parse(h);
                    this.lodash_set(e, r, t), s = this.setval(JSON.stringify(e), i)
                } catch (e) {
                    const o = {};
                    this.lodash_set(o, r, t), s = this.setval(JSON.stringify(o), i)
                }
            } else s = this.setval(t, e);
            return s
        }

        getval(t) {
            return this.isSurge() || this.isLoon() ? $persistentStore.read(t) : this.isQuanX() ? $prefs.valueForKey(t) : this.isNode() ? (this.data = this.loaddata(), this.data[t]) : this.data && this.data[t] || null
        }

        setval(t, e) {
            return this.isSurge() || this.isLoon() ? $persistentStore.write(t, e) : this.isQuanX() ? $prefs.setValueForKey(t) : this.isNode() ? (this.data = this.loaddata(), this.data[e] = t, this.writedata(), !0) : this.data && this.data[e] || null
        }

        initGotEnv(t) {
            this.got = this.got ? this.got : require("got"), this.cktough = this.cktough ? this.cktough : require("tough-cookie"), this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar, t && (t.headers = t.headers ? t.headers : {}, void 0 === t.headers.Cookie && void 0 === t.cookieJar && (t.cookieJar = this.ckjar))
        }

        get(t, e = (() => { })) {
            t.headers && (delete t.headers["Content-Type"], delete t.headers["Content-Length"]), this.isSurge() || this.isLoon() ? (this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, {
                "X-Surge-Skip-Scripting": !1
            })), $httpClient.get(t, (t, s, i) => {
                !t && s && (s.body = i, s.statusCode = s.status), e(t, s, i)
            })) : this.isQuanX() ? (this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, {
                hints: !1
            })), $task.fetch(t).then(t => {
                const {
                    statusCode: s,
                    statusCode: i,
                    headers: r,
                    body: o
                } = t;
                e(null, {
                    status: s,
                    statusCode: i,
                    headers: r,
                    body: o
                }, o)
            }, t => e(t))) : this.isNode() && (this.initGotEnv(t), this.got(t).on("redirect", (t, e) => {
                try {
                    if (t.headers["set-cookie"]) {
                        const s = t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();
                        s && this.ckjar.setCookieSync(s, null), e.cookieJar = this.ckjar
                    }
                } catch (t) {
                    this.logErr(t)
                }
            }).then(t => {
                const {
                    statusCode: s,
                    statusCode: i,
                    headers: r,
                    body: o
                } = t;
                e(null, {
                    status: s,
                    statusCode: i,
                    headers: r,
                    body: o
                }, o)
            }, t => {
                const {
                    message: s,
                    response: i
                } = t;
                e(s, i, i && i.body)
            }))
        }

        post(t, e = (() => { })) {
            if (t.body && t.headers && !t.headers["Content-Type"] && (t.headers["Content-Type"] = "application/x-www-form-urlencoded"), t.headers && delete t.headers["Content-Length"], this.isSurge() || this.isLoon()) this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, {
                "X-Surge-Skip-Scripting": !1
            })), $httpClient.post(t, (t, s, i) => {
                !t && s && (s.body = i, s.statusCode = s.status), e(t, s, i)
            });
            else if (this.isQuanX()) t.method = "POST", this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, {
                hints: !1
            })), $task.fetch(t).then(t => {
                const {
                    statusCode: s,
                    statusCode: i,
                    headers: r,
                    body: o
                } = t;
                e(null, {
                    status: s,
                    statusCode: i,
                    headers: r,
                    body: o
                }, o)
            }, t => e(t));
            else if (this.isNode()) {
                this.initGotEnv(t);
                const {
                    url: s,
                    ...i
                } = t;
                this.got.post(s, i).then(t => {
                    const {
                        statusCode: s,
                        statusCode: i,
                        headers: r,
                        body: o
                    } = t;
                    e(null, {
                        status: s,
                        statusCode: i,
                        headers: r,
                        body: o
                    }, o)
                }, t => {
                    const {
                        message: s,
                        response: i
                    } = t;
                    e(s, i, i && i.body)
                })
            }
        }

        time(t, e = null) {
            const s = e ? new Date(e) : new Date;
            let i = {
                "M+": s.getMonth() + 1,
                "d+": s.getDate(),
                "H+": s.getHours(),
                "m+": s.getMinutes(),
                "s+": s.getSeconds(),
                "q+": Math.floor((s.getMonth() + 3) / 3),
                S: s.getMilliseconds()
            };
            /(y+)/.test(t) && (t = t.replace(RegExp.$1, (s.getFullYear() + "").substr(4 - RegExp.$1.length)));
            for (let e in i) new RegExp("(" + e + ")").test(t) && (t = t.replace(RegExp.$1, 1 == RegExp.$1.length ? i[e] : ("00" + i[e]).substr(("" + i[e]).length)));
            return t
        }

        msg(e = t, s = "", i = "", r) {
            const o = t => {
                if (!t) return t;
                if ("string" == typeof t) return this.isLoon() ? t : this.isQuanX() ? {
                    "open-url": t
                } : this.isSurge() ? {
                    url: t
                } : void 0;
                if ("object" == typeof t) {
                    if (this.isLoon()) {
                        let e = t.openUrl || t.url || t["open-url"],
                            s = t.mediaUrl || t["media-url"];
                        return {
                            openUrl: e,
                            mediaUrl: s
                        }
                    }
                    if (this.isQuanX()) {
                        let e = t["open-url"] || t.url || t.openUrl,
                            s = t["media-url"] || t.mediaUrl;
                        return {
                            "open-url": e,
                            "media-url": s
                        }
                    }
                    if (this.isSurge()) {
                        let e = t.url || t.openUrl || t["open-url"];
                        return {
                            url: e
                        }
                    }
                }
            };
            if (this.isMute || (this.isSurge() || this.isLoon() ? $notification.post(e, s, i, o(r)) : this.isQuanX() && $notify(e, s, i, o(r))), !this.isMuteLog) {
                let t = ["", "==============📣系统通知📣=============="];
                t.push(e), s && t.push(s), i && t.push(i), console.log(t.join("\n")), this.logs = this.logs.concat(t)
            }
        }

        log(...t) {
            t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(t.join(this.logSeparator))
        }

        logErr(t, e) {
            const s = !this.isSurge() && !this.isQuanX() && !this.isLoon();
            s ? this.log("", `❗️${this.name}, 错误!`, t.stack) : this.log("", `❗️${this.name}, 错误!`, t)
        }

        wait(t) {
            return new Promise(e => setTimeout(e, t))
        }

        done(t = {}) {
            const e = (new Date).getTime(),
                s = (e - this.startTime) / 1e3;
            this.log("", `🔔${this.name}, 结束! 🕛 ${s} 秒`), this.log(), (this.isSurge() || this.isQuanX() || this.isLoon()) && $done(t)
        }
    }(t, e)
}
