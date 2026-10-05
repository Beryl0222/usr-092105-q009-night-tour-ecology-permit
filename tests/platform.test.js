import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import test from "node:test";

import { loadCatalog } from "../src/catalog.js";
import { EventStore } from "../src/eventStore.js";
import { DomainError, NightTourService, PermissionError, ROLES } from "../src/service.js";

const catalog = await loadCatalog(new URL("../data/sites.json", import.meta.url));

const issuer = { actor_id: "off-01", name: "林岚", roles: [ROLES.PERMIT_ISSUER] };
const confirmer = { actor_id: "off-02", name: "赵谨", roles: [ROLES.BREACH_CONFIRMER] };
const approver = { actor_id: "off-03", name: "孙衡", roles: [ROLES.RESUMPTION_APPROVER] };
const organizer = { actor_id: "org-01", name: "山谷文旅" };
const resident = { actor_id: "res-01", name: "居民甲" };

const LIMITS = {
  light: { max_lux: 5, spectrum_min_nm: 590, curfew: "21:30" },
  noise: { max_db: 55, amplified_end: "21:00" },
  crowd: { max_attendance: 300 },
};

function applicationPayload(overrides = {}) {
  return {
    applicant: { name: "山谷文旅", contact: "138-0000-0000" },
    site_id: "site-firefly-valley",
    activity_type: "萤火虫观察",
    editions: [
      { edition_id: "E1", date: "2026-07-10", start: "19:30", end: "22:00", expected_attendance: 260 },
      { edition_id: "E2", date: "2026-07-11", start: "19:30", end: "22:00", expected_attendance: 260 },
    ],
    equipment: { lighting: [{ kind: "LED 投光灯", spectrum_nm: 620, count: 4 }], sound: [] },
    traffic_plan: "预约制接驳车",
    waste_plan: { bins: 12, capacity_l: 2400, hauler: "绿洁清运" },
    ...overrides,
  };
}

/** 搭好一个已签发许可与场次条件的申请，时钟可推进。 */
async function setup() {
  let clock = new Date("2026-06-20T10:00:00+08:00");
  const store = EventStore.memory();
  const service = new NightTourService(store, catalog, { now: () => clock });
  const { application_id: appId, hints } = await service.submitApplication(applicationPayload(), organizer);
  await service.issuePermit(appId, issuer, {});
  await service.issueConditions(appId, "E1", issuer, LIMITS);
  await service.issueConditions(appId, "E2", issuer, LIMITS);
  return {
    service,
    store,
    appId,
    hints,
    setClock: (iso) => {
      clock = new Date(iso);
    },
  };
}

async function noiseSample(service, appId, value, occurredAt, extra = {}) {
  return service.recordSample({
    application_id: appId, edition_id: "E1", dimension: "noise", phase: "realtime",
    device_id: "noise-01", unit: "dB", value, occurred_at: occurredAt, ...extra,
  });
}

test("提交申请：结构化校验与规则提示", async () => {
  const { service } = await setup();
  await assert.rejects(
    () => service.submitApplication(applicationPayload({ activity_type: "" }), organizer),
    /活动类型/,
  );
  await assert.rejects(
    () => service.submitApplication(applicationPayload({ waste_plan: {} }), organizer),
    /垃圾方案/,
  );
  const { hints } = await service.submitApplication(applicationPayload(), organizer);
  assert.ok(hints.some((h) => h.kind === "species_window" && h.message.includes("萤火虫")));
  assert.equal(hints.find((h) => h.kind === "species_window").suggested_limits.light.spectrum_min_nm, 590);
});

test("人群容量与垃圾容量提示", async () => {
  let clock = new Date("2026-06-20T10:00:00+08:00");
  const service = new NightTourService(EventStore.memory(), catalog, { now: () => clock });
  const { hints } = await service.submitApplication(
    applicationPayload({
      editions: [{ edition_id: "E1", date: "2026-07-10", start: "19:30", end: "22:00", expected_attendance: 800 }],
      waste_plan: { bins: 2, capacity_l: 100, hauler: "绿洁清运" },
    }),
    organizer,
  );
  assert.ok(hints.some((h) => h.kind === "capacity"));
  assert.ok(hints.some((h) => h.kind === "waste"));
});

test("无权人员不能签发许可、确认违规、批准恢复", async () => {
  const { service, appId } = await setup();
  await assert.rejects(() => service.issuePermit(appId, organizer, {}), PermissionError);
  await assert.rejects(() => service.confirmBreach("case#x#E1#noise", organizer, {}), PermissionError);
  await assert.rejects(() => service.resumeCase("case#x#E1#noise", confirmer, {}), PermissionError);
});

