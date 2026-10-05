import { randomUUID } from "node:crypto";

import { DIMENSION_LABELS, DIMENSIONS, ROLE_PERMISSIONS } from "./constants.js";
import { evaluateEditionAlerts, evaluateSample } from "./rules.js";

/** 业务错误：message 直接面向调用方，status 供 HTTP 层映射。 */
export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const FEEDBACK_SAMPLE_WINDOW_MIN = 30; // 反馈与采样互证的时间窗
const FEEDBACK_PEER_WINDOW_MIN = 60; // 多人印证的时间窗
const FEEDBACK_PEER_COUNT = 2; // 多人印证所需的其他反馈数

/**
 * 夜游生态扰动许可业务服务。
 * 所有事实以领域事件落库（occurred_at 为真实发生时间），读模型由事件回放得到。
 * 规则引擎只提示越界；签发许可、确认违规、批准恢复必须由有权人员调用。
 */
export class NightTourService {
  constructor(store, { zones = [], speciesWindows = [], officers = [], now } = {}) {
    this.store = store;
    this.zones = new Map(zones.map((z) => [z.zone_id, z]));
    this.speciesWindows = speciesWindows;
    this.officers = new Map(officers.map((o) => [o.officer_id, o]));
    this.now = now ?? (() => new Date().toISOString());
    this.#reset();
    for (const event of store.events) this.#apply(event);
  }

