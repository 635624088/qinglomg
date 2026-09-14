// YYB 平台「账号任务」包装 - 华润壹票达
// 等价替换 run_one_yipiaoda.sh：设置 runner 所需环境变量后转调 yyb_runner.js。
// 账号隔离：平台按账号运行时注入 YYB_SERVER='host:port@<account_id>'，
// 这里把 account_id 换算成 openid 交给 runner 的 YYB_ACCOUNT_REFS，实现只跑该账号；
// 定时全量运行时（无 @账号）行为与原 .sh 完全一致。
const { spawnSync } = require('child_process');

const RUNNER = '/ql/data/scripts/QLScriptPublic_wxapp_yyb/wxapp/yyb_runner.js';
const SCRIPT = 'yipiaoda.js';

const raw = String(process.env.YYB_SERVER || process.env.wx_server_url || 'http://172.17.0.1:18080');
// 兼容多行 YYB_SERVER（账号列表，每行 host:port@openid）：取首行地址并走全量模式
const _lines = raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
const _isMulti = _lines.length > 1;
const _first = _lines[0] || 'http://172.17.0.1:18080';
const at = _first.lastIndexOf('@');
let base = _first;
let acctId = '';
if (at > 0) {
  base = _first.slice(0, at);
  if (!_isMulti) acctId = _first.slice(at + 1).trim();
}
if (!/^https?:\/\//.test(base)) base = 'http://' + base;
base = base.replace(':18082', ':18080');
process.env.YYB_SERVER = base;
process.env.wx_server_url = base;

if (acctId) {
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const r = spawnSync('curl', ['-s', '-m', '20', base + '/accounts'], { encoding: 'utf8' });
    try {
      const payload = JSON.parse(r.stdout || '[]');
      const list = Array.isArray(payload) ? payload : (payload.data || []);
      const hit = list.filter(function (x) { return String(x.id) === acctId || String(x.openid) === acctId; })[0];
      if (hit && hit.openid) {
        process.env.YYB_ACCOUNT_REFS = hit.openid;
        process.env.YYB_AUTO_ACCOUNTS = '';
        ok = true;
      }
    } catch (e) {
      console.error('[wrap] 账号解析失败: ' + e.message);
    }
    if (!ok && attempt < 3) {
      console.error('[wrap] 第' + attempt + '次未匹配到账号，3秒后重试...');
      spawnSync('sleep', ['3']);
    }
  }
  if (!ok) {
    console.error('[wrap] 未匹配到账号 ' + acctId + '（已重试3次, base=' + base + '），本次跳过');
    process.exit(0);
  }
} else if (process.env.YYB_AUTO_ACCOUNTS !== '0') {
  process.env.YYB_AUTO_ACCOUNTS = '1';
}

process.env.YYB_RUN_SCRIPTS = SCRIPT;
require(RUNNER);
