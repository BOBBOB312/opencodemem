import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { memoryClient } from "./services/worker-client.js";
import { getTags } from "./services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
import { performAutoCapture } from "./services/auto-capture.js";
import { startWebServer } from "./services/web-server.js";

import { isConfigured, CONFIG } from "./config.js";
import { log } from "./services/logger.js";
import { getLanguageName } from "./services/language-detector.js";

export const OpenCodeMemPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  const tags = getTags(directory);
  let webServer: any = null;
  let idleTimeout: Timer | null = null;
  const ACTIVE_SESSIONS_KEY = Symbol.for("opencodemem.active.sessions");
  const activeSessions: Set<string> =
    ((globalThis as any)[ACTIVE_SESSIONS_KEY] as Set<string> | undefined) || new Set<string>();
  (globalThis as any)[ACTIVE_SESSIONS_KEY] = activeSessions;

  if (!isConfigured()) {
  }

  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencodemem.plugin.warmedup");

  if (!(globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] && isConfigured()) {
    try {
      await memoryClient.warmup();
      (globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] = true;
    } catch (error) {
      log("Plugin warmup failed", { error: String(error) });
    }
  }

  if (CONFIG.webServerEnabled) {
    startWebServer({
      port: CONFIG.webServerPort || 4747,
      host: CONFIG.webServerHost || "127.0.0.1",
      enabled: CONFIG.webServerEnabled,
    })
      .then((server) => {
        webServer = server;
        const url = webServer.getUrl();

        if (webServer.isServerOwner()) {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "OpenCodeMem",
                  message: `Memory system started at ${url}`,
                  variant: "success",
                  duration: 5000,
                },
              })
              .catch(() => {});
          }
        }
      })
      .catch((error) => {
        log("Web server failed to start", { error: String(error) });
      });
  }

  const shutdownHandler = async () => {
    try {
      for (const sessionID of activeSessions) {
        await memoryClient.completeSession({
          sessionId: sessionID,
          project: tags.project.tag,
          status: "completed",
        });
      }

      if (webServer) {
        await webServer.stop();
      }
      memoryClient.close();
      process.exit(0);
    } catch (error) {
      log("Shutdown error", { error: String(error) });
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);

  return {
    "chat.message": async (input, output) => {
      if (!isConfigured() || !CONFIG.chatMessage?.enabled) return;

      try {
        if (!activeSessions.has(input.sessionID)) {
          const sessionResult = await memoryClient.initSession({
            sessionId: input.sessionID,
            project: tags.project.tag,
          });
          if (sessionResult.success) {
            activeSessions.add(input.sessionID);
          }
        }

        const textParts = output.parts.filter(
          (p): p is Part & { type: "text"; text: string } => p.type === "text"
        );

        if (textParts.length === 0) return;
        const userMessage = textParts.map((p) => p.text).join("\n");
        if (!userMessage.trim()) return;

        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID },
        });
        const messages = messagesResponse.data || [];

        const hasNonSyntheticUserMessages = messages.some(
          (m) =>
            m.info.role === "user" &&
            !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
        );

        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        const isAfterCompaction = lastMessage?.info?.summary === true;

        const shouldInject =
          CONFIG.chatMessage?.injectOn === "always" ||
          !hasNonSyntheticUserMessages ||
          isAfterCompaction;

        if (!shouldInject) return;

        const contextResult = await memoryClient.getInjectContext(tags.project.tag, {
          maxTokens: 800,
          mode: CONFIG.chatMessage?.injectOn || "first",
          sessionId: CONFIG.chatMessage?.excludeCurrentSession ? input.sessionID : undefined,
          maxAgeDays: CONFIG.chatMessage?.maxAgeDays,
          maxMemories: CONFIG.chatMessage?.maxMemories,
        });

        if (contextResult.success && contextResult.context) {
          const contextPart: Part = {
            id: `memory-context-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: contextResult.context,
            synthetic: true,
          } as any;
          output.parts.unshift(contextPart);
        }
      } catch (error) {
        log("chat.message: ERROR", { error: String(error) });
      }
    },

    tool: {
      memory: tool({
        description: `Manage and query project memory. Three-layer workflow:
1. search(query) - Get compact index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID or query) - Get chronological context
3. get_observations(ids) - Fetch full details for filtered IDs
Use 'add' to store knowledge, 'list' to view memories.`,
        args: {
          mode: tool.schema.enum(["add", "search", "timeline", "get_observations", "list", "forget", "help"]).optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          anchor: tool.schema.number().optional(),
          ids: tool.schema.string().optional(),
          tags: tool.schema.string().optional(),
          type: tool.schema.string().optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
          depth_before: tool.schema.number().optional(),
          depth_after: tool.schema.number().optional(),
        },
        async execute(
          args: {
            mode?: "add" | "search" | "timeline" | "get_observations" | "list" | "forget" | "help";
            content?: string;
            query?: string;
            anchor?: number;
            ids?: string;
            tags?: string;
            type?: string;
            memoryId?: string;
            limit?: number;
            depth_before?: number;
            depth_after?: number;
          },
          toolCtx: { sessionID: string }
        ) {
          if (!isConfigured()) {
            return JSON.stringify({
              success: false,
              error: "Memory system not configured properly.",
            });
          }

          const needsWarmup = !(await memoryClient.isReady());
          if (needsWarmup) {
            return JSON.stringify({ success: false, error: "Memory system is initializing." });
          }

          const mode = args.mode || "help";

          try {
            switch (mode) {
              case "help":
                return JSON.stringify({
                  success: true,
                  message: "Memory System - Three-Layer Workflow",
                  workflow: [
                    { step: 1, command: "search", description: "Get compact index with IDs (~50-100 tokens)" },
                    { step: 2, command: "timeline", description: "Get chronological context around anchor" },
                    { step: 3, command: "get_observations", description: "Fetch full details for filtered IDs" },
                  ],
                  commands: [
                    { command: "add", description: "Store new memory", args: ["content", "type?", "tags?"] },
                    { command: "search", description: "Step 1: Search memories (compact index)", args: ["query", "limit?"] },
                    { command: "timeline", description: "Step 2: Get context around anchor", args: ["anchor?", "query?", "depth_before?", "depth_after?"] },
                    { command: "get_observations", description: "Step 3: Get full details for IDs", args: ["ids (comma-separated)"] },
                    { command: "list", description: "List recent memories", args: ["limit?"] },
                    { command: "forget", description: "Remove memory", args: ["memoryId"] },
                  ],
                });

              case "add":
                if (!args.content)
                  return JSON.stringify({ success: false, error: "content required" });
                const sanitizedContent = stripPrivateContent(args.content);
                if (isFullyPrivate(args.content))
                  return JSON.stringify({ success: false, error: "Private content blocked" });
                const tagInfo = tags.project;
                const parsedTags = args.tags
                  ? args.tags.split(",").map((t) => t.trim().toLowerCase())
                  : undefined;
                const result = await memoryClient.addMemory(sanitizedContent, tagInfo.tag, {
                  type: args.type,
                  tags: parsedTags,
                  metadata: {
                    sessionID: toolCtx.sessionID,
                    projectPath: tagInfo.projectPath,
                    projectName: tagInfo.projectName,
                  },
                });
                return JSON.stringify({
                  success: result.success,
                  message: result.success ? "Memory added" : "Failed to add memory",
                  id: result.id,
                });

              case "search":
                if (!args.query) return JSON.stringify({ success: false, error: "query required" });
                const searchRes = await memoryClient.searchMemories({
                  query: args.query,
                  project: tags.project.tag,
                  limit: args.limit || 10,
                  orderBy: "relevance",
                });
                if (!searchRes.success)
                  return JSON.stringify({ success: false, error: searchRes.error });
                return JSON.stringify({
                  success: true,
                  layer: 1,
                  workflow: "Use returned IDs in timeline or get_observations for details",
                  query: args.query,
                  count: searchRes.results.length,
                  results: searchRes.results.map((r: any) => ({
                    id: r.id,
                    title: r.title,
                    snippet: r.snippet,
                    type: r.type,
                    similarity: r.similarity,
                    date: r.date,
                  })),
                });

              case "timeline":
                const timelineRes = await memoryClient.getTimeline({
                  anchor: args.anchor,
                  query: args.query,
                  depthBefore: args.depth_before || 3,
                  depthAfter: args.depth_after || 3,
                  project: tags.project.tag,
                });
                if (!timelineRes.success)
                  return JSON.stringify({ success: false, error: timelineRes.error });
                return JSON.stringify({
                  success: true,
                  layer: 2,
                  anchor: timelineRes.anchor,
                  before_count: timelineRes.before.length,
                  after_count: timelineRes.after.length,
                  before: timelineRes.before.slice(0, 2).map((o: any) => ({ id: o.id, title: o.title })),
                  after: timelineRes.after.slice(0, 2).map((o: any) => ({ id: o.id, title: o.title })),
                  prompts_count: timelineRes.prompts?.length || 0,
                  summary: timelineRes.summary || "Timeline retrieved successfully",
                });

              case "get_observations":
                if (!args.ids) return JSON.stringify({ success: false, error: "ids required (comma-separated)" });
                const idArray = args.ids.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n));
                if (idArray.length === 0)
                  return JSON.stringify({ success: false, error: "valid ids required" });
                const obsRes = await memoryClient.getObservations({
                  ids: idArray,
                  project: tags.project.tag,
                });
                if (!obsRes.success)
                  return JSON.stringify({ success: false, error: obsRes.error });
                return JSON.stringify({
                  success: true,
                  layer: 3,
                  count: obsRes.count,
                  observations: obsRes.observations.map((o: any) => ({
                    id: o.id,
                    title: o.title,
                    subtitle: o.subtitle,
                    text: o.text,
                    type: o.type,
                    facts: o.facts,
                    files_read: o.files_read,
                    files_modified: o.files_modified,
                    created_at: o.created_at,
                  })),
                });

              case "list":
                const listRes = await memoryClient.listMemories(tags.project.tag, args.limit || 20);
                if (!listRes.success)
                  return JSON.stringify({ success: false, error: listRes.error });
                return JSON.stringify({
                  success: true,
                  count: listRes.memories?.length,
                  memories: listRes.memories?.map((m: any) => ({
                    id: m.id,
                    content: m.summary || m.content?.substring(0, 100),
                    type: m.type,
                    createdAt: m.createdAt,
                  })),
                });

              case "forget":
                if (!args.memoryId)
                  return JSON.stringify({ success: false, error: "memoryId required" });
                const delRes = await memoryClient.deleteMemory(args.memoryId);
                return JSON.stringify({ success: delRes.success, message: delRes.success ? "Memory removed" : "Failed to remove" });

              default:
                return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
            }
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      const event = input.event;
      if (event.type === "session.idle") {
        if (!isConfigured()) return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        if (idleTimeout) clearTimeout(idleTimeout);

        idleTimeout = setTimeout(async () => {
          try {
            await performAutoCapture(ctx, sessionID, directory);
          } catch (error) {
            log("Idle processing error", { error: String(error) });
          } finally {
            idleTimeout = null;
          }
        }, 10000);
      }

      if (event.type === "session.compacted") {
        if (!isConfigured() || !CONFIG.compaction?.enabled) return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        try {
          const memoriesResult = await memoryClient.getMemoriesBySession(
            sessionID,
            tags.project.tag,
            CONFIG.compaction?.memoryLimit || 5
          );

          if (!memoriesResult.success || memoriesResult.results.length === 0) {
            return;
          }

          const memoryContext = formatMemoriesForCompaction(memoriesResult.results);

          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: memoryContext }],
              noReply: true,
            },
          });

          log("Compaction memory injected", { sessionID, count: memoriesResult.results.length });
        } catch (error) {
          log("Compaction handler error", { error: String(error) });
        }
      }

      const completionEvents = new Set([
        "session.completed",
        "session.ended",
        "session.end",
        "session.stopped",
        "session.stop",
        "session.terminated",
      ]);
      if (completionEvents.has(event.type)) {
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        await memoryClient.completeSession({
          sessionId: sessionID,
          project: tags.project.tag,
          status: "completed",
        });
        activeSessions.delete(sessionID);
      }
    },
  };
};

function formatMemoriesForCompaction(memories: any[]): string {
  let output = `## Restored Session Memory\n\n`;
  memories.forEach((m, i) => {
    output += `### Memory ${i + 1}\n${m.memory}\n\n`;
  });
  return output;
}
