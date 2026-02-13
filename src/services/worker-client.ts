import { getConfig } from "../config.js";
import { logger } from "./logger.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const config = getConfig();
const WORKER_PORT = config.webServerPort;
const WORKER_HOST = config.webServerHost;
const BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

interface SearchOptions {
  query: string;
  project: string;
  type?: string;
  dateStart?: string;
  dateEnd?: string;
  limit?: number;
  offset?: number;
  orderBy?: "relevance" | "date";
}

interface TimelineOptions {
  anchor?: number;
  query?: string;
  depthBefore?: number;
  depthAfter?: number;
  project?: string;
}

interface BatchObservationsOptions {
  ids: number[];
  project?: string;
  orderBy?: "date" | "id";
}

interface SessionInitOptions {
  sessionId: string;
  project: string;
}

interface SessionCompleteOptions {
  sessionId: string;
  project: string;
  status?: "completed" | "failed";
}

interface IngestEventOptions {
  eventType: "session_start" | "session_end" | "observation" | "user_prompt";
  sessionId: string;
  project: string;
  data?: Record<string, any>;
}

const MAX_RETRIES = 10;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;

interface WorkerProcessState {
  process: Bun.Subprocess<"ignore", "ignore", "ignore"> | null;
  ownedByPlugin: boolean;
}

const WORKER_PROCESS_KEY = Symbol.for("opencodemem.worker.process");

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exponentialBackoff(
  attempt: number,
  maxRetries: number
): Promise<number> {
  const backoff = Math.min(
    INITIAL_BACKOFF_MS * Math.pow(2, attempt),
    MAX_BACKOFF_MS
  );
  const jitter = Math.random() * 0.3 * backoff;
  return Math.floor(backoff + jitter);
}

class MemoryClient {
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private isStarting = false;
  private startAttempts = 0;

  private getWorkerState(): WorkerProcessState {
    const globalObj = globalThis as Record<symbol, unknown>;
    if (!globalObj[WORKER_PROCESS_KEY]) {
      globalObj[WORKER_PROCESS_KEY] = {
        process: null,
        ownedByPlugin: false,
      } satisfies WorkerProcessState;
    }
    return globalObj[WORKER_PROCESS_KEY] as WorkerProcessState;
  }

  async warmup(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    if (this.ready) {
      return Promise.resolve();
    }

    this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.isStarting) {
      while (this.isStarting && this.startAttempts < MAX_RETRIES) {
        await sleep(500);
      }
      if (this.ready) return;
    }

    this.isStarting = true;
    this.startAttempts = 0;