  #reset() {
    this.applications = new Map();
    this.editions = new Map();
    this.conditions = new Map(); // edition_id -> condition
    this.samples = new Map(); // edition_id -> [sample]
    this.feedback = new Map(); // feedback_id -> feedback
    this.breaches = new Map(); // `${edition_id}:${dimension}` -> record
    this.suspensions = new Map(); // suspension_id -> suspension
  }

  // ---------- 内部工具 ----------

  #id(prefix) {
    return `${prefix}-${randomUUID()}`;
  }

  async #emit(eventType, aggregateType, aggregateId, occurredAt, summary, data) {
    const event = await this.store.append({
      event_id: this.#id("evt"),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: occurredAt ?? this.now(),
      summary,
      data,
    });
    this.#apply(event);
    return event;
  }

  #requireOfficer(officerId, action) {
    const officer = this.officers.get(officerId);
    if (!officer) throw new DomainError("未登记的工作人员，无权执行该操作", 403);
    if (!ROLE_PERMISSIONS[officer.role]?.includes(action)) {
      throw new DomainError(`岗位「${officer.role}」无权执行该操作`, 403);
    }
    return officer;
  }

  #getEdition(editionId) {
    const edition = this.editions.get(editionId);
    if (!edition) throw new DomainError(`场次不存在：${editionId}`, 404);
    return edition;
  }

  #editionSamples(editionId) {
    return this.samples.get(editionId) ?? [];
  }

  /** 场次落入的物种季节窗口（按日期重叠判断）。 */
  #speciesNotices(edition) {
    const day = (iso) => iso.slice(0, 10);
    return this.speciesWindows
      .filter((w) => w.zone_id === edition.zone_id)
      .filter((w) => day(edition.start_at) <= w.end_date && day(edition.end_at) >= w.start_date)
      .map((w) => ({
        window_id: w.window_id,
        species: w.species,
        message: `场次处于${w.species}季节窗口（${w.start_date}至${w.end_date}）：灯光主波长不得低于${w.min_wavelength_nm}nm，安静时段${w.quiet_hours.start}至${w.quiet_hours.end}`,
        min_wavelength_nm: w.min_wavelength_nm,
      }));
  }

  // ---------- 申请与场次 ----------

  /** 登记申请：按场次记录敏感区、预计人数、灯光音响设备、交通与垃圾方案。 */
  async submitApplication({ applicant, title, activity_kind, editions }, occurredAt) {
    if (!applicant || !title) throw new DomainError("申请必须包含主办方与活动名称");
    if (!Array.isArray(editions) || editions.length === 0) throw new DomainError("申请必须包含至少一个场次");
    for (const e of editions) {
      if (!this.zones.has(e.zone_id)) throw new DomainError(`未知场地敏感区：${e.zone_id}`);
      if (!Number.isInteger(e.expected_attendance) || e.expected_attendance <= 0) {
        throw new DomainError(`场次「${e.title}」缺少有效的预计人数`);
      }
      if (!e.start_at || !e.end_at) throw new DomainError(`场次「${e.title}」缺少起止时间`);
      if (!e.traffic_plan || !e.waste_plan) throw new DomainError(`场次「${e.title}」缺少交通或垃圾方案`);
    }
    const applicationId = this.#id("app");
    await this.#emit("APPLICATION_SUBMITTED", "permit_application", applicationId, occurredAt,
      `收到「${title}」夜游扰动许可申请（${editions.length} 个场次）`,
      { application_id: applicationId, applicant, title, activity_kind });
    for (const e of editions) {
      const edition = {
        edition_id: this.#id("edn"),
        application_id: applicationId,
        zone_id: e.zone_id,
        title: e.title,
        start_at: e.start_at,
        end_at: e.end_at,
        expected_attendance: e.expected_attendance,
        equipment: e.equipment ?? [],
        traffic_plan: e.traffic_plan,
        waste_plan: e.waste_plan,
        species_notices: this.#speciesNotices(e),
      };
      await this.#emit("EDITION_REGISTERED", "permit_application", applicationId, occurredAt,
        `登记场次「${e.title}」于${this.zones.get(e.zone_id).name}，预计 ${e.expected_attendance} 人`,
        edition);
    }
    return this.getApplication(applicationId);
  }

  // ---------- 许可条件（售票前的可执行场次条件） ----------

  /**
   * 签发场次条件。只有许可签发官可执行；签发前主办方只有申请回执，
   * 签发后拿到的必须是逐场次、可采样核对的条件，而不是笼统的“原则同意”。
   */
  async issueConditions(applicationId, officerId, { conditions, ticket_sale_open_at }, occurredAt) {
    const officer = this.#requireOfficer(officerId, "issue_conditions");
    const application = this.applications.get(applicationId);
    if (!application) throw new DomainError(`申请不存在：${applicationId}`, 404);
    if (application.status === "conditions_issued") throw new DomainError("该申请已签发条件，如需变更请走变更流程", 409);
    if (!ticket_sale_open_at) throw new DomainError("必须给出售票开放时间");
    const byEdition = new Map((conditions ?? []).map((c) => [c.edition_id, c]));
    for (const editionId of application.edition_ids) {
      if (!byEdition.has(editionId)) throw new DomainError(`场次 ${editionId} 缺少许可条件，不得笼统签发`);
    }
    for (const [editionId, c] of byEdition) {
      const edition = this.#getEdition(editionId);
      for (const dim of ["light", "noise", "crowd"]) {
        if (!c[dim]) throw new DomainError(`场次「${edition.title}」缺少${DIMENSION_LABELS[dim]}条件`);
      }
      for (const notice of edition.species_notices) {
        if (c.light.min_wavelength_nm < notice.min_wavelength_nm) {
          throw new DomainError(
            `场次「${edition.title}」灯光波长下限 ${c.light.min_wavelength_nm}nm 低于${notice.species}季节窗口要求 ${notice.min_wavelength_nm}nm`);
        }
      }
    }
    for (const [editionId, c] of byEdition) {
      const edition = this.#getEdition(editionId);
      const condition = {
        edition_id: editionId,
        light: c.light,
        noise: c.noise,
        crowd: c.crowd,
        issued_by: officer.name,
        issued_at: occurredAt ?? this.now(),
        ticket_sale_open_at,
      };
      await this.#emit("CONDITION_ISSUED", "operating_condition", `condition:${editionId}`, occurredAt,
        `签发场次「${edition.title}」许可条件：波长≥${c.light.min_wavelength_nm}nm、照度≤${c.light.max_lux}lx、` +
        `${c.light.blackout_after}后熄灯、噪声≤${c.noise.max_db}dB、${c.noise.amplification_end}停止扩音、` +
        `人数≤${c.crowd.max_attendance}、垃圾≤${c.crowd.max_waste_bins}桶`,
        condition);
    }
    await this.#emit("CONDITION_ISSUED", "permit_application", applicationId, occurredAt,
      `全部 ${application.edition_ids.length} 个场次条件签发完成，${ticket_sale_open_at} 起可售票`,
      { application_id: applicationId, ticket_sale_open_at, issued_by: officer.name });
    return this.getTicketConditions(applicationId);
  }

  /** 主办方售票前取得的逐场次可执行条件。未签发时明确拒绝，不出具“原则同意”。 */
  getTicketConditions(applicationId) {
    const application = this.applications.get(applicationId);
    if (!application) throw new DomainError(`申请不存在：${applicationId}`, 404);
    if (application.status !== "conditions_issued") {
      throw new DomainError("许可条件尚未签发，主办方暂无可执行场次条件，不得售票", 409);
    }
    return {
      application_id: applicationId,
      ticket_sale_open_at: application.ticket_sale_open_at,
      editions: application.edition_ids.map((id) => ({
        edition: this.editions.get(id),
        condition: this.conditions.get(id),
      })),
    };
  }

  // ---------- 监测采样（基线、实时、离线补报） ----------

  /** 登记一条采样并立即按场次条件判定越界。 */
  async recordSample(editionId, input, occurredAt) {
    const edition = this.#getEdition(editionId);
    const sample = this.#buildSample(editionId, input);
    await this.#emit("SAMPLE_RECORDED", "monitoring_sample", `samples:${editionId}`, sample.occurred_at,
      `${edition.title} ${DIMENSION_LABELS[sample.dimension]}采样 ${sample.metric}=${sample.value}${sample.unit}` +
      (sample.baseline ? "（基线）" : "") + (sample.backfill ? "（离线补报）" : ""),
      sample);
    const condition = this.conditions.get(editionId);
    const breach = condition && !sample.baseline ? evaluateSample(condition, sample) : null;
    return { sample, breach };
  }

  /**
   * 监测设备离线后的补报：沿用 monitoring_sample 契约，必须给出离线原因，
   * 每条补报必须带原 sample_id 与真实 occurred_at；重复 sample_id 幂等跳过。
   */
  async backfillSamples(editionId, { device_id, offline_reason, samples }) {
    this.#getEdition(editionId);
    if (!device_id) throw new DomainError("补报必须注明设备编号");
    if (!offline_reason) throw new DomainError("补报必须注明设备离线原因");
    if (!Array.isArray(samples) || samples.length === 0) throw new DomainError("补报内容为空");
    const now = this.now();
    const known = new Set(this.#editionSamples(editionId).map((s) => s.sample_id));
    const recorded = [];
    const skipped = [];
    for (const raw of samples) {
      if (!raw.sample_id) throw new DomainError("补报采样必须携带原 sample_id");
      if (known.has(raw.sample_id)) {
        skipped.push({ sample_id: raw.sample_id, reason: "已存在，幂等跳过" });
        continue;
      }
      if (!raw.occurred_at || Number.isNaN(Date.parse(raw.occurred_at))) {
        throw new DomainError(`补报采样 ${raw.sample_id} 缺少可解析的 occurred_at`);
      }
      if (raw.occurred_at > now) throw new DomainError(`补报采样 ${raw.sample_id} 的发生时间晚于当前时间`);
      const sample = this.#buildSample(editionId, { ...raw, device_id, backfill: true, offline_reason });
      await this.#emit("SAMPLE_RECORDED", "monitoring_sample", `samples:${editionId}`, sample.occurred_at,
        `离线补报 ${DIMENSION_LABELS[sample.dimension]}采样 ${sample.metric}=${sample.value}${sample.unit}（设备 ${device_id}）`,
        sample);
      known.add(sample.sample_id);
      recorded.push(sample);
    }
    return { recorded, skipped };
  }

  #buildSample(editionId, input) {
    if (!DIMENSIONS.includes(input.dimension)) throw new DomainError(`未知扰动维度：${input.dimension}`);
    if (!input.metric || typeof input.value !== "number") throw new DomainError("采样必须包含 metric 与数值 value");
    if (!input.unit) throw new DomainError("采样必须包含单位 unit");
    if (!input.device_id) throw new DomainError("采样必须注明设备编号 device_id");
    if (!input.occurred_at || Number.isNaN(Date.parse(input.occurred_at))) {
      throw new DomainError("采样必须携带可解析的 occurred_at");
    }
    return {
      sample_id: input.sample_id ?? this.#id("smp"),
      edition_id: editionId,
      dimension: input.dimension,
      metric: input.metric,
      value: input.value,
      unit: input.unit,
      device_id: input.device_id,
      occurred_at: input.occurred_at,
      baseline: Boolean(input.baseline),
      backfill: Boolean(input.backfill),
      ...(input.offline_reason ? { offline_reason: input.offline_reason } : {}),
    };
  }

  /** 场次越界提示：规则只提示，不作处置决定。 */
  listAlerts(editionId) {
    this.#getEdition(editionId);
    const condition = this.conditions.get(editionId);
    if (!condition) throw new DomainError("该场次尚未签发许可条件，无法判定越界", 409);
    const realtime = this.#editionSamples(editionId).filter((s) => !s.baseline);
    return evaluateEditionAlerts(condition, realtime);
  }

  // ---------- 居民反馈与证据研判 ----------

  async receiveFeedback(editionId, { anonymous = true, dimension = null, text, occurred_at, channel = "hotline" }) {
    this.#getEdition(editionId);
    if (!text || text.trim().length < 2) throw new DomainError("反馈内容不能为空");
    if (dimension && !DIMENSIONS.includes(dimension)) throw new DomainError(`未知扰动维度：${dimension}`);
    const feedback = {
      feedback_id: this.#id("fbk"),
      edition_id: editionId,
      anonymous: Boolean(anonymous),
      dimension,
      text,
      channel,
      occurred_at: occurred_at ?? this.now(),
    };
    await this.#emit("FEEDBACK_RECEIVED", "resident_feedback", feedback.feedback_id, feedback.occurred_at,
      `收到${feedback.anonymous ? "匿名" : "实名"}居民反馈：${text.slice(0, 30)}`, feedback);
    return this.feedback.get(feedback.feedback_id);
  }

  /**
   * 研判居民反馈：匿名反馈不能单独定性，必须与可核验证据共同研判——
   * 同时段越界采样，或同一时间窗内多人独立反映同一问题。
   */
  async assessFeedback(feedbackId, officerId) {
    const officer = this.#requireOfficer(officerId, "assess_feedback");
    const fb = this.feedback.get(feedbackId);
    if (!fb) throw new DomainError(`反馈不存在：${feedbackId}`, 404);
    if (fb.status !== "received") throw new DomainError("该反馈已研判", 409);
    const condition = this.conditions.get(fb.edition_id);
    const at = Date.parse(fb.occurred_at);
    const nearSamples = this.#editionSamples(fb.edition_id).filter((s) => {
      if (s.baseline) return false;
      if (fb.dimension && s.dimension !== fb.dimension) return false;
      return Math.abs(Date.parse(s.occurred_at) - at) <= FEEDBACK_SAMPLE_WINDOW_MIN * 60_000;
    });
    const breaching = condition ? nearSamples.filter((s) => evaluateSample(condition, s)) : [];
    const peers = [...this.feedback.values()].filter((other) => {
      if (other.feedback_id === fb.feedback_id || other.edition_id !== fb.edition_id) return false;
      if (fb.dimension && other.dimension && other.dimension !== fb.dimension) return false;
      return Math.abs(Date.parse(other.occurred_at) - at) <= FEEDBACK_PEER_WINDOW_MIN * 60_000;
    });
    let status;
    const evidence = { sample_ids: [], feedback_ids: [] };
    if (breaching.length > 0) {
      status = "corroborated";
      evidence.sample_ids = breaching.map((s) => s.sample_id);
    } else if (peers.length >= FEEDBACK_PEER_COUNT) {
      status = "corroborated";
      evidence.feedback_ids = peers.map((p) => p.feedback_id);
    } else {
      status = "evidence_insufficient";
    }
    await this.#emit("FEEDBACK_ASSESSED", "resident_feedback", feedbackId, this.now(),
      status === "corroborated"
        ? `反馈经研判获得证据支持（采样 ${evidence.sample_ids.length} 条、互证反馈 ${evidence.feedback_ids.length} 条）`
        : "反馈证据不足，不能作为定性依据",
      { feedback_id: feedbackId, status, evidence, assessed_by: officer.name });
    return this.feedback.get(feedbackId);
  }

  // ---------- 违规确认、暂停、整改、恢复 ----------

  /** 确认违规：执法确认官依据越界采样或已获证据支持的反馈逐维度确认。 */
  async confirmBreach(editionId, dimension, officerId, { sample_ids = [], feedback_ids = [] } = {}, occurredAt) {
    const officer = this.#requireOfficer(officerId, "confirm_breach");
    const edition = this.#getEdition(editionId);
    if (!DIMENSIONS.includes(dimension)) throw new DomainError(`未知扰动维度：${dimension}`);
    const condition = this.conditions.get(editionId);
    if (!condition) throw new DomainError("该场次尚未签发许可条件", 409);
    const samples = this.#editionSamples(editionId);
    const cited = sample_ids.map((id) => {
      const s = samples.find((x) => x.sample_id === id);
      if (!s) throw new DomainError(`采样不存在：${id}`);
      if (!evaluateSample(condition, s)) throw new DomainError(`采样 ${id} 未越界，不能作为违规依据`);
      return s;
    });
    const citedFeedback = feedback_ids.map((id) => {
      const fb = this.feedback.get(id);
      if (!fb) throw new DomainError(`反馈不存在：${id}`);
      if (fb.status !== "corroborated") throw new DomainError(`反馈 ${id} 未获证据支持，不能作为违规依据`);
      return fb;
    });
    if (cited.length === 0 && citedFeedback.length === 0) {
      throw new DomainError("确认违规必须引用越界采样或已获证据支持的居民反馈");
    }
    const decisionId = this.#id("dec");
    await this.#emit("BREACH_CONFIRMED", "enforcement_decision", decisionId, occurredAt,
      `确认场次「${edition.title}」${DIMENSION_LABELS[dimension]}维度违规（采样 ${cited.length} 条、反馈 ${citedFeedback.length} 条）`,
      {
        decision_id: decisionId,
        kind: "breach",
        edition_id: editionId,
        dimension,
        trigger_sample_ids: cited.map((s) => s.sample_id),
        trigger_feedback_ids: citedFeedback.map((f) => f.feedback_id),
        decided_by: officer.name,
      });
    return this.breaches.get(`${editionId}:${dimension}`);
  }

  /**
   * 下达暂停。范围必须落在已确认违规的场次与维度内；
   * 规则判定局部调整足够时，拒绝整场取消。
   */
  async orderSuspension({ edition_ids, dimensions, scope = "dimensions", decided_by, rectifications = [] }, occurredAt) {
    const officer = this.#requireOfficer(decided_by, "order_suspension");
    if (!Array.isArray(edition_ids) || edition_ids.length === 0) throw new DomainError("暂停必须指明场次");
    if (!Array.isArray(dimensions) || dimensions.length === 0) throw new DomainError("暂停必须指明维度");
    for (const d of dimensions) {
      if (!DIMENSIONS.includes(d)) throw new DomainError(`未知扰动维度：${d}`);
    }
    for (const editionId of edition_ids) {
      this.#getEdition(editionId);
      for (const d of dimensions) {
        if (!this.breaches.has(`${editionId}:${d}`)) {
          throw new DomainError(`场次 ${editionId} 的${DIMENSION_LABELS[d]}维度尚未确认违规，不能纳入暂停`);
        }
      }
      if (scope === "full") {
        const { sufficient_scope } = this.listAlerts(editionId);
        if (sufficient_scope === "dimension") {
          throw new DomainError(
            `场次 ${editionId} 当前仅单一维度越界，局部调整即为充分处置，不能取消整场`, 409);
        }
      }
    }
    const suggested = dimensions.map((d) => ({
      light: "更换合规灯具并复测照度与波长",
      noise: "调整扩音设备并复测时段噪声",
      crowd: "落实限流与分批入场并补充垃圾清运",
    }[d]));
    const actions = [...new Set([...suggested, ...rectifications])].map((action, i) => ({
      action_id: `act-${i + 1}`,
      action,
      status: "pending",
    }));
    const suspensionId = this.#id("sus");
    const triggerSampleIds = edition_ids.flatMap((id) =>
      dimensions.flatMap((d) => this.breaches.get(`${id}:${d}`)?.trigger_sample_ids ?? []));
    await this.#emit("SUSPENSION_ORDERED", "enforcement_decision", suspensionId, occurredAt,
      `暂停 ${edition_ids.length} 个场次的${dimensions.map((d) => DIMENSION_LABELS[d]).join("、")}活动` +
      (scope === "full" ? "（整场）" : "（按维度局部暂停）"),
      {
        suspension_id: suspensionId,
        kind: "suspension",
        edition_ids,
        dimensions,
        scope,
        trigger_sample_ids: triggerSampleIds,
        rectifications: actions,
        decided_by: officer.name,
      });
    return this.suspensions.get(suspensionId);
  }

  /** 登记整改动作完成情况。 */
  async recordRectification(suspensionId, actionId, { operator, note }, occurredAt) {
    const suspension = this.suspensions.get(suspensionId);
    if (!suspension) throw new DomainError(`暂停决定不存在：${suspensionId}`, 404);
    if (suspension.status !== "open") throw new DomainError("该暂停已结案", 409);
    if (!operator) throw new DomainError("必须注明整改执行人");
    const action = suspension.rectifications.find((a) => a.action_id === actionId);
    if (!action) throw new DomainError(`整改动作不存在：${actionId}`, 404);
    await this.#emit("RECTIFICATION_RECORDED", "enforcement_decision", suspensionId, occurredAt,
      `整改动作「${action.action}」由 ${operator} 完成`,
      { suspension_id: suspensionId, action_id: actionId, operator, note: note ?? "", done_at: occurredAt ?? this.now() });
    return this.suspensions.get(suspensionId);
  }

  /**
   * 批准恢复：整改全部完成、逐维度给出重开门槛、主办方与执法确认官共同签署。
   * 恢复公告完整列出触发采样、整改动作、签署人与重新开放门槛。
   */
  async approveResumption(suspensionId, officerId, { organizer_signatory, reopen_thresholds }, occurredAt) {
    const officer = this.#requireOfficer(officerId, "approve_resumption");
    const suspension = this.suspensions.get(suspensionId);
    if (!suspension) throw new DomainError(`暂停决定不存在：${suspensionId}`, 404);
    if (suspension.status !== "open") throw new DomainError("该暂停已结案", 409);
    const pending = suspension.rectifications.filter((a) => a.status !== "done");
    if (pending.length > 0) {
      throw new DomainError(`仍有 ${pending.length} 项整改未完成：${pending.map((a) => a.action).join("；")}`, 409);
    }
    if (!organizer_signatory) throw new DomainError("恢复必须由主办方共同签署");
    for (const d of suspension.dimensions) {
      if (!reopen_thresholds?.[d]) throw new DomainError(`缺少${DIMENSION_LABELS[d]}维度的重新开放门槛`);
    }
    const signatories = [officer.name, organizer_signatory];
    await this.#emit("ACTIVITY_RESUMED", "enforcement_decision", suspensionId, occurredAt,
      `批准恢复 ${suspension.edition_ids.length} 个场次：整改 ${suspension.rectifications.length} 项已完成，签署人 ${signatories.join("、")}`,
      {
        suspension_id: suspensionId,
        kind: "resumption",
        edition_ids: suspension.edition_ids,
        dimensions: suspension.dimensions,
        trigger_sample_ids: suspension.trigger_sample_ids,
        rectifications: suspension.rectifications,
        signatories,
        reopen_thresholds,
        decided_by: officer.name,
      });
    return this.suspensions.get(suspensionId);
  }

  // ---------- 查询视图 ----------

  getApplication(applicationId) {
    const application = this.applications.get(applicationId);
    if (!application) throw new DomainError(`申请不存在：${applicationId}`, 404);
    return {
      ...application,
      editions: application.edition_ids.map((id) => this.editions.get(id)),
      conditions_issued: application.status === "conditions_issued",
    };
  }

  /** 暂停处置进度（公开页数据）。 */
  getSuspensionProgress(suspensionId) {
    const suspension = this.suspensions.get(suspensionId);
    if (!suspension) throw new DomainError(`暂停决定不存在：${suspensionId}`, 404);
    const triggerSamples = suspension.trigger_sample_ids
      .map((id) => [...this.samples.values()].flat().find((s) => s.sample_id === id))
      .filter(Boolean);
    return {
      suspension_id: suspension.suspension_id,
      status: suspension.status,
      scope: suspension.scope,
      editions: suspension.edition_ids.map((id) => {
        const e = this.editions.get(id);
        return { edition_id: id, title: e?.title, zone: this.zones.get(e?.zone_id)?.name };
      }),
      dimensions: suspension.dimensions.map((d) => ({ dimension: d, label: DIMENSION_LABELS[d] })),
      decided_by: suspension.decided_by,
      ordered_at: suspension.ordered_at,
      trigger_samples: triggerSamples.map((s) => ({
        sample_id: s.sample_id, dimension: s.dimension, metric: s.metric,
        value: s.value, unit: s.unit, occurred_at: s.occurred_at,
      })),
      rectifications: suspension.rectifications,
      resumption: suspension.resumption ?? null,
    };
  }

  /** 恢复公告（公开）：触发采样、整改动作、签署人、重新开放门槛完整列出。 */
  getResumptionNotice(suspensionId) {
    const progress = this.getSuspensionProgress(suspensionId);
    if (progress.status !== "resumed") throw new DomainError("该暂停尚未恢复，暂无恢复公告", 409);
    return progress;
  }

  /** 申请相关全部事件，按发生时间组织。 */
  timelineFor(applicationId) {
    const application = this.applications.get(applicationId);
    if (!application) throw new DomainError(`申请不存在：${applicationId}`, 404);
    const ids = new Set([applicationId]);
    for (const editionId of application.edition_ids) {
      ids.add(`condition:${editionId}`);
      ids.add(`samples:${editionId}`);
    }
    for (const fb of this.feedback.values()) {
      if (application.edition_ids.includes(fb.edition_id)) ids.add(fb.feedback_id);
    }
    for (const suspension of this.suspensions.values()) {
      if (suspension.edition_ids.some((id) => application.edition_ids.includes(id))) ids.add(suspension.suspension_id);
    }
    for (const [key, breach] of this.breaches) {
      if (application.edition_ids.includes(breach.edition_id)) ids.add(breach.decision_id);
    }
    return this.store.events
      .filter((e) => ids.has(e.aggregate_id))
      .slice()
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }

  // ---------- 事件回放 ----------

  #apply(event) {
    const d = event.data ?? {};
    switch (event.event_type) {
      case "APPLICATION_SUBMITTED":
        this.applications.set(d.application_id, {
          application_id: d.application_id,
          applicant: d.applicant,
          title: d.title,
          activity_kind: d.activity_kind,
          status: "submitted",
          edition_ids: [],
          submitted_at: event.occurred_at,
        });
        break;
      case "EDITION_REGISTERED": {
        this.editions.set(d.edition_id, { ...d, status: "registered" });
        this.applications.get(d.application_id)?.edition_ids.push(d.edition_id);
        break;
      }
      case "CONDITION_ISSUED":
        if (event.aggregate_type === "operating_condition") {
          this.conditions.set(d.edition_id, d);
          const edition = this.editions.get(d.edition_id);
          if (edition) edition.status = "conditions_issued";
        } else {
          const application = this.applications.get(d.application_id);
          if (application) {
            application.status = "conditions_issued";
            application.ticket_sale_open_at = d.ticket_sale_open_at;
          }
        }
        break;
      case "SAMPLE_RECORDED": {
        if (!this.samples.has(d.edition_id)) this.samples.set(d.edition_id, []);
        this.samples.get(d.edition_id).push(d);
        break;
      }
      case "FEEDBACK_RECEIVED":
        this.feedback.set(d.feedback_id, { ...d, status: "received", evidence: { sample_ids: [], feedback_ids: [] } });
        break;
      case "FEEDBACK_ASSESSED": {
        const fb = this.feedback.get(d.feedback_id);
        if (fb) Object.assign(fb, { status: d.status, evidence: d.evidence, assessed_by: d.assessed_by });
        break;
      }
      case "BREACH_CONFIRMED":
        this.breaches.set(`${d.edition_id}:${d.dimension}`, { ...d, occurred_at: event.occurred_at });
        break;
      case "SUSPENSION_ORDERED":
        this.suspensions.set(d.suspension_id, {
          ...d,
          status: "open",
          ordered_at: event.occurred_at,
          rectifications: d.rectifications.map((a) => ({ ...a })),
        });
        break;
      case "RECTIFICATION_RECORDED": {
        const suspension = this.suspensions.get(d.suspension_id);
        const action = suspension?.rectifications.find((a) => a.action_id === d.action_id);
        if (action) Object.assign(action, { status: "done", done_at: d.done_at, operator: d.operator, note: d.note });
        break;
      }
      case "ACTIVITY_RESUMED": {
        const suspension = this.suspensions.get(d.suspension_id);
        if (suspension) {
          suspension.status = "resumed";
          suspension.resumption = {
            trigger_sample_ids: d.trigger_sample_ids,
            rectifications: d.rectifications,
            signatories: d.signatories,
            reopen_thresholds: d.reopen_thresholds,
            resumed_at: event.occurred_at,
          };
        }
        break;
      }
      default:
        break;
    }
  }
}
