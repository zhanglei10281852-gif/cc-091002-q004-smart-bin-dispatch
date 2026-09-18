import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TelemetryStore } from '../src/telemetry-store.js';
import { DispatchService } from '../src/dispatch-service.js';
import { thresholds, offlineWindowMs } from '../src/domain.js';

const T = (m) => new Date(Date.parse('2026-09-10T06:00:00+08:00') + m * 60000).toISOString();
// 读数：默认采样后 1 秒送达，远在失联窗口内。
const r = (deviceSeq, fillPercent, { sampled = 0, received = null, sessionId = 'SESSION-A', deviceId = 'BIN-88' } = {}) => ({
  deviceId,
  sessionId,
  deviceSeq,
  sampledAt: T(sampled),
  receivedAt: received === null ? new Date(Date.parse(T(sampled)) + 1000).toISOString() : T(received),
  fillPercent,
  batteryPercent: 72,
});

test('高液位读数生成清运任务（基线流程保持不变）', async () => {
  const reading = JSON.parse(await readFile(new URL('../fixtures/device-session.json', import.meta.url)));
  const store = new TelemetryStore();
  const result = new DispatchService(store).ingest(reading);
  assert.equal(result.decision, 'adopted');
  assert.equal(store.openTasks('BIN-88').length, 1);
});

test('网关重放同一读数三次：只形成一张可执行任务，原始遥测三条全保留', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  const packet = r(41, 86);
  const a = svc.ingest(packet);
  const b = svc.ingest(packet);
  const c = svc.ingest(packet);
  assert.equal(a.decision, 'adopted');
  assert.equal(b.decision, 'duplicate');
  assert.equal(c.decision, 'duplicate');
  assert.equal(store.activeTasks('BIN-88').length, 1);
  assert.equal(store.readings.length, 3); // 重放数据也不丢
});

test('乱序：先到的高序号开单，迟到的旧序号低读数不能关单，当前液位不变', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  svc.ingest(r(41, 86, { sampled: 1 }));
  const late = svc.ingest(r(40, 20, { sampled: 0, received: 2 }));
  assert.equal(late.decision, 'stale');
  assert.equal(late.reason, 'older-device-seq');
  assert.equal(store.activeTasks('BIN-88').length, 1);
  assert.equal(svc.deviceStatus('BIN-88', T(2)).level, 86);
});

test('双阈值迟滞：高阈值开单，中间液位保持，低阈值才关单，再次升高重新开放', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  svc.ingest(r(1, 86, { sampled: 1 }));
  const first = store.activeTasks('BIN-88')[0];
  assert.equal(first.state, 'open');

  assert.equal(svc.ingest(r(2, 60, { sampled: 2 })).taskAction.type, 'held');
  assert.equal(svc.ingest(r(3, thresholds.high, { sampled: 3 })).taskAction.type, 'held');
  assert.equal(store.tasks.length, 1); // 区间内高读数不得重复派单

  svc.ingest(r(4, 34, { sampled: 4 }));
  assert.equal(store.getTask(first.id).state, 'cancelled');

  svc.ingest(r(5, 81, { sampled: 5 }));
  assert.equal(store.activeTasks('BIN-88').length, 1);
  assert.notEqual(store.activeTasks('BIN-88')[0].id, first.id); // 重新开放为新任务
});

test('车辆已接受的任务不因迟到低读数取消', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  svc.ingest(r(41, 86, { sampled: 1 }));
  const task = store.activeTasks('BIN-88')[0];
  svc.acceptTask(task.id, 'truck-7', T(2));

  const result = svc.ingest(r(42, 20, { sampled: 3 }));
  assert.equal(result.taskAction.type, 'held');
  assert.equal(result.taskAction.reason, 'task-accepted-by-vehicle');
  assert.equal(store.getTask(task.id).state, 'accepted');

  svc.completeTask(task.id, 'truck-7', T(4));
  assert.equal(store.getTask(task.id).state, 'completed');
});

test('离线恢复：超过失联窗口的过期采样不驱动液位、不产生告警/任务', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  // 设备离线期间缓存的高读数，恢复后才送达，采样->送达超过 15 分钟。
  const expired = svc.ingest(
    r(41, 99, { sampled: 0, received: 20 }),
  );
  assert.equal(expired.decision, 'stale');
  assert.equal(expired.reason, 'sample-older-than-offline-window');
  assert.equal(store.tasks.length, 0);
  assert.equal(svc.deviceStatus('BIN-88', T(20)).level, null);
  assert.equal(svc.deviceStatus('BIN-88', T(20)).online, false);

  // 恢复后一条新鲜读数正常工作。
  const fresh = svc.ingest(r(42, 50, { sampled: 21, received: 21 }));
  assert.equal(fresh.decision, 'adopted');
  assert.equal(svc.deviceStatus('BIN-88', T(21)).online, true);
  assert.equal(svc.deviceStatus('BIN-88', T(40)).online, false); // 再次超过窗口判失联
});

