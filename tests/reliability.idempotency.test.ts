import { beforeEach, describe, expect, test } from "bun:test";
import { DatabaseManager } from "../src/services/sqlite/schema.js";
import { pendingMessageStore } from "../src/services/sqlite/pending-message-store.js";

describe("Reliability: event idempotency", () => {
  beforeEach(() => {
    const db = DatabaseManager.getInstance().getDatabase();
    db.run("DELETE FROM pending_messages");
    db.run("DELETE FROM processed_events");
  });

  test("enqueue skips already processed dedup key", () => {
    pendingMessageStore.markEventProcessed("dedup-1", "observation", "s-1");

    const first = pendingMessageStore.enqueue({
      queueName: "observation",
      entityId: "s-1",
      payload: { data: 1 },
      dedupKey: "dedup-1",
    });

    expect(first).toBe(-1);
  });

  test("enqueue returns same pending id for duplicate dedup key", () => {
    const first = pendingMessageStore.enqueue({
      queueName: "observation",
      entityId: "s-2",
      payload: { data: 1 },
      dedupKey: "dedup-2",
    });
    const second = pendingMessageStore.enqueue({
      queueName: "observation",
      entityId: "s-2",
      payload: { data: 1 },
      dedupKey: "dedup-2",
    });

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});
