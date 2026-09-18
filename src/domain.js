export const taskStates = ['open', 'accepted', 'completed', 'cancelled'];
export const readingDecisions = ['adopted', 'stale', 'duplicate', 'invalid-session', 'expired'];
export const thresholds = { high: 80, low: 35 };
// 失联窗口：到达时间与采样时间之差超过该值，视为离线积压样本，只入审计不触发告警
export const offlineWindowMs = 15 * 60 * 1000;
