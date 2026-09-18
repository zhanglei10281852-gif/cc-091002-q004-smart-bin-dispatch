import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryStore } from '../src/telemetry-store.js';
import { DispatchService } from '../src/dispatch-service.js';

const EPOCH = Date.parse('2026-09-18T06:00:00+08:00');
const ts = (seconds) => new Date(EPOCH + seconds * 1000).toISOString();

function reading({ deviceId = 'BIN-88', sessionId = 'SESSION-A', deviceSeq, fillPercent, sampledAt, receivedAt, batteryPercent = 70 }) {
  return { deviceId, sessionId, deviceSeq, fillPercent, batteryPercent, sampledAt, receivedAt: receivedAt ?? sampledAt };
}

test('暴雨早班：网关重放与乱序读数只形成一张可执行任务', () => {
  const store = new TelemetryStore();
  const service = new DispatchService(store);

  const first = service.ingest(reading({ deviceSeq: 41, fillPercent: 86, sampledAt: ts(0), receivedAt: ts(1) }));
  assert.equal(first.decision, 'adopted');
  assert.ok(first.task);

  // 网关重放同一帧
  const replay1 = service.ingest(reading({ deviceSeq: 41, fillPercent: 86, sampledAt: ts(0), receivedAt: ts(2) }));
  assert.equal(replay1.decision, 'duplicate');

  // 乱序迟到的低读数（采样更早、序号更旧），不得拉低当前液位、不得取消任务
  const lateLow = service.ingest(reading({ deviceSeq: 40, fillPercent: 18, sampledAt: ts(-30), receivedAt: ts(3) }));
  assert.equal(lateLow.decision, 'stale');

  // 网关再次重放高液位帧
  const replay2 = service.ingest(reading({ deviceSeq: 41, fillPercent: 86, sampledAt: ts(0), receivedAt: ts(4) }));
  assert.equal(replay2.decision, 'duplicate');

  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].state, 'open');
  assert.equal(store.deviceState('BIN-88').currentFillPercent, 86);
  assert.equal(store.readings.length, 4); // 原始遥测全部入审计保留
});

test('双阈值迟滞：跨高派单后至低阈值前不重复派单，回落后重新开放', () => {
  const store = new TelemetryStore();
  const service = new DispatchService(store);

  service.ingest(reading({ deviceSeq: 1, fillPercent: 86, sampledAt: ts(0) }));
  const t1 = store.tasks[0];

  const mid = service.ingest(reading({ deviceSeq: 2, fillPercent: 60, sampledAt: ts(10) }));
  assert.equal(mid.decision, 'adopted');
  assert.equal(t1.state, 'open'); // 迟滞区内任务保持

  const again = service.ingest(reading({ deviceSeq: 3, fillPercent: 83, sampledAt: ts(20) }));
  assert.equal(again.task, null); // 已派单 episode 不重复派单
  assert.equal(store.tasks.length, 1);

  service.ingest(reading({ deviceSeq: 4, fillPercent: 30, sampledAt: ts(30) }));
  assert.equal(t1.state, 'cancelled'); // 低于低阈值，关闭未锁定开放任务

  const reopen = service.ingest(reading({ deviceSeq: 5, fillPercent: 85, sampledAt: ts(40) }));
  assert.ok(reopen.task); // 重新上穿高阈值，重新开放一张新任务
  assert.equal(store.tasks.length, 2);
  assert.equal(store.openTasks('BIN-88').length, 1);
});

test('车辆已接受的任务不被迟到或当前低读数取消', () => {
  const store = new TelemetryStore();
  const service = new DispatchService(store);

  service.ingest(reading({ deviceSeq: 1, fillPercent: 86, sampledAt: ts(0) }));
  const task = store.tasks[0];
  assert.equal(service.acceptTask(task.id, ts(5)).changed, true);

  const lateLow = service.ingest(reading({ deviceSeq: 0, fillPercent: 10, sampledAt: ts(-30), receivedAt: ts(6) }));
  assert.equal(lateLow.decision, 'stale');
  assert.equal(task.state, 'accepted');

  const currentLow = service.ingest(reading({ deviceSeq: 2, fillPercent: 20, sampledAt: ts(10) }));
  assert.equal(currentLow.decision, 'adopted');
  assert.equal(task.state, 'accepted'); // 当前低读数也不取消已接受任务

  assert.equal(service.completeTask(task.id, ts(20)).changed, true);
  assert.equal(task.state, 'completed');
});

