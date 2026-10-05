import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { NightTourService } from "../src/service.js";
import { DEMO_APPLICATION, OFFICERS, SPECIES_WINDOWS, ZONES } from "../src/seed.js";

const PERMIT = "officer-permit-01";
const ENFORCE = "officer-enforce-01";

async function makeService(now = "2026-07-11T23:30:00+08:00") {
  const store = new EventStore();
  const service = new NightTourService(store, {
    zones: ZONES,
    speciesWindows: SPECIES_WINDOWS,
    officers: OFFICERS,
    now: () => now,
  });
  const application = await service.submitApplication(DEMO_APPLICATION, "2026-06-01T10:00:00+08:00");
  return { service, store, application };
}

async function issueAllConditions(service, application) {
  const conditions = application.editions.map((e) => ({
    edition_id: e.edition_id,
    light: { min_wavelength_nm: 590, max_lux: 15, blackout_after: "23:00" },
    noise: { max_db: 60, amplification_end: "22:30" },
    crowd: { max_attendance: e.expected_attendance, max_waste_bins: 24 },
  }));
  return service.issueConditions(application.application_id, PERMIT, {
    conditions,
    ticket_sale_open_at: "2026-06-20T09:00:00+08:00",
  }, "2026-06-10T15:00:00+08:00");
}

test("申请登记：场次携带敏感区、人数、设备、交通垃圾方案与物种窗口提示", async () => {
  const { application } = await makeService();
  assert.equal(application.editions.length, 3);
  const firefly = application.editions.find((e) => e.title === "萤火虫河岸观察");
  assert.equal(firefly.species_notices.length, 1);
  assert.match(firefly.species_notices[0].message, /萤火虫季节窗口/);
  assert.match(firefly.species_notices[0].message, /590nm/);
});

test("签发前主办方拿不到可执行条件，不存在笼统“原则同意”", async () => {
  const { service, application } = await makeService();
  assert.throws(
    () => service.getTicketConditions(application.application_id),
    /尚未签发/);
});

test("签发条件：无权人员被拒，许可官签发后给出逐场次可执行条件", async () => {
  const { service, application } = await makeService();
  const conditions = application.editions.map((e) => ({
    edition_id: e.edition_id,
    light: { min_wavelength_nm: 590, max_lux: 15, blackout_after: "23:00" },
    noise: { max_db: 60, amplification_end: "22:30" },
    crowd: { max_attendance: e.expected_attendance, max_waste_bins: 24 },
  }));
  await assert.rejects(
    () => service.issueConditions(application.application_id, "nobody", {
      conditions, ticket_sale_open_at: "2026-06-20T09:00:00+08:00",
    }),
    /无权/);
  const ticket = await issueAllConditions(service, application);
  assert.equal(ticket.editions.length, 3);
  assert.equal(ticket.ticket_sale_open_at, "2026-06-20T09:00:00+08:00");
  assert.equal(ticket.editions[0].condition.noise.amplification_end, "22:30");
});

test("物种窗口约束：萤火虫区灯光波长下限不得低于 590nm", async () => {
  const { service, application } = await makeService();
  const firefly = application.editions.find((e) => e.title === "萤火虫河岸观察");
  const conditions = application.editions.map((e) => ({
    edition_id: e.edition_id,
    light: { min_wavelength_nm: e.edition_id === firefly.edition_id ? 550 : 590, max_lux: 15, blackout_after: "23:00" },
    noise: { max_db: 60, amplification_end: "22:30" },
    crowd: { max_attendance: e.expected_attendance, max_waste_bins: 24 },
  }));
  await assert.rejects(
    () => service.issueConditions(application.application_id, PERMIT, {
      conditions, ticket_sale_open_at: "2026-06-20T09:00:00+08:00",
    }),
    /季节窗口要求 590nm/);
});

test("采样越界即时提示，基线采样不参与判定", async () => {
  const { service, application } = await makeService();
  await issueAllConditions(service, application);
  const show = application.editions.find((e) => e.title === "古城沉浸式演出");
  const base = await service.recordSample(show.edition_id, {
    dimension: "noise", metric: "db", value: 80, unit: "dB",
    device_id: "mic-01", occurred_at: "2026-07-11T18:00:00+08:00", baseline: true,
  });
  assert.equal(base.breach, null);
  const over = await service.recordSample(show.edition_id, {
    dimension: "noise", metric: "amplified_db", value: 62, unit: "dB",
    device_id: "mic-01", occurred_at: "2026-07-11T22:45:00+08:00",
  });
  assert.equal(over.breach.dimension, "noise");
  assert.match(over.breach.message, /扩音停止时限/);
});

