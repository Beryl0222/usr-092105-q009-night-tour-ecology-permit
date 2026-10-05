import { DIMENSION_LABELS } from "./constants.js";

/** 从 ISO 时间取当地“HH:MM”，用于与条件中的时刻比较。 */
function wallClock(isoString) {
  return isoString.slice(11, 16);
}

function exceedRatio(value, limit) {
  return (value - limit) / limit;
}

/**
 * 单条采样对单场次的越界判定。灯光、噪声、客流分别判断，互不替代。
 * 返回 null（未越界）或 { dimension, metric, value, limit, severity, message }。
 * severity: "adjust" 表示局部调整即可；"serious" 表示超幅大或触碰时段红线。
 */
export function evaluateSample(condition, sample) {
  const rules = DIMENSION_RULES[sample.dimension];
  if (!rules) return null;
  return rules(condition, sample);
}

const DIMENSION_RULES = {
  light(condition, sample) {
    const c = condition.light;
    if (sample.metric === "wavelength_nm" && sample.value < c.min_wavelength_nm) {
      return breach(sample, c.min_wavelength_nm, "adjust",
        `主波长 ${sample.value}nm 低于许可下限 ${c.min_wavelength_nm}nm，需更换低色温灯具`);
    }
    if (sample.metric === "lux") {
      if (wallClock(sample.occurred_at) >= c.blackout_after && sample.value > 0) {
        return breach(sample, 0, "serious", `${c.blackout_after} 熄灯后仍测得 ${sample.value}lx 照明`);
      }
      if (sample.value > c.max_lux) {
        const severity = exceedRatio(sample.value, c.max_lux) >= 0.1 ? "serious" : "adjust";
        return breach(sample, c.max_lux, severity, `照度 ${sample.value}lx 超过许可上限 ${c.max_lux}lx`);
      }
    }
    return null;
  },

  noise(condition, sample) {
    const c = condition.noise;
    if (sample.metric === "amplified_db" && wallClock(sample.occurred_at) >= c.amplification_end) {
      return breach(sample, 0, "serious", `${c.amplification_end} 扩音停止时限后仍有扩音 ${sample.value}dB`);
    }
    if ((sample.metric === "db" || sample.metric === "amplified_db") && sample.value > c.max_db) {
      const severity = exceedRatio(sample.value, c.max_db) >= 0.1 ? "serious" : "adjust";
      return breach(sample, c.max_db, severity, `噪声 ${sample.value}dB 超过许可上限 ${c.max_db}dB`);
    }
    return null;
  },

  crowd(condition, sample) {
    const c = condition.crowd;
    if (sample.metric === "headcount" && sample.value > c.max_attendance) {
      const severity = exceedRatio(sample.value, c.max_attendance) >= 0.1 ? "serious" : "adjust";
      return breach(sample, c.max_attendance, severity, `在场 ${sample.value} 人超过许可上限 ${c.max_attendance} 人`);
    }
    if (sample.metric === "waste_bins_used" && sample.value > c.max_waste_bins) {
      return breach(sample, c.max_waste_bins, "adjust",
        `垃圾投放 ${sample.value} 桶超过容量 ${c.max_waste_bins} 桶，需增加清运`);
    }
    return null;
  },
};

function breach(sample, limit, severity, message) {
  return {
    dimension: sample.dimension,
    metric: sample.metric,
    value: sample.value,
    limit,
    severity,
    sample_id: sample.sample_id,
    occurred_at: sample.occurred_at,
    message,
  };
}

/** 各维度的局部调整建议。 */
const SUGGESTED_ACTIONS = {
  light: "更换低色温灯具、压暗照度或提前熄灯",
  noise: "降低音量或提前结束扩音",
  crowd: "现场限流、分批入场或增加垃圾清运",
};

/**
 * 汇总一个场次的越界提示。
 * sufficient_scope 给出“足够处置范围”：只有多个维度同时越界时才可能到场次级，
 * 单维度越界时局部调整即为充分处置，不应取消整场。
 */
export function evaluateEditionAlerts(condition, samples) {
  const breaches = samples.map((s) => evaluateSample(condition, s)).filter(Boolean);
  const byDimension = new Map();
  for (const b of breaches) {
    if (!byDimension.has(b.dimension)) byDimension.set(b.dimension, []);
    byDimension.get(b.dimension).push(b);
  }
  const alerts = [...byDimension.entries()].map(([dimension, list]) => ({
    dimension,
    dimension_label: DIMENSION_LABELS[dimension],
    breach_count: list.length,
    worst_severity: list.some((b) => b.severity === "serious") ? "serious" : "adjust",
    suggested_action: SUGGESTED_ACTIONS[dimension],
    breaches: list,
  }));
  const sufficientScope = byDimension.size >= 2 ? "edition" : "dimension";
  return {
    alerts,
    sufficient_scope: sufficientScope,
    note: sufficientScope === "dimension"
      ? "当前仅单一维度越界，局部调整即为充分处置，不应取消整场"
      : "多个维度同时越界，可提请有权人员评估场次级处置",
  };
}
