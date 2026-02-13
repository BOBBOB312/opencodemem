import { DatabaseManager } from "./schema.js";

export interface PendingMessage {
  id: number;
  queueName: string;
  entityId: string;
  payload: string;
  retryCount: number;
  maxRetries: number;
  createdAtEpoch: number;
  nextRetryAtEpoch?: number;
}

export interface EnqueueMessageInput {
  queueName: string;
  entityId: string;
  payload: Record<string, unknown>;
  maxRetries?: number;
  delayMs?: number;
  dedupKey?: string;
}

export class PendingMessageStore {
  private static instance: PendingMessageStore | null = null;

  static getInstance(): PendingMessageStore {
    if (!PendingMessageStore.instance) {
      PendingMessageStore.instance = new PendingMessageStore();
    }
    return PendingMessageStore.instance;
  }

  enqueue(input: EnqueueMessageInput): number {
    const db = DatabaseManager.getInstance().getDatabase();
    const maxRetries = input.maxRetries ?? 3;
    const nextRetryAt = input.delayMs ? Date.now() + input.delayMs : null;

    if (input.dedupKey) {
      const alreadyProcessed = db
        .query("SELECT 1 as x FROM processed_events WHERE event_key = ? LIMIT 1")
        .get(input.dedupKey) as { x: number } | undefined;
      if (alreadyProcessed) {
        return -1;
      }

      const pendingDuplicate = db
        .query(
          `
            SELECT id
            FROM pending_messages
            WHERE queue_name = ?
              AND json_extract(payload, '$.dedupKey') = ?
            LIMIT 1
          `
        )
        .get(input.queueName, input.dedupKey) as { id: number } | undefined;

      if (pendingDuplicate) {
        return pendingDuplicate.id;
      }
    }

    const payloadWithKey = {
      ...input.payload,
      dedupKey: input.dedupKey,
    };

    const result = db.query(`
      INSERT INTO pending_messages (queue_name, entity_id, payload, retry_count, max_retries, created_at_epoch, next_retry_at_epoch)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(
      input.queueName,
      input.entityId,
      JSON.stringify(payloadWithKey),
      maxRetries,
      Date.now(),
      nextRetryAt
    );

    return Number(result.lastInsertRowid);
  }

  getById(id: number): PendingMessage | undefined {
    const db = DatabaseManager.getInstance().getDatabase();
    const row = db.query(`
      SELECT id, queue_name, entity_id, payload, retry_count, max_retries, created_at_epoch, next_retry_at_epoch
      FROM pending_messages WHERE id = ?
    `).get(id) as any;

    if (!row) return undefined;

    return this.mapRow(row);
  }

  getReadyMessages(queueName?: string, limit: number = 100): PendingMessage[] {
    const db = DatabaseManager.getInstance().getDatabase();
    const now = Date.now();

    let sql = `
      SELECT id, queue_name, entity_id, payload, retry_count, max_retries, created_at_epoch, next_retry_at_epoch
      FROM pending_messages
      WHERE (next_retry_at_epoch IS NULL OR next_retry_at_epoch <= ?) AND retry_count < max_retries
    `;
    const params: any[] = [now];

    if (queueName) {
      sql += " AND queue_name = ?";
      params.push(queueName);
    }

    sql += " ORDER BY created_at_epoch ASC LIMIT ?";
    params.push(limit);

    const rows = db.query(sql).all(...params) as any[];
    return rows.map(this.mapRow);
  }

  incrementRetry(id: number, nextRetryDelayMs?: number): boolean {
    const db = DatabaseManager.getInstance().getDatabase();
    const message = this.getById(id);
    if (!message) return false;

    const newRetryCount = message.retryCount + 1;
    const nextRetryAt = nextRetryDelayMs ? Date.now() + nextRetryDelayMs : null;

    if (newRetryCount >= message.maxRetries) {
      db.query(`
        UPDATE pending_messages SET retry_count = ?, next_retry_at_epoch = NULL WHERE id = ?
      `).run(newRetryCount, id);
      return false;
    }

    db.query(`
      UPDATE pending_messages SET retry_count = ?, next_retry_at_epoch = ? WHERE id = ?
    `).run(newRetryCount, nextRetryAt, id);

    return true;
  }

  markProcessed(id: number): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query("DELETE FROM pending_messages WHERE id = ?").run(id);
  }

  markEventProcessed(
    eventKey: string,
    queueName: string,
    entityId?: string,
    processedAtEpoch: number = Date.now()
  ): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query(
      `
        INSERT OR IGNORE INTO processed_events (event_key, queue_name, entity_id, processed_at_epoch)
        VALUES (?, ?, ?, ?)
      `
    ).run(eventKey, queueName, entityId || null, processedAtEpoch);
  }

  isEventProcessed(eventKey: string): boolean {
    const db = DatabaseManager.getInstance().getDatabase();
    const row = db
      .query("SELECT 1 as x FROM processed_events WHERE event_key = ? LIMIT 1")
      .get(eventKey) as { x: number } | undefined;
    return !!row;
  }

  deleteByQueue(queueName: string): number {
    const db = DatabaseManager.getInstance().getDatabase();
    const result = db.query("DELETE FROM pending_messages WHERE queue_name = ?").run(queueName);
    return result.changes;
  }

  getStats(queueName?: string): { total: number; ready: number; pending: number } {
    const db = DatabaseManager.getInstance().getDatabase();
    const now = Date.now();

    const total = queueName
      ? (db.query("SELECT COUNT(*) as count FROM pending_messages WHERE queue_name = ?").get(queueName) as any)?.count || 0
      : (db.query("SELECT COUNT(*) as count FROM pending_messages").get() as any)?.count || 0;

    const ready = queueName
      ? (db.query("SELECT COUNT(*) as count FROM pending_messages WHERE queue_name = ? AND (next_retry_at_epoch IS NULL OR next_retry_at_epoch <= ?) AND retry_count < max_retries").get(queueName, now) as any)?.count || 0
      : (db.query("SELECT COUNT(*) as count FROM pending_messages WHERE (next_retry_at_epoch IS NULL OR next_retry_at_epoch <= ?) AND retry_count < max_retries").get(now) as any)?.count || 0;

    return {
      total,
      ready,
      pending: total - ready,
    };
  }

  private mapRow(row: any): PendingMessage {
    return {
      id: row.id,
      queueName: row.queue_name,
      entityId: row.entity_id,
      payload: row.payload,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAtEpoch: row.created_at_epoch,
      nextRetryAtEpoch: row.next_retry_at_epoch,
    };
  }
}

export const pendingMessageStore = PendingMessageStore.getInstance();
