'use strict';

// xjp supports:
//   YYB_BASE_URL - YYB协议地址，默认 http://172.17.0.1:18080
// Multiple accounts can be separated by newline or &.

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

const BASE_URL = 'https://mpb.jingjiu.com';
const YYB_BASE_URL = (process.env.YYB_BASE_URL || 'http://172.17.0.1:18080').replace(/\/+$/, '');
const ENV_ACCOUNTS = process.env.xjp || process.env.XJP || '';
const DRY_RUN = process.argv.includes('--dry-run') || process.env.XJP_DRY_RUN === '1';
const PLAY_DELAY_MS = Number(process.env.XJP_PLAY_DELAY_MS || 1200);
const ACCOUNT_DELAY_MS = Number(process.env.XJP_ACCOUNT_DELAY_MS || 2000);

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF';
const APPID = 'wxefd0fe341e06b815';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const todayDate = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

async function fetchAccountsFromYYB() {
  const base = YYB_BASE_URL;
  console.log(`[YYB] 尝试从 ${base} 获取账号`);
  try {
    const res = await new Promise((resolve, reject) => {
      const url = new URL(`${base}/accounts`);
      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: { raw: data } });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    console.log(`[YYB] 响应状态: ${res.status}`);
    if (res.status >= 200 && res.status < 300 && res.body && res.body.code === 0) {
      const list = Array.isArray(res.body.data) ? res.body.data : [];
      if (list.length) {
        console.log(`✅ 从 YYB 协议获取到 ${list.length} 个账号`);
        return list.map((item, idx) => ({
          name: item.nickname || item.remark || `账号${idx + 1}`,
          wxid: item.openid || item.wxid || '',
          userAgent: process.env.XJP_UA || DEFAULT_UA,
          xVersion: process.env.XJP_X_VERSION || '0.0.1',
          referer: process.env.XJP_REFERER || `https://servicewechat.com/${APPID}/723/page-frame.html`,
        })).filter((a) => a.wxid);
      } else {
        console.log(`❌ YYB 返回数据为空，请检查 YYB 协议是否正常运行`);
      }
    } else {
      console.log(`❌ YYB 返回错误: code=${res.body?.code}, msg=${res.body?.msg || res.body?.message || 'unknown'}`);
    }
  } catch (e) {
    console.log(`❌ 从 YYB 获取账号失败: ${e.message || e}`);
    console.log(`   请检查 YYB_BASE_URL=${base} 是否可达`);
  }
  return [];
}

function parseAccounts() {
  return ENV_ACCOUNTS
    .split(/[\r\n&]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name, ...rest] = line.includes('#') ? line.split('#') : [`账号${index + 1}`, line];
      const credential = rest.join('#').trim();
      const base = {
        name: name.trim() || `账号${index + 1}`,
        userAgent: process.env.XJP_UA || DEFAULT_UA,
        xVersion: process.env.XJP_X_VERSION || '0.0.1',
        referer: process.env.XJP_REFERER || `https://servicewechat.com/${APPID}/723/page-frame.html`,
      };
      if (/^wxid_/i.test(credential)) {
        return { ...base, wxid: credential };
      }
      return {
        ...base,
        authorization: credential,
      };
    });
}

function request(account, method, path, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const body = data == null ? '' : JSON.stringify(data);
    const headers = {
      'content-type': 'application/json',
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': account.userAgent || DEFAULT_UA,
      'x-version': account.xVersion || '0.0.1',
      'xweb_xhr': '1',
      'referer': account.referer || `https://servicewechat.com/${APPID}/723/page-frame.html`,
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
    };
    if (account.authorization && !Object.prototype.hasOwnProperty.call(extraHeaders, 'Authorization')) {
      headers.authorization = account.authorization;
    }
    Object.assign(headers, extraHeaders);

    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc.includes('gzip') || enc.includes('deflate')) stream = res.pipe(zlib.createUnzip());
      if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function postJson(urlText, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const body = JSON.stringify(data || {});
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function deepFindCode(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.code === 'string' && obj.code) return obj.code;
  if (typeof obj.Code === 'string' && obj.Code) return obj.Code;
  for (const value of Object.values(obj)) {
    const found = deepFindCode(value);
    if (found) return found;
  }
  return '';
}

