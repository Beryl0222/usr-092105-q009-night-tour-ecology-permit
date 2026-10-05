import { createServer } from "node:http";

import { DomainError } from "./service.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

async function readBody(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("请求体不是合法 JSON", 400);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 公开暂停处置进度页。 */
function renderSuspensionPage(progress) {
  const rows = progress.rectifications.map((a) => `
    <tr>
      <td>${escapeHtml(a.action)}</td>
      <td>${a.status === "done" ? "已完成" : "进行中"}</td>
      <td>${escapeHtml(a.operator ?? "—")}</td>
      <td>${escapeHtml(a.done_at ?? "—")}</td>
    </tr>`).join("");
  const triggers = progress.trigger_samples.map((s) => `
    <li>${escapeHtml(s.occurred_at)}　${escapeHtml(s.dimension)} / ${escapeHtml(s.metric)} = ${s.value}${escapeHtml(s.unit)}</li>`).join("");
  const resumption = progress.resumption ? `
    <h2>恢复公告</h2>
    <p>恢复时间：${escapeHtml(progress.resumption.resumed_at)}</p>
    <p>签署人：${progress.resumption.signatories.map(escapeHtml).join("、")}</p>
    <h3>重新开放门槛</h3>
    <ul>${Object.entries(progress.resumption.reopen_thresholds)
      .map(([d, t]) => `<li>${escapeHtml(d)}：${escapeHtml(t)}</li>`).join("")}</ul>` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>暂停处置进度 ${escapeHtml(progress.suspension_id)}</title></head>
<body>
  <h1>夜游活动暂停处置进度</h1>
  <p>状态：${progress.status === "resumed" ? "已恢复" : "处置中"}　决定人：${escapeHtml(progress.decided_by)}　下达时间：${escapeHtml(progress.ordered_at)}</p>
  <p>涉及场次：${progress.editions.map((e) => escapeHtml(e.title)).join("、")}</p>
  <p>涉及维度：${progress.dimensions.map((d) => escapeHtml(d.label)).join("、")}</p>
  <h2>触发采样</h2>
  <ul>${triggers || "<li>（以居民反馈证据触发）</li>"}</ul>
  <h2>整改动作</h2>
  <table border="1" cellpadding="6">
    <thead><tr><th>动作</th><th>状态</th><th>执行人</th><th>完成时间</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${resumption}
</body></html>`;
}

/** 创建 HTTP 服务。service 为 NightTourService 实例。 */
export function createApp(service) {
  const routes = [
    ["GET", /^\/health$/, async () => ({ status: "ok" })],

    ["POST", /^\/applications$/, async (req, _m, body) =>
      service.submitApplication(body)],

    ["GET", /^\/applications\/([^/]+)$/, async (_req, m) =>
      service.getApplication(m[1])],

    ["GET", /^\/applications\/([^/]+)\/timeline$/, async (_req, m) =>
      ({ events: service.timelineFor(m[1]) })],

    ["POST", /^\/applications\/([^/]+)\/conditions$/, async (req, m, body) =>
      service.issueConditions(m[1], officerOf(req), body)],

    ["GET", /^\/applications\/([^/]+)\/ticket-conditions$/, async (_req, m) =>
      service.getTicketConditions(m[1])],

    ["POST", /^\/editions\/([^/]+)\/samples$/, async (_req, m, body) =>
      service.recordSample(m[1], body)],

    ["POST", /^\/editions\/([^/]+)\/samples\/backfill$/, async (_req, m, body) =>
      service.backfillSamples(m[1], body)],

    ["GET", /^\/editions\/([^/]+)\/alerts$/, async (_req, m) =>
      service.listAlerts(m[1])],

    ["POST", /^\/editions\/([^/]+)\/feedback$/, async (_req, m, body) =>
      service.receiveFeedback(m[1], body)],

    ["POST", /^\/feedback\/([^/]+)\/assess$/, async (req, m) =>
      service.assessFeedback(m[1], officerOf(req))],

    ["POST", /^\/editions\/([^/]+)\/breaches$/, async (req, m, body) =>
      service.confirmBreach(m[1], body.dimension, officerOf(req), body)],

    ["POST", /^\/suspensions$/, async (_req, _m, body) =>
      service.orderSuspension(body)],

    ["POST", /^\/suspensions\/([^/]+)\/rectifications\/([^/]+)$/, async (_req, m, body) =>
      service.recordRectification(m[1], m[2], body)],

    ["POST", /^\/suspensions\/([^/]+)\/resume$/, async (req, m, body) =>
      service.approveResumption(m[1], officerOf(req), body)],

    ["GET", /^\/public\/suspensions\/([^/]+)\.json$/, async (_req, m) =>
      service.getSuspensionProgress(m[1])],

    ["GET", /^\/public\/suspensions\/([^/]+)$/, async (_req, m) =>
      ({ html: renderSuspensionPage(service.getSuspensionProgress(m[1])) })],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      for (const [method, pattern, handler] of routes) {
        if (req.method !== method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        const body = method === "POST" ? await readBody(req) : {};
        const result = await handler(req, match, body);
        if (result && typeof result === "object" && "html" in result) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(result.html);
        } else {
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(result));
        }
        return;
      }
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: "接口不存在" }));
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      res.writeHead(status, JSON_HEADERS);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

function officerOf(req) {
  return req.headers["x-officer-id"] ?? "";
}
