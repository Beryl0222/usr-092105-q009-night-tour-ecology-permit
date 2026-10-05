import { randomUUID } from "node:crypto";

import * as proj from "./projections.js";
import { describeBreaches, DIMENSION_NAMES, DIMENSIONS, evaluateApplication, evaluateSample } from "./rules.js";

export class DomainError extends Error {}

export class PermissionError extends DomainError {}

/** 有权角色：规则只提示，行政决定由持权人员作出。 */
export const ROLES = {
  PERMIT_ISSUER: "permit_issuer",
  BREACH_CONFIRMER: "breach_confirmer",
  RESUMPTION_APPROVER: "resumption_approver",
};

const SYSTEM_ACTOR = { actor_id: "system", name: "规则引擎", kind: "system" };

/** 采样时间早于登记时间超过该阈值即视为补报，须注明原因。 */
const BACKFILL_THRESHOLD_MS = 10 * 60 * 1000;

function requireRole(actor, role) {
  if (!actor || !Array.isArray(actor.roles) || !actor.roles.includes(role)) {
    throw new PermissionError(`该操作需要 ${role} 权限，规则提示不能替代有权人员决定`);
  }
}

function requireActor(actor) {
  if (!actor || !actor.actor_id) throw new PermissionError("缺少行为人信息");
}

export class NightTourService {
  constructor(store, catalog, { now = () => new Date() } = {}) {
    this.store = store;
    this.catalog = catalog;
    this.now = now;
  }

