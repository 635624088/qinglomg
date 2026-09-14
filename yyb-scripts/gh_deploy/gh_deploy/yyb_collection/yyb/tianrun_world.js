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
// name: 甜润世界签到施肥
// cron: 1 15 * * *

const axios = require("axios");
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
        const { data } = await axios.post(url, { ref, app_id: APPID }, { timeout: 20000, proxy: false });
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

// ====== 业务常量 ======
const APP_NAME = "甜润世界";
const APPID = "wx210e40a77dbe7a27";
const BASE = "https://m.ahzyssl.com";
const UA = "Mozilla/5.0 (Linux; Android 14; PJE110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 MiniProgramEnv/android";
const BASE_HEADERS = {
    Host: "m.ahzyssl.com",
    Connection: "keep-alive",
    charset: "utf-8",
    "User-Agent": UA,
    Referer: `https://servicewechat.com/${APPID}/page-frame.html`,
};
// ======================

const now = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

let successCount = 0, failedCount = 0, skippedCount = 0;

// ====== 登录 ======
async function loginWithCode(code) {
    try {
        const resp = await axios.get(`${BASE}/wx/user/appletLogin`, {
            params: { code },
            headers: { "Content-Type": "application/json" },
            timeout: 20000,
        });
        if (resp.data?.code === 200 && resp.data?.data) {
            return resp.data.data;
        }
        console.log(`    [✗] 登录失败: ${resp.data?.msg || "未知错误"}`);
        return null;
    } catch (e) {
        console.log(`    [✗] 登录异常: ${e.message}`);
        return null;
    }
}

// ====== 通用请求 ======
async function doRequest(token, url, desc, method = "GET") {
    try {
        const opts = {
            headers: { ...BASE_HEADERS, Authorization: token },
            timeout: 45000,
            validateStatus: () => true,
        };
        const resp = method === "POST" ? await axios.post(url, null, opts) : await axios.get(url, opts);
        const data = resp.data;
        const msg = data?.msg || "操作成功";
        console.log(`    [${desc}] ${msg}`);
        return data;
    } catch (e) {
        console.log(`    [${desc}] 失败: ${e.message}`);
        return null;
    }
}

// ====== 业务步骤 ======

// [1/5] 签到有奖
async function signInAward(token) {
    const logs = [];
    const resp = await doRequest(token, `${BASE}/applet/user/signIn/getUserSignInLog`, "查询签到有奖状态");
    if (!resp || resp.code !== 200) { logs.push("查询签到有奖状态失败"); return logs; }
    const today = now().slice(0, 10);
    const signList = resp.data?.userSignInList || [];
    const signed = signList.some(i => i.signInDate === today && i.signInStatus === 1);
    if (signed) {
        logs.push("签到有奖：今日已完成");
    } else {
        const r = await doRequest(token, `${BASE}/applet/user/signIn`, "执行签到有奖", "POST");
        logs.push(r?.code === 200 ? "签到有奖成功" : "签到有奖失败");
    }
    return logs;
}

// [2/5] 石斛签到
async function dendrobiumSign(token) {
    const logs = [];
    const resp = await doRequest(token, `${BASE}/applet/game/dendrobium/signIn/getUserSignInLog`, "查询石斛签到状态");
    if (resp?.data?.todaySignInStatus) {
        logs.push("石斛签到：今日已完成");
    } else {
        const r = await doRequest(token, `${BASE}/applet/game/dendrobium/signIn`, "执行石斛签到");
        logs.push(r?.code === 200 ? "石斛签到成功" : "石斛签到失败");
    }
    return logs;
}

// [3/5] 推文浏览（3次，每次等30-40秒）
async function browseArticles(token) {
    const test = await doRequest(token, `${BASE}/applet/game/dendrobium/article/completeRead`, "检查推文状态");
    if (!test || test.code !== 200 || !(test.msg || "").startsWith("肥料")) {
        return ["今日推文已完成，跳过"];
    }
    const logs = [];
    for (let i = 1; i <= 3; i++) {
        const sec = randInt(30, 40);
        console.log(`    第${i}次浏览，等待${sec}秒`);
        await sleep(sec * 1000);
        const r = await doRequest(token, `${BASE}/applet/game/dendrobium/article/completeRead`, `第${i}次推文浏览`);
        if (r?.code === 200) logs.push(`第${i}次浏览成功`);
        else { logs.push(`第${i}次浏览已完成`); break; }
        await sleep(2000);
    }
    return logs;
}