async function getWxCode(wxid) {
  const res = await postJson(`${YYB_BASE_URL}/wxapp/getCode`, { ref: wxid, app_id: APPID });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`YYB HTTP ${res.status}: ${String(res.raw).slice(0, 160)}`);
  }
  const body = res.body || {};
  let code = null;
  if (body.code === 0) {
    const data = body.data || {};
    const result = data.result || {};
    code = result.code || result.Code || data.code || data.Code;
  }
  if (!code && body.Success === true) {
    const data = body.Data || body.data || {};
    code = data.Code || data.code;
  }
  if (!code) {
    throw new Error(`YYB 未返回 code: ${JSON.stringify(res.body).slice(0, 220)}`);
  }
  return String(code);
}

async function ensureAuthorization(account) {
  if (account.authorization) return;
  if (!account.wxid) throw new Error(`${account.name} 缺少 authorization/wxid`);

  if (DRY_RUN) {
    console.log(`  [dry] wxid 登录: ${account.wxid}`);
    account.authorization = 'dry-run-token';
    return;
  }

  console.log(`  [登录] wxid -> code: ${account.wxid}`);
  const code = await getWxCode(account.wxid);
  console.log('  [登录] code -> access_token');
  const login = await api({ ...account, authorization: '' }, '/proxy-he/jp/api/loginauto', {
    code,
    unionid: account.unionid || '',
    user_id: '',
    user_sources: '0',
  });
  const data = login.data || {};
  if (!data.access_token) {
    throw new Error(`/jp/api/loginauto 未返回 access_token: ${JSON.stringify(data).slice(0, 220)}`);
  }
  account.authorization = data.access_token;
  account.unionid = data.unionid || account.unionid || '';
  account.sessionKey = data.session_key || '';
  account.userId = data.user_id || '';
}

