export const migration001Init = {
  name: "001_init",
  sql: `
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed'))
    );

    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at_epoch INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

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
      created_at_epoch INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      created_at_epoch INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

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
    );

    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project, created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id, prompt_number);
    CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id, prompt_number);
    CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
  `,
} as const;
