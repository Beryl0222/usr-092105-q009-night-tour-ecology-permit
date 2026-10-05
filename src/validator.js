export const EVENT_TYPES = [
  "APPLICATION_SUBMITTED",
  "PERMIT_ISSUED",
  "FEEDBACK_RECEIVED",
  "CONDITION_ISSUED",
  "CONDITION_ADJUSTED",
  "SAMPLE_RECORDED",
  "RULE_VIOLATION_FLAGGED",
  "BREACH_CONFIRMED",
  "ACTIVITY_SUSPENDED",
  "RECTIFICATION_RECORDED",
  "ACTIVITY_RESUMED",
];

export const AGGREGATE_TYPES = ["permit_application", "operating_condition", "monitoring_sample", "enforcement_decision"];

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 返回可以直接展示给接入方的中文错误。 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知业务对象类型：${record.aggregate_type}`);
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 不是可解析的时间");
  if ("payload" in record && (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  return errors;
}
