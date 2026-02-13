import { logger } from "../logger.js";
import { DatabaseManager } from "../sqlite/schema.js";
import { vectorService } from "../search/vectors.js";

export interface SyncConfig {
  chromaUrl?: string;
  collectionName: string;
  syncIntervalMs: number;
  batchSize: number;
}

export interface SyncedRecord {
  id: string;
  document: string;
  metadata: Record<string, any>;
  embedding?: number[];
}

export interface SyncRunStats {
  synced: number;
  failed: number;
  conflicts: number;
  retries: number;
  durationMs: number;
  startedAtEpoch: number;
  endedAtEpoch: number;
  provider: string;
  project?: string;
}

export class ChromaSync {
  private static instance: ChromaSync | null = null;
  private config: SyncConfig;
  private syncInterval?: NodeJS.Timeout;
  private isSyncing = false;
  private initialized = false;
  private collectionId: string | null = null;
  private lastRunStats: SyncRunStats | null = null;
  private totalRetries = 0;

  static getInstance(config?: Partial<SyncConfig>): ChromaSync {
    if (!ChromaSync.instance) {
      ChromaSync.instance = new ChromaSync({
        collectionName: config?.collectionName || "opencodemem_memories",
        syncIntervalMs: config?.syncIntervalMs || 60000,
        batchSize: config?.batchSize || 100,
        chromaUrl: config?.chromaUrl,
      });
    }
    return ChromaSync.instance;
  }

  constructor(config: SyncConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (!this.config.chromaUrl) {
      logger.info("SYNC", "Chroma URL not configured, sync disabled");
      return;
    }

    try {
      this.collectionId = await this.ensureCollection();
      this.initialized = true;
      logger.info("SYNC", `ChromaSync initialized with collection: ${this.config.collectionName}`);
    } catch (error) {
      this.initialized = false;
      logger.error("SYNC", "Failed to initialize Chroma collection", {
        error: String(error),
      });
    }
  }

  startPeriodicSync(): void {
    if (this.syncInterval) {
      return;
    }

    this.syncInterval = setInterval(() => {
      this.sync().catch((error) => {
        logger.error("SYNC", "Periodic sync failed", {
          error: String(error),
        });
      });
    }, this.config.syncIntervalMs);

    logger.info("SYNC", `Periodic sync started (interval: ${this.config.syncIntervalMs}ms)`);
  }

  stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
      logger.info("SYNC", "Periodic sync stopped");
    }
  }

  async sync(project?: string): Promise<{ synced: number; failed: number }> {
    if (this.isSyncing) {
      logger.warn("SYNC", "Sync already in progress");
      return { synced: 0, failed: 0 };
    }

    if (!this.config.chromaUrl || !this.initialized || !this.collectionId) {
      return { synced: 0, failed: 0 };
    }

    this.isSyncing = true;
    let synced = 0;
    let failed = 0;
    let conflicts = 0;
    let retries = 0;
    const startedAtEpoch = Date.now();
    const runId = this.beginSyncRun(project, startedAtEpoch);

    try {
      const db = DatabaseManager.getInstance().getDatabase();
      const cursor = this.getSyncCursor(project);

      let sql = `
        SELECT o.id, o.title, o.subtitle, o.text, o.type, o.project, o.created_at_epoch
        FROM observations o
        WHERE o.text IS NOT NULL AND o.text != ''
      `;
      const params: any[] = [];

      if (cursor > 0) {
        sql += " AND o.id > ?";
        params.push(cursor);
      }

      if (project) {
        sql += " AND o.project = ?";
        params.push(project);
      }

      sql += " ORDER BY o.id ASC LIMIT ?";
      params.push(this.config.batchSize);

      const observations = db.query(sql).all(...params) as any[];
      let maxSeenId = cursor;

      for (const obs of observations) {
        try {
          if (obs.id > maxSeenId) {
            maxSeenId = obs.id;
          }

          const conflict = this.detectConflict(obs.id, obs.text);
          if (conflict) {
            conflicts += 1;
          }

          const embedding = await this.getEmbedding(obs.text);

          const record: SyncedRecord = {
            id: `obs_${obs.id}`,
            document: `${obs.title}\n${obs.text}`,
            metadata: {
              title: obs.title,
              type: obs.type,
              project: obs.project,
              created_at_epoch: obs.created_at_epoch,
              version: obs.created_at_epoch,
              content_hash: this.hashText(obs.text),
            },
            embedding,
          };

          const upsertResult = await this.upsertWithRetry(record);
          retries += upsertResult.retries;
          this.totalRetries += upsertResult.retries;
          synced += 1;

          this.setObservationHash(obs.id, obs.text);
        } catch (error) {
          failed += 1;
          this.recordSyncFailure(project, obs.id, obs.text, String(error));
          logger.warn("SYNC", `Failed to sync observation ${obs.id}`, {
            error: String(error),
          });
        }
      }

      this.setSyncCursor(project, maxSeenId);

      const endedAtEpoch = Date.now();
      this.lastRunStats = {
        synced,
        failed,
        conflicts,
        retries,
        durationMs: endedAtEpoch - startedAtEpoch,
        startedAtEpoch,
        endedAtEpoch,
        provider: "chroma",
        project,
      };
      this.finishSyncRun(runId, "success", this.lastRunStats);

      logger.info("SYNC", `Sync completed: ${synced} synced, ${failed} failed`);
    } catch (error) {
      const endedAtEpoch = Date.now();
      this.lastRunStats = {
        synced,
        failed,
        conflicts,
        retries,
        durationMs: endedAtEpoch - startedAtEpoch,
        startedAtEpoch,
        endedAtEpoch,
        provider: "chroma",
        project,
      };
      this.finishSyncRun(runId, "failed", this.lastRunStats, String(error));

      logger.error("SYNC", "Sync failed", {
        error: String(error),
      });
    } finally {
      this.isSyncing = false;
    }

    return { synced, failed };
  }

  async replayFailed(limit: number = 50): Promise<{ replayed: number; failed: number }> {
    const db = DatabaseManager.getInstance().getDatabase();
    const rows = db
      .query(
        `
          SELECT id, payload
          FROM dead_letters
          WHERE queue_name = 'chroma_sync'
          ORDER BY created_at_epoch ASC
          LIMIT ?
        `
      )
      .all(limit) as { id: number; payload: string }[];

    let replayed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as { record: SyncedRecord };
        await this.upsertWithRetry(payload.record);
        db.query("DELETE FROM dead_letters WHERE id = ?").run(row.id);
        replayed += 1;
      } catch {
        failed += 1;
      }
    }

    return { replayed, failed };
  }

  async search(query: string, project?: string, limit: number = 10): Promise<SyncedRecord[]> {
    if (!this.config.chromaUrl || !this.initialized || !this.collectionId) {
      return [];
    }

    try {
      const embedding = await this.getEmbedding(query);
      if (embedding.length === 0) {
        return [];
      }

      const payload: Record<string, unknown> = {
        query_embeddings: [embedding],
        n_results: limit,
      };

      if (project) {
        payload.where = { project };
      }

      const response = await fetch(`${this.config.chromaUrl}/api/v1/collections/${this.collectionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as any;
      const ids = data?.ids?.[0] || [];
      const docs = data?.documents?.[0] || [];
      const metas = data?.metadatas?.[0] || [];

      return ids.map((id: string, idx: number) => ({
        id,
        document: String(docs[idx] || ""),
        metadata: (metas[idx] || {}) as Record<string, any>,
      }));
    } catch (error) {
      logger.error("SYNC", "Chroma search failed", {
        error: String(error),
      });
      return [];
    }
  }

  async deleteByProject(project: string): Promise<number> {
    if (!this.config.chromaUrl || !this.initialized || !this.collectionId) {
      return 0;
    }

    try {
      const response = await fetch(`${this.config.chromaUrl}/api/v1/collections/${this.collectionId}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ where: { project } }),
      });

      if (!response.ok) {
        return 0;
      }

      this.clearSyncStateForProject(project);
      return 1;
    } catch (error) {
      logger.error("SYNC", "Failed to delete project records", {
        error: String(error),
      });
      return 0;
    }
  }

  getConfig(): SyncConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<SyncConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getLastRunStats(): SyncRunStats | null {
    return this.lastRunStats;
  }

  getSyncCounters(): { totalRetries: number; initialized: boolean; syncing: boolean } {
    return {
      totalRetries: this.totalRetries,
      initialized: this.initialized,
      syncing: this.isSyncing,
    };
  }

  private async getEmbedding(text: string): Promise<number[]> {
    const embedding = await vectorService.generateEmbedding(text);
    return embedding || [];
  }

  private async upsertWithRetry(
    record: SyncedRecord,
    maxAttempts: number = 3
  ): Promise<{ retries: number }> {
    let attempt = 0;
    while (attempt < maxAttempts) {
      try {
        await this.upsertToChroma(record);
        return { retries: Math.max(0, attempt) };
      } catch (error) {
        attempt += 1;
        if (attempt >= maxAttempts) {
          throw error;
        }
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    return { retries: maxAttempts - 1 };
  }

  private async upsertToChroma(record: SyncedRecord): Promise<void> {
    if (!this.config.chromaUrl || !this.initialized || !this.collectionId) {
      return;
    }

    const response = await fetch(`${this.config.chromaUrl}/api/v1/collections/${this.collectionId}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: [record.id],
        documents: [record.document],
        metadatas: [record.metadata],
        embeddings: record.embedding && record.embedding.length > 0 ? [record.embedding] : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`Chroma upsert failed: HTTP ${response.status}`);
    }
  }

  private async ensureCollection(): Promise<string> {
    if (!this.config.chromaUrl) {
      throw new Error("Chroma URL not configured");
    }

    const listResp = await fetch(`${this.config.chromaUrl}/api/v1/collections`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!listResp.ok) {
      throw new Error(`Failed to list collections: HTTP ${listResp.status}`);
    }

    const collections = (await listResp.json()) as any[];
    const existing = collections.find((c) => c.name === this.config.collectionName);
    if (existing?.id) {
      return String(existing.id);
    }

    const createResp = await fetch(`${this.config.chromaUrl}/api/v1/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.config.collectionName }),
    });

    if (!createResp.ok) {
      throw new Error(`Failed to create collection: HTTP ${createResp.status}`);
    }

    const created = (await createResp.json()) as any;
    return String(created.id);
  }

  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  private detectConflict(observationId: number, text: string): boolean {
    const db = DatabaseManager.getInstance().getDatabase();
    const key = `chroma.hash.observation.${observationId}`;
    const row = db
      .query("SELECT state_value FROM sync_state WHERE state_key = ? LIMIT 1")
      .get(key) as { state_value: string } | undefined;
    if (!row) {
      return false;
    }
    return row.state_value !== this.hashText(text);
  }

  private setObservationHash(observationId: number, text: string): void {
    const db = DatabaseManager.getInstance().getDatabase();
    const key = `chroma.hash.observation.${observationId}`;
    const value = this.hashText(text);
    db.query(
      `
        INSERT INTO sync_state (state_key, state_value, updated_at_epoch)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key)
        DO UPDATE SET state_value = excluded.state_value, updated_at_epoch = excluded.updated_at_epoch
      `
    ).run(key, value, Date.now());
  }

  private getSyncCursor(project?: string): number {
    const db = DatabaseManager.getInstance().getDatabase();
    const key = `chroma.cursor.${project || "__all__"}`;
    const row = db
      .query("SELECT state_value FROM sync_state WHERE state_key = ? LIMIT 1")
      .get(key) as { state_value: string } | undefined;
    return row ? Number(row.state_value) || 0 : 0;
  }

  private setSyncCursor(project: string | undefined, cursor: number): void {
    const db = DatabaseManager.getInstance().getDatabase();
    const key = `chroma.cursor.${project || "__all__"}`;
    db.query(
      `
        INSERT INTO sync_state (state_key, state_value, updated_at_epoch)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key)
        DO UPDATE SET state_value = excluded.state_value, updated_at_epoch = excluded.updated_at_epoch
      `
    ).run(key, String(cursor), Date.now());
  }

  private clearSyncStateForProject(project: string): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query("DELETE FROM sync_state WHERE state_key = ?").run(`chroma.cursor.${project}`);
  }

  private beginSyncRun(project: string | undefined, startedAtEpoch: number): number {
    const db = DatabaseManager.getInstance().getDatabase();
    const result = db
      .query(
        `
          INSERT INTO sync_runs (provider, project, status, started_at_epoch)
          VALUES (?, ?, ?, ?)
        `
      )
      .run("chroma", project || null, "running", startedAtEpoch);
    return Number(result.lastInsertRowid);
  }

  private finishSyncRun(
    runId: number,
    status: "success" | "failed",
    stats: SyncRunStats,
    error?: string
  ): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query(
      `
        UPDATE sync_runs
        SET status = ?,
            synced_count = ?,
            failed_count = ?,
            conflict_count = ?,
            retry_count = ?,
            ended_at_epoch = ?,
            details = ?
        WHERE id = ?
      `
    ).run(
      status,
      stats.synced,
      stats.failed,
      stats.conflicts,
      stats.retries,
      stats.endedAtEpoch,
      JSON.stringify({ durationMs: stats.durationMs, error: error || null }),
      runId
    );
  }

  private recordSyncFailure(
    project: string | undefined,
    observationId: number,
    text: string,
    reason: string
  ): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query(
      `
        INSERT INTO dead_letters (queue_name, entity_id, payload, reason, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run(
      "chroma_sync",
      String(observationId),
      JSON.stringify({
        project,
        record: {
          id: `obs_${observationId}`,
          document: text,
          metadata: { project },
        },
      }),
      reason,
      Date.now()
    );
  }
}

export const chromaSync = ChromaSync.getInstance();
