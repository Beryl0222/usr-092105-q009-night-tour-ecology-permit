/**
 * 端到端演示：申请 → 签发 → 场次条件 → 基线与实时采样 → 匿名投诉 →
 * 确认违规 → 局部暂停 → 整改 → 恢复，并打印售票条件与公开暂停页。
 * 运行：node scripts/demo.js
 */
import { loadCatalog } from "../src/catalog.js";
import { EventStore } from "../src/eventStore.js";
import { NightTourService, ROLES } from "../src/service.js";

const show = (title, value) => {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

const catalog = await loadCatalog(new URL("../data/sites.json", import.meta.url));
const store = EventStore.memory();
// 可推进的时钟：让采样、处置发生在各自的“当下”
let clock = new Date("2026-06-20T10:00:00+08:00");
const service = new NightTourService(store, catalog, { now: () => clock });

const organizer = { actor_id: "org-01", name: "山谷文旅", kind: "organizer", roles: [] };
const issuer = { actor_id: "off-01", name: "林岚", kind: "officer", roles: [ROLES.PERMIT_ISSUER] };
const confirmer = { actor_id: "off-02", name: "赵谨", kind: "officer", roles: [ROLES.BREACH_CONFIRMER] };
const approver = { actor_id: "off-03", name: "孙衡", kind: "officer", roles: [ROLES.RESUMPTION_APPROVER] };

// 1. 提交申请：萤火虫观察，两个场次
const { application_id: appId, hints } = await service.submitApplication(
  {
    applicant: { name: "山谷文旅", contact: "138-0000-0000" },
    site_id: "site-firefly-valley",
    activity_type: "萤火虫观察",
    editions: [
      { edition_id: "E1", date: "2026-07-10", start: "19:30", end: "22:00", expected_attendance: 260 },
      { edition_id: "E2", date: "2026-07-11", start: "19:30", end: "22:00", expected_attendance: 260 },
    ],
    equipment: {
      lighting: [{ kind: "LED 投光灯", spectrum_nm: 620, count: 4 }],
      sound: [{ kind: "定向音箱", max_db: 75, count: 2 }],
    },
    traffic_plan: "预约制接驳车，每小时两班",
    waste_plan: { bins: 12, capacity_l: 2400, hauler: "绿洁清运" },
  },
  organizer,
);
show("1. 申请已提交，规则提示（只提示，不拦截）", hints);

// 2. 签发许可与场次条件
await service.issuePermit(appId, issuer, { decision_note: "按敏感窗口建议附加光谱与熄灯条件" });
const limits = {
  light: { max_lux: 5, spectrum_min_nm: 590, curfew: "21:30" },
  noise: { max_db: 55, amplified_end: "21:00" },
  crowd: { max_attendance: 300 },
};
await service.issueConditions(appId, "E1", issuer, limits);
await service.issueConditions(appId, "E2", issuer, limits);
show("2. 售票前主办方拿到的可执行场次条件", service.getTicketClearance(appId));

// 3. 基线采样（不触发提示）
clock = new Date("2026-07-10T18:05:00+08:00");
await service.recordSample({
  application_id: appId, edition_id: "E1", dimension: "noise", phase: "baseline",
  device_id: "noise-01", unit: "dB", value: 42, occurred_at: "2026-07-10T18:00:00+08:00",
});

// 4. 实时采样：E1 噪声越界，系统自动提示
clock = new Date("2026-07-10T21:21:00+08:00");
const { flags } = await service.recordSample({
  application_id: appId, edition_id: "E1", dimension: "noise", phase: "realtime",
  device_id: "noise-01", unit: "dB", value: 68, source: "amplified", occurred_at: "2026-07-10T21:20:00+08:00",
});
show("3. 越界采样触发的规则提示", flags.map((f) => f.summary));

// 5. 匿名投诉：单独不能定案
await service.fileFeedback(appId, { actor_id: "resident-anon", name: "匿名居民" }, {
  edition_id: "E1", anonymous: true, channel: "hotline", content: "太吵了，孩子睡不着",
});
const caseId = flags[0].aggregate_id;
try {
  await service.confirmBreach(caseId, confirmer, { feedback_ids: [(await service.getApplication(appId)).feedback[0].feedback_id] });
} catch (err) {
  show("4. 仅匿名投诉，确认违规被拒绝", err.message);
}

// 6. 匿名投诉 + 监测采样共同研判，确认违规；局部暂停噪声维度
const sampleEventId = flags[0].payload.sample_event_id;
await service.confirmBreach(caseId, confirmer, {
  sample_event_ids: [sampleEventId],
  feedback_ids: [(await service.getApplication(appId)).feedback[0].feedback_id],
  note: "采样与投诉时段吻合",
});
await service.suspendCase(caseId, confirmer, { reason: "扩音超时且声级超限", scope: "case" });
show("5. 局部暂停后，E1 其余维度仍可执行、E2 不受影响", service.getTicketClearance(appId));

// 7. 整改与恢复
clock = new Date("2026-07-11T10:00:00+08:00");
await service.recordRectification(caseId, organizer, { description: "拆除临时音箱两支，扩音改为 20:45 结束", evidence_refs: ["photo-001"] });
clock = new Date("2026-07-11T16:00:00+08:00");
await service.resumeCase(caseId, approver, {
  signatories: [
    { name: "孙衡", capacity: "approver" },
    { name: "山谷文旅现场负责人", capacity: "organizer" },
  ],
  reopening_thresholds: { noise: { max_db: 55, amplified_end: "21:00" } },
  note: "恢复后连续两晚复测",
});

// 8. 设备离线补报：按真实发生时间落入时间线
clock = new Date("2026-07-11T16:30:00+08:00");
await service.recordSample({
  application_id: appId, edition_id: "E1", dimension: "noise", phase: "realtime",
  device_id: "noise-01", unit: "dB", value: 53, occurred_at: "2026-07-10T20:10:00+08:00",
  backfill_reason: "noise-01 于 20:05-21:25 离线，恢复后补报",
});

show("6. 公开暂停页（处置进度与恢复披露）", service.getPublicSuspensionPage(appId));
show("7. 按发生时间组织的时间线", service.getTimeline(appId).map((t) => `${t.occurred_at} ${t.summary}${t.backfilled ? "（补报）" : ""}`));