test("售票前拿到可执行场次条件，而非笼统原则同意", async () => {
  let clock = new Date("2026-06-20T10:00:00+08:00");
  const service = new NightTourService(EventStore.memory(), catalog, { now: () => clock });
  const { application_id: appId } = await service.submitApplication(applicationPayload(), organizer);

  let clearance = service.getTicketClearance(appId);
  assert.ok(clearance.editions.every((e) => e.sale_status === "blocked"));

  await service.issuePermit(appId, issuer, {});
  clearance = service.getTicketClearance(appId);
  assert.ok(clearance.editions.every((e) => e.sale_status === "blocked" && e.notes.some((n) => n.includes("场次条件"))));

  await service.issueConditions(appId, "E1", issuer, LIMITS);
  await service.issueConditions(appId, "E2", issuer, LIMITS);
  clearance = service.getTicketClearance(appId);
  assert.ok(clearance.editions.every((e) => e.sale_status === "cleared"));
  assert.equal(clearance.editions[0].conditions.noise.amplified_end, "21:00");
  assert.equal(clearance.editions[0].conditions.light.spectrum_min_nm, 590);
});

test("实时采样越界产生规则提示但不自动处置；基线采样不提示", async () => {
  const { service, appId, setClock } = await setup();
  setClock("2026-07-10T18:05:00+08:00");
  const baseline = await service.recordSample({
    application_id: appId, edition_id: "E1", dimension: "noise", phase: "baseline",
    device_id: "noise-01", unit: "dB", value: 70, occurred_at: "2026-07-10T18:00:00+08:00",
  });
  assert.equal(baseline.flags.length, 0);

  setClock("2026-07-10T21:21:00+08:00");
  const { flags } = await noiseSample(service, appId, 68, "2026-07-10T21:20:00+08:00", { source: "amplified" });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].event_type, "RULE_VIOLATION_FLAGGED");
  assert.equal(flags[0].actor.kind, "system");
  const caseView = service.getCase(flags[0].aggregate_id);
  assert.equal(caseView.status, "flagged");
});

test("匿名投诉须与可核验证据共同研判", async () => {
  const { service, appId, setClock } = await setup();
  setClock("2026-07-10T21:21:00+08:00");
  const { flags } = await noiseSample(service, appId, 68, "2026-07-10T21:20:00+08:00", { source: "amplified" });
  const caseId = flags[0].aggregate_id;
  const { feedback_id } = await service.fileFeedback(appId, resident, {
    edition_id: "E1", anonymous: true, content: "太吵了",
  });

  await assert.rejects(() => service.confirmBreach(caseId, confirmer, { feedback_ids: [feedback_id] }), /匿名投诉/);
  await assert.rejects(() => service.confirmBreach(caseId, confirmer, {}), /可核验证据/);

  await service.confirmBreach(caseId, confirmer, {
    sample_event_ids: [flags[0].payload.sample_event_id],
    feedback_ids: [feedback_id],
  });
  assert.equal(service.getCase(caseId).status, "confirmed");
});

test("局部暂停为默认；扩大范围须说明理由", async () => {
  const { service, appId, setClock } = await setup();
  setClock("2026-07-10T21:21:00+08:00");
  const { flags } = await noiseSample(service, appId, 68, "2026-07-10T21:20:00+08:00", { source: "amplified" });
  const caseId = flags[0].aggregate_id;
  await service.confirmBreach(caseId, confirmer, { sample_event_ids: [flags[0].payload.sample_event_id] });

  await assert.rejects(() => service.suspendCase(caseId, confirmer, { scope: "application", reason: "噪声超限" }), /局部调整/);

  await service.suspendCase(caseId, confirmer, { reason: "扩音超时且声级超限" });
  const clearance = service.getTicketClearance(appId);
  const e1 = clearance.editions.find((e) => e.edition_id === "E1");
  const e2 = clearance.editions.find((e) => e.edition_id === "E2");
  assert.equal(e1.sale_status, "restricted");
  assert.deepEqual(e1.suspended_dimensions, ["noise"]);
  assert.equal(e2.sale_status, "cleared");
});

test("恢复须整改、门槛与签署人齐全，并在公开页完整披露", async () => {
  const { service, appId, setClock } = await setup();
  setClock("2026-07-10T21:21:00+08:00");
  const { flags } = await noiseSample(service, appId, 68, "2026-07-10T21:20:00+08:00", { source: "amplified" });
  const caseId = flags[0].aggregate_id;
  await service.confirmBreach(caseId, confirmer, { sample_event_ids: [flags[0].payload.sample_event_id] });
  await service.suspendCase(caseId, confirmer, { reason: "扩音超时" });

  await assert.rejects(() => service.resumeCase(caseId, approver, {}), /整改/);
  await service.recordRectification(caseId, organizer, { description: "拆除临时音箱，扩音提前结束" });
  await assert.rejects(() => service.resumeCase(caseId, approver, { signatories: [] }), /门槛/);
  await assert.rejects(
    () =>
      service.resumeCase(caseId, approver, {
        reopening_thresholds: { noise: { max_db: 55 } },
        signatories: [{ name: "孙衡", capacity: "approver" }],
      }),
    /主办方/,
  );

  await service.resumeCase(caseId, approver, {
    signatories: [
      { name: "孙衡", capacity: "approver" },
      { name: "山谷文旅现场负责人", capacity: "organizer" },
    ],
    reopening_thresholds: { noise: { max_db: 55, amplified_end: "21:00" } },
  });
  assert.equal(service.getCase(caseId).status, "resumed");

  const page = service.getPublicSuspensionPage(appId);
  assert.equal(page.cases.length, 1);
  const disclosure = page.cases[0].disclosure;
  assert.equal(disclosure.trigger_samples.length, 1);
  assert.equal(disclosure.trigger_samples[0].value, 68);
  assert.equal(disclosure.rectification_actions.length, 1);
  assert.deepEqual(disclosure.signatories.map((s) => s.capacity).sort(), ["approver", "organizer"]);
  assert.equal(disclosure.reopening_thresholds.noise.max_db, 55);
  assert.deepEqual(
    page.cases[0].progress.map((p) => p.step),
    ["规则提示越界", "确认违规", "暂停处置", "整改记录", "批准恢复"],
  );
});

