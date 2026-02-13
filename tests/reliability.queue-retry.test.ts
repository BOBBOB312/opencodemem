import { beforeEach, describe, expect, test } from "bun:test";
import { DatabaseManager } from "../src/services/sqlite/schema.js";
import { SessionQueueProcessor } from "../src/services/queue/session-queue-processor.js";

describe("Reliability: queue retry and dead-letter", () => {
  const processor = SessionQueueProcessor.getInstance({
    pollIntervalMs: 10,
    batchSize: 20,
    maxRetries: 2,
    retryDelayMs: 1,
  });

  beforeEach(() => {
    const db = DatabaseManager.getInstance().getDatabase();
    db.run("DELETE FROM pending_messages");
    db.run("DELETE FROM dead_letters");
    processor.resetStats();
    processor.unregisterHandler("reliability.fail");
  });

  test("moves permanently failing message to dead_letters", async () => {
    processor.registerHandler("reliability.fail", async () => {
      throw new Error("forced failure");
    });

    const db = DatabaseManager.getInstance().getDatabase();
    db.query(
      `
        INSERT INTO pending_messages
          (queue_name, entity_id, payload, retry_count, max_retries, created_at_epoch, next_retry_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      "reliability.fail",
      "r-session",
      JSON.stringify({
        type: "reliability.fail",
        sessionId: "r-session",
        project: "r-project",
        data: { x: 1 },
        timestamp: Date.now(),
      }),
      1,
      2,
      Date.now(),
      Date.now() - 1
    );

    await processor.processQueue();

    const pending = db.query("SELECT COUNT(*) as cnt FROM pending_messages").get() as { cnt: number };
    const dead = db.query("SELECT COUNT(*) as cnt FROM dead_letters WHERE queue_name = 'session_ingest'").get() as {
      cnt: number;
    };

    expect(pending.cnt).toBe(0);
    expect(dead.cnt).toBeGreaterThan(0);

    const stats = processor.getStats();
    expect(stats.failed).toBeGreaterThan(0);
  });
});
