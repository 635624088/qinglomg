#!/usr/bin/env node

const crypto = require("node:crypto");
const https = require("node:https");

const BASE_URL = "https://xapi.weimob.com";
const APP_ID = "wx8356b84042cc6865";
const REFERER = `https://servicewechat.com/${APP_ID}/36/page-frame.html`;

// ── YYB 协议 ─────────────────────────────────────────────────────
const YYB_BASE_URL = (process.env.YYB_BASE_URL || 'http://172.17.0.1:18080').replace(/\/+$/, '');
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';

function bridgeHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (BRIDGE_KEY) h['Authorization'] = 'Bearer ' + BRIDGE_KEY;
    return h;
}

async function fetchAccounts() {
    const res = await httpsRequest(YYB_BASE_URL + '/accounts', 'GET', bridgeHeaders());
    const body = res.body || {};
    const list = (body.data || []).map(a => ({
        mode: 'wxid',
        name: (a.nickname || a.name || '账号').trim(),
        wxid: (a.openid || '').trim()
    })).filter(a => a.wxid);
    console.log('共获取到 ' + list.length + ' 个账号');
    list.forEach((a, i) => console.log('   ' + (i+1) + '. ' + a.name + ' (openid: ' + a.wxid.substring(0,12) + '...)'));
    return list;
}

async function bridgeGetCode(openid) {
    const res = await httpsRequest(YYB_BASE_URL + '/wxapp/getCode', 'POST', bridgeHeaders(), { app_id: APP_ID, ref: openid });
    const data = res.body || {};
    if (data.code !== 0) throw new Error('bridge 拒绝: ' + JSON.stringify(data));
    const code = data.data?.result?.code || '';
    if (!code) throw new Error('bridge 未返回 code');
    return code;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/132.0.0.0 Safari/537.36 " +
  "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI " +
  "MiniProgramEnv/Windows WindowsWechat/WMPF " +
  "WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254181d) XWEB/19201";

const WX_CODE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
};

const COMMON_CONTEXT = {
  appid: APP_ID,
  queryParameter: null,
  i18n: { language: "zh", timezone: "8" },
  pid: "",
  storeId: "",
};

