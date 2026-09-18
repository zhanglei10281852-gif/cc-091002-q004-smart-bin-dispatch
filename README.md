# 智能回收箱调度

服务接收回收箱遥测数据并在达到清运条件时生成调度任务。设备通过会话与递增序号标识采样顺序，原始遥测长期保留；任务可由调度员锁定、车辆接受并最终完成。

阈值约定保存在 `fixtures/device-session.json`，`src/telemetry-store.js` 保存读数与设备状态，`src/dispatch-service.js` 维护读数接纳与任务生命周期。使用 Node.js 20 或更高版本并运行 `npm test`。

## 读数接纳（`ingest`）

每条读数都先原样写入 `readings`，再依次经过门禁；未通过的读数只进审计、不改变当前液位与任务：

1. **协议校验**：字段缺失或越界抛 `TypeError`。
2. **会话门禁**：设备首个会话随首条读数自助登记；此后新 `sessionId` 必须先经 `registerSession(deviceId, sessionId, at, by)` 登记，否则裁决 `invalid-session`；已被取代的旧会话迟到读数裁决 `stale`（`session-superseded`）。登记会话会重置序号基线。
3. **重放**：同会话下相同 `deviceSeq` 裁决 `duplicate`（`replay-same-seq`）。
4. **乱序**：`deviceSeq` 小于已采用序号裁决 `stale`（`older-device-seq`）。
5. **过期采样**：`receivedAt - sampledAt` 超过 `offlineWindowMs`（15 分钟）裁决 `stale`（`sample-older-than-offline-window`），离线恢复不会制造过期告警。
6. 其余读数裁决 `adopted`（`level-updated`），推进当前液位。

## 阈值与任务生命周期

- 双阈值迟滞：液位 ≥ 高阈值（80）派单；回到 ≤ 低阈值（35）才关闭并重新武装；区间内维持现状。高阈值之后、低阈值之前的任何高读数都不会重复派单。
- 车辆保护：`acceptTask` 后任务为 `accepted`，迟到的低读数只能保持（`task-accepted-by-vehicle`），不能取消；车辆完成后 `completeTask` 关闭为 `completed`。
- 人工锁定：`setLock(deviceId, true/false, by, at)` 期间高读数不派单、低读数不关单；解锁时按当前液位补评估（补派或补关）。
- 每台设备任意时刻至多一条可执行任务（`activeTasks`：`open` 或 `accepted`）。

## 调度查询

- `explainReadings(deviceId)`：逐条返回读数的 `decision`、`reason`、是否改变液位，以及触发的任务动作（`opened` / `held` / `closed` / `suppressed` / `none` 及理由）。
- `explainTask(taskId)`：任务快照含 `events`，说明开放、保持、关闭或重新开放的原因链。
- `deviceStatus(deviceId, now)`：当前会话、序号、液位、在线状态（超过失联窗口未收到采用读数即离线）、锁定与在途任务。
