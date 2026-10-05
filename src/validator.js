import { AGGREGATE_TYPES, EVENT_TYPES } from "./constants.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 返回可以直接展示给接入方的中文错误。 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是可解析的时间");
  return errors;
}
