import express from "express";
import { DatabaseManager } from "../sqlite/schema.js";
import { logger } from "../logger.js";
import { getConfig } from "../../config.js";
import { vectorService } from "../search/vectors.js";
import { searchOrchestrator } from "../search/orchestrator.js";
import {
  DateRangeFilter,
  DeduplicateFilter,
  ProjectFilter,
  RelevanceThresholdFilter,
  TypeFilter,
} from "../search/filters/index.js";
import { settingsManager } from "./settings-manager.js";
import { privacyValidator } from "./validation/privacy-validator.js";
import { sessionQueueProcessor, type QueueEvent } from "../queue/session-queue-processor.js";
import { sseBroadcaster } from "./sse-broadcaster.js";
import { chromaSync } from "../sync/chroma-sync.js";
import { sessionService } from "./session/service.js";
import { processManager } from "../infrastructure/process-manager.js";
import { healthMonitor, registerDefaultHealthChecks } from "../infrastructure/health-monitor.js";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4747;

const CONFIG = getConfig();

type RouteMetrics = {
  count: number;
  errorCount: number;
  durations: number[];
};

const routeMetrics = new Map<string, RouteMetrics>();

function recordRouteMetric(routeKey: string, durationMs: number, statusCode: number): void {
  const metric =
    routeMetrics.get(routeKey) ||
    {
      count: 0,
      errorCount: 0,
      durations: [],
    };

  metric.count += 1;
  if (statusCode >= 400) {
    metric.errorCount += 1;
  }
  metric.durations.push(durationMs);
  if (metric.durations.length > 500) {
    metric.durations.shift();
  }

  routeMetrics.set(routeKey, metric);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

app.use((req, res, next) => {
  const start = performance.now();
  res.on("finish", () => {
    const durationMs = performance.now() - start;
    recordRouteMetric(`${req.method} ${req.path}`, durationMs, res.statusCode);
  });
  next();
});

function broadcastEvent(type: string, payload: Record<string, unknown>, project?: string, sessionId?: string): void {
  const runtimeSettings = settingsManager.get();
  if (!runtimeSettings.features.sseEnabled) {
    return;
  }
  sseBroadcaster.broadcast({ type, payload }, project, sessionId);
}

function sanitizeInputText(text: string): { text: string; warnings: string[] } {
  const validation = privacyValidator.validateAndRedact({ text });
  if (!validation.result.valid) {
    const reason = validation.result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Privacy validation failed: ${reason}`);
  }
  const warnings = validation.result.warnings.map((w) => `${w.field}: ${w.message}`);
  return {
    text: String((validation.redacted as { text?: string }).text || text),
    warnings,
  };
}

async function processIngestEvent(event: QueueEvent): Promise<void> {
  const { type: eventType, sessionId, project, data } = event;
  const db = DatabaseManager.getInstance().getDatabase();

  if (eventType === "session_start") {
    await sessionService.initSession({ sessionId, project });
    broadcastEvent("session_start", { sessionId, project }, project, sessionId);
    return;
  }

  if (eventType === "session_end") {
    await sessionService.completeSession(sessionId, "completed");
    broadcastEvent("session_end", { sessionId, project }, project, sessionId);
    return;
  }

  if (eventType === "observation") {
    const rawText = String(data?.text || "");
    const { text } = sanitizeInputText(rawText);
    const obsType = String(data?.type || "general");
    const obsTitle = String(data?.title || "Observation");
    const obsSubtitle = data?.subtitle ? String(data.subtitle) : null;
    const obsFacts = Array.isArray(data?.facts) ? JSON.stringify(data.facts) : null;
    const obsFilesRead = Array.isArray(data?.files_read) ? JSON.stringify(data.files_read) : null;
    const obsFilesModified = Array.isArray(data?.files_modified)
      ? JSON.stringify(data.files_modified)
      : null;
    const obsPromptNumber = Number(data?.promptNumber || 0);

    const insertResult = db
      .query(
        `
        INSERT INTO observations (
          session_id,
          project,
          type,
          title,
          text,
          subtitle,
          facts,
          files_read,
          files_modified,
          prompt_number
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        sessionId,
        project,
        obsType,
        obsTitle,
        text,
        obsSubtitle,
        obsFacts,
        obsFilesRead,
        obsFilesModified,
        obsPromptNumber
      );

    const observationId = Number(insertResult.lastInsertRowid);
    if (Number.isFinite(observationId) && observationId > 0) {
      vectorService.enqueueEmbedding(observationId);
      broadcastEvent(
        "observation_added",
        {
          id: observationId,
          title: obsTitle,
          type: obsType,
        },
        project,
        sessionId
      );
    }
    return;
  }

  if (eventType === "user_prompt") {
    const promptText = String(data?.promptText || "");
    const { text } = sanitizeInputText(promptText);
    const countResult = db
      .query("SELECT COALESCE(MAX(prompt_number), 0) + 1 as next FROM user_prompts WHERE session_id = ?")
      .get(sessionId) as { next: number };

    db.query(
      `
      INSERT INTO user_prompts (session_id, prompt_number, prompt_text)
      VALUES (?, ?, ?)
    `
    ).run(sessionId, countResult?.next || 1, text);

    broadcastEvent("user_prompt", { sessionId, project }, project, sessionId);
  }
}

void (async () => {
  registerDefaultHealthChecks();
  healthMonitor.registerCheck("queue", async () => sessionQueueProcessor.getStats().isRunning, 5000);
  healthMonitor.registerCheck(
    "chroma_sync",
    async () => {
      const counters = chromaSync.getSyncCounters();
      return counters.initialized || !CONFIG.embedding?.enabled;
    },
    10000
  );

  const vectorReady = await vectorService.initialize();
  if (vectorReady) {
    await vectorService.backfillMissingEmbeddings(200);
  }

  await chromaSync.initialize();
  chromaSync.startPeriodicSync();

  sessionQueueProcessor.registerHandler("session_start", processIngestEvent);
  sessionQueueProcessor.registerHandler("session_end", processIngestEvent);
  sessionQueueProcessor.registerHandler("observation", processIngestEvent);
  sessionQueueProcessor.registerHandler("user_prompt", processIngestEvent);
  sessionQueueProcessor.start();
})();

// ============================================================================
// Web Viewer Endpoint (P3-1)
// ============================================================================

app.get("/viewer", (req, res) => {
  const viewerPath = join(dirname(dirname(__dirname)), "web-server", "viewer.html");
  
  if (existsSync(viewerPath)) {
    res.sendFile(viewerPath);
  } else {
    res.send(`<!DOCTYPE html>
<html>
<head><title>OpenCodeMem Viewer</title></head>
<body>
  <h1>OpenCodeMem Viewer</h1>
  <p>Viewer HTML not found.</p>
</body>
</html>`);
  }
});

app.get("/viewer.html", (req, res) => {
  res.redirect("/viewer");
});

app.get("/", (req, res) => {
  res.json({
    name: "OpenCodeMem Worker",
    version: "0.1.0",
    endpoints: [
      "GET /api/health",
      "GET /api/stats", 
      "GET /api/search",
      "GET /api/timeline",
      "POST /api/observations/batch",
      "GET /api/memory/list",
      "POST /api/memory/save",
      "DELETE /api/memory/:id",
      "GET /api/context/inject",
      "POST /api/sessions/init",
      "POST /api/sessions/complete",
      "GET /api/diagnostics/queue",
      "GET /api/diagnostics/search",
      "GET /api/diagnostics/sync",
      "POST /api/diagnostics/sync/replay",
      "GET /api/stream",
      "GET /api/settings",
      "POST /api/settings",
      "POST /api/cleanup/run",
      "POST /api/cleanup/purge",
      "GET /viewer"
    ]
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

function formatObservationForSearch(obs: any): any {
  return {
    id: obs.id,
    title: obs.title,
    subtitle: obs.subtitle || "",
    text: obs.text || "",
    type: obs.type,
    facts: obs.facts ? JSON.parse(obs.facts) : [],
    files_read: obs.files_read ? JSON.parse(obs.files_read) : [],
    files_modified: obs.files_modified ? JSON.parse(obs.files_modified) : [],
    prompt_number: obs.prompt_number,
    created_at: new Date(obs.created_at_epoch).toISOString(),
    created_at_epoch: obs.created_at_epoch,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Health & Stats (P3-2)
// ============================================================================

app.get("/api/health", async (req, res) => {
  const db = DatabaseManager.getInstance().getDatabase();
  const queueStats = sessionQueueProcessor.getStats();
  const health = await healthMonitor.getStatus();
  
  let dbConnected = true;
  try {
    db.query("SELECT 1").get();
  } catch {
    dbConnected = false;
  }

  res.json({
    status: dbConnected && health.overall !== "unhealthy" ? "ok" : "error",
    timestamp: Date.now(),
    dbConnected,
    vectorEnabled: vectorService.isEnabled(),
    queueRunning: queueStats.isRunning,
    sseClients: sseBroadcaster.getClientCount(),
    checks: health.checks,
    processStatuses: processManager.getAllStatuses(),
    version: "0.1.0",
  });
});

app.get("/api/stats", (req, res) => {
  const db = DatabaseManager.getInstance().getDatabase();

  const sessionCount = db.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
  const observationCount = db.query("SELECT COUNT(*) as count FROM observations").get() as { count: number };
  const memoryCount = db.query("SELECT COUNT(*) as count FROM memories").get() as { count: number };
  const vectorCount = db.query("SELECT COUNT(*) as count FROM vectors").get() as { count: number };
  const deadLetterCount = db.query("SELECT COUNT(*) as count FROM dead_letters").get() as {
    count: number;
  };
  const lastSyncRun = db
    .query(
      `
        SELECT id, provider, project, status, synced_count, failed_count, conflict_count, retry_count,
               started_at_epoch, ended_at_epoch, details
        FROM sync_runs
        ORDER BY id DESC
        LIMIT 1
      `
    )
    .get() as any;

  const apiMetrics = Object.fromEntries(
    Array.from(routeMetrics.entries()).map(([route, metric]) => [
      route,
      {
        count: metric.count,
        errors: metric.errorCount,
        errorRate: metric.count === 0 ? 0 : Number((metric.errorCount / metric.count).toFixed(4)),
        p50: Number(percentile(metric.durations, 50).toFixed(2)),
        p95: Number(percentile(metric.durations, 95).toFixed(2)),
      },
    ])
  );

  res.json({
    sessions: sessionCount?.count || 0,
    observations: observationCount?.count || 0,
    memories: memoryCount?.count || 0,
    vectors: vectorCount?.count || 0,
    deadLetters: deadLetterCount?.count || 0,
    embeddingEnabled: CONFIG.embedding?.enabled || false,
    embeddingQueue: vectorService.getQueueStats(),
    ingestQueue: sessionQueueProcessor.getStats(),
    sseClients: sseBroadcaster.getClientCount(),
    runtimeSettings: settingsManager.get(),
    chromaSync: {
      counters: chromaSync.getSyncCounters(),
      lastRun: chromaSync.getLastRunStats(),
      lastRunRow: lastSyncRun || null,
    },
    searchDiagnostics: searchOrchestrator.getLastDiagnostics(),
    apiMetrics,
  });
});

// ============================================================================
// Session Management APIs (P1-1)
// ============================================================================

app.post("/api/sessions/init", async (req, res) => {
  const { sessionId, project } = req.body;

  if (!sessionId || !project) {
    return res.status(400).json({ success: false, error: "sessionId and project required" });
  }

  await sessionService.initSession({ sessionId, project });
  broadcastEvent("session_init", { sessionId, project }, project, sessionId);

  res.json({ success: true, message: "Session initialized" });
});

app.post("/api/sessions/complete", async (req, res) => {
  const { sessionId, project, status = "completed" } = req.body;

  if (!sessionId || !project) {
    return res.status(400).json({ success: false, error: "sessionId and project required" });
  }

  await sessionService.completeSession(sessionId, status);
  broadcastEvent("session_complete", { sessionId, project, status }, project, sessionId);

  res.json({ success: true, message: "Session completed" });
});

// ============================================================================
// Layer 1: Search - FTS-based with hybrid ranking
// ============================================================================

app.get("/api/search", async (req, res) => {
  const startedAt = performance.now();
  const {
    query,
    project,
    type,
    dateStart,
    dateEnd,
    limit = 20,
    offset = 0,
    orderBy = "relevance",
    includeDiagnostics,
  } = req.query;

  if (!query) {
    return res.status(400).json({ success: false, error: "query required" });
  }

  const projectStr = project ? String(project) : undefined;
  const searchTerm = String(query);
  const limitNum = Number(limit);
  const offsetNum = Number(offset);

  const settings = settingsManager.getSearchSettings();
  const filters = [];
  if (projectStr) {
    filters.push(new ProjectFilter(projectStr));
  }
  if (type) {
    filters.push(new TypeFilter(String(type)));
  }
  if (dateStart || dateEnd) {
    filters.push(
      new DateRangeFilter({
        startDate: dateStart ? new Date(String(dateStart)) : undefined,
        endDate: dateEnd ? new Date(String(dateEnd)) : undefined,
      })
    );
  }
  filters.push(new DeduplicateFilter("id"));
  filters.push(new RelevanceThresholdFilter(0));
  searchOrchestrator.setFilters(filters);

  const searchResult = await searchOrchestrator.search(searchTerm, {
    project: projectStr,
    type: type ? String(type) : undefined,
    dateStart: dateStart ? new Date(String(dateStart)) : undefined,
    dateEnd: dateEnd ? new Date(String(dateEnd)) : undefined,
    limit: limitNum,
    offset: offsetNum,
    useFTS: settings.useFTS,
    useSemantic: settings.useSemantic,
  });

  let finalResults = searchResult.results.map((r: any) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle || "",
    snippet: r.text ? r.text.substring(0, 150) + (r.text.length > 150 ? "..." : "") : "",
    type: r.type,
    prompt_number: r.prompt_number,
    created_at_epoch: r.created_at_epoch,
    similarity: Math.round((r.finalScore || 0) * 100),
    scores: {
      lexical: Math.round((r.lexicalScore || 0) * 100),
      semantic: Math.round((r.semanticScore || 0) * 100),
      recency: Math.round((r.recencyScore || 0) * 100),
    },
  }));

  if (projectStr && CONFIG.embedding?.enabled) {
    const chromaResults = await chromaSync.search(searchTerm, projectStr, Math.max(5, Math.floor(limitNum / 2)));
    if (chromaResults.length > 0) {
      const existing = new Set(finalResults.map((r) => String(r.id)));
      const mapped = chromaResults
        .filter((r) => !existing.has(r.id))
        .map((r) => ({
          id: r.id,
          title: String((r.metadata?.title as string) || "Chroma Result"),
          subtitle: "",
          snippet: r.document.substring(0, 150),
          type: String((r.metadata?.type as string) || "semantic"),
          prompt_number: 0,
          created_at_epoch: Number(r.metadata?.created_at_epoch || Date.now()),
          similarity: 50,
          scores: {
            lexical: 0,
            semantic: 50,
            recency: 0,
          },
        }));
      finalResults = [...finalResults, ...mapped].slice(0, limitNum);
    }
  }

  res.json({
    success: true,
    query,
    results: finalResults,
    total: searchResult.total,
    strategies: searchResult.strategies,
    diagnostics: includeDiagnostics ? searchResult.diagnostics : undefined,
    timingMs: Number((performance.now() - startedAt).toFixed(2)),
  });
});

// ============================================================================
// Layer 2: Timeline - Chronological context around anchor
// ============================================================================

app.get("/api/timeline", (req, res) => {
  const startedAt = performance.now();
  const { anchor, query, depth_before = 3, depth_after = 3, project } = req.query;

  if (!anchor && !query) {
    return res.status(400).json({ success: false, error: "anchor or query required" });
  }

  const db = DatabaseManager.getInstance().getDatabase();

  let anchorId: number | null = null;
  let anchorEpoch: number | null = null;
  const projectStr = project ? String(project) : undefined;
  const depthBefore = Number(depth_before);
  const depthAfter = Number(depth_after);

  // If anchor is a query, find the best matching observation first
  if (query && !anchor) {
    const searchPattern = `%${query}%`;
    const searchResult = projectStr
      ? (db
          .query(`
          SELECT id, created_at_epoch FROM observations
          WHERE project = ? AND (title LIKE ? OR text LIKE ?)
          ORDER BY created_at_epoch DESC LIMIT 1
        `)
          .get(projectStr, searchPattern, searchPattern) as any)
      : (db
          .query(`
          SELECT id, created_at_epoch FROM observations
          WHERE (title LIKE ? OR text LIKE ?)
          ORDER BY created_at_epoch DESC LIMIT 1
        `)
          .get(searchPattern, searchPattern) as any);

    if (searchResult) {
      anchorId = searchResult.id;
      anchorEpoch = searchResult.created_at_epoch;
    }
  } else if (anchor) {
    anchorId = Number(anchor);
    const obs = db.query("SELECT created_at_epoch FROM observations WHERE id = ?").get(anchorId) as any;
    if (obs) {
      anchorEpoch = obs.created_at_epoch;
    }
  }

  if (!anchorId || !anchorEpoch) {
    return res.json({
      success: true,
      anchor: null,
      before: [],
      after: [],
      summary: "No matching observation found for timeline",
    });
  }

  // Get observations before anchor
  const before = projectStr
    ? db
        .query(`
      SELECT id, title, subtitle, text, type, created_at_epoch, prompt_number
      FROM observations
      WHERE project = ? AND created_at_epoch < ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `)
        .all(projectStr, anchorEpoch, depthBefore)
    : db
        .query(`
      SELECT id, title, subtitle, text, type, created_at_epoch, prompt_number
      FROM observations
      WHERE created_at_epoch < ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `)
        .all(anchorEpoch, depthBefore);

  // Get observations after anchor
  const after = projectStr
    ? db
        .query(`
      SELECT id, title, subtitle, text, type, created_at_epoch, prompt_number
      FROM observations
      WHERE project = ? AND created_at_epoch > ?
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `)
        .all(projectStr, anchorEpoch, depthAfter)
    : db
        .query(`
      SELECT id, title, subtitle, text, type, created_at_epoch, prompt_number
      FROM observations
      WHERE created_at_epoch > ?
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `)
        .all(anchorEpoch, depthAfter);

  // Get user prompts around the anchor
  const prompts = db.query(`
    SELECT id, prompt_text, prompt_number, created_at_epoch
    FROM user_prompts
    WHERE session_id = (SELECT session_id FROM observations WHERE id = ?)
    ORDER BY prompt_number
  `).all(anchorId);

  res.json({
    success: true,
    anchor: {
      id: anchorId,
      created_at_epoch: anchorEpoch,
    },
    before: before.map(formatObservationForSearch),
    after: after.map(formatObservationForSearch),
    prompts: prompts.map((p: any) => ({
      id: p.id,
      prompt_number: p.prompt_number,
      text: p.prompt_text,
      created_at_epoch: p.created_at_epoch,
    })),
    timingMs: Number((performance.now() - startedAt).toFixed(2)),
  });
});

// ============================================================================
// Layer 3: Get Observations - Full details for filtered IDs
// ============================================================================

app.post("/api/observations/batch", (req, res) => {
  const startedAt = performance.now();
  const { ids, project, orderBy = "date" } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "ids array required" });
  }

  const db = DatabaseManager.getInstance().getDatabase();

  const placeholders = ids.map(() => "?").join(",");
  const observations = db.query(`
    SELECT id, session_id, project, type, title, subtitle, text, facts, 
           files_read, files_modified, prompt_number, created_at_epoch
    FROM observations
    WHERE id IN (${placeholders})
    ${project ? "AND project = ?" : ""}
    ORDER BY ${orderBy === "date" ? "created_at_epoch" : "id"} ${orderBy === "date" ? "DESC" : "ASC"}
  `).all(...ids, ...(project ? [project] : []));

  res.json({
    success: true,
    observations: observations.map(formatObservationForSearch),
    count: observations.length,
    timingMs: Number((performance.now() - startedAt).toFixed(2)),
  });
});

// ============================================================================
// Memory CRUD
// ============================================================================

app.get("/api/memory/list", (req, res) => {
  const { project, limit = 20, offset = 0, type } = req.query;

  const db = DatabaseManager.getInstance().getDatabase();
  const projectStr = project ? String(project) : undefined;
  const limitNum = Number(limit);
  const offsetNum = Number(offset);

  let sql = "SELECT id, content, summary, type, tags, metadata, session_id, created_at FROM memories WHERE 1=1";
  const params: any[] = [];

  if (projectStr) {
    sql += " AND project = ?";
    params.push(projectStr);
  }

  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limitNum, offsetNum);

  const memories = db.query(sql).all(...params);

  res.json({
    success: true,
    memories: memories.map((m: any) => ({
      id: m.id,
      content: m.content,
      summary: m.summary || m.content.substring(0, 100),
      type: m.type,
      tags: m.tags ? JSON.parse(m.tags) : [],
      metadata: m.metadata ? JSON.parse(m.metadata) : {},
      sessionID: m.session_id,
      createdAt: m.created_at,
    })),
  });
});

app.post("/api/memory/save", (req, res) => {
  const { text, project, title, type, tags, metadata, sessionId } = req.body;

  if (!text || !project) {
    return res.status(400).json({ success: false, error: "text and project required" });
  }

  const db = DatabaseManager.getInstance().getDatabase();
  const { text: safeText, warnings } = sanitizeInputText(String(text));

  const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const summary = safeText.substring(0, 150);

  db.query(`
    INSERT INTO memories (id, project, content, summary, type, tags, metadata, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    project,
    safeText,
    summary,
    type || "general",
    tags ? JSON.stringify(tags) : null,
    metadata ? JSON.stringify(metadata) : null,
    sessionId || null
  );

  // Also create an observation entry for searchability
  if (safeText.length > 20) {
    const insertResult = db.query(`
      INSERT INTO observations (session_id, project, type, title, text, prompt_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId || "manual",
      project,
      type || "general",
      title || summary.substring(0, 50),
      safeText,
      0
    );

    const observationId = Number(insertResult.lastInsertRowid);
    if (Number.isFinite(observationId) && observationId > 0) {
      vectorService.enqueueEmbedding(observationId);
      broadcastEvent(
        "memory_saved",
        {
          id,
          observationId,
          title: title || summary.substring(0, 50),
          type: type || "general",
          warnings,
        },
        project,
        sessionId
      );
    }
  }

  res.json({
    success: true,
    id,
    warnings,
    message: "Memory saved successfully",
  });
});

app.delete("/api/memory/:id", (req, res) => {
  const { id } = req.params;

  const db = DatabaseManager.getInstance().getDatabase();

  db.query("DELETE FROM memories WHERE id = ?").run(id);

  res.json({
    success: true,
    message: "Memory deleted",
  });
});

app.get("/api/memory/by-session", (req, res) => {
  const { sessionId, project, limit = 5 } = req.query;

  const db = DatabaseManager.getInstance().getDatabase();

  const memories = db.query(`
    SELECT id, content, summary, type, created_at
    FROM memories
    WHERE session_id = ? AND project = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(String(sessionId), String(project), Number(limit));

  res.json({
    success: true,
    results: memories.map((m: any) => ({
      id: m.id,
      memory: m.summary || m.content,
      content: m.content,
      type: m.type,
    })),
  });
});

app.get("/api/diagnostics/queue", (req, res) => {
  const db = DatabaseManager.getInstance().getDatabase();
  const recentDeadLetters = db
    .query(
      `
        SELECT id, queue_name, entity_id, reason, created_at_epoch
        FROM dead_letters
        ORDER BY created_at_epoch DESC
        LIMIT 20
      `
    )
    .all() as any[];

  res.json({
    success: true,
    embeddingQueue: vectorService.getQueueStats(),
    ingestQueue: sessionQueueProcessor.getStats(),
    deadLetters: recentDeadLetters,
  });
});

app.get("/api/diagnostics/search", (req, res) => {
  res.json({
    success: true,
    lastDiagnostics: searchOrchestrator.getLastDiagnostics(),
  });
});

app.get("/api/diagnostics/sync", (req, res) => {
  const db = DatabaseManager.getInstance().getDatabase();
  const runs = db
    .query(
      `
        SELECT id, provider, project, status, synced_count, failed_count, conflict_count, retry_count,
               started_at_epoch, ended_at_epoch, details
        FROM sync_runs
        ORDER BY id DESC
        LIMIT 20
      `
    )
    .all() as any[];

  res.json({
    success: true,
    counters: chromaSync.getSyncCounters(),
    lastRun: chromaSync.getLastRunStats(),
    runs,
  });
});

app.post("/api/diagnostics/sync/replay", async (req, res) => {
  const limit = Number(req.body?.limit || 50);
  const result = await chromaSync.replayFailed(limit);
  res.json({ success: true, ...result });
});

app.get("/api/stream", (req, res) => {
  const runtimeSettings = settingsManager.get();
  if (!runtimeSettings.features.sseEnabled) {
    return res.status(403).json({ success: false, error: "SSE disabled" });
  }

  const project = req.query.project ? String(req.query.project) : undefined;
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
  const clientId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 15000);

  sseBroadcaster.addClient({
    id: clientId,
    project,
    sessionId,
    send: (data: string) => {
      res.write(data);
    },
    close: () => {
      clearInterval(heartbeat);
      res.end();
    },
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, project, sessionId })}\n\n`);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseBroadcaster.removeClient(clientId);
  });
});

