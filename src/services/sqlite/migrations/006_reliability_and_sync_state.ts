export const migration006ReliabilityAndSyncState = {
  name: "006_reliability_and_sync_state",
  sql: `
    CREATE TABLE IF NOT EXISTS processed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT UNIQUE NOT NULL,
      queue_name TEXT NOT NULL,
      entity_id TEXT,
      processed_at_epoch INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_processed_events_queue
      ON processed_events(queue_name, processed_at_epoch DESC);

    CREATE TABLE IF NOT EXISTS sync_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      project TEXT,
      status TEXT NOT NULL,
      synced_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      started_at_epoch INTEGER NOT NULL,
      ended_at_epoch INTEGER,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_runs_provider
      ON sync_runs(provider, started_at_epoch DESC);
  `,
} as const;
