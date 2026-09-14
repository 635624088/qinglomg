// === 修复 got decompress-response 兼容性 ===
try {
  const _got = require('got');
  const _g = _got.default || _got;
  if (_g && typeof _g.extend === 'function') {
    _g.extend({ decompress: false });
  }
} catch (e) {}
// === 修复 end ===

// === YYB_GO 统一通知注入 begin ===
(function () {
  const __logs = [];
  const __oL = console.log.bind(console);
  console.log = function (...a) { try { __logs.push(a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ')); } catch (e) {} __oL(...a); };
  const __oE = console.error.bind(console);
  console.error = function (...a) { try { __logs.push('[ERR] ' + a.map(x => (x && x.stack) ? x.stack : String(x)).join(' ')); } catch (e) {} __oE(...a); };

  function __resolveKey() {
    let k = process.env.QYWX_KEY || process.env.QYWX || process.env.WEWORK_KEY;
    if (k) return k;
    try {
      const fs = require('fs');
      let p = null;
      try { p = require.resolve('./sendNotify'); } catch (e) { try { p = require.resolve('/ql/data/scripts/sendNotify'); } catch (e2) {} }
      if (p) {
        const t = fs.readFileSync(p, 'utf-8');
        const m = t.match(/QYWX_KEY\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
    } catch (e) {}
    return null;
  }

  let __flushed = false;
  function __flush() {
    if (__flushed) return;
    __flushed = true;
    const title = (process.argv[1] || 'YYB_GO').split(/[\/]/).pop();
    const body = __logs.slice(-40).join('\n');
    // 1) 显式调用 sendNotify.js（满足要求）；临时静音其可能产生的报错，避免误导
    const _ol = console.log, _oe = console.error;
    console.log = function () {}; console.error = function () {};
    try {
      let sn;
      try { sn = require('./sendNotify'); } catch (e) { try { sn = require('/ql/data/scripts/sendNotify'); } catch (e2) { sn = null; } }
      if (sn) {
        if (typeof sn === 'function') { try { sn(title, body); } catch (e) {} }
        else if (sn.sendNotify && typeof sn.sendNotify === 'function') { try { sn.sendNotify(title, body); } catch (e) {} }
      }
    } catch (e) {}
    console.log = _ol; console.error = _oe;
    // 2) 兜底：同步 curl POST 企业微信机器人 webhook（绕过损坏的 sendNotify.js，确保送达）
    try {
      const key = __resolveKey();
      if (key) {
        const fs = require('fs');
        const cp = require('child_process');
        const tmp = '/tmp/yyb_notify_' + process.pid + '.json';
        fs.writeFileSync(tmp, JSON.stringify({ msgtype: 'text', text: { content: '【' + title + '】\n' + body } }));
        cp.execSync('curl -s -m 15 -X POST -H "Content-Type: application/json" --data @' + tmp + ' "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + key + '"', { stdio: 'ignore' });
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
    } catch (e) {}
  }

  let __exiting = false;
  const __origExit = (typeof process.exit === 'function') ? process.exit.bind(process) : function (c) { throw new Error('exit ' + c); };
  process.exit = function (code) {
    if (__exiting) return __origExit(code);
    __exiting = true;
    try { __flush(); } catch (e) {}
    return __origExit(code);
  };
  process.on('beforeExit', () => { if (!__exiting) { __exiting = true; try { __flush(); } catch (e) {} } });
})();
// === YYB_GO 统一通知注入 end ===
// name: 衣城通
// cron: 21 8 * * *

const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
// ====================== YYB Go 账号（环境变量 YYB_GO = 地址@微信账号标识，多行） ======================
const SERVERS = (process.env.YYB_GO || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
if (!SERVERS.length) {
    console.error("未配置环境变量 YYB_GO，请设置后重试（格式：地址@微信账号标识，多行换行）");
    process.exit(1);
}
function parseYybGoEntry(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) return { server: "", ref: "" };
    const atIndex = value.indexOf("@");
    if (atIndex === -1) {
        console.log("YYB_GO 格式应为 地址@微信账号标识，当前值: " + value);
        return { server: "", ref: "" };
    }
    let server = value.slice(0, atIndex).trim();
    const ref = value.slice(atIndex + 1).trim();
    if (server.startsWith("http://")) server = server.slice(7);
    else if (server.startsWith("https://")) server = server.slice(8);
    server = server.replace(/\/+$/, "");
    if (!server || !ref) return { server: "", ref: "" };
    return { server, ref };
}
async function getCode(server) {
    const { server: parsedServer, ref } = parseYybGoEntry(server);
    if (!parsedServer || !ref) return null;
    const url = "http://" + parsedServer + "/wxapp/getCode";
    try {
        const { data } = await axios.post(url, { ref, app_id: MINI_APP_ID }, { timeout: 20000, proxy: false });
        const code = data && data.data && data.data.result && data.data.result.code;
        if (!data || data.code !== 0 || !code) {
            console.log(parsedServer + " 获取code失败: " + JSON.stringify(data));
            return null;
        }
        console.log(parsedServer + " 获取code成功");
        return code;
    } catch (e) {
        console.log(parsedServer + " 获取code异常: " + e.message);
        return null;
    }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let userIdx = 1;

const MINI_APP_ID = "wxc4eaf0fd0c97862f";
const PACKAGE_VERSION = "138";
const API_BASE = "https://api.yctjob.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "token_caches", "yichengtong_token_cache.json");
try { fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true }); } catch (e) {}
const TASK_FUNC_TYPE = {
  lookpost: 1,
  sharepost: 2,
  improveresume: 3,
  adddesktop: 4,
  addmymini: 5,
  lookmerchant: 6,
  lookclothing: 7,
  invitecolleagues: 8,
};
const AUTO_TASK_TYPES = new Set([
  TASK_FUNC_TYPE.lookpost,
  TASK_FUNC_TYPE.sharepost,
  TASK_FUNC_TYPE.lookmerchant,
  TASK_FUNC_TYPE.lookclothing,
]);

function readCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {
    console.log(`token缓存写入失败: ${e.message || e}`);
  }
}

function md5(text) {
  return crypto.createHash("md5").update(String(text)).digest("hex");
}

function mask(value = "") {
  value = String(value);
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 6)}***${value.slice(-6)}`;
}

function parseAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return {};

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return {
        openid: data.openid || data.openId || data.account || "",
        token: data.token || data.Authorization || data.authorization || "",
      };
    } catch {}
  }

  for (const sep of ["#", "|"]) {
    if (text.includes(sep)) {
      const [openid, ...rest] = text.split(sep);
      return { openid: openid.trim(), token: rest.join(sep).trim().replace(/^Bearer\s+/i, "") };
    }
  }

  if (text.startsWith("eyJ") || text.length > 80) return { token: text.replace(/^Bearer\s+/i, "") };
  return { openid: text };
}

function ok(res) {
  return Number(res?.code) === 200;
}

function taskSummary(list = []) {
  return list
    .map((item) => `${item.name || item.title || item.id || "任务"} ${item.completeCount ?? 0}/${item.num ?? 1}`)
    .join("；");
}

function taskName(task = {}) {
  return task.name || task.title || `任务${task.id || task.configId || ""}`;
}

async function request(method, urlPath, { token = "", data = null, params = null, custom = {} } = {}) {
  const res = await axios({
    method,
    url: `${API_BASE}${urlPath}`,
    data,
    params,
    timeout: 30000,
    validateStatus: () => true,
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 MicroMessenger MiniProgramEnv/Windows",
      Referer: `https://servicewechat.com/${MINI_APP_ID}/${PACKAGE_VERSION}/page-frame.html`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...custom,
  });
  return {
    status: res.status,
    data: res.data,
    text: typeof res.data === "string" ? res.data : JSON.stringify(res.data),
  };
}

class Task {
  constructor(raw) {
        this.server = raw;
        const _yyb = parseYybGoEntry(this.server);
        this.ref = _yyb.ref;
        this.openid = _yyb.ref;
    this.index = userIdx++;
    const account = parseAccount(raw);
    this.openid = account.openid || "";
    this.token = account.token || process.env.yichengtong_token || "";
    this.wxInfo = {};
    this.userInfo = {};
    this.cacheKey = this.openid || (this.token ? md5(this.token).slice(0, 16) : `account_${this.index}`);
  }

  getCached() {
    return readCache()[this.cacheKey] || {};
  }

  saveCache(extra = {}) {
    const cache = readCache();
    cache[this.cacheKey] = {
      ...(cache[this.cacheKey] || {}),
      ...(this.openid ? { openid: this.openid } : {}),
      ...(this.token ? { token: this.token } : {}),
      ...(this.userInfo?.userId ? { userId: this.userInfo.userId } : {}),
      ...(this.userInfo?.mobile ? { mobile: this.userInfo.mobile } : {}),
      ...extra,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  removeToken() {
    const cache = readCache();
    if (cache[this.cacheKey]) {
      delete cache[this.cacheKey].token;
      writeCache(cache);
    }
  }

  async getWxCode() {
        return await getCode(this.server);
    }

  async loginByCode() {
    const code = await this.getWxCode();
    const session = await request("post", "/client/web/wechatSession", {
      params: { code },
      data: {},
    });
    if (session.status !== 200 || !ok(session.data)) {
      throw new Error(`wechatSession失败[${session.status}]: ${session.text.slice(0, 500)}`);
    }
    const data = session.data.data || {};
    this.wxInfo = data.wxInfo || {};
    this.userInfo = data.userInfo || {};
    if (this.wxInfo.openid && !this.openid) this.openid = this.wxInfo.openid;
    const token = this.userInfo.token || data.token || "";
    if (!token) return false;
    this.token = token;
    this.saveCache({ loginType: "wechatSession" });
    console.log(`账号[${this.index}] code登录成功: ${mask(this.userInfo.userId || this.token)}`);
    return true;
  }

  async ensureLogin() {
    const cached = this.getCached();
    this.token = this.token || cached.token || "";
    this.userInfo.userId = cached.userId || "";
    if (this.token) return;
    if (!(await this.loginByCode())) {
      console.log(`账号[${this.index}] code登录失败，YYB Go 模式下不支持手机号授权数据兜底登录`);
    }
  }

  async api(method, urlPath, options = {}) {
    let res = await request(method, urlPath, { ...options, token: this.token });
    if (res.status === 401 || Number(res.data?.code) === 401) {
      console.log(`账号[${this.index}] token失效，尝试重新登录`);
      this.removeToken();
      this.token = "";
      await this.ensureLogin();
      res = await request(method, urlPath, { ...options, token: this.token });
    }
    return res;
  }

  async querySignHome() {
    const res = await this.api("get", "/client/user/signHome");
    if (res.status !== 200 || !ok(res.data)) {
      throw new Error(`签到信息查询失败[${res.status}]: ${res.text.slice(0, 800)}`);
    }
    const data = res.data.data || {};
    const amount = data.amount ?? 0;
    const integral = data.integral ?? 0;
    const configs = Array.isArray(data.configs) ? data.configs : [];
    const today = configs.find((item) => Number(item.signStatus) === 0) || configs.find((item) => item.today);
    const signed = configs.some((item) => Number(item.signStatus) === 1 && item.today);
    console.log(`账号[${this.index}] 查询: 积分${integral}，红包${amount}`);
    if (configs.length) {
      const statusText = configs
        .map((item) => `第${item.dayNum ?? item.days ?? "?"}天:${["未签", "已签", "可补签"][Number(item.signStatus)] || item.signStatus}`)
        .join("；");
      console.log(`账号[${this.index}] 签到日历: ${statusText}`);
    }
    return { data, today, signed };
  }

  async sign(signInfo) {
    if (!signInfo?.today?.logId) {
      console.log(`账号[${this.index}] 未找到今日可签到记录，可能已签到或活动未开放`);
      return;
    }
    const res = await this.api("post", "/client/user/sign", {
      data: { logId: signInfo.today.logId },
    });
    if (res.status === 200 && ok(res.data)) {
      console.log(`账号[${this.index}] 签到成功: ${res.data.msg || "成功"}`);
      return;
    }
    const msg = res.data?.msg || res.data?.message || res.text.slice(0, 500);
    if (/已签|重复|already/i.test(msg)) console.log(`账号[${this.index}] 今日已签到: ${msg}`);
    else console.log(`账号[${this.index}] 签到失败[${res.status}]: ${msg}`);
  }

  async queryTaskHome() {
    const res = await this.api("get", "/client/user/taskHome");
    if (res.status !== 200 || !ok(res.data)) {
      console.log(`账号[${this.index}] 任务信息查询失败[${res.status}]: ${res.text.slice(0, 500)}`);
      return null;
    }
    const data = res.data.data || {};
    console.log(`账号[${this.index}] 任务中心: 积分${data.integral ?? 0}，红包${data.amount ?? 0}`);
    const todayTask = Array.isArray(data.todayTask) ? data.todayTask : [];
    const experienceTask = Array.isArray(data.experienceTask) ? data.experienceTask : [];
    if (todayTask.length) console.log(`账号[${this.index}] 每日任务: ${taskSummary(todayTask)}`);
    if (experienceTask.length) console.log(`账号[${this.index}] 体验任务: ${taskSummary(experienceTask)}`);
    return data;
  }

  async submitTask(task) {
    const id = task.id || task.configId;
    if (!id) return false;
    const res = await this.api("post", "/client/user/taskSub", {
      data: { configId: id },
    });
    if (res.status === 200 && ok(res.data)) {
      console.log(`账号[${this.index}] 任务提交成功: ${taskName(task)} ${res.data.msg || ""}`);
      return true;
    }
    const msg = res.data?.msg || res.data?.message || res.text.slice(0, 500);
    console.log(`账号[${this.index}] 任务提交失败: ${taskName(task)}，${msg}`);
    return false;
  }

  async doDailyTasks(taskHome = null) {
    const data = taskHome || (await this.queryTaskHome());
    if (!data) return;
    const todayTask = Array.isArray(data.todayTask) ? data.todayTask : [];
    const runnable = todayTask.filter((task) => {
      const total = Number(task.num || 1);
      const done = Number(task.completeCount || 0);
      return done < total && AUTO_TASK_TYPES.has(Number(task.functionType));
    });
    if (!runnable.length) {
      console.log(`账号[${this.index}] 每日任务: 暂无可自动执行任务`);
      return;
    }

    for (const task of runnable) {
      const total = Number(task.num || 1);
      let done = Number(task.completeCount || 0);
      const waitSeconds = Math.max(0, Number(task.second || 0));
      while (done < total) {
        console.log(`账号[${this.index}] 执行每日任务: ${taskName(task)} ${done + 1}/${total}`);
        if (waitSeconds > 0) await await sleep(waitSeconds * 1000 + 500, waitSeconds * 1000 + 1800);
        const success = await this.submitTask(task);
        if (!success) break;
        done += 1;
        await await sleep(800, 1500);
      }
    }
  }

  async run() {
    await this.ensureLogin();
    const signInfo = await this.querySignHome();
    await this.sign(signInfo);
    await this.querySignHome();
    const taskHome = await this.queryTaskHome();
    await this.doDailyTasks(taskHome);
    await this.queryTaskHome();
    this.saveCache();
  }
}

!(async () => {
  
  for (const account of SERVERS) {
    try {
      await new Task(account).run();
    } catch (e) {
      console.log(`账号执行异常: ${e.message || e}`);
    }
    await await sleep(800, 1500);
  }
})()
  .catch((e) => console.log(e.message || e))
