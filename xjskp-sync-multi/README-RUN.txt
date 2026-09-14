鲜花小镇自动化控制台

1. 双击 start-system.cmd 或 启动系统.cmd。
2. 第一次使用时，在浏览器控制台导入账号凭据。
3. 在页面内启动循环、停止任务、执行一轮或只查订单。
4. 多账号并行：在控制台勾选账号后点击“启动所选账号”；不会自动补选、导入或验证账号。
5. 默认最多 3 个账号同时运行，可通过 XJSKP_MAX_PARALLEL_TASKS 调整并发上限。
6. run-auto-plant.cmd 仍是单账号兼容入口，不作为多账号启动方式。
7. 双击 stop-system.cmd 或 停止系统.cmd 可关闭本地服务和托管任务。
8. 双击 重置账号凭据.cmd 会清空 runtime/accounts 下的账号凭据。
9. 后续运行和修复都以这个绿色包目录为准。

升级到另一台机器

1. 先双击 停止系统.cmd，确认页面中的全部账号均为“未运行”。
2. 请覆盖完整绿色包的程序文件（bin、work、根目录 cmd/package.json/client-analysis），不要只复制 work。
3. 保留目标机器的 runtime 目录并合并它；其中 accounts、settings、status、game-data、game-code 都不能丢失。
4. 覆盖后重新双击 启动系统.cmd，再刷新页面。看到“代码/数据”版本后才可继续启动任务。

只替换 work 会造成新程序逻辑与旧 runtime 数据包、旧联合发布指针或旧 Node 运行时混用，可能出现版本一直落后、设置无法保存等异常。