async function api(account, path, data = {}, method = 'POST', extraHeaders = {}) {
  if (DRY_RUN) {
    console.log(`    [dry] ${method} ${path} ${JSON.stringify(data)}`);
    return { code: 0, data: dryData(path), message: 'dry-run' };
  }
  const res = await request(account, method, path, data, extraHeaders);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} HTTP ${res.status}: ${String(res.raw).slice(0, 200)}`);
  }
  if (!res.body || typeof res.body !== 'object') {
    throw new Error(`${method} ${path} 返回非 JSON: ${String(res.raw).slice(0, 200)}`);
  }
  if (res.body.code !== 0) {
    throw new Error(`${method} ${path} code=${res.body.code} message=${res.body.message || ''}`);
  }
  return res.body;
}

function dryData(path) {
  if (path.includes('userInfoV2025')) {
    return { user_show: { name: 'dry-run', point: 0, level_name: 'dry-run' } };
  }
  if (path.includes('taskUserListsV2025')) {
    return {
      taskList: [
        { name: 'dry-run 视频任务', tag_group: 'view_video', tag: 'dry_video', point: 1 },
        { name: 'dry-run 订阅任务', tag_group: 'subscribe_message', tag: 'dry_subscribe', point: 1 },
        { name: 'dry-run 普通任务', tag_group: 'normal', task_id: 1001, point: 1 },
        { name: 'dry-run 知识问答', tag_group: 'knowledge_qa', tag: 'dry_qa', questionnaire_paper_id: 1002, point: 1 },
        { name: 'dry-run 调研问卷', tag_group: 'questionnaire', tag: 'dry_questionnaire', questionnaire_paper_id: 1003, point: 1 },
        { name: 'dry-run 每日调研', tag_group: 'daily_survey', tag: 'dry_daily_survey', point: 1 },
      ],
    };
  }
  if (path.includes('taskQuestionnairePaperDetails')) {
    return {
      paper: {
        paper_id: 1002,
        paper_name: 'dry-run 问卷',
        questions: [
          {
            type: 'single',
            title: 'dry-run',
            options: [
              { label: 'A', value: 'A', score: 1 },
              { label: 'B', value: 'B', score: 0 },
            ],
          },
        ],
      },
    };
  }
  if (path.includes('qingxingUserMains')) {
    return { today_play_num_can: 1, is_play_max: -1, activity_status: 'Can', activity: { activity_id: 9333 } };
  }
  if (path.includes('dateUserMains')) {
    return { today_play_num_can: 1, is_play_max: -1, activity_status: 'Can', activity: { activity_id: 100000 } };
  }
  if (path.includes('UserMains')) {
    return { today_play_num_can: 1, is_play_max: -1, activity_status: 'Can', activity: {} };
  }
  if (path.includes('FlanSignInDaily/adds')) {
    return { is_first: 0, jifen: 1, point: 1, message: 'dry-run' };
  }
  if (path.includes('FlanSignInDaily/mains')) {
    return { sign_in_day_continue: 1, sign_in_day_total: 1 };
  }
  if (path.includes('UserDrawGet')) {
    return { user_record_id: 999999 };
  }
  if (path.includes('userFinishs')) {
    return { user_play_id: 888888, user_record_year: new Date().getFullYear() };
  }
  if (path.includes('UserDraws') || path.includes('datelUserDraws')) {
    return { awardLocal: { title: 'dry-run' }, award_jifen: { jifen: 0 } };
  }
  return {};
}

function canPlay(data) {
  if (!data) return false;
  if (data.activity_status && data.activity_status !== 'Can') return false;
  if (Number(data.today_play_num_can || 0) <= 0) return false;
  if (Number(data.is_play_max || -1) === 1) return false;
  return true;
}

function awardText(data) {
  if (!data) return '无奖励信息';
  const local = data.awardLocal || {};
  const title = local.title || (Array.isArray(data.award) && data.award[0] && data.award[0].title) || '';
  const jifen = (data.award_jifen && data.award_jifen.jifen) || local.jifen || '';
  if (title && jifen) return `${title} (${jifen}积分)`;
  if (title) return title;
  if (jifen) return `${jifen}积分`;
  return '未中奖/无奖励信息';
}

function appSignHeaders(account, data, keys) {
  const apptime = nowSec();
  let signPayload = '';
  const keySet = new Set(keys.map(String));
  for (const key of Object.keys(data)) {
    if (!keySet.has(String(key))) continue;
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      signPayload += `${key}${String(data[key])}`;
    }
  }
  const raw = `${apptime}${signPayload}DYSHJS^M&.YXZRGS${account.authorization}`;
  const appsign = crypto.createHash('md5').update(raw).digest('hex').toUpperCase().slice(-10);
  return {
    apptime: String(apptime),
    appsign,
    Authorization: account.authorization,
  };
}

function signText(addData, mainData) {
  const parts = [];
  const point = addData && (addData.jifen || addData.point || addData.award_jifen);
  if (point) parts.push(`积分+${point}`);
  if (addData && addData.is_first === 1) parts.push('首次签到');
  if (mainData && mainData.sign_in_day_continue != null) parts.push(`连续${mainData.sign_in_day_continue}天`);
  return parts.length ? parts.join('，') : '已请求签到';
}

async function runDailySign(account) {
  const name = '每日签到';
  try {
    const body = { date: todayDate() };
    console.log(`  [${name}] 签到`);
    const add = await api(
      account,
      '/proxy-he/api/FlanSignInDaily/adds',
      body,
      'POST',
      appSignHeaders(account, body, ['date'])
    );
    const main = await api(account, '/proxy-he/api/FlanSignInDaily/mains', {});
    console.log(`  [${name}] ${signText(add.data, main.data)}`);
  } catch (err) {
    console.log(`  [${name}] 失败: ${err.message}`);
  }
}

async function runLongTask(account, task) {
  console.log(`  [${task.name}] 查询`);
  const main = await api(account, task.mainPath, {});
  const activity = main.data && main.data.activity ? main.data.activity : {};
  const activityId = activity.activity_id || task.activityId;

  if (!DRY_RUN && !canPlay(main.data)) {
    console.log(`  [${task.name}] 今日无次数或活动不可参与`);
    return;
  }

  const startBody = task.startBody(activityId);
  const startHeaders = task.startSignKeys ? appSignHeaders(account, startBody, task.startSignKeys) : {};
  console.log(`  [${task.name}] 开始`);
  const start = await api(account, task.startPath, startBody, 'POST', startHeaders);
  const recordId = start.data && start.data.user_record_id;
  if (!DRY_RUN && !recordId) throw new Error(`${task.name} 未返回 user_record_id`);

  await sleep(PLAY_DELAY_MS);
  console.log(`  [${task.name}] 完成/抽奖`);
  const finishBody = task.finishBody(activityId, recordId);
  const finishHeaders = task.finishSignKeys ? appSignHeaders(account, finishBody, task.finishSignKeys) : {};
  const finish = await api(account, task.finishPath, finishBody, 'POST', finishHeaders);
  console.log(`  [${task.name}] ${awardText(finish.data)}`);
}

async function runQingxing(account) {
  const name = '春日轻醒力';
  console.log(`  [${name}] 查询`);
  const main = await api(account, '/proxy-he/api/BlzLongcaobenActivity/qingxingUserMains', {});
  const activityId = main.data && main.data.activity && main.data.activity.activity_id;

  if (!DRY_RUN && !canPlay(main.data)) {
    console.log(`  [${name}] 今日无次数或活动不可参与`);
    return;
  }

  console.log(`  [${name}] 开始`);
  await api(account, '/proxy-he/api/BlzLongcaobenActivity/qingxingUserStarts', { activity_id: activityId });
  const get = await api(account, '/proxy-he/api/BlzLongcaobenActivity/qingxingUserDrawGet', {
    activity_id: String(activityId),
    play_finish_is: -1,
  });
  const recordId = get.data && get.data.user_record_id;
  if (!DRY_RUN && !recordId) throw new Error(`${name} 未返回 user_record_id`);

  await sleep(PLAY_DELAY_MS);
  console.log(`  [${name}] 完成/抽奖`);
  const draw = await api(account, '/proxy-he/api/BlzLongcaobenActivity/qingxingUserDraws', {
    user_record_id: recordId,
  });
  console.log(`  [${name}] ${awardText(draw.data)}`);
}

async function runMeishi(account) {
  const name = '夏日美食配对';
  const activityId = 100000;
  console.log(`  [${name}] 查询`);
  const main = await api(account, '/proxy-he/api/opactivity/ccncommon/dateUserMains', {
    activity_id: activityId,
    latitude: '',
    longitude: '',
  });

  if (!DRY_RUN && !canPlay(main.data)) {
    console.log(`  [${name}] 今日无次数或活动不可参与`);
    return;
  }

  console.log(`  [${name}] 开始`);
  await api(account, '/proxy-he/api/opactivity/ccncommon/userStarts', { activity_id: activityId });
  await sleep(PLAY_DELAY_MS);
  const finish = await api(account, '/proxy-he/api/opactivity/ccncommon/userFinishs', {
    activity_id: String(activityId),
    latitude: '',
    longitude: '',
    province: '',
    city: '',
    district: '',
    play_data_json: '',
    play_finish_is: 1,
  });
  const userPlayId = finish.data && finish.data.user_play_id;
  const year = finish.data && finish.data.user_record_year;
  if (!DRY_RUN && (!userPlayId || !year)) throw new Error(`${name} 未返回 user_play_id/year`);

  console.log(`  [${name}] 抽奖`);
  const draw = await api(account, '/proxy-he/api/opactivity/ccncommon/datelUserDraws', {
    activity_id: String(activityId),
    user_play_id: String(userPlayId),
    year: String(year),
  });
  console.log(`  [${name}] ${awardText(draw.data)}`);
}

function parseOptions(options) {
  if (Array.isArray(options)) return options;
  if (typeof options !== 'string' || !options.trim()) return [];
  try {
    const parsed = JSON.parse(options);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function autoAnswerQuestion(question, preferScored) {
  const result = { ...question };
  result.type = result.type || 'single';

  if (result.type === 'text') {
    result.textAnswer = result.textAnswer || '无';
    return result;
  }

  const options = parseOptions(result.options).map((option) => ({ ...option, selected: false }));
  if (!options.length) {
    result.options = options;
    result.otherAnswer = '';
    result.selectedOption = '';
    return result;
  }

  let selectedIndexes = [];
  if (preferScored) {
    selectedIndexes = options
      .map((option, index) => (Number(option.score || 0) > 0 ? index : -1))
      .filter((index) => index >= 0);
  }
  if (!selectedIndexes.length && result.type === 'rating') selectedIndexes = [options.length - 1];
  if (!selectedIndexes.length) selectedIndexes = [0];
  if (result.type !== 'multiple') selectedIndexes = [selectedIndexes[0]];

  for (const index of selectedIndexes) {
    options[index].selected = true;
  }

  result.options = options;
  result.otherAnswer = '';
  result.selectedOption = selectedIndexes.map((index) => String(options[index].value ?? '')).filter(Boolean).join(',');
  return result;
}

async function submitQuestionnaire(account, task, preferScored) {
  const paperId = task.questionnaire_paper_id || task.paper_id;
  if (!paperId) throw new Error('缺少 questionnaire_paper_id');

  const detail = await api(account, '/proxy-he/api/BlzAppletIndex/taskQuestionnairePaperDetails', {
    tag: task.tag || '',
    questionnaire_paper_id: paperId,
  });
  const paper = detail.data && detail.data.paper ? detail.data.paper : {};
  const questions = Array.isArray(paper.questions) ? paper.questions : [];
  if (!questions.length) throw new Error('问卷详情未返回 questions');

  return api(account, '/proxy-he/api/BlzAppletIndex/taskQuestionnairePaperCreates', {
    tag: task.tag || '',
    paper_id: paper.paper_id || paperId,
    paper_name: paper.paper_name || task.name || '任务问卷',
    questions: JSON.stringify(questions.map((question) => autoAnswerQuestion(question, preferScored))),
  });
}

function taskFinished(task) {
  const doneValues = new Set([true, 1, '1', 'true', 'finished', 'done', 'completed']);
  return (
    doneValues.has(task.finished) ||
    doneValues.has(task.is_finished) ||
    doneValues.has(task.is_finish) ||
    doneValues.has(task.finish_status) ||
    doneValues.has(task.status)
  );
}

function isSurveyFinishTask(task, taskName) {
  if (!task.tag) return false;
  if (task.tag_group === 'questionnaire_finish' || task.tag_group === 'daily_survey' || task.tag_group === 'survey') {
    return true;
  }
  return /调研|问卷|問卷/.test(taskName) && !task.questionnaire_paper_id;
}

async function runTaskCenter(account) {
  const name = '任务中心';
  console.log(`  [${name}] 查询`);
  let taskRes;
  try {
    taskRes = await api(account, '/proxy-he/api/BlzAppletIndex/taskUserListsV2025', {});
  } catch (err) {
    console.log(`  [${name}] 失败: ${err.message}`);
    return;
  }

  const tasks = (taskRes.data && taskRes.data.taskList) || [];
  if (!Array.isArray(tasks) || !tasks.length) {
    console.log(`  [${name}] 无任务`);
    return;
  }

  console.log(`  [${name}] 共${tasks.length}个任务`);
  for (const task of tasks) {
    const taskName = task.name || task.task_name || task.title || task.tag_group || '未命名任务';
    try {
      if (task.tag_group === 'sign_day') {
        console.log(`  [${name}] ${taskName} 已由每日签到处理`);
        continue;
      }
      if (taskFinished(task)) {
        console.log(`  [${name}] ${taskName} 已完成`);
        continue;
      }

      console.log(`  [${name}] ${taskName} 执行`);
      if (task.tag_group === 'questionnaire') {
        await submitQuestionnaire(account, task, false);
      } else if (task.tag_group === 'knowledge_qa') {
        await submitQuestionnaire(account, task, true);
      } else if (task.tag_group === 'view_video') {
        await api(account, '/proxy-he/api/BlzAppletIndex/taskViewVideoView', { video_id: task.video_id || 'video-119' });
      } else if (task.tag_group === 'subscribe_message') {
        await api(account, '/proxy-he/api/BlzAppletIndex/taskSubscribeMessage', { tag: task.tag || '' });
      } else if (isSurveyFinishTask(task, taskName)) {
        await api(account, '/proxy-he/api/BlzAppletIndex/taskQuestionnaireFinish', { tag: task.tag });
      } else if (task.tag_group === 'share' || task.tag_group === 'user_share') {
        await api(account, '/proxy-he/api/BlzAppletIndex/taskUserShareStatss', { tag: task.tag || '' });
      } else if (task.task_id) {
        await api(account, '/proxy-he/api/BlzAppletIndex/taskFinish', { task_id: task.task_id });
      } else {
        console.log(`  [${name}] ${taskName} 暂不支持 tag_group=${task.tag_group || '-'}`);
        continue;
      }
      console.log(`  [${name}] ${taskName} 完成${task.point ? ` +${task.point}积分` : ''}`);
    } catch (err) {
      console.log(`  [${name}] ${taskName} 失败: ${err.message}`);
    }
    await sleep(800);
  }
}

async function printUser(account, label) {
  const user = await api(account, '/proxy-he/jp/api/BlzAppletIndex/userInfoV2025', {});
  const show = user.data && user.data.user_show ? user.data.user_show : {};
  console.log(`  [${label}] ${show.name || '微信用户'} 积分=${show.point ?? '-'} 等级=${show.level_name || '-'}`);
}

const longTasks = [
  {
    name: '识草寻源',
    activityId: 200,
    mainPath: '/proxy-he/api/BlzLonglActivity/shicaoxunyuanUserMains',
    startPath: '/proxy-he/api/BlzLonglActivity/shicaoxunyuanUserDrawGet',
    finishPath: '/proxy-he/api/BlzLonglActivity/shicaoxunyuanUserDraws',
    startBody: () => ({ play_time_start: nowSec(), use_type: 'free' }),
    finishBody: (_activityId, recordId) => ({ play_time_finish: nowSec(), user_record_id: recordId }),
    startSignKeys: ['play_time_start', 'use_type'],
    finishSignKeys: ['user_record_id', 'play_time_finish'],
  },
  {
    name: '毛铺草本实验室',
    activityId: 201,
    mainPath: '/proxy-he/api/BlzLonglActivity/caobenshiyanshiUserMains',
    startPath: '/proxy-he/api/BlzLonglActivity/caobenshiyanshiUserDrawGet',
    finishPath: '/proxy-he/api/BlzLonglActivity/caobenshiyanshiUserDraws',
    startBody: () => ({ play_time_start: nowSec(), use_type: 'free' }),
    finishBody: (_activityId, recordId) => ({ play_time_finish: nowSec(), user_record_id: recordId }),
  },
  {
    name: '代谢研究所',
    activityId: 202,
    mainPath: '/proxy-he/api/BlzLonglActivity/daixieyanjiusuoUserMains',
    startPath: '/proxy-he/api/BlzLonglActivity/daixieyanjiusuoUserDrawGet',
    finishPath: '/proxy-he/api/BlzLonglActivity/daixieyanjiusuoUserDraws',
    startBody: (activityId) => ({ activity_id: String(activityId), play_time_start: nowSec() }),
    finishBody: (activityId, recordId) => ({ activity_id: String(activityId), play_time_finish: nowSec(), user_record_id: recordId }),
    startSignKeys: ['activity_id', 'play_time_start'],
    finishSignKeys: ['play_time_finish', 'user_record_id'],
  },
];

async function runAccount(account, index) {
  console.log(`\n===== ${account.name} (${index + 1}) =====`);
  await ensureAuthorization(account);

  await printUser(account, '执行前');
  await runDailySign(account);
  await runTaskCenter(account);
  for (const task of longTasks) {
    try {
      await runLongTask(account, task);
    } catch (err) {
      console.log(`  [${task.name}] 失败: ${err.message}`);
    }
  }

  for (const fn of [runQingxing, runMeishi]) {
    try {
      await fn(account);
    } catch (err) {
      console.log(`  [任务] 失败: ${err.message}`);
    }
  }
  await printUser(account, '执行后');
}

(async () => {
  try {
    let accounts = parseAccounts();
    if (!accounts.length) {
      const yybAccounts = await fetchAccountsFromYYB();
      if (yybAccounts.length) {
        accounts = yybAccounts;
      }
    }
    if (!accounts.length) {
      throw new Error('请设置环境变量 xjp 或配置 YYB_BASE_URL；格式：备注#wxid，多账号用换行或 & 分隔');
    }
    console.log(`小酒铺任务启动，账号数=${accounts.length}${DRY_RUN ? '，dry-run' : ''}`);
    for (let i = 0; i < accounts.length; i++) {
      try {
        await runAccount(accounts[i], i);
      } catch (err) {
        console.log(`  [账号失败] ${accounts[i].name}: ${err.message}`);
      }
      if (i < accounts.length - 1) await sleep(ACCOUNT_DELAY_MS);
    }
    console.log('\n全部执行完成');
  } catch (err) {
    console.log(`运行失败: ${err.message}`);
    process.exitCode = 1;
  }
})();
