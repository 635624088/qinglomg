# 验收

- 仅包裹在 `business-rejected` 中的结构化 `type:90000` 被归类为 `session-expired`，退出码 42；普通 `unauthorized`、重新登录文本和 JSON 文本片段仍为业务拒绝。
- 第一次失效只调度一次 2 秒恢复，并创建新 worker。
- 旧 `garden-status.json` 的会话终止标记不会停止新 `runId` worker；新 worker 到达 `automationReady` 后仅自身同代次终止标记可停止它。
- 首次启动尚未 ready 的会话过期通过协调令牌调度一次恢复；用户停止或陈旧令牌不得创建恢复计时器。
- 十分钟内第二次失效为 `blocked`；健康进度满十分钟后才允许新的首次恢复。
- 陈旧协调令牌不得调度或阻止更新后的期望状态。
- 普通业务拒绝和收益保护语义保持原状。
