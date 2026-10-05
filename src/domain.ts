/** 领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  data?: Record<string, unknown>;
}

/** 场地敏感区。 */
export interface SensitiveZone {
  zone_id: string;
  name: string;
  kind: "firefly_habitat" | "ancient_town" | "campsite";
  description: string;
}

/** 物种季节窗口：在窗口期内对灯光光谱与安静时段有额外约束。 */
export interface SpeciesWindow {
  window_id: string;
  zone_id: string;
  species: string;
  start_date: string; // 含时区或日期
  end_date: string;
  min_wavelength_nm: number; // 该季节允许的最小主波长
  quiet_hours: { start: string; end: string }; // 每日安静时段
}

/** 活动版次（场次）。 */
export interface ActivityEdition {
  edition_id: string;
  application_id: string;
  zone_id: string;
  title: string;
  start_at: string;
  end_at: string;
  expected_attendance: number;
  equipment: Array<{ kind: "light" | "sound"; name: string; spec: string }>;
  traffic_plan: string;
  waste_plan: string;
}

/** 许可条件：按场次下达、可执行、可采样核对。 */
export interface OperatingCondition {
  edition_id: string;
  light: { min_wavelength_nm: number; max_lux: number; blackout_after: string };
  noise: { max_db: number; amplification_end: string };
  crowd: { max_attendance: number; max_waste_bins: number };
  issued_by: string;
  issued_at: string;
  ticket_sale_open_at: string;
}

/** 监测采样（基线或实时；离线补报带 backfill 标记）。 */
export interface MonitoringSample {
  sample_id: string;
  edition_id: string;
  dimension: "light" | "noise" | "crowd";
  metric: string;
  value: number;
  unit: string;
  device_id: string;
  occurred_at: string;
  baseline: boolean;
  backfill: boolean;
  offline_reason?: string;
}

/** 居民反馈：匿名反馈必须与可核验证据共同研判。 */
export interface ResidentFeedback {
  feedback_id: string;
  edition_id: string;
  anonymous: boolean;
  dimension: "light" | "noise" | "crowd" | null;
  text: string;
  occurred_at: string;
  status: "received" | "corroborated" | "evidence_insufficient";
  evidence: { sample_ids: string[]; feedback_ids: string[] };
  assessed_by?: string;
}

/** 执法决定：违规确认、暂停、整改、恢复。 */
export interface EnforcementDecision {
  decision_id: string;
  kind: "breach" | "suspension" | "rectification" | "resumption";
  edition_ids: string[];
  dimensions: Array<"light" | "noise" | "crowd">;
  trigger_sample_ids: string[];
  rectifications: Array<{ action_id: string; action: string; status: string; done_at?: string; operator?: string }>;
  signatories: string[];
  reopen_thresholds: Record<string, string>;
  decided_by: string;
  occurred_at: string;
}