app.get("/api/settings", (req, res) => {
  res.json({ success: true, settings: settingsManager.get() });
});

app.post("/api/settings", (req, res) => {
  settingsManager.update(req.body || {});
  res.json({ success: true, settings: settingsManager.get() });
});

// ============================================================================
// Event Ingestion (Legacy兼容)
// ============================================================================

app.post("/api/events/ingest", (req, res) => {
  const { eventType, sessionId, project, data, dedupKey } = req.body;

  if (!eventType || !sessionId || !project) {
    return res.status(400).json({ success: false, error: "eventType, sessionId, project required" });
  }

  const computedDedupKey =
    dedupKey ||
    `${String(eventType)}:${String(sessionId)}:${JSON.stringify(data || {})}`;

  const queuedId = sessionQueueProcessor.enqueue({
    type: String(eventType),
    sessionId: String(sessionId),
    project: String(project),
    data: (data || {}) as Record<string, unknown>,
    timestamp: Date.now(),
    dedupKey: String(computedDedupKey),
  });

  res.json({
    success: true,
    queued: queuedId !== -1,
    duplicate: queuedId === -1,
    queueMessageId: queuedId,
    dedupKey: computedDedupKey,
  });
});

// ============================================================================
// Context Injection (P0-3 fix, P1-4 enhancement)
// ============================================================================

