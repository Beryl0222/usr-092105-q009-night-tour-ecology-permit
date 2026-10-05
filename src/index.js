import { EventStore } from "./store.js";
import { NightTourService } from "./service.js";
import { createApp } from "./server.js";
import { DEMO_APPLICATION, OFFICERS, SPECIES_WINDOWS, ZONES } from "./seed.js";

const port = Number(process.env.PORT ?? 8080);
const store = await EventStore.load(new URL("../data/events.jsonl", import.meta.url).pathname);
const service = new NightTourService(store, {
  zones: ZONES,
  speciesWindows: SPECIES_WINDOWS,
  officers: OFFICERS,
});

// 首次启动写入演示申请，便于本地联调。
if (service.applications.size === 0) {
  const demo = await service.submitApplication(DEMO_APPLICATION, "2026-06-01T10:00:00+08:00");
  console.log(`已登记演示申请：${demo.application_id}`);
}

createApp(service).listen(port, () => {
  console.log(`夜游生态扰动平台已启动：http://localhost:${port}`);
});