test('人工锁定的开放任务不被低读数关闭，解锁后恢复自动关闭', () => {
  const store = new TelemetryStore();
  const service = new DispatchService(store);

  service.ingest(reading({ deviceSeq: 1, fillPercent: 86, sampledAt: ts(0) }));
  const task = store.tasks[0];
  assert.equal(service.lockTask(task.id, ts(5)).changed, true);

  service.ingest(reading({ deviceSeq: 2, fillPercent: 30, sampledAt: ts(10) }));
  assert.equal(task.state, 'open'); // 锁定保持

  service.unlockTask(task.id, ts(15));
  service.ingest(reading({ deviceSeq: 3, fillPercent: 30, sampledAt: ts(20) }));
  assert.equal(task.state, 'cancelled'); // 解锁后低读数正常关闭
});

test('离线恢复不制造过期告警：积压高液位不派单、积压低液位不取消', () => {
  const store = new TelemetryStore();
  const service = new DispatchService(store);

  // 在线时高液位派单
  service.ingest(reading({ deviceSeq: 41, fillPercent: 86, sampledAt: ts(0), receivedAt: ts(1) }));
  assert.equal(store.openTasks('BIN-88').length, 1);

  // 失联期间网关积压的帧恢复后补传（滞留 30 分钟，超过失联窗口）
  const backlogHigh = service.ingest(reading({ deviceSeq: 42, fillPercent: 95, sampledAt: ts(120), receivedAt: ts(1920) }));
  const backlogLow = service.ingest(reading({ deviceSeq: 43, fillPercent: 10, sampledAt: ts(240), receivedAt: ts(2040) }));
  assert.equal(backlogHigh.decision, 'expired');
  assert.equal(backlogLow.decision, 'expired');
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].state, 'open');

  // 恢复后的新鲜样本正常采纳，episode 内仍不重复派单
  const fresh = service.ingest(reading({ deviceSeq: 44, fillPercent: 85, sampledAt: ts(2100), receivedAt: ts(2101) }));
  assert.equal(fresh.decision, 'adopted');
  assert.equal(store.tasks.length, 1);
});

test('设备重置序号必须经过登记的会话切换', () => {
  const store = new TelemetryStore();
  const service = new DispatchService(store);

  service.ingest(reading({ deviceSeq: 41, fillPercent: 86, sampledAt: ts(0) }));
  assert.equal(store.tasks.length, 1);

  // 未登记的新会话直接拒绝
  const unknown = service.ingest(reading({ sessionId: 'SESSION-B', deviceSeq: 1, fillPercent: 90, sampledAt: ts(10) }));
  assert.equal(unknown.decision, 'invalid-session');

  // 同会话序号回退视为乱序，不允许借此重置
  const rollback = service.ingest(reading({ deviceSeq: 1, fillPercent: 90, sampledAt: ts(20) }));
  assert.equal(rollback.decision, 'stale');

  // 登记后切换生效，序号重新起步；已有在途任务不重复派单
  service.registerSession('BIN-88', 'SESSION-B');
  const switched = service.ingest(reading({ sessionId: 'SESSION-B', deviceSeq: 1, fillPercent: 90, sampledAt: ts(30) }));
  assert.equal(switched.decision, 'adopted');
  assert.equal(store.tasks.length, 1);

  // 旧会话已被替换，其后续帧一律拒绝
  const retired = service.ingest(reading({ deviceSeq: 42, fillPercent: 90, sampledAt: ts(40) }));
  assert.equal(retired.decision, 'invalid-session');
});

test('调度查询说明每个读数的取舍理由与任务保持、关闭、重新开放的原因', () => {
  const store = new TelemetryStore();
  const service = new DispatchService(store);

  service.ingest(reading({ deviceSeq: 41, fillPercent: 86, sampledAt: ts(0), receivedAt: ts(1) }));
  service.ingest(reading({ deviceSeq: 41, fillPercent: 86, sampledAt: ts(0), receivedAt: ts(2) }));
  service.ingest(reading({ deviceSeq: 40, fillPercent: 18, sampledAt: ts(-30), receivedAt: ts(3) }));
  service.ingest(reading({ deviceSeq: 42, fillPercent: 30, sampledAt: ts(10), receivedAt: ts(11) }));

  const view = service.explainDevice('BIN-88');
  assert.equal(view.currentFillPercent, 30);
  assert.deepEqual(view.readings.map((r) => r.decision), ['adopted', 'duplicate', 'stale', 'adopted']);
  for (const r of view.readings) assert.ok(r.reason.length > 0);
  assert.match(view.readings[1].reason, /重放/);
  assert.match(view.readings[2].reason, /乱序/);

  const task = view.tasks[0];
  assert.equal(task.state, 'cancelled');
  assert.match(task.history.find((h) => h.to === 'open').reason, /高阈值/);
  assert.match(task.history.find((h) => h.to === 'cancelled').reason, /低阈值/);
});
