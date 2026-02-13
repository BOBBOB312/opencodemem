import type { PluginInput } from "@opencode-ai/plugin";
import { getConfig } from "../config.js";
import { getTags } from "./tags.js";
import { memoryClient } from "./worker-client.js";
import { logger } from "./logger.js";
import { sanitizeForStorage } from "./privacy.js";

interface ToolInfo {
  name: string;
  input: any;
  output?: any;
}

export type AutoCaptureTrigger = "idle" | "first_prompt" | "session_start" | "compaction";

export interface AutoCaptureOptions {
  trigger?: AutoCaptureTrigger;
  forceWithoutTools?: boolean;
  sourceText?: string;
}

function getTriggerLabel(trigger: AutoCaptureTrigger): string {
  switch (trigger) {
    case "session_start":
      return "session start";
    case "first_prompt":
      return "first prompt";
    case "compaction":
      return "compaction";
    case "idle":
    default:
      return "idle";
  }
}

function getFallbackTitle(trigger: AutoCaptureTrigger): string {
  switch (trigger) {
    case "session_start":
      return "Session started";
    case "first_prompt":
      return "First prompt captured";
    case "compaction":
      return "Compaction checkpoint";
    case "idle":
    default:
      return "Idle checkpoint";
  }
}

function extractFilePaths(toolInput: any): string[] {
  const files: string[] = [];
  
  if (toolInput.file_path) {
    files.push(toolInput.file_path);
  }
  if (toolInput.file_pathes) {
    files.push(...toolInput.file_pathes);
  }
  if (toolInput.file_paths) {
    files.push(...toolInput.file_paths);
  }
  if (toolInput.path) {
    files.push(toolInput.path);
  }
  if (toolInput.paths) {
    files.push(...toolInput.paths);
  }
  
  return [...new Set(files)];
}

function inferObservationType(toolName: string, toolInput: any): string {
  const name = toolName.toLowerCase();
  
  if (name.includes("read") || name.includes("glob") || name.includes("find")) {
    return "fact";
  }
  if (name.includes("edit") || name.includes("write") || name.includes("create")) {
    return "workflow";
  }
  if (name.includes("bash") && (toolInput.command?.includes("git") || toolInput.command?.includes("npm"))) {
    return "workflow";
  }
  if (name.includes("search") || name.includes("grep")) {
    return "fact";
  }
  
  return "general";
}

function generateObservationTitle(toolName: string, toolInput: any): string {
  const files = extractFilePaths(toolInput);
  if (files.length > 0) {
    const file = files[0];
    const basename = file.split("/").pop() || file;
    return `${toolName} on ${basename}`;
  }
  return `${toolName} executed`;
}

