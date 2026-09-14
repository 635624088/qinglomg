# qinglomg — 我的 YYB / 自动化脚本仓库

本仓库汇总了我自用的各类自动化脚本，以及从 Windows 移植到 Linux 运行的 xjskp 花园工具，**已对所有个人敏感信息做脱敏处理**（NAS 内网 IP、手机号、青龙 token / client_secret、XJSKP 密钥、账号 ID 等均已替换为占位符）。

## 目录结构

- `yyb-scripts/` — YYB 相关脚本
  - 13 个主脚本：`lt.py`(联通) `jdkd.py`(京东快递) `fzqd.py`(飞猪) `netease_full.js`(网易云) `qqmusic.py`(QQ音乐) `microsoft_rewards.js`(微软积分) `yb.py`(元宝AI) `cw.js`(创维) `hxaj.js`(海信) `chzhjj.py`(长虹) `jgpy.js`(交个朋友) `hshj.js`(红色火箭) `paid.js`(平安i动)
  - 调度/编排脚本：`sync_yyb_go.py` `yyb_runall*.py` `yyb_rerun2.py` `__yyb.py` `__acct.py` `furongwang_qinglong.py` `cdf_checkin.py`
  - `env.sh`：青龙环境变量加载脚本（已脱敏，密码替换为 `YOUR_QL_PASSWORD`）
  - `gh_deploy/`：工会/抽奖等任务脚本（**仅含代码，运行时 token 缓存、银行信息等已剔除**）
- `xjskp-sync-multi/` — [KxinCC/xjskp-sync-multi](https://github.com/KxinCC/xjskp-sync-multi) 的 **Windows→Linux 移植版**（Node ≥ 22，去除 DPAPI / 命名管道等 Windows 依赖，改用 AES-256-GCM + 回环 TCP 端口锁）。原作者署名与说明保留在其 `README.md` / `AGENTS.md` 中。

## 配置说明（脱敏占位符需自行替换）

| 占位符 | 含义 |
| --- | --- |
| `YOUR_QL_HOST` | 青龙 / YYB 网关所在主机地址（原内网 IP 已脱敏） |
| `YOUR_PHONE` | 青龙登录手机号 |
| `YOUR_QL_PASSWORD` | 青龙登录密码 |
| `YOUR_QL_CLIENT_ID` / `YOUR_QL_CLIENT_SECRET` | 青龙 OpenAPI 的 client_id / client_secret |
| `YOUR_XJSKP_SECRET_KEY` | xjskp 凭据加密密钥（环境变量 `XJSKP_SECRET_KEY`） |
| `YOUR_OPEN_ID` / `YOUR_ALIPAY_UID` | 花园账号相关 ID |

各脚本运行所需的 token / cookie 等，请通过青龙环境变量或对应工具的「凭据导入」功能自行填入，不要提交到仓库。

## 已知排除项

- `QLScriptPublic_wxapp_yyb/` 等第三方上游脚本集合：属公开上游仓库，为避免重复与授权问题未纳入，请直接取用原仓库。
- 所有 `tokens.json`、`*_cache.json`、cookie 缓存、`runtime/`、`node_modules/`、`.bak`、`.log` 等运行时数据与依赖均已排除。

## 免责声明

脚本仅供学习与个人自动化使用，请遵守各平台服务条款，勿用于违规刷量或商业滥用。
