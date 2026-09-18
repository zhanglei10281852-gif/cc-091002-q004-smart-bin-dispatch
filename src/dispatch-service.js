import { thresholds as defaultThresholds, offlineWindowMs as defaultOfflineWindowMs } from './domain.js';

function sampleAgeMs(reading) {
  const sampled = Date.parse(reading.sampledAt);
  const received = Date.parse(reading.receivedAt);
  if (Number.isNaN(sampled) || Number.isNaN(received)) return null;
  return Math.max(0, received - sampled);
}

export class DispatchService {
  constructor(store, options = {}) {
    this.store = store;
    this.thresholds = options.thresholds ?? defaultThresholds;
    this.offlineWindowMs = options.offlineWindowMs ?? defaultOfflineWindowMs;
  }

  // 登记下一次会话切换：设备重置序号的唯一合法路径
  registerSession(deviceId, sessionId, note = '调度台登记会话切换') {
    const state = this.store.deviceState(deviceId);
    state.eligibleSessions.add(sessionId);
    return { deviceId, sessionId, registered: true, note };
  }

  ingest(reading) {
    const state = this.store.deviceState(reading.deviceId);

    // 1) 会话校验：首见设备以读数会话自举；其余会话必须事先登记
    if (state.currentSessionId === null) {
      this.#switchSession(state, reading.sessionId, reading.receivedAt, '首见设备，以读数会话自举');
    } else if (reading.sessionId !== state.currentSessionId) {
      if (!state.eligibleSessions.has(reading.sessionId)) {
        return this.#record(reading, 'invalid-session',
          `会话 ${reading.sessionId} 未登记（当前会话 ${state.currentSessionId}）：设备重置序号必须先登记会话切换，读数仅入审计`);
      }
      this.#switchSession(state, reading.sessionId, reading.receivedAt, '登记的会话切换生效，序号重新起步');
    }

