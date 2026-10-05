import { createServer } from "node:http";

import { loadCatalog } from "./catalog.js";
import { EventStore } from "./eventStore.js";
import { DomainError, NightTourService, PermissionError } from "./service.js";

const PORT = process.env.PORT ?? 8080;
const EVENT_LOG = process.env.EVENT_LOG ?? "data/events.jsonl";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

const routes = [
  // 办理类
  ["POST", /^\/applications$/, (svc, _m, body) => svc.submitApplication(body.payload, body.actor)],
  ["POST", /^\/applications\/([\w-]+)\/issue$/, (svc, m, body) => svc.issuePermit(m[1], body.actor, body)],
  ["POST", /^\/applications\/([\w-]+)\/conditions$/, (svc, m, body) => svc.issueConditions(m[1], body.edition_id, body.actor, body.limits, body.note)],
  ["POST", /^\/applications\/([\w-]+)\/conditions\/([\w-]+)\/adjust$/, (svc, m, body) => svc.adjustConditions(m[1], m[2], body.actor, body.limits, body.reason)],
  ["POST", /^\/applications\/([\w-]+)\/feedback$/, (svc, m, body) => svc.fileFeedback(m[1], body.actor, body)],
  ["POST", /^\/samples$/, (svc, _m, body) => svc.recordSample(body.payload, body.actor)],
  ["POST", /^\/cases\/(.+)\/confirm$/, (svc, m, body) => svc.confirmBreach(decodeURIComponent(m[1]), body.actor, body)],
  ["POST", /^\/cases\/(.+)\/suspend$/, (svc, m, body) => svc.suspendCase(decodeURIComponent(m[1]), body.actor, body)],
  ["POST", /^\/cases\/(.+)\/rectifications$/, (svc, m, body) => svc.recordRectification(decodeURIComponent(m[1]), body.actor, body)],
  ["POST", /^\/cases\/(.+)\/resume$/, (svc, m, body) => svc.resumeCase(decodeURIComponent(m[1]), body.actor, body)],
  // 查询类
  ["GET", /^\/applications\/([\w-]+)$/, (svc, m) => svc.getApplication(m[1]) ?? Promise.reject(new DomainError("申请不存在"))],
  ["GET", /^\/applications\/([\w-]+)\/clearance$/, (svc, m) => svc.getTicketClearance(m[1])],
  ["GET", /^\/applications\/([\w-]+)\/timeline$/, (svc, m) => svc.getTimeline(m[1])],
  ["GET", /^\/applications\/([\w-]+)\/cases$/, (svc, m) => svc.listCases(m[1])],
  ["GET", /^\/public\/applications\/([\w-]+)\/suspensions$/, (svc, m) => svc.getPublicSuspensionPage(m[1])],
];

export async function startServer({ port = PORT, eventLog = EVENT_LOG } = {}) {
  const store = await EventStore.open(eventLog);
  const catalog = await loadCatalog(new URL("../data/sites.json", import.meta.url));
  const service = new NightTourService(store, catalog);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      for (const [method, pattern, handler] of routes) {
        const match = method === req.method ? url.pathname.match(pattern) : null;
        if (match) {
          const body = method === "POST" ? await readBody(req) : {};
          const result = await handler(service, match, body);
          send(res, 200, { ok: true, data: result ?? null });
          return;
        }
      }
      send(res, 404, { ok: false, error: "接口不存在" });
    } catch (err) {
      if (err instanceof PermissionError) send(res, 403, { ok: false, error: err.message });
      else if (err instanceof DomainError) send(res, 400, { ok: false, error: err.message });
      else send(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });
  server.listen(port, () => console.log(`夜游生态扰动平台已启动：http://localhost:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  startServer();
}
