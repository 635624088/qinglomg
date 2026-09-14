#!/usr/bin/env node
/**
 * 统一阿萨姆/微盟大转盘：8014 获取小程序 code -> loginX 换 token -> 查机会 -> 抽奖 -> 查中奖记录
 *
 * 青龙变量：
 *   YYB_URL=http://172.17.0.1:18080   青龙容器内访问 pure（外部可改此变量覆盖）
 *   WEIMOB=2                 多账号可换行/逗号/& 分隔；不填则跑 /accounts 全部
 *   YYB_REF=2                单账号，WEIMOB 优先
 *
 * 可选变量：
 *   WEIMOB_DRAW=1            1=有机会就抽奖；0=只查机会和中奖记录，默认1
 *   WEIMOB_ACTIVITIES=30000158204:222,30000159359:337:100148708
 *                            格式：activityId:xBizId:tracePromotionId，可换行/逗号/& 分隔
 *   WEIMOB_APPID=wx532ecb3bdaaf92f9
 *   WEIMOB_CACHE=weimob_token_cache.json
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const YYB_URL = (process.env.YYB_URL || 'http://172.17.0.1:18080').trim().replace(/\/+$/, '')
const WEIMOB_REFS = (process.env.WEIMOB || '').trim()
const YYB_REF = (process.env.YYB_REF || '').trim()
const DO_DRAW = !['0', 'false', 'False', 'no', 'off'].includes((process.env.WEIMOB_DRAW || '1').trim())
const WEIMOB_ACTIVITIES_RAW = (process.env.WEIMOB_ACTIVITIES || '30000158204:222,30000159359:337:100148708').trim()
const CACHE_FILE = process.env.WEIMOB_CACHE || path.join(__dirname, 'weimob_token_cache.json')

const APPID = process.env.WEIMOB_APPID || 'wx532ecb3bdaaf92f9'
const PID = '4020112618957'
const BOS_ID = 4020112618957
const VID = 6013753979957
const CID = 176205957
const WID_VID = '6013753979957'
const MERCHANT_ID = 2000020692957
const PRODUCT_ID = 222
const PRODUCT_INSTANCE_ID = 3169919957
const PRODUCT_VERSION_ID = '12004'
const ACTIVITY_ID = '30000158204'
const ACTIVITY_IDENTITY = '20'
const TEMPLATE_ID = 812
const TEMPLATE_KEY = 'bigwheel'
const YOUSHU_TOKEN = 'bicbd2929b97584cb7'
const BASE = 'https://xapi.weimob.com'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b62) NetType/WIFI Language/zh_CN'
const REFERER = `https://servicewechat.com/${APPID}/293/page-frame.html`

function splitEnv(v) {
  return String(v || '').replace(/\n/g, ',').replace(/&/g, ',').split(',').map(x => x.trim()).filter(Boolean)
}
function parseActivities() {
  const raw = WEIMOB_ACTIVITIES_RAW || '30000158204:222,30000159359:337:100148708'
  return splitEnv(raw).map((part, idx) => {
    const arr = String(part).split(':').map(x => x.trim())
    return {
      name: `活动${idx + 1}`,
      activityId: arr[0] || ACTIVITY_ID,
      xBizId: arr[1] || '222',
      tracePromotionId: arr[2] || ''
    }
  }).filter(x => x.activityId)
}

function randHex(n = 16) { return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n) }
function uuidLike() { return `${randHex(8)}-${randHex(4)}-${randHex(4)}-${randHex(4)}-${randHex(12)}` }
function mask(v) {
  v = String(v || '')
  return v.length > 10 ? `${v.slice(0, 4)}***${v.slice(-4)}` : v
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {} } catch { return {} }
}
function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8') } catch (e) { console.log('⚠️ 缓存写入失败：' + e.message) }
}
async function readJson(resp, label) {
  const text = await resp.text()
  try { return JSON.parse(text) } catch { throw new Error(`${label} 返回非JSON：HTTP ${resp.status} ${text.slice(0, 300)}`) }
}

async function yybRequest(method, apiPath, payload) {
  const opt = { method, headers: { Accept: 'application/json' } }
  if (payload) {
    opt.headers['Content-Type'] = 'application/json'
    opt.body = JSON.stringify(payload)
  }
  const resp = await fetch(`${YYB_URL}${apiPath}`, opt)
  const data = await readJson(resp, 'YYB')
  if (resp.status >= 400) throw new Error(`YYB HTTP ${resp.status}：${JSON.stringify(data)}`)
  if (data.success === false || data.status === false) throw new Error(data.message || data.msg || 'YYB请求失败')
  if (data.code != null && !['0', '200', 'true', 'True'].includes(String(data.code))) throw new Error(data.message || data.msg || `YYB code=${data.code}`)
  return data
}
function findCode(obj) {
  if (!obj) return ''
  if (Array.isArray(obj)) {
    for (const x of obj) { const c = findCode(x); if (c) return c }
  } else if (typeof obj === 'object') {
    for (const k of ['code', 'wx_code', 'app_code', 'js_code']) {
      if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim()
    }
    for (const v of Object.values(obj)) { const c = findCode(v); if (c) return c }
  }
  return ''
}
async function getAccounts() {
  const refs = splitEnv(WEIMOB_REFS || YYB_REF)
  const data = await yybRequest('GET', '/accounts')
  let list = Array.isArray(data.data) ? data.data : (Array.isArray(data.result) ? data.result : [])
  list = list.filter(x => x && x.id != null)
  if (refs.length) {
    list = list.filter(x => ['id', 'uin', 'openid'].some(k => refs.includes(String(x[k] || ''))))
  }
  if (!list.length) throw new Error('没有匹配到 8014 账号')
  return list
}
function accountLabel(a) {
  return String(a.nickname || a.name || a.remark || a.phone || a.openid || a.uin || a.id || '未知账号')
}
function getAccountOpenid(a) {
  const keys = ['openid', 'openId', 'wx_openid', 'wxOpenid', 'wxid', 'ref']
  for (const k of keys) {
    const v = String(a[k] || '').trim()
    if (v) return v
  }
  for (const holder of ['data', 'extra', 'raw']) {
    const obj = a[holder]
    if (obj && typeof obj === 'object') {
      for (const k of keys) {
        const v = String(obj[k] || '').trim()
        if (v) return v
      }
    }
  }
  return ''
}
async function getWxappCode(ref) {
  const payload = { ref: String(ref), app_id: APPID }
  const data = await yybRequest('POST', '/wxapp/getCode', payload)
  const root = data.data || data
  const code = findCode(root.result || root)
  if (!code) {
    throw new Error(`8014 /wxapp/getCode 未返回 code：${JSON.stringify(data).slice(0, 500)}`)
  }
  return code
}

async function loginX(code) {
  const headers = {
    'content-type': 'application/json',
    'x-biz-id': '0',
    'cloud-pid': PID,
    'wos-x-channel': '0:TITAN',
    'weimob-cid': String(CID),
    'weimob-bosid': String(BOS_ID),
    'x-req-from': 'cms_sdk',
    'cloud-project-name': 'tongyixiangmu',
    'weimob-pid': PID,
    'x-apm-conversation-id': uuidLike(),
    'x-apm-page-id': uuidLike(),
    'parentrpcid': randHex(16),
    'cookie': `rprm_cuid=${randHex(18)}`,
    'user-agent': UA,
    'referer': REFERER,
    'accept-encoding': 'gzip,compress,br,deflate'
  }
  const payload = {
    basicInfo: { cid: String(CID), vid: String(VID), tcode: 'weimob', bosId: String(BOS_ID) },
    extendInfo: { source: 1 },
    parentVid: 0,
    is_pre_fetch_open: true,
    env: 'production',
    storeId: '0',
    appid: APPID,
    pid: PID,
    code,
    queryAuthConfig: true,
    relevanceAuthRequest: null
  }
  const resp = await fetch(`${BASE}/fe/mapi/user/loginX`, { method: 'POST', headers, body: JSON.stringify(payload) })
  const data = await readJson(resp, 'loginX')
  if (Number(data.errcode) !== 0) throw new Error(`loginX失败：${JSON.stringify(data)}`)
  const d = data.data || {}
  if (!d.token || !d.openid || !d.wid) throw new Error(`loginX缺少token/openid/wid：${JSON.stringify(data).slice(0, 300)}`)
  return d
}

function commonExtend(refer = 'hd-lego-index') {
  return {
    wxTemplateId: 8265,
    childTemplateIds: [
      { customId: 90004, version: 'crm@0.1.101' },
      { customId: 90002, version: 'ec@90.0' },
      { customId: 90006, version: 'hudong@0.0.255' },
      { customId: 90008, version: 'cms@0.0.537' },
      { customId: 90070, version: '1.0.43' }
    ],
    analysis: [{ channelStatus: true, channelCode: 'youshu', token: YOUSHU_TOKEN }],
    quickdeliver: { enable: false },
    bosTemplateId: 1000002317,
    youshu: { enable: true, token: YOUSHU_TOKEN },
    source: 1,
    channelsource: 5,
    refer,
    mpScene: 1096
  }
}
function basePayload(login, requrl, extra = {}, refer = 'hd-lego-index', activity = null) {
  activity = activity || { activityId: ACTIVITY_ID, xBizId: '222', tracePromotionId: '' }
  const openid = login.openid || login.openId
  const wid = login.wid
  const traceExtra = activity.tracePromotionId ? {
    queryParameter: { tracePromotionId: activity.tracePromotionId, tracepromotionid: activity.tracePromotionId },
    tracePromotionId: activity.tracePromotionId,
    tracepromotionid: activity.tracePromotionId,
    currentTracePromotionId: activity.tracePromotionId
  } : { queryParameter: null }
  return {
    appid: APPID,
    basicInfo: {
      vid: VID, vidType: 2, bosId: BOS_ID, productId: PRODUCT_ID,
      productInstanceId: PRODUCT_INSTANCE_ID, productVersionId: PRODUCT_VERSION_ID,
      merchantId: MERCHANT_ID, tcode: 'weimob', cid: CID
    },
    extendInfo: commonExtend(refer),
    ...traceExtra,
    i18n: { language: 'zh', timezone: '8' },
    pid: PID,
    storeId: '0',
    _transformBasicInfo: true,
    _requrl: requrl,
    templateId: TEMPLATE_ID,
    templateKey: TEMPLATE_KEY,
    activityId: activity.activityId,
    bussinessType: 1,
    channel: 1,
    channelType: 1,
    source: 1,
    _version: '2.5.4',
    activityIdentity: ACTIVITY_IDENTITY,
    ...extra,
    openId: openid,
    wid,
    appId: APPID,
    playSourceCode: 'lcode',
    vid: VID,
    vidType: 2,
    bosId: BOS_ID,
    productId: PRODUCT_ID,
    productInstanceId: PRODUCT_INSTANCE_ID,
    productVersionId: PRODUCT_VERSION_ID,
    merchantId: MERCHANT_ID,
    tcode: 'weimob',
    cid: CID,
    vidTypes: [2],
    openid
  }
}
function apiHeaders(login, route = 'hd_lego/index', component = 'hd_lego/RAW/games/stage/stage', activity = null) {
  activity = activity || { activityId: ACTIVITY_ID, xBizId: '222', tracePromotionId: '' }
  const now = Date.now()
  return {
    'content-type': 'application/json',
    'x-cmssdk-vidticket': `${randHex(4)}-${Math.floor(now / 1000)}.${String(now).slice(-3)}-saas-w1-${randHex(4)}-${randHex(12)}`,
    'x-wmsdk-close-store': 'v2',
    'x-apm-page-id': uuidLike(),
    'weimob-pid': PID,
    'weimob-bosid': String(BOS_ID),
    'x-wmsdk-bc': `5 ${now}`,
    'x-req-from': 'hd_lego',
    'x-page-route': route,
    'cloud-bosid': String(BOS_ID),
    'x-tp-uuid': randHex(40),
    'x-apm-conversation-id': uuidLike(),
    'x-component-is': component,
    'x-wmsdk-vid': String(VID),
    'x-biz-id': String(activity.xBizId || '222'),
    'x-tp-signature': randHex(40),
    'cloud-project-name': 'tongyixiangmu',
    'x-wx-token': login.token,
    'cookie': `rprm_cuid=${randHex(18)}`,
    'cloud-pid': PID,
    'parentrpcid': randHex(16),
    'x-cms-sdk-request': '1.5.151',
    'wos-x-channel': '0:TITAN',
    'user-agent': UA,
    'referer': REFERER,
    'accept-encoding': 'gzip,compress,br,deflate'
  }
}
async function apiPost(login, activity, path2, requrl, extra = {}, route = 'hd_lego/index', component = 'hd_lego/RAW/games/stage/stage', refer = 'hd-lego-index') {
  const resp = await fetch(`${BASE}/api3${path2}`, {
    method: 'POST',
    headers: apiHeaders(login, route, component, activity),
    body: JSON.stringify(basePayload(login, requrl, extra, refer, activity))
  })
  const data = await readJson(resp, path2)
  return data
}
async function activityEntry(login, activity) {
  return apiPost(login, activity, '/orchestration/mobile/activity/entry', '/orchestration/mobile/activity/entry')
}
async function getRemainingAssets(login, activity) {
  return apiPost(login, activity, '/orchestration/mobile/prize/getRemainingAssets', '/orchestration/mobile/prize/getRemainingAssets', { assetTypes: ['chance'] })
}
async function drawPlay(login, activity) {
  return apiPost(login, activity, '/orchestration/mobile/activity/draw/play', '/orchestration/mobile/activity/draw/play')
}
async function userPrizes(login, activity) {
  return apiPost(login, activity, '/orchestration/mobile/prize/userPrizes', '/orchestration/mobile/prize/userPrizes', { pageIndex: 1, pageSize: 100 }, 'hd_lego/prize', 'hd_lego/prize', 'hd-lego-prize')
}

function chanceInfo(data) {
  const chance = (((data.data || {}).assets || {}).chance || {})
  return {
    total: Number(chance.totalNum || 0),
    left: Number(chance.assetNum || 0),
    used: Number(chance.assetUseNum || 0)
  }
}
function prizeTextFromDraw(data) {
  if (String(data.errcode) === '100200003') return '次数已用完'
  if (String(data.errcode) !== '0') return `抽奖失败：${data.errmsg || data.errcode}`
  const prizes = (((data.data || {}).prizes) || [])
  if (!prizes.length) return '无奖品返回'
  return prizes.map(p => String(p.id) === '-111' ? '未中奖' : `中奖：${p.name || p.prizeName || p.id}`).join('；')
}
function userPrizesText(data) {
  const d = data.data || {}
  const list = d.data || []
  if (!list || !list.length) return '中奖记录：0'
  return '中奖记录：' + list.map(x => x.prizeName || x.name || x.id).join('，')
}

async function getLoginForAccount(account) {
  const ref = getAccountOpenid(account)
  if (!ref) throw new Error('账号没有 openid 字段，账号字段：' + Object.keys(account).join(','))
  const cache = loadCache()
  const key = `ref:${ref}`
  const now = Date.now()
  const old = cache[key]
  if (old && old.token && old.openid && old.wid && Number(old.latestExpireTime || old.expireTime || 0) > now + 300000) {
    console.log(`✅ 使用缓存 token：${accountLabel(account)} openid=${mask(old.openid)}`)
    return old
  }
  console.log(`🔑 获取小程序 code：${accountLabel(account)} ref=${mask(ref)}`)
  const code = await getWxappCode(ref)
  console.log(`✅ code 获取成功，换微盟 token`)
  const login = await loginX(code)
  cache[key] = {
    token: login.token,
    wid: login.wid,
    openid: login.openid || login.openId,
    unionid: login.unionid || login.unionId,
    expireTime: login.expireTime || 0,
    latestExpireTime: login.latestExpireTime || 0,
    updatedAt: now
  }
  saveCache(cache)
  return cache[key]
}

async function runAccount(index, account) {
  console.log(`\n========== 账号 ${index}｜${accountLabel(account)} ==========`)
  const login = await getLoginForAccount(account)
  console.log(`openid：${mask(login.openid)} wid：${login.wid}`)

  const activityReports = []
  for (const activity of parseActivities()) {
    console.log(`
--- ${activity.name} activityId=${activity.activityId} x-biz-id=${activity.xBizId}${activity.tracePromotionId ? ' trace=' + activity.tracePromotionId : ''} ---`)
    const entry = await activityEntry(login, activity)
    const check = (entry.data || {}).checkResult
    console.log(`活动资格：${check === true ? '有资格' : JSON.stringify(entry.data || entry)}`)

    const remain = await getRemainingAssets(login, activity)
    const c = chanceInfo(remain)
    console.log(`抽奖机会：总${c.total}，已用${c.used}，剩余${c.left}`)

    let drawMsg = '未执行抽奖'
    const drawResults = []
    if (DO_DRAW && c.left > 0) {
      for (let n = 1; n <= c.left; n++) {
        const draw = await drawPlay(login, activity)
        const one = prizeTextFromDraw(draw)
        drawResults.push(`第${n}次：${one}`)
        console.log(`抽奖结果：第${n}次：${one}`)
        if (String(draw.errcode) === '100200003') break
        if (n < c.left) await sleep(1200)
      }
      drawMsg = drawResults.join('；')
    } else if (c.left <= 0) {
      drawMsg = '次数已用完，跳过抽奖'
      console.log(drawMsg)
    }

    const prizes = await userPrizes(login, activity)
    const prizeMsg = userPrizesText(prizes)
    console.log(prizeMsg)
    activityReports.push(`${activity.name}(${activity.activityId}) 资格:${check} 机会:总${c.total}/已用${c.used}/剩余${c.left} 抽奖:${drawMsg} ${prizeMsg}`)
  }

  return `账号${index} ${accountLabel(account)}` + '\n' + activityReports.join('\n')
}

async function main() {
  const accounts = await getAccounts()
  console.log(`共 ${accounts.length} 个账号，YYB=${YYB_URL}，抽奖=${DO_DRAW ? '开启' : '关闭'}，活动=${parseActivities().map(a => a.activityId).join(',')}，缓存=${CACHE_FILE}`)
  const reports = []
  for (let i = 0; i < accounts.length; i++) {
    try {
      reports.push(await runAccount(i + 1, accounts[i]))
    } catch (e) {
      const msg = `账号${i + 1}\n❌ 运行异常：${e.message}`
      console.log(msg)
      reports.push(msg)
    }
    if (i < accounts.length - 1) await sleep(2000)
  }
  console.log('\n========== 汇总 ==========' )
  console.log(reports.join('\n\n'))
}

main().catch(e => {
  console.error('程序异常退出：' + e.message)
  process.exitCode = 1
})