function envString(name, fallback) {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function envNumber(name, fallback) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PROFILE_BASIC_INFO = {
  vid: 6016634561713,
  vidType: 2,
  bosId: 4022022983713,
  productId: 222,
  productInstanceId: 14519561713,
  productVersionId: "12004",
  merchantId: 2000360645713,
  tcode: "weimob",
  cid: 770524713,
};

const SIGN_BASIC_INFO = {
  vid: 6016634561713,
  vidType: 2,
  bosId: 4022022983713,
  productId: 146,
  productInstanceId: 14519577713,
  productVersionId: "14026",
  merchantId: 2000360645713,
  tcode: "weimob",
  cid: 770524713,
};

const DRAW_BASIC_INFO = {
  vid: envNumber("YANGLEDUO_DRAW_VID", 6016634561713),
  vidType: envNumber("YANGLEDUO_DRAW_VID_TYPE", 2),
  bosId: envNumber("YANGLEDUO_DRAW_BOS_ID", 4022022983713),
  productId: envNumber("YANGLEDUO_DRAW_PRODUCT_ID", 222),
  productInstanceId: envNumber("YANGLEDUO_DRAW_PRODUCT_INSTANCE_ID", 14519561713),
  productVersionId: envString("YANGLEDUO_DRAW_PRODUCT_VERSION_ID", "12004"),
  merchantId: envNumber("YANGLEDUO_DRAW_MERCHANT_ID", 2000360645713),
  tcode: envString("YANGLEDUO_DRAW_TCODE", "weimob"),
  cid: envNumber("YANGLEDUO_DRAW_CID", 770524713),
};

const PROFILE_EXTEND_INFO = {
  wxTemplateId: 8136,
  analysis: [],
  bosTemplateId: 1000002185,
  childTemplateIds: [
    { customId: 90004, version: "crm@0.1.87" },
    { customId: 90002, version: "ec@82.1" },
    { customId: 90006, version: "hudong@0.0.251" },
    { customId: 90008, version: "cms@0.0.527" },
    { customId: 90070, version: "1.0.16y" },
  ],
  quickdeliver: { enable: false },
  youshu: { enable: false },
  source: 1,
  channelsource: 5,
  refer: "hd-lego-index",
  mpScene: 1089,
};

const SIGN_EXTEND_INFO = {
  wxTemplateId: 8136,
  analysis: [],
  bosTemplateId: 1000002185,
  childTemplateIds: [
    { customId: 90004, version: "crm@0.1.87" },
    { customId: 90002, version: "ec@82.1" },
    { customId: 90006, version: "hudong@0.0.251" },
    { customId: 90008, version: "cms@0.0.527" },
    { customId: 90070, version: "1.0.16y" },
  ],
  quickdeliver: { enable: false },
  youshu: { enable: false },
  source: 1,
  channelsource: 5,
  refer: "onecrm-signgift",
  mpScene: 1089,
};

const DRAW_EXTEND_INFO = {
  wxTemplateId: 8136,
  analysis: [],
  bosTemplateId: 1000002185,
  childTemplateIds: [
    { customId: 90004, version: "crm@0.1.87" },
    { customId: 90002, version: "ec@82.1" },
    { customId: 90006, version: "hudong@0.0.251" },
    { customId: 90008, version: "cms@0.0.527" },
    { customId: 90070, version: "1.0.16y" },
  ],
  quickdeliver: { enable: false },
  youshu: { enable: false },
  source: 1,
  channelsource: 5,
  refer: "hd-lego-index",
  mpScene: envNumber("YANGLEDUO_DRAW_MP_SCENE", 1106),
};

const DRAW_ACTIVITY_CONTEXT = {
  _transformBasicInfo: true,
  templateId: envNumber("YANGLEDUO_DRAW_TEMPLATE_ID", 812),
  templateKey: envString("YANGLEDUO_DRAW_TEMPLATE_KEY", "bigwheel"),
  activityId: envString("YANGLEDUO_DRAW_ACTIVITY_ID", "30000145685"),
  bussinessType: 1,
  channel: 1,
  channelType: 1,
  source: 1,
  _version: envString("YANGLEDUO_DRAW_VERSION", "2.5.4"),
  activityIdentity: envString("YANGLEDUO_DRAW_ACTIVITY_IDENTITY", "20"),
  appId: APP_ID,
  playSourceCode: envString("YANGLEDUO_DRAW_PLAY_SOURCE_CODE", "lcode"),
  vidTypes: [envNumber("YANGLEDUO_DRAW_VID_TYPE", 2)],
};

// 飞书推送
async function sendFeishuMessage(text) {
  const fskey = process.env.FSKEY || "";
  if (!fskey) return;

  const payload = JSON.stringify({
    msg_type: "text",
    content: { text: `养乐多任务通知\n\n${text}` },
  });

  const options = {
    hostname: "open.feishu.cn",
    port: 443,
    path: `/open-apis/bot/v2/hook/${fskey}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.write(payload);
    req.end();
  });
}

function splitItems(raw) {
  return String(raw || "")
    .replace(/\r/g, "")
    .split(/[&\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTokenAccounts(raw) {
  return splitItems(raw)
    .map((item, index) => {
      const parts = item.split("#").map((part) => part.trim());
      if (parts.length === 1) {
        return {
          mode: "token",
          name: `账号${index + 1}`,
          token: parts[0],
          openid: "",
          wid: "",
        };
      }

      const name = parts[0] || `账号${index + 1}`;
      const token = parts[1] || "";
      const third = parts[2] || "";
      const fourth = parts[3] || "";

      let openid = "";
      let wid = "";

      if (third && /^\d+$/.test(third) && !fourth) {
        wid = third;
      } else {
        openid = third;
        wid = fourth;
      }

      return { mode: "token", name, token, openid, wid };
    })
    .filter((item) => item.token);
}

function parseWxidAccounts(raw) {
  return splitItems(raw)
    .map((item, index) => {
      const parts = item.split("#");
      if (parts.length === 1) {
        return {
          mode: "wxid",
          name: `账号${index + 1}`,
          wxid: parts[0].trim(),
        };
      }

      const name = parts[0].trim() || `账号${index + 1}`;
      const wxid = parts.slice(1).join("#").trim();
      return { mode: "wxid", name, wxid };
    })
    .filter((item) => item.wxid);
}

function maskToken(token) {
  const value = String(token || "").trim();
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function normalizeErrmsg(data) {
  if (!data || typeof data !== "object") {
    return "未知错误";
  }
  return data.errmsg || data.bizErrmsg || data.message || JSON.stringify(data);
}

function drawMode() {
  const mode = String(process.env.YANGLEDUO_DRAW_MODE || "play").trim().toLowerCase();
  if (["off", "query", "play"].includes(mode)) {
    return mode;
  }
  return "play";
}

function drawActivitySummary() {
  return `${DRAW_ACTIVITY_CONTEXT.templateKey}/${DRAW_ACTIVITY_CONTEXT.activityId}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomHex(size) {
  return crypto.randomBytes(size).toString("hex");
}

function randomUuid() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const raw = randomHex(16);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

function buildVidTicket() {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const left = String(Math.floor(Math.random() * 90000) + 10000);
  const mid = String(Math.floor(Math.random() * 900) + 100);
  const node = String(Math.floor(Math.random() * 9000) + 1000);
  const tail = String(Math.floor(Math.random() * 9e10) + 1e10);
  return `${left}-${seconds}.${mid}-saas-w1-${node}-${tail}`;
}

function buildRpcId() {
  return randomHex(8);
}

function inferReqFrom(path) {
  return path.includes("/onecrm/") ? "onecrm" : "hd_lego";
}

function inferComponent(path) {
  if (path.includes("/onecrm/")) {
    return "onecrm/signgift";
  }
  if (path.includes("/orchestration/mobile/")) {
    return "hd_lego/RAW/components/design-page/design-page";
  }
  return "hd_lego/index";
}

function inferPageRoute(path) {
  return path.includes("/onecrm/") ? "onecrm/signgift" : "hd_lego/index";
}

function buildRequestHeaders(client, path, token, payload, extraHeaders = {}, attempt = 0) {
  const basicInfo = payload?.basicInfo || {};
  const bosId = String(basicInfo?.bosId || payload?.bosId || "");
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    referer: REFERER,
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    xweb_xhr: "1",
    "weimob-pid": "N/A",
    "wos-x-channel": "0:TITAN",
    "x-wmsdk-close-store": "v2",
    ...(token ? { "x-wx-token": token } : {}),
  };

  if (!path.startsWith("/fe/mapi/user/")) {
    headers["x-apm-page-id"] = randomUuid();
    headers["x-apm-conversation-id"] = client.conversationId;
    headers["x-cmssdk-vidticket"] = buildVidTicket();
    headers.parentrpcid = buildRpcId();
    headers["x-cms-sdk-request"] = "1.5.135";
    headers.cookie = `rprm_cuid=${client.cuid}`;
    headers["x-req-from"] = inferReqFrom(path);
    headers["x-component-is"] = inferComponent(path);
    headers["x-page-route"] = inferPageRoute(path);
    if (attempt > 0 || path.includes("/onecrm/") || path.includes("/orchestration/mobile/")) {
      headers["x-apm-parent-page-id"] = client.parentPageId;
    }
    if (basicInfo?.productId !== undefined && basicInfo?.productId !== null) {
      headers["x-biz-id"] = String(basicInfo.productId);
    }
    if (basicInfo?.vid !== undefined && basicInfo?.vid !== null) {
      headers["x-wmsdk-vid"] = String(basicInfo.vid);
    }
    headers["x-wmsdk-bc"] = `1 ${Date.now()}`;
    if (bosId) {
      headers["weimob-bosid"] = bosId;
    }
  }

  return {
    ...headers,
    ...extraHeaders,
  };
}

function looksLikeJson(text, contentType = "") {
  const body = String(text || "").trim();
  if (!body) {
    return false;
  }
  if (String(contentType).toLowerCase().includes("application/json")) {
    return true;
  }
  return body.startsWith("{") || body.startsWith("[");
}

function bodySnippet(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function buildProfilePayload() {
  return {
    ...COMMON_CONTEXT,
    basicInfo: { ...PROFILE_BASIC_INFO },
    extendInfo: { ...PROFILE_EXTEND_INFO },
    bosId: String(PROFILE_BASIC_INFO.bosId),
  };
}

function buildSignPayload(wid) {
  return {
    ...COMMON_CONTEXT,
    basicInfo: { ...SIGN_BASIC_INFO },
    extendInfo: { ...SIGN_EXTEND_INFO },
    customInfo: {
      source: 0,
      wid: Number(wid),
    },
  };
}

function buildDrawPayload(openid, wid, requrl) {
  return {
    ...COMMON_CONTEXT,
    basicInfo: { ...DRAW_BASIC_INFO },
    extendInfo: { ...DRAW_EXTEND_INFO },
    ...DRAW_ACTIVITY_CONTEXT,
    _requrl: requrl,
    openId: openid,
    openid,
    wid: Number(wid),
    vid: DRAW_BASIC_INFO.vid,
    vidType: DRAW_BASIC_INFO.vidType,
    bosId: DRAW_BASIC_INFO.bosId,
    productId: DRAW_BASIC_INFO.productId,
    productInstanceId: DRAW_BASIC_INFO.productInstanceId,
    productVersionId: DRAW_BASIC_INFO.productVersionId,
    merchantId: DRAW_BASIC_INFO.merchantId,
    tcode: DRAW_BASIC_INFO.tcode,
    cid: DRAW_BASIC_INFO.cid,
  };
}

function buildWxLoginPayload(code) {
  return {
    appid: APP_ID,
    basicInfo: {
      bosId: String(DRAW_BASIC_INFO.bosId),
      cid: String(DRAW_BASIC_INFO.cid),
      tcode: DRAW_BASIC_INFO.tcode,
      vid: String(DRAW_BASIC_INFO.vid),
    },
    env: "production",
    extendInfo: {
      source: 1,
    },
    is_pre_fetch_open: true,
    parentVid: 0,
    pid: "",
    storeId: "",
    code,
    queryAuthConfig: true,
  };
}

function parseRewardList(signForwardMsg) {
  if (!Array.isArray(signForwardMsg) || signForwardMsg.length === 0) {
    return "";
  }

  return signForwardMsg
    .map((item) => {
      const key = String(item?.key || "").trim();
      const value = String(item?.value || "").trim();
      return key && value ? `${key}${value}` : key || value;
    })
    .filter(Boolean)
    .join("，");
}

function summarizeSignState(info) {
  const rewards = parseRewardList(info?.signForwardMsg);
  const signed = info?.hasSign ? "已签到" : "未签到";
  const keepDays = Number(info?.activityCumulativeSignDays || 0);
  const year = info?.year ?? "-";
  const month = info?.month ?? "-";
  const date = info?.date ?? "-";

  let message = `${year}-${month}-${date} ${signed}`;
  if (keepDays > 0) {
    message += `，累计 ${keepDays} 天`;
  }
  if (rewards) {
    message += `，奖励 ${rewards}`;
  }
  return message;
}

// 🔥 精简奖品名称（只显示名字）
function summarizeDrawReward(data) {
  try {
    if (data?.prizes?.[0]?.name) {
      return data.prizes[0].name;
    }
  } catch (e) {}
  return "未中奖";
}

function extractChance(data) {
  return Number(data?.assets?.chance?.assetNum || 0);
}

async function createHttpClient() {
  return {
    conversationId: randomUuid(),
    parentPageId: randomUuid(),
    cuid: `${String(Date.now()).slice(-11)}${randomHex(5)}`,
  };
}

function httpsRequest(url, method, headers, body) {
  const urlObj = new URL(url);
  const isHttps = urlObj.protocol === 'https:';
  const lib = isHttps ? require('https') : require('http');
  const bodyStr = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  const finalHeaders = { ...headers };
  if (bodyStr && method === 'POST') {
    finalHeaders['Content-Length'] = Buffer.byteLength(bodyStr).toString();
  }
  return new Promise((resolve, reject) => {
    const req = lib.request({ hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80), path: urlObj.pathname + urlObj.search, method, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) }); } catch { resolve({ statusCode: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr && method === 'POST') req.write(bodyStr);
    req.end();
  });
}

async function postJsonLegacy(client, path, token, payload, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { "x-wx-token": token } : {}),
    ...extraHeaders,
  };
  const response = await httpsRequest(`${BASE_URL}${path}`, "POST", headers, payload);
  const data = response.body || {};
  if (!looksLikeJson(JSON.stringify(data), response.headers?.["content-type"] || "")) {
    throw new Error(`网关返回非 JSON，HTTP ${response.statusCode}`);
  }
  if (response.statusCode !== 200) {
    throw new Error(`HTTP ${response.statusCode}: ${normalizeErrmsg(data)}`);
  }
  if (String(data.errcode) !== "0") {
    throw new Error(normalizeErrmsg(data));
  }
  return data;
}

