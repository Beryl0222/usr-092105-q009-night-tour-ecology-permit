import { DIMENSION_NAMES, DIMENSIONS } from "./rules.js";

/** 按真实时间先后比较，兼容带不同时区偏移的 ISO 字符串。 */
function byTime(a, b) {
  return Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || Date.parse(a.recorded_at ?? 0) - Date.parse(b.recorded_at ?? 0);
}

/** 与某申请相关的全部事件（申请、场次条件、监测序列、处置案件）。 */
export function relatedEvents(events, applicationId) {
  return events.filter(
    (e) =>
      e.aggregate_id === applicationId ||
      e.aggregate_id.startsWith(`${applicationId}#`) ||
      e.aggregate_id.startsWith(`case#${applicationId}#`),
  );
}

/** 申请视图：基本信息、许可状态、居民反馈。 */
export function buildApplication(events, applicationId) {
  let app = null;
  for (const e of events) {
    if (e.aggregate_type !== "permit_application" || e.aggregate_id !== applicationId) continue;
    if (e.event_type === "APPLICATION_SUBMITTED") {
      app = { application_id: applicationId, ...e.payload, status: "submitted", submitted_at: e.occurred_at, feedback: [] };
    } else if (app && e.event_type === "PERMIT_ISSUED") {
      app.status = "issued";
      app.issued_at = e.occurred_at;
      app.issued_by = e.actor ?? null;
      app.decision_note = e.payload?.decision_note ?? null;
    } else if (app && e.event_type === "FEEDBACK_RECEIVED") {
      app.feedback.push({ ...e.payload, occurred_at: e.occurred_at });
    }
  }
  return app;
}

/** 各场次现行可执行条件（CONDITION_ISSUED 之后按 CONDITION_ADJUSTED 逐维度合并）。 */
export function buildConditions(events, applicationId) {
  const conditions = new Map();
  for (const e of events) {
    if (e.aggregate_type !== "operating_condition" || !e.aggregate_id.startsWith(`${applicationId}#`)) continue;
    const editionId = e.aggregate_id.slice(applicationId.length + 1);
    if (e.event_type === "CONDITION_ISSUED") {
      conditions.set(editionId, { limits: e.payload.limits, issued_at: e.occurred_at, issued_by: e.actor ?? null, history: [] });
    } else if (e.event_type === "CONDITION_ADJUSTED" && conditions.has(editionId)) {
      const current = conditions.get(editionId);
      for (const [dimension, patch] of Object.entries(e.payload.limits ?? {})) {
        current.limits[dimension] = { ...(current.limits[dimension] ?? {}), ...patch };
      }
      current.history.push({ at: e.occurred_at, reason: e.payload.reason ?? null, by: e.actor ?? null });
    }
  }
  return conditions;
}

/** 处置案件视图：规则提示 → 确认违规 → 暂停 → 整改 → 恢复。 */
export function buildCase(events, caseId) {
  const found = { case_id: caseId, status: null, flags: [], confirmation: null, suspension: null, rectifications: [], resumption: null };
  for (const e of events) {
    if (e.aggregate_type !== "enforcement_decision" || e.aggregate_id !== caseId) continue;
    if (e.event_type === "RULE_VIOLATION_FLAGGED") {
      found.flags.push({ ...e.payload, occurred_at: e.occurred_at, event_id: e.event_id });
      if (!found.status) found.status = "flagged";
      found.application_id = e.payload.application_id;
      found.edition_id = e.payload.edition_id;
      found.dimension = e.payload.dimension;
    } else if (e.event_type === "BREACH_CONFIRMED") {
      found.confirmation = { ...e.payload, occurred_at: e.occurred_at, by: e.actor ?? null };
      found.status = "confirmed";
    } else if (e.event_type === "ACTIVITY_SUSPENDED") {
      found.suspension = { ...e.payload, occurred_at: e.occurred_at, by: e.actor ?? null };
      found.status = "suspended";
    } else if (e.event_type === "RECTIFICATION_RECORDED") {
      found.rectifications.push({ ...e.payload, occurred_at: e.occurred_at, by: e.actor ?? null });
    } else if (e.event_type === "ACTIVITY_RESUMED") {
      found.resumption = { ...e.payload, occurred_at: e.occurred_at, by: e.actor ?? null };
      found.status = "resumed";
    }
  }
  return found.status ? found : null;
}

export function listCases(events, applicationId) {
  const ids = new Set(
    events
      .filter((e) => e.aggregate_type === "enforcement_decision" && e.aggregate_id.startsWith(`case#${applicationId}#`))
      .map((e) => e.aggregate_id),
  );
  return [...ids].map((id) => buildCase(events, id));
}