app.get("/api/context/inject", (req, res) => {
  const contextSettings = settingsManager.getContextSettings();
  const {
    project,
    maxTokens = contextSettings.maxTokens,
    mode = "first",
    sessionId,
    maxAgeDays,
    maxMemories,
  } = req.query;

  const db = DatabaseManager.getInstance().getDatabase();
  if (!project) {
    return res.status(400).json({ success: false, error: "project required" });
  }
  const projectStr = String(project);
  const maxTokensNum = Number(maxTokens);
  const maxMemoriesNum = Number(maxMemories || contextSettings.maxMemories || CONFIG.chatMessage?.maxMemories || 3);
  const sessionIdStr = sessionId ? String(sessionId) : undefined;

  let sql = `
    SELECT id, content, summary, type, created_at, session_id
    FROM memories
    WHERE project = ?
  `;
  const params: any[] = [projectStr];

  // Exclude current session
  if (sessionIdStr) {
    sql += " AND (session_id IS NULL OR session_id != ?)";
    params.push(sessionIdStr);
  }

  // Filter by age
  if (maxAgeDays) {
    const cutoff = Date.now() - Number(maxAgeDays) * 24 * 60 * 60 * 1000;
    sql += " AND strftime('%s', created_at) * 1000 >= ?";
    params.push(cutoff);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(maxMemoriesNum);

  const memories = db.query(sql).all(...params) as any[];

  // Format for injection with token budget
  const contextLines: string[] = [];
  let currentTokens = 0;

  for (const m of memories) {
    const text = (m.summary as string) || (m.content as string).substring(0, 200);
    const itemTokens = estimateTokens(text);
    
    if (currentTokens + itemTokens > maxTokensNum) {
      break;
    }
    
    contextLines.push(`[#${m.id}] ${text}`);
    currentTokens += itemTokens;
  }

  const context = contextLines.join("\n\n");

  res.json({
    success: true,
    context: context ? `## Relevant Project Context\n\n${context}\n\n*From previous sessions*` : null,
    count: contextLines.length,
    tokenEstimate: currentTokens,
  });
});

// ============================================================================
// Cleanup & Governance (P3-3)
// ============================================================================

app.post("/api/cleanup/run", (req, res) => {
  const { project, maxMemories, maxAgeDays, dryRun = false } = req.body;

  const db = DatabaseManager.getInstance().getDatabase();
  let deletedMemories = 0;
  let deletedObservations = 0;

  try {
    if (maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      
      if (!dryRun) {
        const result = db.query(`
          DELETE FROM memories 
          WHERE project = ? AND strftime('%s', created_at) * 1000 < ?
        `).run(project, cutoff);
        deletedMemories = result.changes;
      } else {
        const count = db.query(`
          SELECT COUNT(*) as cnt FROM memories 
          WHERE project = ? AND strftime('%s', created_at) * 1000 < ?
        `).get(project, cutoff) as { cnt: number };
        deletedMemories = count.cnt;
      }
    }

    if (maxMemories) {
      const toDelete = db.query(`
        SELECT id FROM memories 
        WHERE project = ?
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      `).all(project, maxMemories) as { id: string }[];

      if (!dryRun && toDelete.length > 0) {
        const ids = toDelete.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        db.query(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
      }
      deletedMemories += toDelete.length;
    }

    res.json({
      success: true,
      deletedMemories,
      deletedObservations,
      dryRun,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

app.post("/api/cleanup/purge", (req, res) => {
  const { project, confirm } = req.body;

  if (!confirm) {
    return res.status(400).json({ 
      success: false, 
      error: "Must set confirm=true to purge" 
    });
  }

  const db = DatabaseManager.getInstance().getDatabase();

  try {
    if (project) {
      db.run(`DELETE FROM pending_messages WHERE entity_id IN (SELECT session_id FROM sessions WHERE project = ?)`, project);
      db.run(`DELETE FROM user_prompts WHERE session_id IN (SELECT session_id FROM sessions WHERE project = ?)`, project);
      db.run(`DELETE FROM memories WHERE project = ?`, project);
      db.run(`DELETE FROM observations WHERE project = ?`, project);
      db.run(`DELETE FROM sessions WHERE project = ?`, project);
      db.run(`DELETE FROM sync_runs WHERE project = ?`, project);
    } else {
      db.run(`DELETE FROM memories`);
      db.run(`DELETE FROM observations`);
      db.run(`DELETE FROM sessions`);
      db.run(`DELETE FROM user_prompts`);
      db.run(`DELETE FROM summaries`);
      db.run(`DELETE FROM memory_index`);
      db.run(`DELETE FROM vectors`);
      db.run(`DELETE FROM pending_messages`);
      db.run(`DELETE FROM dead_letters`);
      db.run(`DELETE FROM processed_events`);
      db.run(`DELETE FROM sync_state`);
      db.run(`DELETE FROM sync_runs`);
    }

    res.json({ success: true, message: project ? `Purged all data for ${project}` : "Purged all data" });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ============================================================================
// Server Start
// ============================================================================

export function startServer(port: number = PORT): void {
  app.listen(port, () => {
    logger.info("SERVER", `OpenCodeMem worker started on port ${port}`);
  });
}

function shutdownWorker(): void {
  sessionQueueProcessor.stop();
  chromaSync.stopPeriodicSync();
  sseBroadcaster.closeAll();
  healthMonitor.stopAll();
  processManager.stopAll();
}

process.on("SIGINT", shutdownWorker);
process.on("SIGTERM", shutdownWorker);

if (import.meta.main) {
  startServer();
}
