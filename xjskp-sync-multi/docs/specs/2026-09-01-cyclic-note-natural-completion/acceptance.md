# 验收标准

## 源码与静态验证

- [x] 状态层只读取 `actTot.taskRcdMap` 当前 `${batchId}|0` 记录。
- [x] 缺少 progress 键显示为 0；非法原始进度、缺少权威字段和非三槽快照均关闭自动动作。
- [x] 父开关默认关闭；旧子开关值原样归一化、持久化和协议往返，`AUTO_HANDLE_CYCLIC_NOTE=0` 保持总停用。
- [x] 父开关关闭时不自动 `enter`、推进或领取；开启后才允许权威快照与动作。
- [x] 规划器先返回全部完成未领取槽位；子开关开启按 1107 数量降序、槽位升序，关闭时按槽位列出全部安全可支持候选。
- [x] 不安全、不可支持或实际无动作的候选不饿死后续候选；成功后仍只执行一个既有业务动作并权威重进。
- [x] 队列卡展示父子开关，父级关闭时子级禁用；“进行期”与“自动执行已开启/关闭”分开显示。
- [x] 代码中无旧自然执行器 import、target snapshot lock、legacy progress/recv fallback。
- [x] 定向 state、planner、flow、设置与 DOM 禁用态测试通过。
- [x] 直接相关 `inspect-garden-cycle` 花笺行为测试通过。
- [x] `npm run check` 与 `git diff --check` 通过。

## 真实验收边界

本方案不以离线夹具、短 replay、HTTP ready 或 hash 结果替代真实账号、服务端和正式宿主验收。当前清理任务不启动服务、不操作真实账号、不发送真实游戏请求；真实验收另行授权。
