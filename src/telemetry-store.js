export class TelemetryStore {
  // 审计记录：{reading, decision, reason}，原始遥测不可变长期保留
  readings = [];
  tasks = [];
  // deviceId -> 会话与序号运行时状态
  devices = new Map();

  append(record) {
    this.readings.push(structuredClone(record));
  }

  addTask(task) {
    this.tasks.push(task);
    return task;
  }

  taskById(id) {
    return this.tasks.find((task) => task.id === id);
  }

  openTasks(deviceId) {
    return this.tasks.filter((task) => task.deviceId === deviceId && task.state === 'open');
  }

  activeTasks(deviceId) {
    return this.tasks.filter((task) => task.deviceId === deviceId && (task.state === 'open' || task.state === 'accepted'));
  }

  deviceState(deviceId) {
    let state = this.devices.get(deviceId);
    if (!state) {
      state = {
        currentSessionId: null,
        eligibleSessions: new Set(),
        watermark: -1,
        seenSeqs: new Set(),
        currentFillPercent: null,
        highEpisodeActive: false,
        lastContactAt: null,
        sessionHistory: [],
      };
      this.devices.set(deviceId, state);
    }
    return state;
  }
}