    try {
      await this.ensureWorkerRunning();
      await this.waitForWorker();
      this.ready = true;
      logger.info("WORKER", "Worker service is ready");
    } catch (error) {
      logger.error("WORKER", "Failed to connect to worker after max retries", {}, error as Error);
      this.ready = false;
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  private async ensureWorkerRunning(): Promise<void> {
    const health = await this.checkHealth();
    if (health.status === "ok") {
      return;
    }

    const state = this.getWorkerState();
    if (state.process && state.process.exitCode === null) {
      return;
    }

    try {
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const pluginRoot = join(moduleDir, "..", "..", "..");
      const bunExec = process.execPath || "bun";

      state.process = Bun.spawn({
        cmd: [bunExec, "run", "worker:start"],
        cwd: pluginRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      state.ownedByPlugin = true;
      logger.info("WORKER", "Spawned worker process", { cwd: pluginRoot });
    } catch (error) {
      logger.warn("WORKER", "Failed to spawn worker process", {
        error: String(error),
      });
    }
  }

  private async waitForWorker(): Promise<void> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${BASE_URL}/api/health`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          const data = await response.json() as any;
          if (data.status === "ok") {
            logger.info("WORKER", `Worker ready after ${attempt + 1} attempts`);
            return;
          }
        }
      } catch (error) {
        logger.debug("WORKER", `Health check attempt ${attempt + 1} failed`, { error: String(error) });
      }

      if (attempt < MAX_RETRIES - 1) {
        const backoff = await exponentialBackoff(attempt, MAX_RETRIES);
        logger.info("WORKER", `Retrying worker connection in ${Math.round(backoff / 1000)}s...`);
        await sleep(backoff);
      }
    }

    throw new Error("Worker did not become ready within timeout");
  }

  async isReady(): Promise<boolean> {
    if (!this.ready && this.initPromise) {
      try {
        await this.initPromise;
        return this.ready;
      } catch {
        return false;
      }
    }
    return this.ready;
  }

  async checkHealth(): Promise<{ status: string; workerVersion?: string; dbConnected?: boolean }> {
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = await response.json() as any;
        return {
          status: data.status || "ok",
          workerVersion: data.version,
          dbConnected: data.dbConnected,
        };
      }
      return { status: "unhealthy" };
    } catch {
      return { status: "unreachable" };
    }
  }

  close(): void {
    this.ready = false;
    this.initPromise = null;
    this.isStarting = false;

    const state = this.getWorkerState();
    if (state.ownedByPlugin && state.process && state.process.exitCode === null) {
      state.process.kill();
      state.process = null;
      state.ownedByPlugin = false;
    }
  }

  // ===========================================================================
  // Session Management APIs (P1-1)
  // ===========================================================================
  async initSession(options: SessionInitOptions): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${BASE_URL}/api/sessions/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: options.sessionId,
          project: options.project,
        }),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async completeSession(options: SessionCompleteOptions): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${BASE_URL}/api/sessions/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: options.sessionId,
          project: options.project,
          status: options.status || "completed",
        }),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async ingestEvent(options: IngestEventOptions): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${BASE_URL}/api/events/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  // ===========================================================================
  // Layer 1: Search - Get compact index with IDs
  // ===========================================================================
  async searchMemories(options: SearchOptions): Promise<{
    success: boolean;
    results: any[];
    query: string;
    total: number;
    error?: string;
  }> {
    try {
      const params = new URLSearchParams({
        query: options.query,
        project: options.project,
        limit: String(options.limit || 10),
        offset: String(options.offset || 0),
        orderBy: options.orderBy || "relevance",
      });

      if (options.type) params.append("type", options.type);
      if (options.dateStart) params.append("dateStart", options.dateStart);
      if (options.dateEnd) params.append("dateEnd", options.dateEnd);

      const response = await fetch(`${BASE_URL}/api/search?${params}`);

      if (!response.ok) {
        return { success: false, results: [], query: options.query, total: 0, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      return {
        success: true,
        results: data.results || [],
        query: options.query,
        total: data.total || 0,
      };
    } catch (error) {
      return { success: false, results: [], query: options.query, total: 0, error: String(error) };
    }
  }

  // ===========================================================================
  // Layer 2: Timeline - Get chronological context around anchor
  // ===========================================================================
  async getTimeline(options: TimelineOptions): Promise<{
    success: boolean;
    anchor?: { id: number; created_at_epoch: number };
    before: any[];
    after: any[];
    prompts: any[];
    summary?: string;
    error?: string;
  }> {
    try {
      const params = new URLSearchParams({
        depth_before: String(options.depthBefore || 3),
        depth_after: String(options.depthAfter || 3),
      });

      if (options.anchor) params.append("anchor", String(options.anchor));
      if (options.query) params.append("query", options.query);
      if (options.project) params.append("project", options.project);

      const response = await fetch(`${BASE_URL}/api/timeline?${params}`);

      if (!response.ok) {
        return { success: false, before: [], after: [], prompts: [], error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      return {
        success: true,
        anchor: data.anchor,
        before: data.before || [],
        after: data.after || [],
        prompts: data.prompts || [],
        summary: data.summary,
      };
    } catch (error) {
      return { success: false, before: [], after: [], prompts: [], error: String(error) };
    }
  }

  // ===========================================================================
  // Layer 3: Get Observations - Fetch full details for filtered IDs
  // ===========================================================================
  async getObservations(options: BatchObservationsOptions): Promise<{
    success: boolean;
    observations: any[];
    count: number;
    error?: string;
  }> {
    try {
      const response = await fetch(`${BASE_URL}/api/observations/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: options.ids,
          project: options.project,
          orderBy: options.orderBy || "date",
        }),
      });

      if (!response.ok) {
        return { success: false, observations: [], count: 0, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      return {
        success: true,
        observations: data.observations || [],
        count: data.count || 0,
      };
    } catch (error) {
      return { success: false, observations: [], count: 0, error: String(error) };
    }
  }

  // ===========================================================================
  // Convenience methods
  // ===========================================================================

  async searchMemoriesSimple(
    query: string,
    project: string,
    limit: number = 10
  ): Promise<{ success: boolean; results: any[]; error?: string }> {
    return this.searchMemories({ query, project, limit });
  }

  async listMemories(
    project: string,
    limit: number = 20
  ): Promise<{ success: boolean; memories: any[]; error?: string }> {
    try {
      const params = new URLSearchParams({
        project,
        limit: String(limit),
      });

      const response = await fetch(`${BASE_URL}/api/memory/list?${params}`);

      if (!response.ok) {
        return { success: false, memories: [], error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      return { success: true, memories: data.memories || [] };
    } catch (error) {
      return { success: false, memories: [], error: String(error) };
    }
  }

  async addMemory(
    content: string,
    project: string,
    options?: {
      title?: string;
      type?: string;
      tags?: string[];
      metadata?: Record<string, any>;
    }
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
      const response = await fetch(`${BASE_URL}/api/memory/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: content,
          project,
          title: options?.title,
          type: options?.type,
          tags: options?.tags,
          metadata: options?.metadata,
        }),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      return { success: true, id: data.id };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async deleteMemory(memoryId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${BASE_URL}/api/memory/${memoryId}`, {
        method: "DELETE",
      });

      return { success: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async getMemoriesBySession(
    sessionId: string,
    project: string,
    limit: number = 5
  ): Promise<{ success: boolean; results: any[]; error?: string }> {
    try {
      const params = new URLSearchParams({
        sessionId,
        project,
        limit: String(limit),
      });

      const response = await fetch(`${BASE_URL}/api/memory/by-session?${params}`);

      if (!response.ok) {
        return { success: false, results: [], error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      return { success: true, results: data.results || [] };
    } catch (error) {
      return { success: false, results: [], error: String(error) };
    }
  }

  async getInjectContext(
    project: string,
    options?: {
      maxTokens?: number;
      mode?: string;
      sessionId?: string;
      maxAgeDays?: number;
      maxMemories?: number;
    }
  ): Promise<{ success: boolean; context?: string; count?: number; error?: string }> {
    try {
      const params = new URLSearchParams({
        project,
        maxTokens: String(options?.maxTokens || 800),
        mode: options?.mode || "first",
      });

      if (options?.sessionId) params.append("sessionId", options.sessionId);
      if (options?.maxAgeDays) params.append("maxAgeDays", String(options.maxAgeDays));
      if (options?.maxMemories) params.append("maxMemories", String(options.maxMemories));

      const response = await fetch(`${BASE_URL}/api/context/inject?${params}`);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      return {
        success: true,
        context: data.context,
        count: data.count,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

export const memoryClient = new MemoryClient();
