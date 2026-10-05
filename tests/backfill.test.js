import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { NightTourService } from "../src/service.js";
import { validateEvent } from "../src/validator.js";
import { DEMO_APPLICATION, OFFICERS, SPECIES_WINDOWS, ZONES } from "../src/seed.js";

async function makeService(now = "2026-07-12T09:00:00+08:00") {
  const service = new NightTourService(new EventStore(), {
    zones: ZONES,
    speciesWindows: SPECIES_WINDOWS,
    officers: OFFICERS,
    now: () => now,
  });
  const application = await service.submitApplication(DEMO_APPLICATION, "2026-06-01T10:00:00+08:00");
  const show = application.editions.find((e) => e.title === "古城沉浸式演出");
  await service.issueConditions(application.application_id, "officer-permit-01", {
    conditions: application.editions.map((e) => ({
      edition_id: e.edition_id,
      light: { min_wavelength_nm: 590, max_lux: 15, blackout_after: "23:00" },
      noise: { max_db: 60, amplification_end: "22:30" },
      crowd: { max_attendance: e.expected_attendance, max_waste_bins: 24 },
    })),
    ticket_sale_open_at: "2026-06-20T09:00:00+08:00",
  }, "2026-06-10T15:00:00+08:00");
  return { service, show };
}

const OFFLINE_SAMPLES = [
  { sample_id: "smp-off-001", dimension: "noise", metric: "db", value: 58, unit: "dB", occurred_at: "2026-07-11T21:00:00+08:00" },
  { sample_id: "smp-off-002", dimension: "noise", metric: "db", value: 63, unit: "dB", occurred_at: "2026-07-11T21:05:00+08:00" },
];

test("离线补报：按 monitoring_sample 契约落库，occurred_at 保留真实发生时间", async () => {
  const { service, show } = await makeService();
  const { recorded, skipped } = await service.backfillSamples(show.edition_id, {
    device_id: "mic-07",
    offline_reason: "4G 链路中断 40 分钟",
    samples: OFFLINE_SAMPLES,
  });
  assert.equal(recorded.length, 2);
  assert.equal(skipped.length, 0);
  assert.ok(recorded.every((s) => s.backfill && s.offline_reason === "4G 链路中断 40 分钟"));
  assert.equal(recorded[0].occurred_at, "2026-07-11T21:00:00+08:00");

  const events = service.store.timeline({ aggregate_id: `samples:${show.edition_id}` });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.version), [1, 2]);
  for (const event of events) {
    assert.equal(event.event_type, "SAMPLE_RECORDED");
    assert.equal(event.aggregate_type, "monitoring_sample");
    assert.deepEqual(validateEvent(event), []);
  }
});

test("离线补报：重复 sample_id 幂等跳过，未来时间拒绝", async () => {
  const { service, show } = await makeService();
  await service.backfillSamples(show.edition_id, {
    device_id: "mic-07", offline_reason: "断电", samples: OFFLINE_SAMPLES,
  });
  const again = await service.backfillSamples(show.edition_id, {
    device_id: "mic-07", offline_reason: "断电", samples: OFFLINE_SAMPLES,
  });
  assert.equal(again.recorded.length, 0);
  assert.equal(again.skipped.length, 2);

  await assert.rejects(
    () => service.backfillSamples(show.edition_id, {
      device_id: "mic-07", offline_reason: "断电",
      samples: [{ sample_id: "smp-future", dimension: "noise", metric: "db", value: 50, unit: "dB", occurred_at: "2026-07-13T00:00:00+08:00" }],
    }),
    /晚于当前时间/);
});

test("离线补报：缺离线原因或设备编号拒绝", async () => {
  const { service, show } = await makeService();
  await assert.rejects(
    () => service.backfillSamples(show.edition_id, { device_id: "mic-07", samples: OFFLINE_SAMPLES }),
    /离线原因/);
  await assert.rejects(
    () => service.backfillSamples(show.edition_id, { offline_reason: "断电", samples: OFFLINE_SAMPLES }),
    /设备编号/);
});

test("补报的越界采样同样进入规则判定与违规确认", async () => {
  const { service, show } = await makeService();
  await service.backfillSamples(show.edition_id, {
    device_id: "mic-07", offline_reason: "断电",
    samples: [{ sample_id: "smp-off-009", dimension: "noise", metric: "amplified_db", value: 61, unit: "dB", occurred_at: "2026-07-11T22:50:00+08:00" }],
  });
  const { alerts } = service.listAlerts(show.edition_id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].dimension, "noise");
  const breach = await service.confirmBreach(show.edition_id, "noise", "officer-enforce-01", {
    sample_ids: ["smp-off-009"],
  });
  assert.deepEqual(breach.trigger_sample_ids, ["smp-off-009"]);
});
