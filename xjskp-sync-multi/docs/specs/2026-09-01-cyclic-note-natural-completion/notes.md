# 决策记录

- 官方状态优先级固定为 `actTot.taskRcdMap[`${batchId}|0`]`；活动对象内的旧 progress/recvMap 只能作为不存在的字段，不能驱动动作。
- `progress` 是稀疏 map，缺少任务键代表 0；显式字符串、布尔值、负数和非有限值不转换，直接关闭自动化。
- 三个槽位必须完整且任务/奖励可比较；无法证明时 fail-closed。
- 领取请求发出后，只在后续 `enter` 的权威 `recvMap` 证明 received 时清除 `batchId:taskId` pending；批次变化也清理旧批次，避免同任务重复发送。
- 最高收益只用于选择未完成任务，不影响其他已完成槽位的正常领取。
