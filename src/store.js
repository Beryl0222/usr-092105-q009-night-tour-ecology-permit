import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 事件存储：append-only，可选 JSONL 文件持久化。
 * - version 按 aggregate_id 从 1 递增，由存储统一分配；
 * - 来源系统重试沿用原 event_id，重复提交幂等返回已存事件。
 */
export class EventStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.events = [];
    this.byId = new Map();
    this.nextVersion = new Map();
  }

  static async load(filePath) {
    const store = new EventStore(filePath);
    try {
      const text = await readFile(filePath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        store.#index(JSON.parse(line));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return store;
  }

  #index(event) {
    this.events.push(event);
    this.byId.set(event.event_id, event);
    this.nextVersion.set(event.aggregate_id, event.version + 1);
  }

  /** 追加事件；event_id 已存在时返回原事件（幂等重试安全）。 */
  async append(event) {
    const existing = this.byId.get(event.event_id);
    if (existing) return existing;
    const version = this.nextVersion.get(event.aggregate_id) ?? 1;
    const stored = Object.freeze({ ...event, version });
    if (this.filePath) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, JSON.stringify(stored) + "\n", "utf8");
    }
    this.#index(stored);
    return stored;
  }

  /** 按发生时间排序返回（可过滤聚合）。 */
  timeline(filter = {}) {
    return this.events
      .filter((event) => (!filter.aggregate_id || event.aggregate_id === filter.aggregate_id))
      .filter((event) => (!filter.aggregate_type || event.aggregate_type === filter.aggregate_type))
      .slice()
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  }
}