    // 2) 序号校验：会话内单调递增，重放与乱序只入审计、不改变当前液位
    if (state.seenSeqs.has(reading.deviceSeq)) {
      return this.#record(reading, 'duplicate',
        `序号 ${reading.deviceSeq} 在会话 ${state.currentSessionId} 已记录，判定网关重放，仅入审计`);
    }
    if (reading.deviceSeq <= state.watermark) {
      return this.#record(reading, 'stale',
        `序号 ${reading.deviceSeq} 落后于会话水位 ${state.watermark}，判定乱序迟到，仅入审计，不改变当前液位`);
    }
    state.seenSeqs.add(reading.deviceSeq);
    state.watermark = reading.deviceSeq;
    state.lastContactAt = reading.receivedAt ?? null;

    // 3) 失联窗口：样本滞留过久视为离线积压，不更新液位、不触发告警
    const ageMs = sampleAgeMs(reading);
    if (ageMs !== null && ageMs > this.offlineWindowMs) {
      return this.#record(reading, 'expired',
        `样本滞留 ${Math.round(ageMs / 1000)}s 超过失联窗口 ${Math.round(this.offlineWindowMs / 1000)}s，判定离线积压：入审计但不更新液位、不触发告警`);
    }

    // 4) 采纳读数，应用高低双阈值迟滞
    state.currentFillPercent = reading.fillPercent;
    const outcome = this.#applyThresholds(reading, state);
    return this.#record(reading, 'adopted', outcome.reason, outcome.events, outcome.task);
  }

  acceptTask(taskId, at = null) {
    const task = this.store.taskById(taskId);
    if (!task) return { changed: false, reason: `任务 ${taskId} 不存在` };
    if (task.state !== 'open') return { changed: false, task, reason: `任务 ${taskId} 当前状态 ${task.state}，仅开放任务可接受` };
    this.#transition(task, 'accepted', at, '车辆接受任务，此后迟到低读数不再取消');
    return { changed: true, task };
  }

  completeTask(taskId, at = null) {
    const task = this.store.taskById(taskId);
    if (!task) return { changed: false, reason: `任务 ${taskId} 不存在` };
    if (task.state !== 'accepted') return { changed: false, task, reason: `任务 ${taskId} 当前状态 ${task.state}，仅已接受任务可完成` };
    this.#transition(task, 'completed', at, '车辆完成清运');
    return { changed: true, task };
  }

  lockTask(taskId, at = null, note = '调度员人工锁定，低读数不再自动关闭') {
    const task = this.store.taskById(taskId);
    if (!task) return { changed: false, reason: `任务 ${taskId} 不存在` };
    if (task.state === 'completed' || task.state === 'cancelled') {
      return { changed: false, task, reason: `任务 ${taskId} 已终结（${task.state}），无法锁定` };
    }
    if (task.locked) return { changed: false, task, reason: `任务 ${taskId} 已处于锁定状态` };
    task.locked = true;
    task.history.push({ at, type: 'note', reason: note });
    return { changed: true, task };
  }

  unlockTask(taskId, at = null, note = '调度员解除锁定') {
    const task = this.store.taskById(taskId);
    if (!task) return { changed: false, reason: `任务 ${taskId} 不存在` };
    if (!task.locked) return { changed: false, task, reason: `任务 ${taskId} 未处于锁定状态` };
    task.locked = false;
    task.history.push({ at, type: 'note', reason: note });
    return { changed: true, task };
  }

  // 调度查询：说明每个读数被采用或忽略的理由，以及任务保持、关闭或重新开放的原因
  explainDevice(deviceId) {
    const state = this.store.devices.get(deviceId) ?? null;
    return {
      deviceId,
      currentSessionId: state?.currentSessionId ?? null,
      currentFillPercent: state?.currentFillPercent ?? null,
      highEpisodeActive: state?.highEpisodeActive ?? false,
      lastContactAt: state?.lastContactAt ?? null,
      sessionHistory: state?.sessionHistory ?? [],
      readings: this.store.readings
        .filter((record) => record.reading.deviceId === deviceId)
        .map((record) => ({
          sessionId: record.reading.sessionId,
          deviceSeq: record.reading.deviceSeq,
          sampledAt: record.reading.sampledAt,
          fillPercent: record.reading.fillPercent,
          batteryPercent: record.reading.batteryPercent,
          decision: record.decision,
          reason: record.reason,
        })),
      tasks: this.store.tasks
        .filter((task) => task.deviceId === deviceId)
        .map((task) => ({ id: task.id, state: task.state, locked: task.locked, createdAt: task.createdAt, history: task.history })),
    };
  }

  #switchSession(state, sessionId, at, note) {
    const previous = state.currentSessionId;
    state.currentSessionId = sessionId;
    state.eligibleSessions.delete(sessionId);
    state.watermark = -1;
    state.seenSeqs = new Set();
    state.highEpisodeActive = false;
    state.sessionHistory.push({ sessionId, previousSessionId: previous, switchedAt: at ?? null, note });
  }

  #applyThresholds(reading, state) {
    const { high, low } = this.thresholds;
    const fill = reading.fillPercent;
    const events = [];
    const none = { events, task: null };

    if (fill >= high) {
      if (state.highEpisodeActive) {
        return { ...none, reason: `液位 ${fill}% 高于高阈值 ${high}%，本 episode 已派单，跨高后至低阈值前不重复派单` };
      }
      state.highEpisodeActive = true;
      if (this.store.activeTasks(reading.deviceId).length > 0) {
        return { ...none, reason: `液位 ${fill}% 上穿高阈值 ${high}%，但设备已有在途任务，保持现有任务不重复派单` };
      }
      const task = this.store.addTask({
        id: `${reading.deviceId}-${reading.sessionId}-${reading.deviceSeq}`,
        deviceId: reading.deviceId,
        state: 'open',
        locked: false,
        createdAt: reading.receivedAt ?? null,
        createdBySeq: reading.deviceSeq,
        history: [{ at: reading.receivedAt ?? null, type: 'transition', from: null, to: 'open', reason: `液位 ${fill}% 上穿高阈值 ${high}%，生成清运任务` }],
      });
      events.push({ type: 'task-opened', taskId: task.id });
      return { events, task, reason: `液位 ${fill}% 上穿高阈值 ${high}%，生成清运任务 ${task.id}` };
    }

    if (fill < low) {
      state.highEpisodeActive = false;
      const kept = [];
      const cancelled = [];
      for (const task of this.store.activeTasks(reading.deviceId)) {
        if (task.state === 'accepted') {
          task.history.push({ at: reading.receivedAt ?? null, type: 'kept', state: task.state, reason: `液位 ${fill}% 低于低阈值 ${low}%，但车辆已接受，任务保持` });
          kept.push(task.id);
        } else if (task.locked) {
          task.history.push({ at: reading.receivedAt ?? null, type: 'kept', state: task.state, reason: `液位 ${fill}% 低于低阈值 ${low}%，但任务被人工锁定，保持开放` });
          kept.push(task.id);
        } else {
          this.#transition(task, 'cancelled', reading.receivedAt, `液位 ${fill}% 低于低阈值 ${low}%，清运需求消失，任务关闭`);
          cancelled.push(task.id);
          events.push({ type: 'task-cancelled', taskId: task.id });
        }
      }
      const parts = [`液位 ${fill}% 低于低阈值 ${low}%，高阈值重新武装`];
      if (cancelled.length > 0) parts.push(`关闭任务 ${cancelled.join('、')}`);
      if (kept.length > 0) parts.push(`任务 ${kept.join('、')} 保持`);
      if (cancelled.length === 0 && kept.length === 0) parts.push('无在途任务');
      return { ...none, reason: parts.join('；') };
    }

    return { ...none, reason: `液位 ${fill}% 位于迟滞区（${low}%~${high}%），任务状态不变` };
  }

  #transition(task, to, at, reason) {
    const from = task.state;
    task.state = to;
    task.history.push({ at: at ?? null, type: 'transition', from, to, reason });
  }

  #record(reading, decision, reason, events = [], task = null) {
    this.store.append({ reading, decision, reason });
    return { decision, reason, task, events };
  }
}
