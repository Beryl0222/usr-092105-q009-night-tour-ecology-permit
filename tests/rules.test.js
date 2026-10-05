import assert from "node:assert/strict";
import test from "node:test";

import { evaluateEditionAlerts, evaluateSample } from "../src/rules.js";

const condition = {
  light: { min_wavelength_nm: 590, max_lux: 15, blackout_after: "23:00" },
  noise: { max_db: 60, amplification_end: "22:30" },
  crowd: { max_attendance: 800, max_waste_bins: 24 },
};

function sample(dimension, metric, value, occurred_at = "2026-07-11T21:00:00+08:00") {
  return { sample_id: `s-${dimension}-${metric}-${value}`, dimension, metric, value, unit: "u", occurred_at };
}

test("灯光：波长低于季节下限判定越界", () => {
  const breach = evaluateSample(condition, sample("light", "wavelength_nm", 520));
  assert.equal(breach.dimension, "light");
  assert.equal(breach.severity, "adjust");
  assert.equal(evaluateSample(condition, sample("light", "wavelength_nm", 600)), null);
});

test("灯光：熄灯时段后仍有照明属严重越界", () => {
  const breach = evaluateSample(condition, sample("light", "lux", 3, "2026-07-11T23:10:00+08:00"));
  assert.equal(breach.severity, "serious");
});

test("噪声：扩音停止时限后仍有扩音属严重越界", () => {
  const breach = evaluateSample(condition, sample("noise", "amplified_db", 55, "2026-07-11T22:45:00+08:00"));
  assert.equal(breach.severity, "serious");
  assert.equal(evaluateSample(condition, sample("noise", "amplified_db", 55, "2026-07-11T22:00:00+08:00")), null);
});

test("客流：超上限 10% 以内为可调整，超出为严重", () => {
  assert.equal(evaluateSample(condition, sample("crowd", "headcount", 850)).severity, "adjust");
  assert.equal(evaluateSample(condition, sample("crowd", "headcount", 900)).severity, "serious");
});

test("单维度越界时充分处置范围为局部，不得取消整场", () => {
  const { alerts, sufficient_scope, note } = evaluateEditionAlerts(condition, [
    sample("noise", "db", 66),
    sample("noise", "db", 70),
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].dimension, "noise");
  assert.equal(sufficient_scope, "dimension");
  assert.match(note, /局部调整/);
});

test("多维度同时越界才提示场次级处置", () => {
  const { sufficient_scope } = evaluateEditionAlerts(condition, [
    sample("noise", "db", 70),
    sample("crowd", "headcount", 900),
  ]);
  assert.equal(sufficient_scope, "edition");
});