/** 当前生效的暂停覆盖（edition_id, dimension）集合。 */
export function activeSuspensions(events, applicationId) {
  const covered = [];
  for (const c of listCases(events, applicationId)) {
    if (c.status !== "suspended" || !c.suspension) continue;
    for (const editionId of c.suspension.edition_ids ?? []) {
      for (const dimension of c.suspension.dimensions ?? []) {
        covered.push({ edition_id: editionId, dimension, case_id: c.case_id });
      }
    }
  }
  return covered;
}

/**
 * 售票前场次条件：主办方拿到的不是“原则同意”，而是每个场次可执行的数值条件。
 * sale_status: cleared 可售 / restricted 部分维度受限 / blocked 不可售。
 */
export function ticketClearance(events, applicationId) {
  const app = buildApplication(events, applicationId);
  if (!app) return null;
  const conditions = buildConditions(events, applicationId);
  const suspended = activeSuspensions(events, applicationId);
  const editions = (app.editions ?? []).map((edition) => {
    const condition = conditions.get(edition.edition_id) ?? null;
    const suspendedDimensions = DIMENSIONS.filter((d) =>
      suspended.some((s) => s.edition_id === edition.edition_id && s.dimension === d),
    );
    const notes = [];
    let sale_status;
    if (app.status !== "issued") {
      sale_status = "blocked";
      notes.push("许可尚未签发");
    } else if (!condition) {
      sale_status = "blocked";
      notes.push("场次条件尚未签发，不能售票");
    } else if (suspendedDimensions.length === DIMENSIONS.length) {
      sale_status = "blocked";
      notes.push("全部维度暂停中");
    } else if (suspendedDimensions.length > 0) {
      sale_status = "restricted";
      notes.push(`受限维度：${suspendedDimensions.map((d) => DIMENSION_NAMES[d]).join("、")}，其余维度按条件执行`);
    } else {
      sale_status = "cleared";
    }
    return {
      edition_id: edition.edition_id,
      date: edition.date,
      expected_attendance: edition.expected_attendance,
      sale_status,
      conditions: condition?.limits ?? null,
      suspended_dimensions: suspendedDimensions,
      notes,
    };
  });
  return { application_id: applicationId, activity_type: app.activity_type, permit_status: app.status, editions };
}

/** 按发生时间组织的时间线；补报事件按 occurred_at 落到历史位置，并标注登记时间。 */
export function timeline(events, applicationId) {
  return relatedEvents(events, applicationId)
    .slice()
    .sort(byTime)
    .map((e) => ({
      occurred_at: e.occurred_at,
      recorded_at: e.recorded_at ?? null,
      event_type: e.event_type,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      version: e.version,
      summary: e.summary,
      backfilled: Boolean(e.payload?.backfilled),
    }));
}

const STEP_NAMES = {
  RULE_VIOLATION_FLAGGED: "规则提示越界",
  BREACH_CONFIRMED: "确认违规",
  ACTIVITY_SUSPENDED: "暂停处置",
  RECTIFICATION_RECORDED: "整改记录",
  ACTIVITY_RESUMED: "批准恢复",
};

/**
 * 公开暂停页：公布到达“确认违规”及以后的案件处置进度。
 * 仅规则提示（未确认）不作为违规公开；恢复时完整披露触发采样、整改动作、签署人、重新开放门槛。
 */
export function publicSuspensionPage(events, applicationId, generatedAt) {
  const cases = listCases(events, applicationId).filter((c) => ["confirmed", "suspended", "resumed"].includes(c.status));
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const view = cases.map((c) => {
    const caseEvents = events
      .filter((e) => e.aggregate_type === "enforcement_decision" && e.aggregate_id === c.case_id)
      .sort(byTime);
    const progress = caseEvents.map((e) => ({
      at: e.occurred_at,
      step: STEP_NAMES[e.event_type] ?? e.event_type,
      detail: e.summary,
    }));
    let disclosure = null;
    if (c.resumption) {
      disclosure = {
        trigger_samples: (c.resumption.trigger_sample_event_ids ?? []).map((id) => {
          const sample = byId.get(id);
          return sample
            ? {
                event_id: id,
                occurred_at: sample.occurred_at,
                dimension: sample.payload.dimension,
                value: sample.payload.value,
                unit: sample.payload.unit,
                backfilled: Boolean(sample.payload.backfilled),
              }
            : { event_id: id, missing: true };
        }),
        rectification_actions: c.rectifications.map((r) => ({
          action_id: r.action_id,
          at: r.occurred_at,
          description: r.description,
          by: r.by?.name ?? null,
        })),
        signatories: c.resumption.signatories ?? [],
        reopening_thresholds: c.resumption.reopening_thresholds ?? null,
      };
    }
    return {
      case_id: c.case_id,
      edition_id: c.edition_id,
      dimension: c.dimension,
      dimension_name: DIMENSION_NAMES[c.dimension] ?? c.dimension,
      status: c.status,
      suspended_scope: c.suspension && c.status === "suspended" ? c.suspension.scope : null,
      progress,
      disclosure,
    };
  });
  return { application_id: applicationId, generated_at: generatedAt, cases: view };
}
