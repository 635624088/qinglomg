/*
------------------------------------------
@Description: YSKJ 小程序签到+积分转算力 (YYB Go 自动获取账号)
@Cron: cron: 5 6,12,18 * * *
------------------------------------------
环境变量：
  YSKJ_CONVERT_HASHRATE 是否积分转算力，默认 1(转换)，设为 0 则跳过
  YSKJ_ACCOUNT_GROUP  账号分组选择: 选1=1-5号, 选2=6-10号, ... 最多50号10组; 不设置或设为0则处理所有账号

依赖：
  axios
------------------------------------------
*/

const axios = require('axios');

// 简化的日志工具类（替代 env.js）
class SimpleLogger {
  constructor(name) {
    this.name = name;
    this.userIdx = 1;
  }
  log(msg) {
    console.log(`[${this.name}] ${msg}`);
  }
  done() {
    console.log(`[${this.name}] 执行完成`);
  }
}

const $ = new SimpleLogger('YSKJ 签到+转算力');
const fs = require('fs');
const path = require('path');

const MINI_APP_ID = 'wxc59eee06736849e8';
const YYB_BASE = 'http://172.17.0.1:18080'; // YYB Go 服务（仅用于获取登录码）
const API_BASE = 'https://net.todaypayforyou.fun'; // 善羿科技业务后端
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF';
const TOKEN_CACHE_FILE = path.join(__dirname, 'yskj_token_cache.json');
const INVITE_CODE = '74D3D549';
const CONVERT_HASHRATE = String(process.env.YSKJ_CONVERT_HASHRATE || '1').trim() !== '0';
const ACCOUNT_GROUP = parseInt(process.env.YSKJ_ACCOUNT_GROUP || '0', 10);

function mask(value) {
  const text = String(value || '');
  if (text.length <= 8) return text ? '****' : '';
  return text.slice(0, 4) + '****' + text.slice(-4);
}

function readCache() {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    $.log(`写入令牌缓存失败: ${error.message || error}`);
  }
}

function isTokenError(error) {
  const text = `${error?.message || ''} ${JSON.stringify(error?.data || {})}`;
  return /401|403|token|登录|鉴权|授权|过期|失效|未登录|无效/i.test(text);
}

// 从 YYB Go 获取账号列表
async function getAccounts() {
  try {
    const resp = await axios({
      url: `${YYB_BASE}/accounts`,
      method: 'GET',
      timeout: 10000,
      validateStatus: () => true,
    });

    if (resp.status !== 200) {
      throw new Error(`获取账号列表失败: HTTP ${resp.status}`);
    }

    const result = resp.data;
    // YYB Go 响应格式: {code, msg, data: [...]}
    if (result?.code !== 0 || !Array.isArray(result?.data)) {
      throw new Error(`获取账号列表失败: code=${result?.code}, msg=${result?.msg}`);
    }

    // 返回所有账号（YYB Go 账号列表没有 app_id，需要用 remark/alias 来识别）
    return result.data.map((acc) => ({
      openid: acc.openid,
      remark: acc.alias || acc.nickname || '',
      uin: acc.uin,
      status: acc.status,
    }));
  } catch (error) {
    throw new Error(`从 YYB Go 获取账号列表失败: ${error.message || error}`);
  }
}

