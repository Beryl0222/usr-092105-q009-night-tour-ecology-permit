import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { validateEvent } from "./validator.js";

/**
 * 追加式事件存储。
 * - 版本按聚合（aggregate_type + aggregate_id）从 1 递增；
 * - 同一 event_id 重复投递视为来源系统重试，直接返回原事件，不重复落库；
 * - 可选 JSONL 文件持久化，重启后自动回放。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #lastVersion = new Map();
  #filePath;

  constructor(filePath = null) {
    this.#filePath = filePath;
  }

  static async open(filePath) {
    const store = new EventStore(filePath);
    try {
      const text = await readFile(filePath, "utf8");
      for (const line of text.split("\n")) {
        if (line.trim()) store.#accept(JSON.parse(line));
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return store;
  }

  static memory() {
    return new EventStore(null);
  }

  #key(type, id) {
    return `${type}:${id}`;
  }

  #accept(event) {
    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    this.#lastVersion.set(this.#key(event.aggregate_type, event.aggregate_id), event.version);
  }

  lastVersion(aggregateType, aggregateId) {
    return this.#lastVersion.get(this.#key(aggregateType, aggregateId)) ?? 0;
  }

  get(eventId) {
    return this.#byId.get(eventId) ?? null;
  }

  all() {
    return [...this.#events];
  }

  eventsOf(aggregateType, aggregateId) {
    return this.#events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId);
  }

  /**
   * 追加事件。返回 { event, duplicate }。
   * 重试同一 event_id 时返回首次登记的事件且 duplicate 为 true。
   */
  async append(event) {
    const existing = this.#byId.get(event.event_id);
    if (existing) return { event: existing, duplicate: true };

    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件不符合契约：${errors.join("；")}`);

    const expected = this.lastVersion(event.aggregate_type, event.aggregate_id) + 1;
    if (event.version !== expected) {
      throw new Error(`版本不连续：${event.aggregate_type}/${event.aggregate_id} 期望 version=${expected}，收到 ${event.version}`);
    }

    const stored = { ...event, recorded_at: event.recorded_at ?? new Date().toISOString() };
    if (this.#filePath) {
      await mkdir(dirname(this.#filePath), { recursive: true });
      await appendFile(this.#filePath, JSON.stringify(stored) + "\n", "utf8");
    }
    this.#accept(stored);
    return { event: stored, duplicate: false };
  }
}
