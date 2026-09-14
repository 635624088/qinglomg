# 鲜花小镇自动化绿色包

项目路径：`E:\00__company_code\Codex\xjskp`

## 双击启动

- `打包绿色版.cmd`：重新生成绿色包到 `release\xjskp-sync-multi-next`。
- `启动系统.cmd` / `start-system.cmd`：启动本地控制台。
- `停止系统.cmd` / `stop-system.cmd`：停止本地控制台和托管任务。
- `run-auto-plant.cmd`：单账号持续循环自动化兼容入口。
- `run-auto-plant-once.cmd`：只执行一轮自动化。
- `重置账号凭据.cmd` / `reset-auto-plant-secrets.cmd`：清空并重新录入账号凭据。
- `查询最新游戏版本.cmd`：直连官方接口，只读查询最新游戏版本与官方包地址。

## 多账号并行

- 多账号并行只通过本地网页控制台操作：勾选账号后点击“启动所选账号”。
- 当前账号的“启动循环 / 停止任务 / 执行一轮 / 只查订单”只作用于当前选中的账号。
- 默认最多 3 个账号同时运行，可通过环境变量 `XJSKP_MAX_PARALLEL_TASKS` 调整。
- 批量启动只处理用户勾选的账号，不会自动补选账号、导入凭据或验证账号。
- 每个账号的状态和日志仍分别写入 `runtime/status/<profileId>` 和 `runtime/logs/<profileId>`。
- `run-auto-plant.cmd` 继续保持单账号兼容行为，不作为多账号入口。

## 远程访问（Cloudflare / 反向代理）

- 控制台默认监听 `0.0.0.0`，本机用 `http://127.0.0.1:端口/` 访问；局域网设备用 `http://<本机局域网IP>:端口/` 访问。
- 通过 Cloudflare / nginx 等反向代理从外网访问时，需在控制台「远程访问」面板的 Host 白名单填入代理域名（如 `console.example.com`），保存后外网可完整操作（导入凭据、启停账号、修改设置）。
- 也可用环境变量 `XJSKP_ALLOWED_HOSTS`（逗号分隔，如 `console.example.com`）注入白名单。
- Cloudflare 源站无论配 IP 还是域名，都会发送 `X-Forwarded-Host`（浏览器域名），因此只要域名在白名单即可放行；白名单只配源站 IP、Origin 是域名且无 `X-Forwarded-Host` 时会被拒绝（安全兜底）。
- 节点小宝等内网穿透（`100.x.x.x` CGN 段）的 Host 与 Origin 一致，白名单配 IP 或域名均可。
- 白名单域名支持 https Origin（代理 TLS 终结）；未配置白名单时，仅本机/局域网私网段可访问，其余一律 403。
- 安全提示：控制台无用户认证层，任何能访问到白名单域名/IP 的设备都能获取会话 token 并执行全部操作；请自行通过 Cloudflare Access / 防火墙限制访问范围。

## 命令启动

```powershell
npm run package-system
npm run system
npm run auto
npm run once
npm run orders
npm run reset-secrets
npm run query-version
```

## 官方版本与客户端包

- `npm run query-version`：只读查询官方最新版本和官方包地址；不打开浏览器，不下载或替换本地文件。
- 控制台任务区的“检查游戏官方版本”会使用当前选中账号查询；顶栏显示当前运行版和最近一次成功查询到的最新版。
- 控制服务会按本机时间每天 `03:00`、`15:00` 自动检查；无需保持控制台网页打开，服务重启后从下一个固定时点继续，不补跑错过的时点。
- 版本检查只读取 `CTOKEN`、`PC_USER_ID`、`PC_TOKEN`，失败时保留上次成功版本；不会下载或替换游戏包，也不会调用游戏业务接口。
- `npm run sync-config`：下载官方包，解出编译后的 `tar/game.js`，同步资源配置并执行兼容审计。
- 查询凭据优先读取环境变量；否则读取本机 Profile Store。存在多个完整账号时设置 `XJSKP_QUERY_PROFILE_ID`。

## 输出文件

运行期间会实时更新 `outputs` 目录：

- `outputs/garden-status.html`：主要查看页面。
- `outputs/garden-status.md`：Markdown 状态文档。
- `outputs/garden-status.json`：原始状态数据。
- `outputs/auto-plant-*.log`：运行日志，默认只保留最近 10 个旧日志。

手动清理旧自动日志：

```powershell
npm run prune-logs
```

## 凭据

游戏接口凭据保存在 `work/game-secrets.json`。文件内容使用当前 Windows 用户的 DPAPI 加密，只适合在本机当前用户下使用，不应提交到代码仓库。

## 校验

```powershell
npm run check
npm test
```

如果 `npm` 不可用，也可以直接运行：

```powershell
node --check work\inspect-garden-dryrun.mjs
node --check work\order-state.mjs
node --check work\run-history.mjs
node --check work\log-retention.mjs
node --test work\*.test.mjs
```