test('设备重置序号：未登记的新会话拒绝；登记后旧会话迟到读数不能影响新周期', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  svc.ingest(r(41, 86, { sampled: 1 }));
  svc.ingest(r(42, 34, { sampled: 2 })); // 完成清运周期，任务关闭

  // 设备重启，序号从 1 开始但会话未登记。
  const unregistered = svc.ingest(r(1, 50, { sampled: 3, sessionId: 'SESSION-B' }));
  assert.equal(unregistered.decision, 'invalid-session');

  // 必须经过登记的会话切换。
  svc.registerSession('BIN-88', 'SESSION-B', T(4), 'technician');
  assert.equal(svc.ingest(r(1, 30, { sampled: 5, sessionId: 'SESSION-B' })).decision, 'adopted');
  svc.ingest(r(2, 88, { sampled: 6, sessionId: 'SESSION-B' }));
  assert.equal(store.activeTasks('BIN-88').length, 1);

  // 旧会话迟到的高读数：序号在旧空间更大也一律拒绝。
  const old = svc.ingest(r(43, 95, { sampled: 7, sessionId: 'SESSION-A' }));
  assert.equal(old.decision, 'stale');
  assert.equal(old.reason, 'session-superseded');
  assert.equal(store.activeTasks('BIN-88').length, 1);
});

test('人工锁定：锁定期高读数不派单、低读数不关单；解锁后按当前液位补评估', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  svc.setLock('BIN-88', true, 'dispatcher', T(1));
  const suppressed = svc.ingest(r(1, 90, { sampled: 2 }));
  assert.equal(suppressed.taskAction.type, 'suppressed');
  assert.equal(store.tasks.length, 0);

  svc.setLock('BIN-88', false, 'dispatcher', T(3));
  assert.equal(store.activeTasks('BIN-88').length, 1); // 解锁补派单

  // 再次锁定，低读数不得自动关单。
  svc.setLock('BIN-88', true, 'dispatcher', T(4));
  const held = svc.ingest(r(2, 20, { sampled: 5 }));
  assert.equal(held.taskAction.reason, 'manual-lock-active');
  assert.equal(store.activeTasks('BIN-88')[0].state, 'open');

  svc.setLock('BIN-88', false, 'dispatcher', T(6));
  assert.equal(store.activeTasks('BIN-88').length, 0); // 解锁后按低液位关闭
});

test('暴雨早班完整场景：重放+乱序叠加，自始至终只有一张可执行任务', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  // 网关重放同一条高读数三次、中间夹杂更早的低液位乱序包。
  svc.ingest(r(41, 86, { sampled: 10 }));
  svc.ingest(r(41, 86, { sampled: 10 }));
  svc.ingest(r(40, 30, { sampled: 9, received: 11 }));
  svc.ingest(r(41, 86, { sampled: 10 }));
  assert.equal(store.activeTasks('BIN-88').length, 1);
  assert.equal(svc.deviceStatus('BIN-88', T(11)).level, 86);
});

test('调度查询：逐条说明读数采用/忽略理由与任务保持/关闭/开放原因', () => {
  const store = new TelemetryStore();
  const svc = new DispatchService(store);
  svc.ingest(r(1, 86, { sampled: 1 }));
  svc.ingest(r(1, 86, { sampled: 1 }));
  svc.ingest(r(2, 60, { sampled: 2 }));
  svc.ingest(r(3, 34, { sampled: 3 }));
  svc.ingest(r(4, 82, { sampled: 4 }));

  const rows = svc.explainReadings('BIN-88');
  assert.deepEqual(
    rows.map((x) => [x.deviceSeq, x.decision, x.reason, x.levelChanged]),
    [
      [1, 'adopted', 'level-updated', true],
      [1, 'duplicate', 'replay-same-seq', false],
      [2, 'adopted', 'level-updated', true],
      [3, 'adopted', 'level-updated', true],
      [4, 'adopted', 'level-updated', true],
    ],
  );
  assert.equal(rows[2].taskAction.type, 'held'); // 60：迟滞保持
  assert.equal(rows[2].taskAction.reason, 'level-between-thresholds');
  assert.equal(rows[3].taskAction.type, 'closed');
  assert.equal(rows[4].taskAction.type, 'opened');

  const first = svc.explainTask(store.tasks[0].id);
  assert.equal(first.state, 'cancelled');
  assert.equal(first.events[0].reason, 'crossed-high-threshold');
  assert.equal(first.events.at(-1).reason, 'reached-low-threshold');
});
