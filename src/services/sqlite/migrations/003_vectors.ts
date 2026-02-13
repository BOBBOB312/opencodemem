export const migration003Vectors = {
  name: "003_vectors",
  sql: `
    CREATE TABLE IF NOT EXISTS vectors (
      observation_id INTEGER PRIMARY KEY,
      embedding BLOB,
      model TEXT NOT NULL,
      created_at_epoch INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (observation_id) REFERENCES observations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_vectors_created ON vectors(created_at_epoch DESC);
  `,
} as const;
