export const migration004DeadLetters = {
  name: "004_dead_letters",
  sql: `
    CREATE TABLE IF NOT EXISTS dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      entity_id TEXT,
      payload TEXT,
      reason TEXT,
      created_at_epoch INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_dead_letters_queue ON dead_letters(queue_name, created_at_epoch DESC);
  `,
} as const;
