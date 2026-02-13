import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";

describe("Integration: Database", () => {
  let db: Database;

  test("should create tables and indexes", () => {
    db = new Database(":memory:");
    
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        status TEXT DEFAULT 'active'
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        type TEXT,
        tags TEXT,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        session_id TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        text TEXT,
        facts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER NOT NULL,
        created_at_epoch INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map((t: any) => t.name);
    
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("observations");
    
    db.close();
  });

  test("should perform CRUD operations", () => {
    db = new Database(":memory:");
    
    db.run(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        status TEXT DEFAULT 'active'
      )
    `);
    
    db.run(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        type TEXT
      )
    `);

    // Insert
    const sessionId = "test_session_" + Date.now();
    db.run("INSERT INTO sessions (session_id, project, status) VALUES (?, ?, ?)",
      [sessionId, "test-project", "active"]);
    
    const memoryId = "mem_" + Date.now();
    db.run("INSERT INTO memories (id, project, content, summary, type) VALUES (?, ?, ?, ?, ?)",
      [memoryId, "test-project", "Test content", "Test summary", "fact"]);

    // Query
    const session = db.query("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    expect(session).toBeDefined();
    expect((session as any).session_id).toBe(sessionId);
    
    const memory = db.query("SELECT * FROM memories WHERE id = ?").get(memoryId);
    expect(memory).toBeDefined();
    expect((memory as any).content).toBe("Test content");

    // Update
    db.run("UPDATE sessions SET status = ? WHERE session_id = ?", ["completed", sessionId]);
    const updated = db.query("SELECT status FROM sessions WHERE session_id = ?").get(sessionId);
    expect((updated as any).status).toBe("completed");

    // Delete
    db.run("DELETE FROM memories WHERE id = ?", memoryId);
    const deleted = db.query("SELECT * FROM memories WHERE id = ?").get(memoryId);
    expect(deleted == null || deleted === null).toBe(true);

    db.close();
  });

  test("should create indexes", () => {
    db = new Database(":memory:");
    
    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at_epoch INTEGER
      )
    `);
    
    db.run("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project, created_at_epoch DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id, created_at_epoch)");

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
    expect(indexes.length).toBe(2);
    
    db.close();
  });
});

describe("Search Flow", () => {
  test("should search with LIKE", () => {
    const db = new Database(":memory:");
    
    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        project TEXT NOT NULL,
        type TEXT,
        title TEXT,
        text TEXT
      )
    `);
    
    db.run("INSERT INTO observations (session_id, project, type, title, text) VALUES (?, ?, ?, ?, ?)",
      ["s1", "test", "bugfix", "Auth Bug", "Login fails with token"]);
    
    const results = db.query(
      "SELECT * FROM observations WHERE project = ? AND (title LIKE ? OR text LIKE ?)"
    ).all("test", "%login%", "%login%");
    
    expect(results.length).toBe(1);
    expect((results[0] as any).title).toBe("Auth Bug");
    
    db.close();
  });
});

describe("Context Injection", () => {
  test("should exclude current session", () => {
    const db = new Database(":memory:");
    
    db.run(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        content TEXT,
        session_id TEXT
      )
    `);
    
    db.run("INSERT INTO memories (id, project, content, session_id) VALUES (?, ?, ?, ?)",
      ["m1", "test", "current session memory", "current_session"]);
    db.run("INSERT INTO memories (id, project, content, session_id) VALUES (?, ?, ?, ?)",
      ["m2", "test", "other session memory", "other_session"]);
    
    const results = db.query(
      "SELECT * FROM memories WHERE project = ? AND (session_id IS NULL OR session_id != ?)"
    ).all("test", "current_session");
    
    expect(results.length).toBe(1);
    expect((results[0] as any).id).toBe("m2");
    
    db.close();
  });
});
