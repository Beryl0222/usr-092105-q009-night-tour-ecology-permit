/**
 * 规则提示引擎：只提示越界，不做行政决定。
 * 签发许可、确认违规、批准恢复仍由有权人员在服务层完成。
 */

export const DIMENSIONS = ["light", "noise", "crowd"];

export const DIMENSION_NAMES = { light: "灯光", noise: "噪声", crowd: "客流" };

/** 从 ISO 时间中取出本地 HH:MM，用于与熄灯、扩音截止等时刻比较。 */
export function timeOf(isoString) {
  return isoString.slice(11, 16);
}

/** 申请阶段提示：物种季节窗口、敏感区容量、垃圾容量、常驻限值。 */
export function evaluateApplication(site, application, catalog) {
  const hints = [];
  for (const edition of application.editions ?? []) {
    for (const w of catalog.windowsFor(site.site_id, edition.date)) {
      hints.push({
        edition_id: edition.edition_id,
        kind: "species_window",
        message: `场次 ${edition.edition_id}（${edition.date}）处于${w.species}敏感窗口（${w.start_md}~${w.end_md}）：${w.note}`,
        suggested_limits: w.suggested_limits ?? null,
      });
    }
    const cap = catalog.recommendedCapacity(site.site_id);
    if (cap != null && edition.expected_attendance > cap) {
      hints.push({
        edition_id: edition.edition_id,
        kind: "capacity",
        message: `场次 ${edition.edition_id} 预计 ${edition.expected_attendance} 人，超过敏感区建议容量 ${cap} 人`,
        suggested_limits: { crowd: { max_attendance: cap } },
      });
    }
  }
  const totalAttendance = (application.editions ?? []).reduce((sum, e) => sum + (e.expected_attendance ?? 0), 0);
  const wasteCap = application.waste_plan?.capacity_l;
  if (Number.isFinite(wasteCap) && wasteCap < totalAttendance * 0.5) {
    hints.push({
      edition_id: null,
      kind: "waste",
      message: `垃圾容量 ${wasteCap}L 低于按每人 0.5L 估算的 ${Math.round(totalAttendance * 0.5)}L 需求`,
      suggested_limits: null,
    });
  }
  if ((application.equipment?.sound ?? []).length > 0 && site.standing_limits?.noise) {
    const n = site.standing_limits.noise;
    hints.push({
      edition_id: null,
      kind: "standing_noise",
      message: `场地毗邻敏感区，建议扩音不晚于 ${n.amplified_end}、声级不超过 ${n.max_db}dB`,
      suggested_limits: { noise: n },
    });
  }
  return hints;
}

/**
 * 实时采样越界判定，按维度分别判断。
 * 返回越界明细数组，空数组表示未越界。
 */
export function evaluateSample(limits, sample) {
  const limit = limits?.[sample.dimension];
  if (!limit) return [];
  const breaches = [];
  const at = timeOf(sample.occurred_at);

  if (sample.dimension === "light") {
    if (limit.max_lux != null && sample.value > limit.max_lux) {
      breaches.push({ metric: "lux", value: sample.value, threshold: limit.max_lux, unit: "lux" });
    }
    if (limit.spectrum_min_nm != null && sample.spectrum_nm != null && sample.spectrum_nm < limit.spectrum_min_nm) {
      breaches.push({ metric: "spectrum_nm", value: sample.spectrum_nm, threshold: limit.spectrum_min_nm, unit: "nm" });
    }
    if (limit.curfew && at > limit.curfew && sample.value > (limit.curfew_lux ?? 0.5)) {
      breaches.push({ metric: "curfew", value: at, threshold: limit.curfew, unit: "time" });
    }
  }

  if (sample.dimension === "noise") {
    if (limit.max_db != null && sample.value > limit.max_db) {
      breaches.push({ metric: "db", value: sample.value, threshold: limit.max_db, unit: "dB" });
    }
    if (limit.amplified_end && sample.source === "amplified" && at > limit.amplified_end) {
      breaches.push({ metric: "amplified_end", value: at, threshold: limit.amplified_end, unit: "time" });
    }
  }

  if (sample.dimension === "crowd") {
    if (limit.max_attendance != null && sample.value > limit.max_attendance) {
      breaches.push({ metric: "attendance", value: sample.value, threshold: limit.max_attendance, unit: "人" });
    }
  }

  return breaches;
}

/** 把越界明细写成中文提示。 */
export function describeBreaches(dimension, breaches) {
  const parts = breaches.map((b) => {
    if (b.unit === "time") return `${b.metric === "curfew" ? "熄灯时间" : "扩音截止"} ${b.threshold}，实际 ${b.value}`;
    return `${b.metric} 限值 ${b.threshold}${b.unit}，实测 ${b.value}${b.unit}`;
  });
  return `${DIMENSION_NAMES[dimension]}维度越界：${parts.join("；")}`;
}
