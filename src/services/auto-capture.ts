import type { PluginInput } from "@opencode-ai/plugin";
import { getConfig } from "../config.js";
import { getTags } from "./tags.js";
import { memoryClient } from "./worker-client.js";
import { logger } from "./logger.js";
import { sanitizeForStorage, stripPrivateContent } from "./privacy.js";

interface ToolInfo {
  name: string;
  input: any;
  output?: any;
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
  projectPath: string
): Promise<void> {
  const config = getConfig();
  
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

    if (recentTools.length === 0) {
      return;
    }

    const uniqueTools = [...new Set(recentTools.map((t: ToolInfo) => t.name))];
    const toolNames = uniqueTools.join(", ");
    
    const filesRead = [...new Set(
      recentTools.flatMap((t: ToolInfo) => extractFilePaths(t.input))
    )];

    const obsType = recentTools.length > 0 
      ? inferObservationType(recentTools[0].name, recentTools[0].input)
      : "workflow";

    const title = generateObservationTitle(uniqueTools[0], recentTools[0]?.input);
    const facts = recentTools.flatMap((t: ToolInfo) => extractFacts(t.input));

    const content = `Session used tools: ${toolNames}. Working with ${filesRead.length} files.`;

    const sanitized = sanitizeForStorage(content);

    await memoryClient.ingestEvent({
      eventType: "observation",
      sessionId: sessionID,
      project: tags.project.tag,
      data: {
        type: obsType,
        title,
        subtitle: `Tools: ${toolNames}`,
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
        toolCount: recentTools.length,
        toolNames,
        filesRead: filesRead.slice(0, 10),
        filesModified: [],
      },
    });

    logger.info("AUTO_CAPTURE", "Captured session activity", { 
      sessionID, 
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