async function postJson(client, path, token, payload, extraHeaders = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers = buildRequestHeaders(client, path, token, payload, extraHeaders, attempt);
    const response = await httpsRequest(`${BASE_URL}${path}`, "POST", headers, payload);

    const data = response.body || {};
    const contentType = response.headers?.["content-type"] || "";
    const bodyStr = JSON.stringify(data);
    if (!looksLikeJson(bodyStr, contentType)) {
      const snippet = bodySnippet(bodyStr);
      lastError = new Error(
        `网关返回非 JSON，HTTP ${response.statusCode}${snippet ? `，响应片段 ${snippet}` : ""}`,
      );
      if (attempt < 2) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    if (response.statusCode !== 200) {
      lastError = new Error(`HTTP ${response.statusCode}: ${normalizeErrmsg(data)}`);
      if ((response.statusCode >= 500 || response.statusCode === 429) && attempt < 2) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    if (String(data.errcode) !== "0") {
      throw new Error(normalizeErrmsg(data));
    }

    return data;
  }

  throw lastError || new Error("网络请求失败");
}

async function getWxCode(wxid) {
  return bridgeGetCode(wxid);
}

async function loginWithWxCode(client, code) {
  const result = await postJson(
    client,
    "/fe/mapi/user/loginX",
    "",
    buildWxLoginPayload(code),
  );

  const data = result?.data || {};
  const token = String(data?.token || "").trim();
  const openid = String(data?.openId || data?.openid || "").trim();
  const wid = Number(data?.wid || 0);

  if (!token) {
    throw new Error("登录成功但未返回 token");
  }
  if (!openid) {
    throw new Error("登录成功但未返回 openid");
  }
  if (!wid) {
    throw new Error("登录成功但未返回 wid");
  }

  return { token, openid, wid };
}

async function queryProfile(client, token) {
  const result = await postJson(
    client,
    "/api3/user/info/web/queryNicknameAndPhone",
    token,
    buildProfilePayload(),
  );

  const profile = result?.data?.nicknamePhoneAvatarInfoVo || {};
  return {
    wid: result?.data?.wid,
    nickname: profile?.nickname || "",
    phone: profile?.phone || "",
  };
}

async function querySignMainInfo(client, token, wid) {
  const result = await postJson(
    client,
    "/api3/onecrm/mactivity/sign/misc/sign/activity/c/signMainInfo",
    token,
    buildSignPayload(wid),
  );
  return result?.data || {};
}

async function doSign(client, token, wid) {
  const result = await postJson(
    client,
    "/api3/onecrm/mactivity/sign/misc/sign/activity/core/c/sign",
    token,
    buildSignPayload(wid),
  );
  return result?.data || {};
}

function buildDrawHeaders() {
  const headers = {};

  if (process.env.YANGLEDUO_TP_UUID) {
    headers["x-tp-uuid"] = process.env.YANGLEDUO_TP_UUID.trim();
  }
  if (process.env.YANGLEDUO_TP_SIGNATURE) {
    headers["x-tp-signature"] = process.env.YANGLEDUO_TP_SIGNATURE.trim();
  }

  return headers;
}

async function queryDrawChance(client, token, openid, wid) {
  const result = await postJson(
    client,
    "/api3/orchestration/mobile/prize/getRemainingAssets",
    token,
    {
      ...buildDrawPayload(openid, wid, "/orchestration/mobile/prize/getRemainingAssets"),
      assetTypes: ["chance"],
    },
    buildDrawHeaders(),
  );
  return result?.data || {};
}

async function doDraw(client, token, openid, wid) {
  const result = await postJson(
    client,
    "/api3/orchestration/mobile/activity/draw/play",
    token,
    buildDrawPayload(openid, wid, "/orchestration/mobile/activity/draw/play"),
    buildDrawHeaders(),
  );
  return result?.data || {};
}

async function resolveAccountAuth(client, account) {
  if (account.mode === "token") {
    return {
      token: String(account.token || "").trim(),
      openid: String(account.openid || "").trim(),
      wid: Number(account.wid || 0),
      source: "token",
    };
  }

  
  const code = await getWxCode(account.wxid);
  if (!code) {
    throw new Error("获取 wx code 失败");
  }
  console.log(`  code=${code.slice(0, 16)}...`);

  
  const auth = await loginWithWxCode(client, code);
  ;

  return {
    token: auth.token,
    openid: auth.openid,
    wid: auth.wid,
    source: "wxid",
  };
}

async function runDrawTask(client, auth, resolvedWid) {
  const mode = drawMode();
  if (mode === "off") {
    return "抽奖已关闭";
  }

  const openid = String(auth.openid || process.env.YANGLEDUO_OPENID || "").trim();
  if (!openid) {
    return "未提供 openid，跳过抽奖";
  }

  const wid = Number(auth.wid || process.env.YANGLEDUO_WID || resolvedWid || 0);
  if (!wid) {
    return "未提供 wid，跳过抽奖";
  }

  const assets = await queryDrawChance(client, auth.token, openid, wid);
  const chance = extractChance(assets);
  console.log(`  抽奖次数=${chance}`);

  if (chance <= 0) {
    return "无抽奖次数";
  }

  if (mode === "query") {
    return `剩余 ${chance} 次抽奖机会`;
  }

  const drawResult = await doDraw(client, auth.token, openid, wid);
  const reward = summarizeDrawReward(drawResult);
  return `抽奖成功：${reward}`;
}

async function runAccount(client, account, index) {
  console.log(`\n[${index}] ${account.name}`);

  const auth = await resolveAccountAuth(client, account);
  if (auth.source === "token") {
    ;
  }

  const profile = await queryProfile(client, auth.token);
  const wid = Number(auth.wid || profile.wid || 0);
  if (!wid) {
    throw new Error("未获取到 wid");
  }

  const displayName = profile.nickname || account.name;
  const phoneSuffix = profile.phone ? `，手机号 ${profile.phone}` : "";
  console.log(`  用户=${displayName}，wid=${wid}${phoneSuffix}`);

  const messages = [];
  const before = await querySignMainInfo(client, auth.token, wid);
  if (before.hasSign) {
    messages.push(`签到: 今日已签到，${summarizeSignState(before)}`);
  } else {
    const signResult = await doSign(client, auth.token, wid);
    const rewardParts = [];

    if (Number(signResult?.fixedReward?.points || 0) > 0) {
      rewardParts.push(`积分+${signResult.fixedReward.points}`);
    }
    if (Number(signResult?.fixedReward?.growth || 0) > 0) {
      rewardParts.push(`成长值+${signResult.fixedReward.growth}`);
    }
    if (Number(signResult?.fixedReward?.amount || 0) > 0) {
      rewardParts.push(`余额+${signResult.fixedReward.amount}`);
    }
    if (Number(signResult?.extraReward?.points || 0) > 0) {
      rewardParts.push(`额外积分+${signResult.extraReward.points}`);
    }

    const after = await querySignMainInfo(client, auth.token, wid);
    const rewardText = rewardParts.length > 0 ? `，奖励 ${rewardParts.join("，")}` : "";
    messages.push(`签到: 成功${rewardText}，${summarizeSignState(after)}`);
  }

  const drawMessage = await runDrawTask(client, auth, wid);
  messages.push(`抽奖: ${drawMessage}`);

  return {
    ok: true,
    label: displayName,
    message: messages.join(" | "),
  };
}

async function main() {
  const client = await createHttpClient();

  const tokenAccounts = parseTokenAccounts(
    process.argv[2] || process.env.YANGLEDUO_TOKEN || process.env.YAKULT_TOKEN || "",
  );
  const wxidAccounts = parseWxidAccounts(
    process.env.yangleduo || process.env.YANGLEDUO_WXID || process.env.YAKULT_WXID || "",
  );
  let accounts = [...tokenAccounts, ...wxidAccounts];

  if (accounts.length === 0) {
    const bridgeAccts = await fetchAccounts();
    if (bridgeAccts.length) {
      accounts = bridgeAccts;
    }
  }

  if (accounts.length === 0) {
    console.log("未检测到账号。");
    console.log("token 账号: YANGLEDUO_TOKEN / YAKULT_TOKEN");
    console.log("wxid 账号: yangleduo / YANGLEDUO_WXID / YAKULT_WXID");
    console.log("token 格式: 备注#token 或 备注#token#openid#wid");

  console.log("抽奖模式: YANGLEDUO_DRAW_MODE=play|query|off");
  console.log("活动参数覆盖: YANGLEDUO_DRAW_ACTIVITY_ID / YANGLEDUO_DRAW_PRODUCT_INSTANCE_ID / YANGLEDUO_DRAW_PRODUCT_VERSION_ID");
    console.log("飞书推送: FSKEY=机器人hook");
    process.exitCode = 1;
    return;
  }

  console.log(`养乐多任务，共 ${accounts.length} 个账号`);
  console.log("支持 token 直登 和 wxid 自动登录");
  console.log(`抽奖模式: ${drawMode()}`);
  console.log(`抽奖活动: ${drawActivitySummary()}\n`);

  const results = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    try {
      const result = await runAccount(client, account, index + 1);
      console.log(`  [OK] ${result.message}`);
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  [FAIL] ${message}`);
      results.push({
        ok: false,
        label: account.name,
        message,
      });
    }
    if (index < accounts.length - 1) {
      await sleep(1200);
    }
  }

  console.log("\n结果汇总:");
  let summary = [];
  for (const item of results) {
    const line = `- [${item.ok ? "OK" : "FAIL"}] ${item.label}: ${item.message}`;
    console.log(line);
    summary.push(line);
  }

  // 飞书推送汇总
  const fskey = process.env.FSKEY;
  if (fskey) {
    console.log("\n推送飞书消息...");
    await sendFeishuMessage(summary.join("\n"));
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
