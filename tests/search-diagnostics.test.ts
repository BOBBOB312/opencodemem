import { describe, expect, test } from "bun:test";
import { DatabaseManager } from "../src/services/sqlite/schema.js";
import { searchOrchestrator } from "../src/services/search/orchestrator.js";

describe("Search diagnostics", () => {
  test("records strategy and filter diagnostics", async () => {
    const db = DatabaseManager.getInstance().getDatabase();
    const project = `diag-project-${Date.now()}`;
    const sessionId = `diag-session-${Date.now()}`;

    const runWithRetry = (fn: () => void): void => {
      let lastError: unknown;
      for (let i = 0; i < 8; i++) {
        try {
          fn();
          return;
        } catch (error) {
          lastError = error;
          const msg = String(error);
          if (!msg.includes("locked") && !msg.includes("SQLITE_BUSY")) {
            throw error;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      throw lastError;
    };

    runWithRetry(() => {
      db.query("INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'active')").run(
        sessionId,
        project
      );
    });

    runWithRetry(() => {
      db.query(
        `
          INSERT INTO observations (session_id, project, type, title, text, prompt_number, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        sessionId,
        project,
        "workflow",
        "Diagnostics observation",
        "search diagnostics should contain strategy timings",
        1,
        Date.now()
      );
    });

    const result = await searchOrchestrator.search("strategy timings", {
      project,
      limit: 10,
      useFTS: true,
      useSemantic: false,
    });

    expect(result.total).toBeGreaterThan(0);
    expect(Object.keys(result.diagnostics.strategyTimingsMs).length).toBeGreaterThan(0);
    expect(result.diagnostics.endedAtEpoch).toBeGreaterThanOrEqual(result.diagnostics.startedAtEpoch);
  });
});
