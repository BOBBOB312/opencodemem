import { describe, expect, test } from "bun:test";
import { DatabaseManager } from "../src/services/sqlite/schema.js";
import { searchOrchestrator } from "../src/services/search/orchestrator.js";

describe("Performance: search latency", () => {
  test("search remains under budget on medium dataset", async () => {
    const db = DatabaseManager.getInstance().getDatabase();
    const project = `perf-project-${Date.now()}`;
    const sessionId = `perf-session-${Date.now()}`;

    db.query("INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'active')").run(
      sessionId,
      project
    );

    const insertBatch = db.transaction((count: number) => {
      const stmt = db.query(
        `
          INSERT INTO observations (session_id, project, type, title, text, prompt_number, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      );

      for (let i = 0; i < count; i++) {
        const noisy = i % 5 === 0 ? "queue reliability token budget" : "generic observation payload";
        stmt.run(
          sessionId,
          project,
          "workflow",
          `Observation ${i}`,
          `This is observation ${i} containing ${noisy}.`,
          i + 1,
          Date.now() - i
        );
      }
    });

    insertBatch(1200);

    searchOrchestrator.setFilters([]);

    const started = performance.now();
    const result = await searchOrchestrator.search("queue reliability token", {
      project,
      limit: 20,
      useFTS: true,
      useSemantic: false,
    });
    const elapsed = performance.now() - started;

    expect(result.total).toBeGreaterThan(0);
    expect(result.results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});