test("设备离线补报：须注明原因，按发生时间落入时间线", async () => {
  const { service, appId, setClock } = await setup();
  setClock("2026-07-10T21:21:00+08:00");
  await noiseSample(service, appId, 50, "2026-07-10T21:20:00+08:00");

  setClock("2026-07-10T23:00:00+08:00");
  await assert.rejects(
    () => noiseSample(service, appId, 53, "2026-07-10T20:10:00+08:00"),
    /backfill_reason/,
  );
  const { sample } = await noiseSample(service, appId, 53, "2026-07-10T20:10:00+08:00", {
    backfill_reason: "noise-01 于 20:05-21:25 离线",
  });
  assert.equal(sample.payload.backfilled, true);

  const times = service.getTimeline(appId).filter((t) => t.event_type === "SAMPLE_RECORDED").map((t) => t.occurred_at);
  assert.deepEqual(times, [...times].sort());
  const backfilledEntry = service.getTimeline(appId).find((t) => t.backfilled);
  assert.equal(backfilledEntry.occurred_at, "2026-07-10T20:10:00+08:00");
});

test("事件存储：重试幂等、版本连续、JSONL 回放", async () => {
  const store = EventStore.memory();
  const event = {
    event_id: "evt-retry-0001", event_type: "APPLICATION_SUBMITTED", aggregate_type: "permit_application",
    aggregate_id: "app-x", occurred_at: "2026-09-20T12:00:00+08:00", version: 1, summary: "提交申请",
  };
  const first = await store.append(event);
  const retry = await store.append(event);
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(store.all().length, 1);

  await assert.rejects(() => store.append({ ...event, event_id: "evt-retry-0002", version: 3 }), /版本不连续/);

  const path = new URL("./tmp-events.jsonl", import.meta.url).pathname;
  await unlink(path).catch(() => {});
  const fileStore = await EventStore.open(path);
  await fileStore.append(event);
  const reopened = await EventStore.open(path);
  assert.equal(reopened.all().length, 1);
  assert.equal(reopened.lastVersion("permit_application", "app-x"), 1);
  await unlink(path).catch(() => {});
});

test("局部调整条件只动需要动的维度", async () => {
  const { service, appId } = await setup();
  await service.adjustConditions(appId, "E1", issuer, { noise: { max_db: 50 } }, "毗邻居民反映敏感，仅收紧噪声");
  const clearance = service.getTicketClearance(appId);
  const e1 = clearance.editions.find((e) => e.edition_id === "E1");
  assert.equal(e1.conditions.noise.max_db, 50);
  assert.equal(e1.conditions.noise.amplified_end, "21:00");
  assert.equal(e1.conditions.light.max_lux, 5);
  await assert.rejects(() => service.adjustConditions(appId, "E1", issuer, { noise: { max_db: 50 } }, ""), /理由/);
});

test("时间线按发生时间组织同一申请的全部事实", async () => {
  const { service, appId, setClock } = await setup();
  setClock("2026-07-10T21:21:00+08:00");
  await noiseSample(service, appId, 68, "2026-07-10T21:20:00+08:00", { source: "amplified" });
  const timeline = service.getTimeline(appId);
  const types = timeline.map((t) => t.event_type);
  assert.ok(types.includes("APPLICATION_SUBMITTED"));
  assert.ok(types.includes("PERMIT_ISSUED"));
  assert.ok(types.includes("CONDITION_ISSUED"));
  assert.ok(types.includes("SAMPLE_RECORDED"));
  assert.ok(types.includes("RULE_VIOLATION_FLAGGED"));
  const occurred = timeline.map((t) => t.occurred_at);
  assert.deepEqual(occurred, [...occurred].sort());
});

test("未确认的仅提示案件不登上公开暂停页", async () => {
  const { service, appId, setClock } = await setup();
  setClock("2026-07-10T21:21:00+08:00");
  await noiseSample(service, appId, 68, "2026-07-10T21:20:00+08:00", { source: "amplified" });
  const page = service.getPublicSuspensionPage(appId);
  assert.equal(page.cases.length, 0);
});
