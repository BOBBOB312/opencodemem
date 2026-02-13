import { DatabaseManager } from "../sqlite/schema.js";
import { getConfig } from "../../config.js";
import { logger } from "../logger.js";

interface VectorRecord {
  observation_id: number;
  embedding: number[];
  model: string;
  created_at_epoch: number;
}

interface QueueItem {
  observationId: number;
  attempt: number;
}

interface QueueStats {
  enqueued: number;
  processed: number;
  failed: number;
  retried: number;
  pending: number;
  maxDepth: number;
}

class VectorService {
  private initialized = false;
  private modelName: string = "";
  private queue: QueueItem[] = [];
  private processing = false;
  private readonly maxAttempts = 3;
  private readonly retryDelayMs = 500;
  private stats: QueueStats = {
    enqueued: 0,
    processed: 0,
    failed: 0,
    retried: 0,
    pending: 0,
    maxDepth: 0,
  };

  async initialize(): Promise<boolean> {
    const config = getConfig();
    
    if (!config.embedding?.enabled) {
      logger.info("VECTOR", "Vector search disabled in config");
      return false;
    }

    try {
      this.modelName = config.embedding?.model || "Xenova/nomic-embed-text-v1";
      
      const db = DatabaseManager.getInstance().getDatabase();
      
      this.initialized = true;
      logger.info("VECTOR", `Initialized with model: ${this.modelName}`);
      return true;
    } catch (error) {
      logger.error("VECTOR", "Failed to initialize vector service", {}, error as Error);
      return false;
    }
  }

  isEnabled(): boolean {
    return this.initialized;
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.initialized) {
      return null;
    }

    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${getConfig().memoryApiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text.substring(0, 8000),
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json() as any;
      return data.data[0].embedding;
    } catch (error) {
      logger.error("VECTOR", "Failed to generate embedding", {}, error as Error);
      return null;
    }
  }

  async storeEmbedding(observationId: number, embedding: number[]): Promise<boolean> {
    if (!this.initialized) {
      return false;
    }

    try {
      const db = DatabaseManager.getInstance().getDatabase();
      
      const embeddingBlob = Buffer.from(new Float32Array(embedding));
      
      db.query(`
        INSERT OR REPLACE INTO vectors (observation_id, embedding, model, created_at_epoch)
        VALUES (?, ?, ?, ?)
      `).run(observationId, embeddingBlob, this.modelName, Date.now());

      return true;
    } catch (error) {
      logger.error("VECTOR", "Failed to store embedding", { observationId }, error as Error);
      return false;
    }
  }

  async getEmbedding(observationId: number): Promise<number[] | null> {
    if (!this.initialized) {
      return null;
    }

    try {
      const db = DatabaseManager.getInstance().getDatabase();
      
      const result = db.query(`
        SELECT embedding FROM vectors WHERE observation_id = ?
      `).get(observationId) as { embedding: Buffer } | undefined;

      if (!result?.embedding) {
        return null;
      }

      return Array.from(new Float32Array(result.embedding));
    } catch (error) {
      logger.error("VECTOR", "Failed to get embedding", { observationId }, error as Error);
      return null;
    }
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async searchSimilar(text: string, project: string, limit: number = 10): Promise<Map<number, number>> {
    if (!this.initialized) {
      return new Map();
    }

    const queryEmbedding = await this.generateEmbedding(text);
    if (!queryEmbedding) {
      return new Map();
    }

    try {
      const db = DatabaseManager.getInstance().getDatabase();
      
      const vectors = db.query(`
        SELECT v.observation_id, v.embedding
        FROM vectors v
        JOIN observations o ON v.observation_id = o.id
        WHERE o.project = ?
      `).all(project) as { observation_id: number; embedding: Buffer }[];

      const scores = new Map<number, number>();

      for (const vec of vectors) {
        const embedding = Array.from(new Float32Array(vec.embedding));
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);
        scores.set(vec.observation_id, similarity);
      }

      const sorted = Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

      return new Map(sorted);
    } catch (error) {
      logger.error("VECTOR", "Failed to search similar", { project }, error as Error);
      return new Map();
    }
  }

  async batchEmbedObservations(observationIds: number[]): Promise<void> {
    if (!this.initialized || observationIds.length === 0) {
      return;
    }

    for (const observationId of observationIds) {
      this.enqueueEmbedding(observationId);
    }
  }

  async backfillMissingEmbeddings(limit: number = 200): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const missing = db
      .query(
        `
          SELECT o.id
          FROM observations o
          LEFT JOIN vectors v ON o.id = v.observation_id
          WHERE v.observation_id IS NULL
          ORDER BY o.created_at_epoch DESC
          LIMIT ?
        `
      )
      .all(limit) as { id: number }[];

    for (const row of missing) {
      this.enqueueEmbedding(row.id);
    }
  }

  getQueueStats(): QueueStats {
    return {
      ...this.stats,
      pending: this.queue.length,
    };
  }

  enqueueEmbedding(observationId: number): void {
    if (!this.initialized) {
      return;
    }

    const alreadyQueued = this.queue.some((q) => q.observationId === observationId);
    if (alreadyQueued) {
      return;
    }

    this.queue.push({ observationId, attempt: 1 });
    this.stats.enqueued += 1;
    this.stats.pending = this.queue.length;
    if (this.queue.length > this.stats.maxDepth) {
      this.stats.maxDepth = this.queue.length;
    }

    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.initialized) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.stats.pending = this.queue.length;

        const ok = await this.embedObservation(item.observationId);
        if (ok) {
          this.stats.processed += 1;
          continue;
        }

        if (item.attempt < this.maxAttempts) {
          this.stats.retried += 1;
          await this.sleep(this.retryDelayMs * item.attempt);
          this.queue.push({ observationId: item.observationId, attempt: item.attempt + 1 });
          this.stats.pending = this.queue.length;
        } else {
          this.stats.failed += 1;
          this.writeDeadLetter(item.observationId, "embedding_failed_after_retries");
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async embedObservation(observationId: number): Promise<boolean> {
    if (!this.initialized) {
      return false;
    }

    const existing = await this.getEmbedding(observationId);
    if (existing) {
      return true;
    }

    const db = DatabaseManager.getInstance().getDatabase();

    const obs = db
      .query(
        `
          SELECT title, text
          FROM observations
          WHERE id = ?
        `
      )
      .get(observationId) as { title: string; text: string } | undefined;

    if (!obs) {
      return true;
    }

    const text = `${obs.title} ${obs.text || ""}`;
    const embedding = await this.generateEmbedding(text);

    if (!embedding) {
      return false;
    }

    return this.storeEmbedding(observationId, embedding);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private writeDeadLetter(observationId: number, reason: string): void {
    try {
      const db = DatabaseManager.getInstance().getDatabase();
      db.query(
        `
          INSERT INTO dead_letters (queue_name, entity_id, payload, reason, created_at_epoch)
          VALUES (?, ?, ?, ?, ?)
        `
      ).run(
        "embedding_queue",
        String(observationId),
        JSON.stringify({ observationId }),
        reason,
        Date.now()
      );
    } catch (error) {
      logger.warn("VECTOR", "Failed to write dead letter", {
        observationId,
        reason,
        error: String(error),
      });
    }
  }

  resetForTests(): void {
    this.queue = [];
    this.processing = false;
    this.initialized = false;
    this.stats = {
      enqueued: 0,
      processed: 0,
      failed: 0,
      retried: 0,
      pending: 0,
      maxDepth: 0,
    };
    this.modelName = "";
    }
}

export const vectorService = new VectorService();