  #nextVersion(aggregateType, aggregateId) {
    return this.store.lastVersion(aggregateType, aggregateId) + 1;
  }

  async #emit(eventType, aggregateType, aggregateId, occurredAt, summary, payload, actor) {
    const event = {
      event_id: `evt-${randomUUID()}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: occurredAt,
      version: this.#nextVersion(aggregateType, aggregateId),
      summary,
      payload,
      actor: { actor_id: actor.actor_id, name: actor.name, kind: actor.kind ?? "officer" },
    };
    const { event: stored } = await this.store.append(event);
    return stored;
  }

  #requireApplication(applicationId) {
    const app = proj.buildApplication(this.store.all(), applicationId);
    if (!app) throw new DomainError(`许可申请不存在：${applicationId}`);
    return app;
  }

  #requireCase(caseId) {
    const c = proj.buildCase(this.store.all(), caseId);
    if (!c) throw new DomainError(`处置案件不存在：${caseId}`);
    return c;
  }

  // ---------- 申请与许可 ----------

  /** 提交申请：结构化登记场地、场次、人数、设备、交通与垃圾方案，返回规则提示。 */
  async submitApplication(payload, actor) {
    requireActor(actor);
    const site = this.catalog.get(payload.site_id);
    if (!site) throw new DomainError(`场地不存在：${payload.site_id}`);
    if (!payload.applicant?.name) throw new DomainError("缺少主办方名称");
    if (!payload.activity_type) throw new DomainError("活动类型不能只写“商业活动”，须注明具体内容（如萤火虫观察、古城演出、露营）");
    if (!Array.isArray(payload.editions) || payload.editions.length === 0) throw new DomainError("至少登记一个活动版次（场次）");
    for (const edition of payload.editions) {
      if (!edition.edition_id || !edition.date || !edition.start || !edition.end) {
        throw new DomainError("每个场次须包含 edition_id、date、start、end");
      }
      if (!Number.isInteger(edition.expected_attendance) || edition.expected_attendance < 1) {
        throw new DomainError(`场次 ${edition.edition_id} 缺少有效的预计人数`);
      }
    }
    if (!payload.equipment || (!payload.equipment.lighting?.length && !payload.equipment.sound?.length)) {
      throw new DomainError("须登记灯光、音响设备（无设备须显式给出空数组）");
    }
    if (!payload.traffic_plan) throw new DomainError("缺少交通方案");
    if (!payload.waste_plan?.capacity_l) throw new DomainError("缺少垃圾方案或容量");

    const applicationId = `app-${randomUUID().slice(0, 8)}`;
    const hints = evaluateApplication(site, payload, this.catalog);
    await this.#emit(
      "APPLICATION_SUBMITTED",
      "permit_application",
      applicationId,
      this.now().toISOString(),
      `提交「${payload.activity_type}」申请：${site.name}，共 ${payload.editions.length} 个场次`,
      payload,
      { ...actor, kind: actor.kind ?? "organizer" },
    );
    return { application_id: applicationId, hints };
  }

  /** 签发许可：仅 permit_issuer。 */
  async issuePermit(applicationId, actor, { decision_note = "" } = {}) {
    requireRole(actor, ROLES.PERMIT_ISSUER);
    const app = this.#requireApplication(applicationId);
    if (app.status === "issued") throw new DomainError("许可已签发，不得重复签发");
    await this.#emit(
      "PERMIT_ISSUED",
      "permit_application",
      applicationId,
      this.now().toISOString(),
      `${actor.name} 签发「${app.activity_type}」夜游许可`,
      { decision_note },
      actor,
    );
  }

  /** 签发场次可执行条件：售票前主办方据此执行。 */
  async issueConditions(applicationId, editionId, actor, limits, note = "") {
    requireRole(actor, ROLES.PERMIT_ISSUER);
    const app = this.#requireApplication(applicationId);
    if (app.status !== "issued") throw new DomainError("许可未签发，不能先签场次条件");
    if (!app.editions.some((e) => e.edition_id === editionId)) throw new DomainError(`场次不存在：${editionId}`);
    if (!limits || typeof limits !== "object" || Object.keys(limits).length === 0) throw new DomainError("场次条件不能为空");
    for (const d of Object.keys(limits)) {
      if (!DIMENSIONS.includes(d)) throw new DomainError(`未知扰动维度：${d}`);
    }
    const aggregateId = `${applicationId}#${editionId}`;
    if (this.store.lastVersion("operating_condition", aggregateId) > 0) {
      throw new DomainError(`场次 ${editionId} 条件已签发，如需调整请使用 adjustConditions`);
    }
    await this.#emit(
      "CONDITION_ISSUED",
      "operating_condition",
      aggregateId,
      this.now().toISOString(),
      `签发场次 ${editionId} 可执行条件（${Object.keys(limits).map((d) => DIMENSION_NAMES[d]).join("、")}）`,
      { application_id: applicationId, edition_id: editionId, limits, note },
      actor,
    );
  }

  /** 局部调整场次条件：只动需要动的维度，不推翻整场。 */
  async adjustConditions(applicationId, editionId, actor, partialLimits, reason) {
    requireRole(actor, ROLES.PERMIT_ISSUER);
    if (!reason) throw new DomainError("调整条件须说明理由");
    const aggregateId = `${applicationId}#${editionId}`;
    if (this.store.lastVersion("operating_condition", aggregateId) === 0) {
      throw new DomainError(`场次 ${editionId} 条件尚未签发`);
    }
    for (const d of Object.keys(partialLimits ?? {})) {
      if (!DIMENSIONS.includes(d)) throw new DomainError(`未知扰动维度：${d}`);
    }
    await this.#emit(
      "CONDITION_ADJUSTED",
      "operating_condition",
      aggregateId,
      this.now().toISOString(),
      `局部调整场次 ${editionId} 条件（${Object.keys(partialLimits).map((d) => DIMENSION_NAMES[d]).join("、")}）：${reason}`,
      { application_id: applicationId, edition_id: editionId, limits: partialLimits, reason },
      actor,
    );
  }

  // ---------- 监测采样 ----------

  /**
   * 登记采样（基线或实时）。设备离线补报沿用 SAMPLE_RECORDED / monitoring_sample 契约：
   * occurred_at 保留真实采样时间，须附 backfill_reason，平台登记时间写入 recorded_at。
   */
  async recordSample(payload, actor = { actor_id: payload.device_id ?? "device", name: payload.device_id ?? "监测设备", kind: "device" }) {
    const app = this.#requireApplication(payload.application_id);
    if (!app.editions.some((e) => e.edition_id === payload.edition_id)) throw new DomainError(`场次不存在：${payload.edition_id}`);
    if (!DIMENSIONS.includes(payload.dimension)) throw new DomainError(`未知扰动维度：${payload.dimension}`);
    if (!["baseline", "realtime"].includes(payload.phase)) throw new DomainError("phase 须为 baseline 或 realtime");
    if (!payload.occurred_at || Number.isNaN(Date.parse(payload.occurred_at))) throw new DomainError("采样须携带真实发生时间 occurred_at");
    if (typeof payload.value !== "number") throw new DomainError("采样值 value 必须是数值");

    const lag = this.now().getTime() - Date.parse(payload.occurred_at);
    const backfilled = lag > BACKFILL_THRESHOLD_MS;
    if (backfilled && !payload.backfill_reason) {
      throw new DomainError("监测设备离线补报须注明 backfill_reason（离线原因与时段）");
    }

    const samplePayload = {
      application_id: payload.application_id,
      edition_id: payload.edition_id,
      dimension: payload.dimension,
      phase: payload.phase,
      device_id: payload.device_id ?? null,
      unit: payload.unit,
      value: payload.value,
      spectrum_nm: payload.spectrum_nm ?? null,
      source: payload.source ?? null,
      backfilled,
      backfill_reason: backfilled ? payload.backfill_reason : null,
    };
    const sampleEvent = await this.#emit(
      "SAMPLE_RECORDED",
      "monitoring_sample",
      `${payload.application_id}#${payload.edition_id}#${payload.dimension}`,
      payload.occurred_at,
      `${payload.phase === "baseline" ? "基线" : "实时"}采样：${DIMENSION_NAMES[payload.dimension]} ${payload.value}${payload.unit ?? ""}${backfilled ? "（离线补报）" : ""}`,
      samplePayload,
      actor,
    );

    // 实时采样触发规则提示；基线采样只作参照，不提示。
    const flags = [];
    if (payload.phase === "realtime") {
      const conditions = proj.buildConditions(this.store.all(), payload.application_id);
      const limits = conditions.get(payload.edition_id)?.limits ?? null;
      const breaches = evaluateSample(limits, samplePayloadWithTime(samplePayload, payload.occurred_at));
      if (breaches.length > 0) {
        const flag = await this.#emit(
          "RULE_VIOLATION_FLAGGED",
          "enforcement_decision",
          caseIdOf(payload.application_id, payload.edition_id, payload.dimension),
          payload.occurred_at,
          `规则提示：${describeBreaches(payload.dimension, breaches)}，建议按${DIMENSION_NAMES[payload.dimension]}维度核查，可局部处置`,
          {
            application_id: payload.application_id,
            edition_id: payload.edition_id,
            dimension: payload.dimension,
            breaches,
            sample_event_id: sampleEvent.event_id,
            advice: "局部调整优先，确认违规与暂停由有权人员决定",
          },
          SYSTEM_ACTOR,
        );
        flags.push(flag);
      }
    }
    return { sample: sampleEvent, flags };
  }

  // ---------- 居民反馈 ----------

  /** 登记居民反馈；匿名反馈可以登记，但确认违规时须与可核验证据共同研判。 */
  async fileFeedback(applicationId, actor, { edition_id = null, anonymous = false, channel = "hotline", content, evidence = [] }) {
    requireActor({ ...actor, kind: actor.kind ?? "resident" });
    const app = this.#requireApplication(applicationId);
    if (edition_id && !app.editions.some((e) => e.edition_id === edition_id)) throw new DomainError(`场次不存在：${edition_id}`);
    if (!content || content.trim().length < 2) throw new DomainError("反馈内容不能为空");
    const feedbackId = `fb-${randomUUID().slice(0, 8)}`;
    await this.#emit(
      "FEEDBACK_RECEIVED",
      "permit_application",
      applicationId,
      this.now().toISOString(),
      `收到${anonymous ? "匿名" : "实名"}居民反馈（${channel}）${edition_id ? `，指向场次 ${edition_id}` : ""}`,
      { feedback_id: feedbackId, edition_id, anonymous, channel, content, evidence },
      { ...actor, kind: "resident" },
    );
    return { feedback_id: feedbackId };
  }

  // ---------- 执法处置 ----------

  /**
   * 确认违规：仅 breach_confirmer。
   * 须附可核验证据；匿名投诉不能单独定案，须与监测采样或带附件的反馈共同研判。
   */
  async confirmBreach(caseId, actor, { sample_event_ids = [], feedback_ids = [], note = "" } = {}) {
    requireRole(actor, ROLES.BREACH_CONFIRMER);
    const c = this.#requireCase(caseId);
    if (c.status !== "flagged") throw new DomainError(`案件当前状态为 ${c.status}，不能确认违规`);

    const samples = sample_event_ids.map((id) => {
      const e = this.store.get(id);
      if (!e || e.event_type !== "SAMPLE_RECORDED") throw new DomainError(`采样证据不存在：${id}`);
      if (e.payload.application_id !== c.application_id || e.payload.dimension !== c.dimension) {
        throw new DomainError(`采样证据 ${id} 与案件维度不一致`);
      }
      return e;
    });
    const feedbackEvents = this.store
      .all()
      .filter((e) => e.event_type === "FEEDBACK_RECEIVED" && e.aggregate_id === c.application_id && feedback_ids.includes(e.payload.feedback_id));
    if (feedbackEvents.length !== feedback_ids.length) throw new DomainError("部分居民反馈编号不存在");

    if (samples.length === 0 && feedbackEvents.length === 0) {
      throw new DomainError("确认违规须附可核验证据（监测采样或居民反馈）");
    }
    const verifiable =
      samples.length > 0 || feedbackEvents.some((f) => !f.payload.anonymous || (f.payload.evidence ?? []).length > 0);
    if (!verifiable) {
      throw new DomainError("仅有匿名投诉，缺少可核验证据（监测采样或带附件的实名/匿名反馈），不能确认违规");
    }

    await this.#emit(
      "BREACH_CONFIRMED",
      "enforcement_decision",
      caseId,
      this.now().toISOString(),
      `${actor.name} 确认${DIMENSION_NAMES[c.dimension]}维度违规（采样 ${samples.length} 条、反馈 ${feedbackEvents.length} 条）`,
      {
        application_id: c.application_id,
        edition_id: c.edition_id,
        dimension: c.dimension,
        evidence: { sample_event_ids, feedback_ids, note },
      },
      actor,
    );
  }

  /**
   * 暂停处置：默认只停涉案场次涉案维度（case）。
   * 扩大到整场次（edition）或整活动（application）时，须说明为何局部调整不足。
   */
  async suspendCase(caseId, actor, { scope = "case", reason, justification = null } = {}) {
    requireRole(actor, ROLES.BREACH_CONFIRMER);
    const c = this.#requireCase(caseId);
    if (c.status !== "confirmed") throw new DomainError(`案件当前状态为 ${c.status}，须先确认违规再暂停`);
    if (!["case", "edition", "application"].includes(scope)) throw new DomainError(`未知暂停范围：${scope}`);
    if (!reason) throw new DomainError("暂停须说明事由");
    if (scope !== "case" && !justification) {
      throw new DomainError("局部调整足够时不得直接取消整场；扩大暂停范围须说明为何局部处置不足");
    }

    const app = this.#requireApplication(c.application_id);
    let editionIds;
    let dimensions;
    if (scope === "case") {
      editionIds = [c.edition_id];
      dimensions = [c.dimension];
    } else if (scope === "edition") {
      editionIds = [c.edition_id];
      dimensions = [...DIMENSIONS];
    } else {
      editionIds = app.editions.map((e) => e.edition_id);
      dimensions = [...DIMENSIONS];
    }
    const scopeText = scope === "case" ? `场次 ${c.edition_id} 的${DIMENSION_NAMES[c.dimension]}维度` : scope === "edition" ? `场次 ${c.edition_id} 全部维度` : "全部场次全部维度";
    await this.#emit(
      "ACTIVITY_SUSPENDED",
      "enforcement_decision",
      caseId,
      this.now().toISOString(),
      `暂停${scopeText}：${reason}`,
      { application_id: c.application_id, scope, edition_ids: editionIds, dimensions, reason, justification },
      actor,
    );
  }

  /** 记录整改动作。 */
  async recordRectification(caseId, actor, { description, evidence_refs = [] }) {
    requireActor(actor);
    const c = this.#requireCase(caseId);
    if (c.status !== "suspended") throw new DomainError(`案件当前状态为 ${c.status}，不能登记整改`);
    if (!description) throw new DomainError("整改动作描述不能为空");
    const actionId = `rect-${randomUUID().slice(0, 8)}`;
    await this.#emit(
      "RECTIFICATION_RECORDED",
      "enforcement_decision",
      caseId,
      this.now().toISOString(),
      `整改：${description}`,
      { action_id: actionId, application_id: c.application_id, dimension: c.dimension, description, evidence_refs },
      { ...actor, kind: actor.kind ?? "organizer" },
    );
    return { action_id: actionId };
  }

  /**
   * 批准恢复：仅 resumption_approver。
   * 恢复事件完整列出触发采样、整改动作、签署人和重新开放门槛，供公开页披露。
   */
  async resumeCase(caseId, actor, { signatories = [], reopening_thresholds = null, note = "" } = {}) {
    requireRole(actor, ROLES.RESUMPTION_APPROVER);
    const c = this.#requireCase(caseId);
    if (c.status !== "suspended") throw new DomainError(`案件当前状态为 ${c.status}，不能恢复`);
    if (c.rectifications.length === 0) throw new DomainError("恢复前须至少记录一项整改动作");
    if (!reopening_thresholds || !reopening_thresholds[c.dimension]) {
      throw new DomainError(`重新开放门槛须覆盖被暂停的维度：${DIMENSION_NAMES[c.dimension]}`);
    }
    const names = signatories.map((s) => s.name);
    if (!names.includes(actor.name)) throw new DomainError("签署人须包含批准人本人");
    if (!signatories.some((s) => s.capacity === "organizer")) throw new DomainError("签署人须包含主办方代表");

    const triggerSampleIds = [
      ...new Set([
        ...c.flags.map((f) => f.sample_event_id).filter(Boolean),
        ...(c.confirmation?.evidence?.sample_event_ids ?? []),
      ]),
    ];
    await this.#emit(
      "ACTIVITY_RESUMED",
      "enforcement_decision",
      caseId,
      this.now().toISOString(),
      `${actor.name} 批准恢复场次 ${c.edition_id} 的${DIMENSION_NAMES[c.dimension]}维度`,
      {
        application_id: c.application_id,
        edition_id: c.edition_id,
        dimension: c.dimension,
        scope: c.suspension.scope,
        trigger_sample_event_ids: triggerSampleIds,
        rectification_action_ids: c.rectifications.map((r) => r.action_id),
        signatories,
        reopening_thresholds,
        note,
      },
      actor,
    );
  }

  // ---------- 查询 ----------

  getApplication(applicationId) {
    return proj.buildApplication(this.store.all(), applicationId);
  }

  listCases(applicationId) {
    return proj.listCases(this.store.all(), applicationId);
  }

  getCase(caseId) {
    return proj.buildCase(this.store.all(), caseId);
  }

  /** 售票前场次条件：可执行的数值条件，而非笼统“原则同意”。 */
  getTicketClearance(applicationId) {
    return proj.ticketClearance(this.store.all(), applicationId);
  }

  /** 按发生时间组织的全过程时间线。 */
  getTimeline(applicationId) {
    return proj.timeline(this.store.all(), applicationId);
  }

  /** 公开暂停页：处置进度与恢复披露。 */
  getPublicSuspensionPage(applicationId) {
    return proj.publicSuspensionPage(this.store.all(), applicationId, this.now().toISOString());
  }
}

function caseIdOf(applicationId, editionId, dimension) {
  return `case#${applicationId}#${editionId}#${dimension}`;
}

function samplePayloadWithTime(samplePayload, occurredAt) {
  return { ...samplePayload, occurred_at: occurredAt };
}
