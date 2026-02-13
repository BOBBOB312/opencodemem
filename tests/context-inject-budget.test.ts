import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

describe("context inject budgeting", () => {
  test("applies maxMemories and maxTokens", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        session_id TEXT
      )
    `);

    db.query(
      "INSERT INTO memories (id, project, content, summary, session_id) VALUES (?, ?, ?, ?, ?)"
    ).run("m1", "p", "A".repeat(200), "A".repeat(120), "s1");
    db.query(
      "INSERT INTO memories (id, project, content, summary, session_id) VALUES (?, ?, ?, ?, ?)"
    ).run("m2", "p", "B".repeat(200), "B".repeat(120), "s2");
    db.query(
      "INSERT INTO memories (id, project, content, summary, session_id) VALUES (?, ?, ?, ?, ?)"
    ).run("m3", "p", "C".repeat(200), "C".repeat(120), "s3");

    const memories = db
      .query(
        `
          SELECT id, content, summary, session_id
          FROM memories
          WHERE project = ?
          ORDER BY created_at DESC
          LIMIT ?
        `
      )
      .all("p", 2) as { id: string; content: string; summary: string }[];

    const maxTokens = 40;
    let consumed = 0;
    const lines: string[] = [];

    for (const m of memories) {
      const text = m.summary || m.content.substring(0, 200);
      const t = estimateTokens(text);
      if (consumed + t > maxTokens) {
        break;
      }
      consumed += t;
      lines.push(`[#${m.id}] ${text}`);
    }

    expect(memories.length).toBe(2);
    expect(lines.length).toBe(1);
    expect(consumed).toBeLessThanOrEqual(maxTokens);
    db.close();
  });

  test("excludes current session", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        session_id TEXT
      )
    `);

    db.query(
      "INSERT INTO memories (id, project, content, summary, session_id) VALUES (?, ?, ?, ?, ?)"
    ).run("same", "p", "same session", "same session", "session-a");
    db.query(
      "INSERT INTO memories (id, project, content, summary, session_id) VALUES (?, ?, ?, ?, ?)"
    ).run("other", "p", "other session", "other session", "session-b");

    const rows = db
      .query(
        `
          SELECT id
          FROM memories
          WHERE project = ?
          AND (session_id IS NULL OR session_id != ?)
        `
      )
      .all("p", "session-a") as { id: string }[];

    expect(rows.map((r) => r.id)).toEqual(["other"]);
    db.close();
  });
});
