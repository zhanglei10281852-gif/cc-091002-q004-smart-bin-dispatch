// 所有状态都保存在本类内部，外部拿到的任务/设备对象是可变活引用——
// 状态变更必须通过这里的方法进行，避免修改 structuredClone 副本后丢失。
export class TelemetryStore {
  readings = []; // 原始遥测，只追加、长期保留
  audit = [];    // 每条读数的裁决（采用/忽略 + 理由）
  tasks = [];
  devices = new Map();

  append(reading) {
    this.readings.push(structuredClone(reading));
  }

  // 保留旧签名供基线流程使用；返回入库后的活引用。
  addTask(task) {
    const stored = structuredClone(task);
    stored.events ??= [];
    this.tasks.push(stored);
    return stored;
  }

  recordAudit(entry) {
    this.audit.push(structuredClone(entry));
  }

  auditFor(deviceId) {
    return this.audit.filter((a) => a.reading.deviceId === deviceId);
  }

  device(deviceId) {
    let d = this.devices.get(deviceId);
    if (!d) {
      d = {
        deviceId,
        sessions: new Map(), // sessionId -> { registeredAt, by }
        currentSessionId: null,
        knownSeqs: new Set(),
        lastSeq: null,
        level: null, // 最近一次被采用读数的液位
        latestReading: null,
        lastAdoptedAt: null, // 最近采用读数的接收时刻
        armed: true, // 是否已武装：需回到低阈值后才允许再次派单；新设备/新会话视为已武装
        lock: { locked: false, at: null, by: null },
        events: [], // 会话切换、锁定抑制等设备级事件
      };
      this.devices.set(deviceId, d);
    }
    return d;
  }

  registerSession(deviceId, sessionId, at, by = null) {
    const d = this.device(deviceId);
    if (d.currentSessionId === sessionId) return d;
    d.sessions.set(sessionId, { registeredAt: at, by });
    d.currentSessionId = sessionId;
    // 新会话是全新序号空间：重置序号基线，旧会话的迟到读数不再影响当前液位。
    d.lastSeq = null;
    d.knownSeqs = new Set();
    // 设备重置/换会话代表新的清运周期，重新允许高阈值派单。
    d.armed = true;
    d.events.push({ type: 'session-switched', at, sessionId, by });
    return d;
  }

  adopt(deviceId, reading, at) {
    const d = this.device(deviceId);
    d.lastSeq = reading.deviceSeq;
    d.knownSeqs.add(reading.deviceSeq);
    d.level = reading.fillPercent;
    d.latestReading = structuredClone(reading);
    d.lastAdoptedAt = at;
    return d;
  }

  openTasks(deviceId) {
    return this.tasks.filter((t) => t.deviceId === deviceId && t.state === 'open');
  }

  // 可执行任务：open 或已被车辆接受；任意时刻每台设备至多一条。
  activeTasks(deviceId) {
    return this.tasks.filter(
      (t) => t.deviceId === deviceId && (t.state === 'open' || t.state === 'accepted'),
    );
  }

  getTask(taskId) {
    return this.tasks.find((t) => t.id === taskId) ?? null;
  }

  addTaskEvent(task, event) {
    task.events.push(structuredClone(event));
  }

  setTaskState(task, state, at, reason, extra = {}) {
    task.state = state;
    task.events.push({ type: state, at, reason, ...extra });
  }

  setLock(deviceId, locked, at, by = null) {
    const d = this.device(deviceId);
    d.lock = { locked, at, by };
    d.events.push({ type: locked ? 'locked' : 'unlocked', at, by });
    return d;
  }
}
