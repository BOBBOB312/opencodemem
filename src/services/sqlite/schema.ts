import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { getConfig } from "../../config.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

let dataDir: string;
let dbPath: string;

function initPaths(): void {
  const config = getConfig();
  dataDir = config.storagePath || join(homedir(), ".opencode-mem", "data");
  dbPath = join(dataDir, "opencodemem.db");
}

export function ensureDataDir(): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private db: Database | null = null;

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      initPaths();
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  getDatabase(): Database {
    if (!this.db) {
      ensureDataDir();
      this.db = new Database(dbPath, { create: true });
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
      this.db.run("PRAGMA foreign_keys = ON");
      this.initializeSchema();
    }
    return this.db;
  }

  private initializeSchema(): void {
    const db = this.db!;
    this.runMigrations(db);
    this.ensureResilienceTables(db);
  }

  private ensureResilienceTables(db: Database): void {
    db.exec(`
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
    `);
  }

  private runMigrations(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at_epoch INTEGER NOT NULL
      )
    `);

    const appliedRows = db.query("SELECT name FROM schema_migrations").all() as {
      name: string;
    }[];
    const applied = new Set(appliedRows.map((row) => row.name));

    const applyMigration = db.transaction((migration: Migration) => {
      db.exec(migration.sql);
      db.query(
        "INSERT INTO schema_migrations (name, applied_at_epoch) VALUES (?, ?)"
      ).run(migration.name, Date.now());
    });

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) {
        continue;
      }
      applyMigration(migration);
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export function getDbPath(): string {
  return dbPath;
}

export function getDataDir(): string {
  return dataDir;
}
