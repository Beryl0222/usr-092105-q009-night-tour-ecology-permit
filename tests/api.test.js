import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { NightTourService } from "../src/service.js";
import { createApp } from "../src/server.js";
import { DEMO_APPLICATION, OFFICERS, SPECIES_WINDOWS, ZONES } from "../src/seed.js";

async function makeServer() {
  const service = new NightTourService(new EventStore(), {
    zones: ZONES,
    speciesWindows: SPECIES_WINDOWS,
    officers: OFFICERS,
    now: () => "2026-07-12T09:00:00+08:00",
  });
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { service, server, base };
}

async function post(base, path, body, officerId) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(officerId ? { "x-officer-id": officerId } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("API：申请→签发→采样→暂停→整改→恢复全流程与公开页", async (t) => {
  const { service, server, base } = await makeServer();
  t.after(() => server.close());

  const submitted = await post(base, "/applications", DEMO_APPLICATION);
  assert.equal(submitted.status, 200);
  const appId = submitted.body.application_id;
  const editions = submitted.body.editions;
  const show = editions.find((e) => e.title === "古城沉浸式演出");

  // 无权人员不能签发
  const denied = await post(base, `/applications/${appId}/conditions`, {
    conditions: [], ticket_sale_open_at: "2026-06-20T09:00:00+08:00",
  }, "officer-enforce-01");
  assert.equal(denied.status, 403);

  const issued = await post(base, `/applications/${appId}/conditions`, {
    conditions: editions.map((e) => ({
      edition_id: e.edition_id,
      light: { min_wavelength_nm: 590, max_lux: 15, blackout_after: "23:00" },
      noise: { max_db: 60, amplification_end: "22:30" },
      crowd: { max_attendance: e.expected_attendance, max_waste_bins: 24 },
    })),
    ticket_sale_open_at: "2026-06-20T09:00:00+08:00",
  }, "officer-permit-01");
  assert.equal(issued.status, 200);
  assert.equal(issued.body.editions.length, 3);

  // 售票前的可执行场次条件
  const ticket = await fetch(`${base}/applications/${appId}/ticket-conditions`).then((r) => r.json());
  assert.equal(ticket.editions.length, 3);

  // 越界采样 → 提示
  const smp = await post(base, `/editions/${show.edition_id}/samples`, {
    dimension: "noise", metric: "amplified_db", value: 64, unit: "dB",
    device_id: "mic-01", occurred_at: "2026-07-11T22:40:00+08:00",
  });
  assert.equal(smp.body.breach.dimension, "noise");
  const alerts = await fetch(`${base}/editions/${show.edition_id}/alerts`).then((r) => r.json());
  assert.equal(alerts.sufficient_scope, "dimension");

  // 确认违规 → 局部暂停
  await post(base, `/editions/${show.edition_id}/breaches`, {
    dimension: "noise", sample_ids: [smp.body.sample.sample_id],
  }, "officer-enforce-01");
  const suspension = await post(base, "/suspensions", {
    edition_ids: [show.edition_id], dimensions: ["noise"], decided_by: "officer-enforce-01",
  });
  assert.equal(suspension.status, 200);
  const susId = suspension.body.suspension_id;

  // 公开进度页：处置中，含触发采样与整改动作
  const progressPage = await fetch(`${base}/public/suspensions/${susId}`).then((r) => r.text());
  assert.match(progressPage, /处置中/);
  assert.match(progressPage, /触发采样/);
  assert.match(progressPage, /整改动作/);
  assert.match(progressPage, /进行中/);

  // 整改 → 恢复
  for (const action of suspension.body.rectifications) {
    await post(base, `/suspensions/${susId}/rectifications/${action.action_id}`, {
      operator: "李运维", note: "已复测",
    });
  }
  const resumed = await post(base, `/suspensions/${susId}/resume`, {
    organizer_signatory: "王主办",
    reopen_thresholds: { noise: "22:30 后扩音≤45dB" },
  }, "officer-enforce-01");
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, "resumed");

  // 恢复公告：触发采样、整改动作、签署人、重开门槛完整公开
  const notice = await fetch(`${base}/public/suspensions/${susId}.json`).then((r) => r.json());
  assert.deepEqual(notice.resumption.signatories, ["赵执法", "王主办"]);
  assert.deepEqual(notice.resumption.trigger_sample_ids, [smp.body.sample.sample_id]);
  assert.equal(notice.resumption.reopen_thresholds.noise, "22:30 后扩音≤45dB");
  const resumedPage = await fetch(`${base}/public/suspensions/${susId}`).then((r) => r.text());
  assert.match(resumedPage, /已恢复/);
  assert.match(resumedPage, /重新开放门槛/);
  assert.match(resumedPage, /赵执法/);

  // 时间线按发生时间组织
  const timeline = await fetch(`${base}/applications/${appId}/timeline`).then((r) => r.json());
  const occurred = timeline.events.map((e) => e.occurred_at);
  assert.deepEqual(occurred, [...occurred].sort());
});

test("API：离线补报端点", async (t) => {
  const { service, server, base } = await makeServer();
  t.after(() => server.close());
  const submitted = await post(base, "/applications", DEMO_APPLICATION);
  const show = submitted.body.editions[0];
  const res = await post(base, `/editions/${show.edition_id}/samples/backfill`, {
    device_id: "lux-03",
    offline_reason: "设备断电 2 小时",
    samples: [
      { sample_id: "smp-bf-1", dimension: "light", metric: "lux", value: 8, unit: "lx", occurred_at: "2026-07-11T20:00:00+08:00" },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.recorded.length, 1);
  assert.equal(res.body.recorded[0].backfill, true);
});

test("API：未知路由与业务错误返回中文信息", async (t) => {
  const { server, base } = await makeServer();
  t.after(() => server.close());
  const missing = await fetch(`${base}/applications/app-404`);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /申请不存在/);
  const noRoute = await fetch(`${base}/nope`);
  assert.equal(noRoute.status, 404);
});
