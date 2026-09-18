export const taskStates = ['open', 'accepted', 'completed', 'cancelled'];
export const readingDecisions = ['adopted', 'stale', 'duplicate', 'invalid-session'];
export const thresholds = { high: 80, low: 35 };

// 失联窗口：读数送达时刻晚于采样时刻超过该值即视为过期（离线恢复的旧采样不得驱动当前状态）；
// 同时用于在线状态判断（距最近一次被采用读数的接收时刻超过该值即失联）。
export const offlineWindowMs = 15 * 60 * 1000;

// 读数判定理由：decision 是四类裁决，reason 说明具体原因，供调度查询逐条解释。
export const readingReasons = Object.freeze({
  levelUpdated: 'level-updated',
  duplicateReplay: 'replay-same-seq',
  olderSeq: 'older-device-seq',
  expiredSample: 'sample-older-than-offline-window',
  supersededSession: 'session-superseded',
  unregisteredSession: 'session-not-registered',
});

// 任务生命周期事件理由：解释任务为何开放、保持、关闭或重新开放。
export const taskReasons = Object.freeze({
  highCross: 'crossed-high-threshold',
  hysteresisHold: 'level-between-thresholds',
  alreadyDispatched: 'task-already-active',
  acceptedProtected: 'task-accepted-by-vehicle',
  manualLockHold: 'manual-lock-active',
  lowReached: 'reached-low-threshold',
  lockReleasedHigh: 'lock-released-level-high',
  lockReleasedLow: 'lock-released-level-low',
  vehicleAccepted: 'vehicle-accepted',
  vehicleCompleted: 'vehicle-confirmed-emptied',
});