// [4/5] 徽宝买肥料
async function buyFertilizer(token) {
    const logs = [];
    const userInfo = await doRequest(token, `${BASE}/applet/game/dendrobium/getUserInfo`, "查询积分");
    if (!userInfo || userInfo.code !== 200) { logs.push("查询积分失败"); return logs; }
    let integrate = userInfo.data?.integrate || 0;
    logs.push(`当前徽宝: ${integrate}`);

    const goodsResp = await doRequest(token, `${BASE}/applet/game/dendrobium/goods/list?type=1`, "查询肥料商品");
    if (!goodsResp || goodsResp.code !== 200 || !goodsResp.data?.length) { logs.push("查询商品列表失败"); return logs; }

    const goodsList = goodsResp.data.sort((a, b) => (b.price || 0) - (a.price || 0));
    let remain = integrate;

    for (const item of goodsList) {
        const price = item.price || 0;
        if (price <= 0) continue;
        const maxCount = Math.floor(remain / price);
        if (maxCount <= 0) continue;
        console.log(`    购买 ${item.goodsName} x${maxCount} (共${maxCount * price}徽宝)`);
        for (let i = 0; i < maxCount; i++) {
            const r = await doRequest(token, `${BASE}/applet/game/dendrobium/order/placeOrder?goodsId=${item.goodsId}&goodsNum=1`, `买${item.goodsName} 第${i + 1}次`);
            if (r?.code === 200) remain -= price;
            else break;
            await sleep(1000);
        }
    }
    logs.push(`共花费 ${integrate - remain} 徽宝，剩余 ${remain} 徽宝`);
    return logs;
}

// [5/5] 自动施肥（肥料<100g停止）
async function exhaustFertilizer(token) {
    const logs = [];
    let count = 0;
    while (true) {
        const info = await doRequest(token, `${BASE}/applet/game/dendrobium/get`, "查询肥料数量");
        if (!info || info.code !== 200) break;
        const val = info.data?.fertilizer || 0;
        if (val < 100) { logs.push(`肥料剩余${val}g，停止`); break; }
        await doRequest(token, `${BASE}/applet/game/dendrobium/fertilizer`, `施肥第${count + 1}次`);
        count++;
        await sleep(1000);
    }
    logs.push(`共施肥${count}次`);
    return logs;
}

// ====== 账号处理 ======
async function processAccount(server, idx) {
    const { ref } = parseYybGoEntry(server);
    console.log(`\n[${idx}/${SERVERS.length}] ${"=".repeat(40)}`);
    console.log(`  ${APP_NAME} | ${ref} | ${now()}`);
    console.log(`${"=".repeat(40)}`);

    console.log(`  [1/6] 获取 wx.login code...`);
    const code = await getCode(server);
    if (!code) {
        console.log(`  [✗] 获取 code 失败, 跳过此账号`);
        skippedCount++;
        return "skip";
    }

    console.log(`  [2/6] 登录 ${APP_NAME}...`);
    const token = await loginWithCode(code);
    if (!token) {
        console.log(`  [✗] 登录失败，跳过`);
        failedCount++;
        return "fail";
    }

    console.log(`  [3/6] 签到有奖...`);
    const allLogs = [];
    allLogs.push(...await signInAward(token));

    console.log(`  [4/6] 石斛签到...`);
    allLogs.push(...await dendrobiumSign(token));

    console.log(`  [5/6] 推文浏览...`);
    allLogs.push(...await browseArticles(token));

    console.log(`  [6/6] 徽宝买肥料 + 自动施肥...`);
    allLogs.push(...await buyFertilizer(token));
    allLogs.push(...await exhaustFertilizer(token));

    console.log(`\n  📋 汇总: ${allLogs.join("; ")}`);
    successCount++;
    return "success";
}

// ====== 主函数 ======
async function main() {
    console.log("=".repeat(56));
    console.log(`  ${APP_NAME} 签到+施肥 (YYB版)`);
    console.log(`  时间: ${now()}`);
    console.log("=".repeat(56));
    console.log(`✅ 读取到 ${SERVERS.length} 个 YYB Go 账号\n`);

    for (let i = 0; i < SERVERS.length; i++) {
        try {
            await processAccount(SERVERS[i], i + 1);
        } catch (e) {
            console.log(`  [✗] 账号执行异常: ${e.message}`);
            failedCount++;
        }
        if (i < SERVERS.length - 1) await sleep(5000);
    }

    console.log("\n" + "=".repeat(56));
    console.log("  📊 执行汇总");
    console.log("=".repeat(56));
    console.log(`  ✅ 成功: ${successCount} 个`);
    console.log(`  ❌ 失败: ${failedCount} 个`);
    console.log(`  ⏭️  跳过: ${skippedCount} 个`);
    console.log("=".repeat(56));
    console.log("  全部任务执行完毕!");
    console.log("=".repeat(56));
}

main().catch(e => console.error(e.message || e));
