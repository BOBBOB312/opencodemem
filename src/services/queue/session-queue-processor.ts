import { logger } from "../logger.js";
import { pendingMessageStore } from "../sqlite/pending-message-store.js";
import { DatabaseManager } from "../sqlite/schema.js";

export interface QueueProcessorConfig {
  pollIntervalMs: number;
  batchSize: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface QueueEvent {
  id: number;
  type: string;
  sessionId: string;
  project: string;
  data: Record<string, unknown>;
  timestamp: number;
  dedupKey?: string;
}

export type QueueEventHandler = (event: QueueEvent) => void | Promise<void>;

export class SessionQueueProcessor {
  private static instance: SessionQueueProcessor | null = null;
  private config: QueueProcessorConfig;
  private handlers: Map<string, QueueEventHandler> = new Map();
  private isProcessing = false;
  private pollInterval?: NodeJS.Timeout;
  private processedCount = 0;
  private failedCount = 0;

  static getInstance(config?: Partial<QueueProcessorConfig>): SessionQueueProcessor {
    if (!SessionQueueProcessor.instance) {
      SessionQueueProcessor.instance = new SessionQueueProcessor({
        pollIntervalMs: config?.pollIntervalMs || 1000,
        batchSize: config?.batchSize || 10,
        maxRetries: config?.maxRetries || 3,
        retryDelayMs: config?.retryDelayMs || 5000,
      });
    }
    return SessionQueueProcessor.instance;
  }

  constructor(config: QueueProcessorConfig) {
    this.config = config;
  }

  registerHandler(eventType: string, handler: QueueEventHandler): void {
    this.handlers.set(eventType, handler);
    logger.info("QUEUE", `Registered handler for event type: ${eventType}`);
  }

  unregisterHandler(eventType: string): void {
    this.handlers.delete(eventType);
  }

  enqueue(event: Omit<QueueEvent, "id">): number {
    return pendingMessageStore.enqueue({
      queueName: event.type,
      entityId: event.sessionId,
      payload: {
        type: event.type,
        sessionId: event.sessionId,
        project: event.project,
        data: event.data,
        timestamp: event.timestamp,
        dedupKey: event.dedupKey,
      },
      maxRetries: this.config.maxRetries,
      dedupKey: event.dedupKey,
    });
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const messages = pendingMessageStore.getReadyMessages(undefined, this.config.batchSize);

      for (const message of messages) {
        await this.processMessage(message.id, message.payload);
      }
    } catch (error) {
      logger.error("QUEUE", "Queue processing error", {
        error: String(error),
      });
    } finally {
      this.isProcessing = false;
    }
  }

  private async processMessage(messageId: number, payload: string): Promise<void> {
    try {
      const data = JSON.parse(payload);
      const handler = this.handlers.get(data.type);

      if (!handler) {
        logger.warn("QUEUE", `No handler for event type: ${data.type}`);
        pendingMessageStore.markProcessed(messageId);
        return;
      }

      const event: QueueEvent = {
        id: messageId,
        type: data.type,
        sessionId: data.sessionId,
        project: data.project,
        data: data.data,
        timestamp: data.timestamp,
        dedupKey: data.dedupKey,
      };

      if (event.dedupKey && pendingMessageStore.isEventProcessed(event.dedupKey)) {
        pendingMessageStore.markProcessed(messageId);
        return;
      }

      await handler(event);
      if (event.dedupKey) {
        pendingMessageStore.markEventProcessed(
          event.dedupKey,
          event.type,
          event.sessionId,
          event.timestamp || Date.now()
        );
      }
      pendingMessageStore.markProcessed(messageId);
      this.processedCount++;

      logger.debug("QUEUE", `Processed event: ${data.type} for session ${data.sessionId}`);
    } catch (error) {
      this.failedCount++;
      const shouldRetry = pendingMessageStore.incrementRetry(messageId, this.config.retryDelayMs);

      if (!shouldRetry) {
        const db = DatabaseManager.getInstance().getDatabase();
        db.query(
          `
            INSERT INTO dead_letters (queue_name, entity_id, payload, reason, created_at_epoch)
            VALUES (?, ?, ?, ?, ?)
          `
        ).run("session_ingest", String(messageId), payload, "max_retries_exceeded", Date.now());
        pendingMessageStore.markProcessed(messageId);
        logger.error("QUEUE", `Message ${messageId} exceeded max retries, moving to dead letter`);
      } else {
        logger.warn("QUEUE", `Message ${messageId} processing failed, will retry`, {
          error: String(error),
        });
      }
    }
  }

  start(): void {
    if (this.pollInterval) {
      return;
    }

    this.pollInterval = setInterval(() => {
      this.processQueue().catch((error) => {
        logger.error("QUEUE", "Poll error", {
          error: String(error),
        });
      });
    }, this.config.pollIntervalMs);

    logger.info("QUEUE", `SessionQueueProcessor started (poll interval: ${this.config.pollIntervalMs}ms)`);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      logger.info("QUEUE", "SessionQueueProcessor stopped");
    }
  }

  getStats(): { processed: number; failed: number; isRunning: boolean } {
    return {
      processed: this.processedCount,
      failed: this.failedCount,
      isRunning: !!this.pollInterval,
    };
  }

  resetStats(): void {
    this.processedCount = 0;
    this.failedCount = 0;
  }
}

export const sessionQueueProcessor = SessionQueueProcessor.getInstance();
