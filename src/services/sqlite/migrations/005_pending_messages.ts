export const migration005PendingMessages = {
  name: "005_pending_messages",
  sql: `
    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at_epoch INTEGER NOT NULL,
      next_retry_at_epoch INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pending_messages_ready
      ON pending_messages(queue_name, next_retry_at_epoch, retry_count);
  `,
} as const;
