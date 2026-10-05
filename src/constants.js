/** 领域公共常量：事件类型、聚合类型、扰动维度与岗位角色。 */

export const EVENT_TYPES = [
  "APPLICATION_SUBMITTED",
  "EDITION_REGISTERED",
  "CONDITION_ISSUED",
  "SAMPLE_RECORDED",
  "FEEDBACK_RECEIVED",
  "FEEDBACK_ASSESSED",
  "BREACH_CONFIRMED",
  "SUSPENSION_ORDERED",
  "RECTIFICATION_RECORDED",
  "ACTIVITY_RESUMED",
];

export const AGGREGATE_TYPES = [
  "permit_application",
  "operating_condition",
  "monitoring_sample",
  "resident_feedback",
  "enforcement_decision",
];

/** 扰动维度：灯光、噪声、客流分别判断，互不替代。 */
export const DIMENSIONS = ["light", "noise", "crowd"];

export const DIMENSION_LABELS = {
  light: "灯光",
  noise: "噪声",
  crowd: "客流",
};

/** 有权人员岗位：规则只提示越界，签发、确认、恢复必须由这些岗位完成。 */
export const ROLES = {
  permit_officer: "许可签发官",
  enforcement_officer: "执法确认官",
};

/** 岗位可执行的关键动作。 */
export const ROLE_PERMISSIONS = {
  permit_officer: ["issue_conditions"],
  enforcement_officer: ["assess_feedback", "confirm_breach", "order_suspension", "approve_resumption"],
};
