import { describe, expect, test } from "bun:test";
import { DatabaseManager } from "../src/services/sqlite/schema.js";
import { searchOrchestrator } from "../src/services/search/orchestrator.js";

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

describe("Performance: long-run search baseline", () => {
  test("maintains p95 under baseline across repeated queries", async () => {
    const db = DatabaseManager.getInstance().getDatabase();
    const project = `perf-long-${Date.now()}`;
    const sessionId = `perf-long-session-${Date.now()}`;

    db.query("INSERT OR IGNORE INTO sessions (session_id, project, status) VALUES (?, ?, 'active')").run(
      sessionId,
      project
    );

    const insert = db.transaction((count: number) => {
      const stmt = db.query(
        `
          INSERT INTO observations (session_id, project, type, title, text, prompt_number, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      );
      for (let i = 0; i < count; i++) {
        stmt.run(
          sessionId,
          project,
          "workflow",
          `Perf Long ${i}`,
          `Long-run perf sample ${i} includes queue retry diagnostics context injection semantics.`,
          i + 1,
          Date.now() - i
        );
      }
    });

    insert(3000);

    const runs: number[] = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      const result = await searchOrchestrator.search("queue retry diagnostics", {
        project,
        limit: 20,
        useFTS: true,
        useSemantic: false,
      });
      const elapsed = performance.now() - started;
      runs.push(elapsed);
      expect(result.results.length).toBeGreaterThan(0);
    }

    expect(p95(runs)).toBeLessThan(600);
  });
});