test("匿名投诉：无证据时不能作为定性依据，有同时段越界采样时可研判", async () => {
  const { service, application } = await makeService();
  await issueAllConditions(service, application);
  const show = application.editions.find((e) => e.title === "古城沉浸式演出");

  const lonely = await service.receiveFeedback(show.edition_id, {
    anonymous: true, dimension: "noise", text: "太吵了", occurred_at: "2026-07-11T21:00:00+08:00",
  });
  const assessed1 = await service.assessFeedback(lonely.feedback_id, ENFORCE);
  assert.equal(assessed1.status, "evidence_insufficient");

  await service.recordSample(show.edition_id, {
    dimension: "noise", metric: "db", value: 68, unit: "dB",
    device_id: "mic-01", occurred_at: "2026-07-11T22:05:00+08:00",
  });
  const backed = await service.receiveFeedback(show.edition_id, {
    anonymous: true, dimension: "noise", text: "演出音响震得窗户响", occurred_at: "2026-07-11T22:10:00+08:00",
  });
  const assessed2 = await service.assessFeedback(backed.feedback_id, ENFORCE);
  assert.equal(assessed2.status, "corroborated");
  assert.equal(assessed2.evidence.sample_ids.length, 1);

  await assert.rejects(
    () => service.confirmBreach(show.edition_id, "noise", ENFORCE, { feedback_ids: [lonely.feedback_id] }),
    /未获证据支持/);
});

test("确认违规与暂停：局部足够时拒绝整场取消，整改完成前不得恢复", async () => {
  const { service, application } = await makeService();
  await issueAllConditions(service, application);
  const show = application.editions.find((e) => e.title === "古城沉浸式演出");
  const { sample } = await service.recordSample(show.edition_id, {
    dimension: "noise", metric: "amplified_db", value: 66, unit: "dB",
    device_id: "mic-01", occurred_at: "2026-07-11T22:40:00+08:00",
  });

  await assert.rejects(
    () => service.confirmBreach(show.edition_id, "noise", PERMIT, { sample_ids: [sample.sample_id] }),
    /无权/);
  const breach = await service.confirmBreach(show.edition_id, "noise", ENFORCE, { sample_ids: [sample.sample_id] });
  assert.deepEqual(breach.trigger_sample_ids, [sample.sample_id]);

  await assert.rejects(
    () => service.orderSuspension({
      edition_ids: [show.edition_id], dimensions: ["noise"], scope: "full", decided_by: ENFORCE,
    }),
    /局部调整即为充分处置/);

  const suspension = await service.orderSuspension({
    edition_ids: [show.edition_id], dimensions: ["noise"], decided_by: ENFORCE,
  });
  assert.equal(suspension.status, "open");
  assert.ok(suspension.rectifications.length >= 1);

  await assert.rejects(
    () => service.approveResumption(suspension.suspension_id, ENFORCE, {
      organizer_signatory: "王主办",
      reopen_thresholds: { noise: "22:30 后扩音≤45dB" },
    }),
    /整改未完成/);

  for (const action of suspension.rectifications) {
    await service.recordRectification(suspension.suspension_id, action.action_id, {
      operator: "李运维", note: "已调整线阵角度并复测",
    }, "2026-07-12T10:00:00+08:00");
  }
  const resumed = await service.approveResumption(suspension.suspension_id, ENFORCE, {
    organizer_signatory: "王主办",
    reopen_thresholds: { noise: "22:30 后扩音≤45dB，连续两晚复测合格" },
  }, "2026-07-12T12:00:00+08:00");
  assert.equal(resumed.status, "resumed");

  const notice = service.getResumptionNotice(suspension.suspension_id);
  assert.deepEqual(notice.resumption.trigger_sample_ids, [sample.sample_id]);
  assert.deepEqual(notice.resumption.signatories, ["赵执法", "王主办"]);
  assert.equal(notice.resumption.reopen_thresholds.noise, "22:30 后扩音≤45dB，连续两晚复测合格");
  assert.ok(notice.resumption.rectifications.every((a) => a.status === "done"));
});

test("未确认违规的维度不能纳入暂停", async () => {
  const { service, application } = await makeService();
  await issueAllConditions(service, application);
  const show = application.editions.find((e) => e.title === "古城沉浸式演出");
  await assert.rejects(
    () => service.orderSuspension({ edition_ids: [show.edition_id], dimensions: ["light"], decided_by: ENFORCE }),
    /尚未确认违规/);
});

test("事件按发生时间组织，version 按聚合递增", async () => {
  const { service, store, application } = await makeService();
  await issueAllConditions(service, application);
  const timeline = service.timelineFor(application.application_id);
  const occurred = timeline.map((e) => e.occurred_at);
  assert.deepEqual(occurred, [...occurred].sort());
  const appEvents = timeline.filter((e) => e.aggregate_id === application.application_id);
  assert.deepEqual(appEvents.map((e) => e.version), appEvents.map((_, i) => i + 1));
  assert.ok(store.events.every((e) => e.event_id.length >= 8));
});
