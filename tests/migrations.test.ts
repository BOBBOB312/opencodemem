import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../src/services/sqlite/migrations/index.js";

describe("SQLite migrations", () => {
  test("should be ordered and unique", () => {
    const names = MIGRATIONS.map((m) => m.name);
    const unique = new Set(names);

    expect(unique.size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  test("should apply cleanly on empty database", () => {
    const db = new Database(":memory:");

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at_epoch INTEGER NOT NULL
      )
    `);

    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
      db.query(
        "INSERT INTO schema_migrations (name, applied_at_epoch) VALUES (?, ?)"
      ).run(migration.name, Date.now());
    }

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));

    expect(names.has("sessions")).toBe(true);
    expect(names.has("observations")).toBe(true);
    expect(names.has("vectors")).toBe(true);
    expect(names.has("dead_letters")).toBe(true);

    const migrationCount = db.query("SELECT COUNT(*) as cnt FROM schema_migrations").get() as {
      cnt: number;
    };
    expect(migrationCount.cnt).toBe(MIGRATIONS.length);

    db.close();
  });
});
