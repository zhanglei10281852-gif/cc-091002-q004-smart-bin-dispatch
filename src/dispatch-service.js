import {
  thresholds,
  offlineWindowMs,
  readingReasons,
  taskReasons,
} from './domain.js';

// 读数接纳顺序：协议校验 → 会话门禁 → 同序号重放 → 旧序号乱序 → 过期采样 → 采用。
// 任何读数都先原样入库；被忽略的读数只进审计，不改变当前液位与任务。
export class DispatchService {
  constructor(store, clock = () => new Date()) {
    this.store = store;
    this.clock = clock;
  }

  registerSession(deviceId, sessionId, at = this.clock().toISOString(), by = null) {
    // 设备重置序号必须经过登记的会话切换；切换后旧会话的迟到读数只入审计。
    return this.store.registerSession(deviceId, sessionId, at, by);
  }

  setLock(deviceId, locked, by = null, at = this.clock().toISOString()) {
    this.store.setLock(deviceId, locked, at, by);
    if (!locked) this.#reevaluateAfterUnlock(deviceId, at);
  }

  acceptTask(taskId, by = null, at = this.clock().toISOString()) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.state !== 'open') throw new Error(`task ${taskId} is ${task.state}, cannot accept`);
    this.store.setTaskState(task, 'accepted', at, taskReasons.vehicleAccepted, { by });
    return task;
  }

  completeTask(taskId, by = null, at = this.clock().toISOString()) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.state !== 'accepted') throw new Error(`task ${taskId} is ${task.state}, cannot complete`);
    this.store.setTaskState(task, 'completed', at, taskReasons.vehicleCompleted, { by });
    // 完成后若液位仍高，在收到低液位读数前不再派单（armed 仍为 false）。
    return task;
  }

  ingest(reading) {
    this.#validate(reading);
    this.store.append(reading); // 原始遥测只追加，永不因裁决结果丢失

    const device = this.store.device(reading.deviceId);
    const receivedAt = reading.receivedAt ?? this.clock().toISOString();
    const sampledAtMs = Date.parse(reading.sampledAt);
    const receivedAtMs = Date.parse(receivedAt);

    const reject = (decision, reason, taskAction = null) => {
      const entry = {
        reading: structuredClone(reading),
        decision,
        reason,
        at: receivedAt,
        levelChanged: false,
        taskAction,
      };
      this.store.recordAudit(entry);
      return { decision, reason, task: null, taskAction: null };
    };

    // 1) 会话门禁：首个会话随首条读数自助登记（引导）；此后新会话必须先登记，
    //    已被取代的旧会话读数按乱序处理，二者都不得改变当前液位。
    if (device.sessions.size === 0) {
      this.store.registerSession(reading.deviceId, reading.sessionId, receivedAt, 'bootstrap');
    } else if (!device.sessions.has(reading.sessionId)) {
      return reject('invalid-session', readingReasons.unregisteredSession);
    } else if (device.currentSessionId !== reading.sessionId) {
      return reject('stale', readingReasons.supersededSession);
    }

    // 2) 同序号重放（网关重发）：审计为重复。
    if (device.knownSeqs.has(reading.deviceSeq)) {
      return reject('duplicate', readingReasons.duplicateReplay);
    }

    // 3) 旧序号乱序：序号较小且非重复，只能入审计。
    if (device.lastSeq !== null && reading.deviceSeq < device.lastSeq) {
      return reject('stale', readingReasons.olderSeq);
    }

    // 4) 过期采样：离线恢复后送达的旧数据超出失联窗口，不得驱动液位或产生告警/任务。
    if (receivedAtMs - sampledAtMs > offlineWindowMs) {
      return reject('stale', readingReasons.expiredSample);
    }

    // 5) 采用：推进液位与序号基线，再执行阈值与任务生命周期判断。
    this.store.adopt(reading.deviceId, reading, receivedAt);
    const action = this.#applyLifecycle(device, reading, receivedAt);

    const entry = {
      reading: structuredClone(reading),
      decision: 'adopted',
      reason: readingReasons.levelUpdated,
      at: receivedAt,
      levelChanged: true,
      taskAction: action,
    };
    this.store.recordAudit(entry);
    return {
      decision: 'adopted',
      reason: readingReasons.levelUpdated,
      task: action.taskId ? this.store.getTask(action.taskId) : null,
      taskAction: action,
    };
  }

  #applyLifecycle(device, reading, at) {
    const level = reading.fillPercent;
    const active = this.store.activeTasks(reading.deviceId)[0] ?? null;
    const locked = device.lock.locked;

    // 低液位：迟滞复位。已派单任务在到达低阈值前保持；到达后关闭，
    // 但车辆已接受的任务受到保护，人工锁定期间也不自动关闭。
    if (level <= thresholds.low) {
      if (!locked) device.armed = true;
      if (active && active.state === 'open' && !locked) {
        this.store.setTaskState(active, 'cancelled', at, taskReasons.lowReached, {
          level,
          seq: reading.deviceSeq,
        });
        return { type: 'closed', taskId: active.id, reason: taskReasons.lowReached };
      }
      if (active?.state === 'accepted') {
        return { type: 'held', taskId: active.id, reason: taskReasons.acceptedProtected };
      }
      if (active && locked) {
        return { type: 'held', taskId: active.id, reason: taskReasons.manualLockHold };
      }
      return { type: 'none', reason: taskReasons.lowReached };
    }

    // 高液位：仅在“已武装（上次到达过低阈值）+ 无在途任务 + 未锁定”时派单，
    // 实现跨过高阈值后、回到低阈值前绝不重复派单。
    if (level >= thresholds.high) {
      if (active) {
        return {
          type: 'held',
          taskId: active.id,
          reason:
            active.state === 'accepted'
              ? taskReasons.acceptedProtected
              : taskReasons.alreadyDispatched,
        };
      }
      if (locked) {
        return { type: 'suppressed', reason: taskReasons.manualLockHold };
      }
      if (!device.armed) {
        return { type: 'held', reason: taskReasons.alreadyDispatched };
      }
      const task = this.store.addTask({
        id: `${reading.deviceId}-T${(device.taskSeq = (device.taskSeq ?? 0) + 1)}`,
        deviceId: reading.deviceId,
        sessionId: reading.sessionId,
        state: 'open',
        triggerSeq: reading.deviceSeq,
        openedAt: at,
        events: [],
      });
      device.armed = false;
      this.store.addTaskEvent(task, {
        type: 'opened',
        at,
        reason: taskReasons.highCross,
        level,
        seq: reading.deviceSeq,
      });
      return { type: 'opened', taskId: task.id, reason: taskReasons.highCross };
    }

    // 高低阈值之间：维持现状（开着的任务保持，无任务不派单）。
    if (active) {
      return { type: 'held', taskId: active.id, reason: taskReasons.hysteresisHold };
    }
    return { type: 'none', reason: taskReasons.hysteresisHold };
  }

  #reevaluateAfterUnlock(deviceId, at) {
    const device = this.store.device(deviceId);
    if (device.level === null) return;
    const active = this.store.activeTasks(deviceId)[0] ?? null;
    if (device.level <= thresholds.low) {
      device.armed = true;
      if (active && active.state === 'open') {
        this.store.setTaskState(active, 'cancelled', at, taskReasons.lockReleasedLow, {
          level: device.level,
        });
      }
    } else if (device.level >= thresholds.high) {
      if (!active && device.armed) {
        const reading = device.latestReading;
        const task = this.store.addTask({
          id: `${deviceId}-T${(device.taskSeq = (device.taskSeq ?? 0) + 1)}`,
          deviceId,
          sessionId: reading.sessionId,
          state: 'open',
          triggerSeq: reading.deviceSeq,
          openedAt: at,
          events: [],
        });
        device.armed = false;
        this.store.addTaskEvent(task, {
          type: 'opened',
          at,
          reason: taskReasons.lockReleasedHigh,
          level: device.level,
          seq: reading.deviceSeq,
        });
      }
    }
  }

  #validate(reading) {
    const bad =
      !reading ||
      typeof reading.deviceId !== 'string' ||
      typeof reading.sessionId !== 'string' ||
      !Number.isInteger(reading.deviceSeq) ||
      typeof reading.fillPercent !== 'number' ||
      reading.fillPercent < 0 ||
      reading.fillPercent > 100 ||
      Number.isNaN(Date.parse(reading.sampledAt)) ||
      (reading.receivedAt !== undefined && Number.isNaN(Date.parse(reading.receivedAt)));
    if (bad) throw new TypeError('malformed telemetry reading');
  }

  // —— 调度查询：解释每条读数的采用/忽略理由，以及任务保持/关闭/重新开放的原因 ——

  explainReadings(deviceId) {
    return this.store.auditFor(deviceId).map((a) => ({
      deviceSeq: a.reading.deviceSeq,
      sessionId: a.reading.sessionId,
      sampledAt: a.reading.sampledAt,
      fillPercent: a.reading.fillPercent,
      decision: a.decision,
      reason: a.reason,
      levelChanged: a.levelChanged,
      taskAction: a.taskAction,
    }));
  }

  explainTask(taskId) {
    const task = this.store.getTask(taskId);
    return task ? structuredClone(task) : null;
  }

  deviceStatus(deviceId, now = this.clock().toISOString()) {
    const d = this.store.device(deviceId);
    const online = d.lastAdoptedAt !== null
      && Date.parse(now) - Date.parse(d.lastAdoptedAt) <= offlineWindowMs;
    return {
      deviceId,
      online,
      currentSessionId: d.currentSessionId,
      lastSeq: d.lastSeq,
      level: d.level,
      lock: structuredClone(d.lock),
      activeTask: structuredClone(this.store.activeTasks(deviceId)[0] ?? null),
    };
  }
}
