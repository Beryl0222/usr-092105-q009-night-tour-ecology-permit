/** 领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  /** 事实发生时间；补报时保留真实采样时间。 */
  occurred_at: string;
  /** 平台登记时间，由事件存储写入。 */
  recorded_at?: string;
  version: number;
  summary: string;
  actor?: Actor;
  payload?: Record<string, unknown>;
}

export type EventType =
  | "APPLICATION_SUBMITTED"
  | "PERMIT_ISSUED"
  | "FEEDBACK_RECEIVED"
  | "CONDITION_ISSUED"
  | "CONDITION_ADJUSTED"
  | "SAMPLE_RECORDED"
  | "RULE_VIOLATION_FLAGGED"
  | "BREACH_CONFIRMED"
  | "ACTIVITY_SUSPENDED"
  | "RECTIFICATION_RECORDED"
  | "ACTIVITY_RESUMED";

export type AggregateType = "permit_application" | "operating_condition" | "monitoring_sample" | "enforcement_decision";

export interface Actor {
  actor_id: string;
  name: string;
  kind: "officer" | "organizer" | "resident" | "device" | "system";
}

/** 扰动维度：灯光、噪声、客流分别判断、分别处置。 */
export type Dimension = "light" | "noise" | "crowd";

/** 活动版次（场次）。 */
export interface Edition {
  edition_id: string;
  date: string;
  start: string;
  end: string;
  expected_attendance: number;
}

/** 场次可执行条件：售票前主办方拿到的就是这组数值。 */
export interface ConditionLimits {
  light?: { max_lux?: number; spectrum_min_nm?: number; curfew?: string };
  noise?: { max_db?: number; amplified_end?: string };
  crowd?: { max_attendance?: number };
}

/** 暂停范围：默认只停涉案场次涉案维度，扩大范围须说明理由。 */
export type SuspensionScope = "case" | "edition" | "application";