function extractFacts(toolOutput: any): string[] {
  const facts: string[] = [];
  
  if (!toolOutput) return facts;
  
  if (typeof toolOutput === "string") {
    const lines = toolOutput.split("\n").filter(l => l.trim().length > 0);
    if (lines.length <= 3) {
      facts.push(...lines);
    }
  }
  
  return facts;
}

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  projectPath: string,
  options: AutoCaptureOptions = {}
): Promise<void> {
  const config = getConfig();
  const trigger = options.trigger || "idle";
  
  if (!config.autoCaptureEnabled) {
    return;
  }

  try {
    const tags = getTags(projectPath);

    const messagesResponse = await ctx.client.session.messages({
      path: { id: sessionID },
    });

    const messages = messagesResponse.data || [];

    const recentTools = messages
      .filter((m) => m.info?.role === "assistant" && m.parts)
      .slice(-10)
      .flatMap((m) => 
        m.parts
          .filter((p: any) => p.type === "toolUse")
          .map((p: any) => ({
            name: p.name,
            input: p.input,
          }))
      );

    if (recentTools.length === 0 && !options.forceWithoutTools) {
      return;
    }

    const latestUserMessage = options.sourceText || messages
      .filter((m) => m.info?.role === "user" && m.parts)
      .flatMap((m) =>
        m.parts
          .filter((p: any) => p.type === "text" && p.synthetic !== true)
          .map((p: any) => p.text)
      )
      .filter((text: string) => !!text && text.trim().length > 0)
      .slice(-1)[0];

    let toolNames = "";
    let filesRead: string[] = [];
    let obsType = "workflow";
    let title = getFallbackTitle(trigger);
    let subtitle = `Trigger: ${getTriggerLabel(trigger)}`;
    let facts: string[] = [];
    let content = `Session checkpoint captured during ${getTriggerLabel(trigger)}.`;

    if (recentTools.length > 0) {
      const uniqueTools = [...new Set(recentTools.map((t: ToolInfo) => t.name))];
      toolNames = uniqueTools.join(", ");
      filesRead = [...new Set(
        recentTools.flatMap((t: ToolInfo) => extractFilePaths(t.input))
      )];
      obsType = inferObservationType(recentTools[0].name, recentTools[0].input);
      title = generateObservationTitle(uniqueTools[0], recentTools[0]?.input);
      subtitle = `Trigger: ${getTriggerLabel(trigger)} | Tools: ${toolNames}`;
      facts = recentTools.flatMap((t: ToolInfo) => extractFacts(t.input));
      content = `Triggered by ${getTriggerLabel(trigger)}. Session used tools: ${toolNames}. Working with ${filesRead.length} files.`;
    } else if (latestUserMessage) {
      const compactMessage = latestUserMessage.replace(/\s+/g, " ").trim().slice(0, 300);
      facts = [compactMessage];
      content = `Triggered by ${getTriggerLabel(trigger)}. User intent snapshot: ${compactMessage}`;
    }

    const sanitized = sanitizeForStorage(content);

    await memoryClient.ingestEvent({
      eventType: "observation",
      sessionId: sessionID,
      project: tags.project.tag,
      data: {
        type: obsType,
        title,
        subtitle,
        text: sanitized,
        facts: facts.slice(0, 8),
        files_read: filesRead.slice(0, 20),
        files_modified: [],
        promptNumber: 0,
      },
    });

    await memoryClient.addMemory(sanitized, tags.project.tag, {
      type: obsType,
      metadata: {
        sessionID,
        trigger,
        toolCount: recentTools.length,
        toolNames,
        filesRead: filesRead.slice(0, 10),
        filesModified: [],
      },
    });

    logger.info("AUTO_CAPTURE", "Captured session activity", { 
      sessionID, 
      trigger,
      toolCount: recentTools.length,
      type: obsType,
    });
  } catch (error) {
    logger.error("AUTO_CAPTURE", "Failed to capture session", {}, error as Error);
  }
}

export async function captureToolUse(
  sessionID: string,
  project: string,
  toolName: string,
  toolInput: any,
  toolOutput: any,
  promptNumber: number
): Promise<void> {
  try {
    const obsType = inferObservationType(toolName, toolInput);
    const title = generateObservationTitle(toolName, toolInput);
    const filesRead = extractFilePaths(toolInput);
    const facts = extractFacts(toolOutput);

    const content = `Used ${toolName}: ${title}`;

    const sanitized = sanitizeForStorage(content);

    await memoryClient.ingestEvent({
      eventType: "observation",
      sessionId: sessionID,
      project,
      data: {
        type: obsType,
        title,
        subtitle: `Tool: ${toolName}`,
        text: sanitized,
        facts: facts.slice(0, 8),
        files_read: filesRead,
        files_modified: [],
        promptNumber,
      },
    });

    await memoryClient.addMemory(sanitized, project, {
      type: obsType,
      metadata: {
        sessionID,
        toolName,
        promptNumber,
        filesRead,
        filesModified: [],
        facts: facts.slice(0, 5),
      },
    });
  } catch (error) {
    logger.error("AUTO_CAPTURE", "Failed to capture tool use", { toolName }, error as Error);
  }
}