// 从 YYB Go 获取登录 code
async function getLoginCode(openid) {
  try {
    const resp = await axios({
      url: `${YYB_BASE}/wxapp/getCode`,
      method: 'POST',
      data: { ref: openid, app_id: MINI_APP_ID },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (resp.status !== 200) {
      throw new Error(`YYB Go 未返回登录码: HTTP ${resp.status}`);
    }

    const result = resp.data;
    // YYB Go 响应格式: {code: 0, msg, data: {openid, result: {code, errMsg}}}
    if (result?.code !== 0 || !result?.data?.result?.code) {
      throw new Error(`YYB Go 返回错误: code=${result?.code}, msg=${result?.msg}`);
    }

    return result.data.result.code;
  } catch (error) {
    throw new Error(`从 YYB Go 获取登录码失败: ${error.message || error}`);
  }
}

class Task {
  constructor(account) {
    this.index = $.userIdx++;
    this.account = account;
    this.openid = account.openid;
    this.remark = account.remark || '';
    this.token = '';
    this.deviceId = '';
    this.profile = null;
    this.realtime = null;
  }

  get cached() {
    return readCache()[this.openid] || null;
  }

  clearCache() {
    const cache = readCache();
    delete cache[this.openid];
    writeCache(cache);
    this.token = '';
  }

  saveCache() {
    if (!this.token) return;
    const cache = readCache();
    cache[this.openid] = {
      token: this.token,
      deviceId: this.deviceId,
      updatedAt: new Date().toISOString(),
    };
    writeCache(cache);
  }

  async request(method, apiPath, body = undefined) {
    const url = `${API_BASE}${apiPath}`;
    const resp = await axios({
      url,
      method,
      data: body,
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        'x-token': this.token || '',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: '*/*',
      },
    });

    const result = resp.data;
    if (resp.status < 200 || resp.status >= 300) {
      $.log(
        `[错误] 业务接口 HTTP ${resp.status} | ${url} | body=${JSON.stringify(result).slice(0, 500)}`,
      );
      const error = new Error(
        `业务接口 HTTP ${resp.status}: ${JSON.stringify(result).slice(0, 300)}`,
      );
      error.data = result;
      throw error;
    }

    // 成功判定: code === 200
    if (result?.code !== 200) {
      $.log(
        `[错误] 业务状态码=${result?.code} | ${url} | body=${JSON.stringify(result).slice(0, 500)}`,
      );
      const error = new Error(result?.msg || `业务状态码=${result?.code}`);
      error.data = result;
      throw error;
    }
    return result;
  }

  async login() {
    const code = await getLoginCode(this.openid);

    this.deviceId = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const loginResult = await this.request('POST', '/YSKJ/api/user/login_wx', {
      code,
      device_id: this.deviceId,
      invite_code: INVITE_CODE,
      nickname: '',
      avatar: '',
    });

    this.token = loginResult.data?.token || '';
    if (!this.token) throw new Error('登录成功但未获取到令牌');

    const isNew = loginResult.data?.is_new ? '新用户' : '老用户';
    const displayName = this.remark ? `${this.remark}(${mask(this.openid)})` : mask(this.openid);
    $.log(
      `账号[${this.index}] ${displayName} 登录成功（${isNew}）, user_id: ${loginResult.data?.user_id}`,
    );
  }

  async getUserInfo() {
    const result = await this.request('GET', '/YSKJ/api/user/profile');
    this.profile = result.data || {};
    return this.profile;
  }

  async getRealtime(lite = true) {
    const result = await this.request('GET', `/YSKJ/api/mining/realtime?lite=${lite ? 1 : 0}`);
    this.realtime = result.data || {};
    return this.realtime;
  }

  async checkSignStatus() {
    const result = await this.request('GET', '/YSKJ/api/sign/status');
    return result.data || {};
  }

  async doSign() {
    const statusResult = await this.request('POST', '/YSKJ/api/sign/checkin', {});
    return statusResult.data || {};
  }

  async doExchange() {
    const result = await this.request('POST', '/YSKJ/api/points/exchange', {});
    return result.data || {};
  }

  async printAccountInfo() {
    const profile = this.profile || {};
    const realtime = this.realtime || {};
    const displayName = this.remark || mask(this.openid);
    $.log(
      `账号[${this.index}] 昵称: ${profile.nickname || '-'} | 备注: ${displayName} | 积分: ${profile.points ?? '-'} | 算力: ${profile.hashrate ?? '-'} | 余额: ${profile.coin_balance ?? '-'} | 连续: ${profile.consecutive_days ?? '-'} 天 | 等级: ${profile.level_name ?? '-'}`,
    );
  }

  async run() {
    // 1. 尝试缓存 token
    const cached = this.cached;
    if (cached?.token) {
      this.token = cached.token;
      this.deviceId = cached.deviceId || '';
      try {
        await this.getUserInfo();
        $.log(`账号[${this.index}] 使用缓存令牌`);
      } catch (error) {
        if (isTokenError(error)) {
          $.log(`账号[${this.index}] 缓存令牌已失效，重新登录`);
          this.clearCache();
        } else {
          throw error;
        }
      }
    }

    // 2. 登录
    if (!this.token) {
      await this.login();
      await this.getUserInfo();
    }

    // 3. 打印签到前状态
    $.log(`账号[${this.index}] ====== 签到前状态 ======`);
    await this.getRealtime();
    this.printAccountInfo();

    // 4. 签到
    let signDone = false;
    try {
      const signStatus = await this.checkSignStatus();
      if (signStatus.can_checkin) {
        const signResult = await this.doSign();
        $.log(
          `账号[${this.index}] ✓ 签到成功！获得 ${signResult.points_earned ?? '-'} 积分 | 当前: ${signResult.points_balance ?? '-'} 积分 | 今日第 ${signResult.today_sign_count ?? '-'} 次`,
        );
        signDone = true;
      } else {
        $.log(`账号[${this.index}] 本时段已完成签到 (${signStatus.current_session || '?'})`);
      }
    } catch (error) {
      const msg = error?.data?.msg || error.message || '';
      if (/已签|完成/i.test(msg)) {
        $.log(`账号[${this.index}] 今日已完成签到`);
      } else if (isTokenError(error)) {
        this.clearCache();
        throw error;
      } else {
        $.log(`账号[${this.index}] × 签到失败: ${msg}`);
      }
    }

    // 5. 签到后再次查询
    if (signDone) {
      $.log(`账号[${this.index}] ====== 签到后状态 ======`);
      await this.getUserInfo();
      await this.getRealtime();
      this.printAccountInfo();
    }

    // 6. 积分转算力
    if (CONVERT_HASHRATE) {
      await this.getUserInfo();
      const points = this.profile?.points || 0;
      if (points >= 100) {
        try {
          const exchangeResult = await this.doExchange();
          $.log(
            `账号[${this.index}] ✓ 积分兑换算力成功！消耗 ${exchangeResult.points_used ?? '-'} 积分 -> 获得 ${exchangeResult.hashrate_gained ?? '-'} 算力 | 剩余: ${exchangeResult.points ?? '-'} 积分 | 总算力: ${exchangeResult.hashrate ?? '-'}`,
          );
        } catch (error) {
          const msg = error?.data?.msg || error.message || '';
          if (/已兑换|无可兑换|积分不足/i.test(msg)) {
            $.log(`账号[${this.index}] 积分不足或今日已兑换: ${msg}`);
          } else {
            $.log(`账号[${this.index}] × 积分兑换算力失败: ${msg}`);
          }
        }
      } else {
        $.log(`账号[${this.index}] 积分不足100，跳过兑换 (当前: ${points})`);
      }
    } else {
      $.log(`账号[${this.index}] 积分兑换算力已关闭 (YSKJ_CONVERT_HASHRATE=0)`);
    }

    // 7. 保存缓存
    this.saveCache();
  }
}

!(async () => {
  try {
    // 从 YYB Go 获取账号列表
    const accounts = await getAccounts();

    if (!accounts || accounts.length === 0) {
      throw new Error('未在 YYB Go 找到善羿科技小程序的账号');
    }

    $.log(`从 YYB Go 获取到 ${accounts.length} 个账号`);

    // 账号分组: 选1=1-5号, 选2=6-10号, ... 最多50号10组
    let targetAccounts = accounts;
    if (ACCOUNT_GROUP > 0) {
      const groupSize = 5;
      const startIdx = (ACCOUNT_GROUP - 1) * groupSize;
      const endIdx = startIdx + groupSize;
      targetAccounts = accounts.slice(startIdx, endIdx);
      $.log(`账号分组: 选${ACCOUNT_GROUP} (账号 ${startIdx + 1}-${endIdx})`);
    }

    for (const account of targetAccounts) {
      try {
        await new Task(account).run();
      } catch (error) {
        const msg = error.message || error;
        const extra = [];
        if (error.data) extra.push(`data=${JSON.stringify(error.data).slice(0, 500)}`);
        if (error.response) {
          extra.push(`httpStatus=${error.response.status}`);
          if (error.response.data)
            extra.push(`body=${JSON.stringify(error.response.data).slice(0, 500)}`);
        }
        if (error.config) extra.push(`url=${error.config.url || '?'}`);
        const displayName = account.remark || mask(account.openid);
        $.log(
          `账号[${displayName}] 运行失败: ${msg}` +
            (extra.length ? `\n  [详细信息] ${extra.join(' | ')}` : ''),
        );
      }
    }
  } catch (error) {
    $.log(`初始化失败: ${error.message || error}`);
  }
})()
  .catch((error) => $.log(error.message || error))
  .finally(() => $.done());
