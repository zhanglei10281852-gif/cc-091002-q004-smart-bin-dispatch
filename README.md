# 智能回收箱调度

服务接收回收箱遥测数据并在达到清运条件时生成调度任务。设备通过会话与递增序号标识采样顺序，原始遥测长期保留；任务可由调度员锁定、车辆接受并最终完成。

阈值约定保存在 `fixtures/device-session.json`，`src/telemetry-store.js` 保存读数，`src/dispatch-service.js` 维护清运任务。使用 Node.js 20 或更高版本并运行 `npm test` 可检查正常高液位触发流程。
