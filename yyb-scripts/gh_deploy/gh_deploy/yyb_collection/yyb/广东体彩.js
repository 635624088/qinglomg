/*
广东体彩签到脚本
*/

const predefinedAxios = require('axios');

const ACCOUNTS = process.env.xj2_wxid ? process.env.xj2_wxid.split('\n').filter(Boolean) : [];

// ===================== 从 YYB 协议获取账号 =====================
async function fetchAccountsFromYYB() {
  try {
    const YYB_BASE_URL = process.env.YYB_BASE_URL || 'http://172.17.0.1:18080';
    const response = await predefinedAxios.get(`${YYB_BASE_URL}/accounts`, { timeout: 10000 });
    const data = response.data;
    if (data.code === 0 && data.data) {
      return data.data.map(acc => ({
        nickname: acc.nickname || acc.alias || acc.openid,
        openid: acc.openid
      }));
    }
  } catch (e) {
    console.log(`❌ 从 YYB 协议获取账号失败：`, e.message);
  }
  return [];
}

// ===================== 获取微信 Code =====================
async function getWxCode(wxid, appid) {
  try {
    const YYB_BASE_URL = process.env.YYB_BASE_URL || 'http://172.17.0.1:18080';
    const response = await predefinedAxios.post(`${YYB_BASE_URL}/wxapp/getCode`, {
      ref: wxid,
      app_id: appid
    }, { timeout: 10000 });
    const res = response.data;
    // 兼容 YYB 格式：code=0, data.result.code
    if (res.code === 0) {
      const data = res.data || {};
      const result = data.result || {};
      const code = result.code || data.code;
      if (code) return { success: true, code };
    }
    // 兼容旧格式
    if (res.status && res.Data && res.Data.code) {
      return { success: true, code: res.Data.code };
    }
    return { success: false, error: JSON.stringify(res) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const APP_ID = 'wxb7278fcf0cb8b3e5';
const SIGN_ACTIVITY_UUID = '9d13c46a85e94e17981075de1f6e4464';

const apiMain = predefinedAxios.create({
    baseURL: 'https://pnup.lottery-sports.com',
    headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.67(0x1800432e) NetType/WIFI Language/zh_CN',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
    }
});

const apiAct = predefinedAxios.create({
    baseURL: 'https://pnup-hd.tcssyw.com',
    headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.67(0x1800432e) NetType/WIFI Language/zh_CN',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://cdn.pnup-hd.tcssyw.com',
        'Referer': 'https://cdn.pnup-hd.tcssyw.com/'
    }
});

async function runAccount(remark, wxid, index) {
    console.log(`\n========== 账号 ${index + 1}: ${remark} ==========`);

    try {
        ;
        const codeRes = await getWxCode(wxid, APP_ID);
        if (!codeRes.success) {
            console.error(`❌ 获取Code失败: ${codeRes.error}`);
            return;
        }
        const code = codeRes.code;
        console.log(`✅ 获取Code成功`);

        ;
        const loginUrl = `/sapi/open/auth?code=${code}&needValidSubscribe=false&channelId=44`;
        const loginRes = await apiMain.post(loginUrl, null, {
            headers: {
                'Origin': 'https://cdn.pnup-ls.tcssyw.com',
                'Referer': 'https://cdn.pnup-ls.tcssyw.com/',
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': null
            }
        });

        if (!loginRes.data || (loginRes.data.code !== 0 && loginRes.data.code !== '0')) {
            console.error(`❌ 登录失败: ${JSON.stringify(loginRes.data)}`);
            return;
        }

        const accessToken = loginRes.data.data.accessToken;
        const nickName = loginRes.data.data.nickName;
        ;

        console.log(`[3/3] 执行签到...`);
        const signBody = `uuid=${SIGN_ACTIVITY_UUID}&accessToken=${accessToken}`;

        const checkRes = await apiAct.post('/api/act/get_sign_use', signBody);

        let alreadySigned = false;
        if (checkRes.data && checkRes.data.ret == "0" && checkRes.data.data) {
            console.log(`ℹ️ 连续签到: ${checkRes.data.data.insistcount}天`);
            if (checkRes.data.data.ablecount == "0" && checkRes.data.data.alreadyUse == "yes") {
                console.log(`⚠️ 今日已签到`);
                alreadySigned = true;
            }
        }

        if (!alreadySigned) {
            const signRes = await apiAct.post('/api/act/do_sign_in', signBody);
            if (signRes.data && signRes.data.ret == "0") {
                const data = signRes.data.data || {};
                if (data.getwealth) {
                    console.log(`✅ 签到成功! 获得积分: ${data.getwealth}`);
                } else {
                    console.log(`⚠️ 签到返回成功但无积分，视为今日已签到`);
                }
            } else {
                console.error(`❌ 签到失败: ${signRes.data.msg || JSON.stringify(signRes.data)}`);
            }
        }

        const infoRes = await apiMain.post('/sapi/member/queryUserInfo', `channelId=44&accessToken=${accessToken}`, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://cdn.pnup-ls.tcssyw.com',
                'Referer': 'https://cdn.pnup-ls.tcssyw.com/'
            }
        });
        if (infoRes.data && (infoRes.data.code === 0 || infoRes.data.code === '0')) {
            console.log(`💰 用户总积分: ${infoRes.data.data.memberPoints}`);
        }

    } catch (error) {
        console.error(`❌ 发生异常: ${error.message}`);
    }
}

async function main() {
    // 优先从 YYB 协议获取账号
    let accounts = [];
    const yybAccounts = await fetchAccountsFromYYB();
    if (yybAccounts.length > 0) {
      console.log(`✅ 从 YYB 协议获取到 ${yybAccounts.length} 个账号`);
      accounts = yybAccounts.map(acc => ({ remark: acc.nickname, wxid: acc.openid }));
    } else {
      // 回退到环境变量
      const raw = process.env.xj2_wxid || '';
      const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length === 0) {
        console.log('⚠️ 请先设置环境变量 xj2_wxid，且 YYB 协议无账号');
        return;
      }
      accounts = lines.map((wxid, i) => ({ remark: `账号${i+1}`, wxid }));
      console.log(`📋 从环境变量解析到 ${accounts.length} 个账号`);
    }
    console.log(`启动广东体彩签到脚本，共 ${accounts.length} 个账号`);

    for (let i = 0; i < accounts.length; i++) {
        await runAccount(accounts[i].remark, accounts[i].wxid, i);
        if (i < ACCOUNTS.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    console.log(`\n所有账号运行完毕`);
}

main();
