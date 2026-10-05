import { readFile } from "node:fs/promises";

/** 场地目录：敏感区、物种季节窗口、常驻限值。 */
export class Catalog {
  constructor(sites) {
    this.sites = new Map(sites.map((site) => [site.site_id, site]));
  }

  get(siteId) {
    return this.sites.get(siteId) ?? null;
  }

  /** 日期（MM-DD）是否落在窗口内，支持跨年窗口（如 10-01 ~ 03-31）。 */
  static inWindow(dateMd, startMd, endMd) {
    if (startMd <= endMd) return dateMd >= startMd && dateMd <= endMd;
    return dateMd >= startMd || dateMd <= endMd;
  }

  /** 指定场地、日期（YYYY-MM-DD）命中的物种季节窗口。 */
  windowsFor(siteId, date) {
    const site = this.get(siteId);
    if (!site) return [];
    const md = date.slice(5, 10);
    return (site.species_windows ?? []).filter((w) => Catalog.inWindow(md, w.start_md, w.end_md));
  }

  /** 场地最严格的敏感区建议容量。 */
  recommendedCapacity(siteId) {
    const site = this.get(siteId);
    if (!site) return null;
    const caps = (site.sensitive_zones ?? []).map((z) => z.recommended_capacity).filter((c) => Number.isFinite(c));
    return caps.length > 0 ? Math.min(...caps) : null;
  }
}

export async function loadCatalog(path) {
  const data = JSON.parse(await readFile(path, "utf8"));
  return new Catalog(data.sites ?? []);
}
