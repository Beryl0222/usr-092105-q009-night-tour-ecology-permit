/** 种子数据：场地敏感区、物种季节窗口、有权人员。 */

export const ZONES = [
  {
    zone_id: "zone-firefly-river",
    name: "萤火河岸观察区",
    kind: "firefly_habitat",
    description: "萤火虫繁殖栖息地，夜间对光谱与照度高度敏感",
  },
  {
    zone_id: "zone-old-town-square",
    name: "古城墙广场",
    kind: "ancient_town",
    description: "居民环绕的古城演出场地，重点关注扩音结束时间",
  },
  {
    zone_id: "zone-lakeside-camp",
    name: "湖畔露营区",
    kind: "campsite",
    description: "受客流承载与垃圾容量限制的露营场地",
  },
];

export const SPECIES_WINDOWS = [
  {
    window_id: "win-firefly-2026",
    zone_id: "zone-firefly-river",
    species: "萤火虫",
    start_date: "2026-05-01",
    end_date: "2026-09-30",
    min_wavelength_nm: 590,
    quiet_hours: { start: "21:30", end: "23:00" },
  },
];

export const OFFICERS = [
  { officer_id: "officer-permit-01", name: "林许可", role: "permit_officer" },
  { officer_id: "officer-enforce-01", name: "赵执法", role: "enforcement_officer" },
];

/** 演示申请：同一夜游季下的萤火虫观察、古城演出与湖畔露营三个场次。 */
export const DEMO_APPLICATION = {
  applicant: "星河夜游文化有限公司",
  title: "2026 夏夜巡游季",
  activity_kind: "commercial_night_tour",
  editions: [
    {
      zone_id: "zone-firefly-river",
      title: "萤火虫河岸观察",
      start_at: "2026-07-10T19:30:00+08:00",
      end_at: "2026-07-10T22:00:00+08:00",
      expected_attendance: 120,
      equipment: [
        { kind: "light", name: "步道引导灯", spec: "LED 3000K 可调光" },
        { kind: "sound", name: "讲解耳麦", spec: "低功率定向" },
      ],
      traffic_plan: "游客中心统一摆渡，每小时两班",
      waste_plan: "无痕观察，出口设 4 个分类桶",
    },
    {
      zone_id: "zone-old-town-square",
      title: "古城沉浸式演出",
      start_at: "2026-07-11T20:00:00+08:00",
      end_at: "2026-07-11T22:30:00+08:00",
      expected_attendance: 800,
      equipment: [
        { kind: "sound", name: "线阵音响", spec: "峰值 105dB" },
        { kind: "light", name: "城墙投影", spec: "20000lm" },
      ],
      traffic_plan: "地铁接驳加开三班，散客分流两条步行线",
      waste_plan: "广场四角各设 6 个分类桶，演出结束即清运",
    },
    {
      zone_id: "zone-lakeside-camp",
      title: "湖畔星空露营",
      start_at: "2026-07-12T16:00:00+08:00",
      end_at: "2026-07-13T10:00:00+08:00",
      expected_attendance: 200,
      equipment: [{ kind: "light", name: "营地串灯", spec: "暖光 2200K" }],
      traffic_plan: "预约制自驾，车位 80 个封顶",
      waste_plan: "每营位一袋，容量 30 桶，次日 8 点前清运",
    },
  ],
};
