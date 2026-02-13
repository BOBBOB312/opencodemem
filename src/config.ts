import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { z } from "zod";

const ConfigSchema = z.object({
  storagePath: z.string().optional(),
  webServerEnabled: z.boolean().optional(),
  webServerPort: z.number().optional(),
  webServerHost: z.string().optional(),
  autoCaptureEnabled: z.boolean().optional(),
  autoCaptureLanguage: z.string().optional(),
  memoryProvider: z.string().optional(),
  memoryModel: z.string().optional(),
  memoryApiUrl: z.string().optional(),
  memoryApiKey: z.string().optional(),
  memoryTemperature: z.number().optional(),
  showAutoCaptureToasts: z.boolean().optional(),
  showUserProfileToasts: z.boolean().optional(),
  showErrorToasts: z.boolean().optional(),
  userProfileAnalysisInterval: z.number().optional(),
  maxMemories: z.number().optional(),
  chatMessage: z.object({
    enabled: z.boolean().optional(),
    maxMemories: z.number().optional(),
    excludeCurrentSession: z.boolean().optional(),
    maxAgeDays: z.number().optional(),
    injectOn: z.enum(["first", "always"]).optional(),
  }).optional(),
  compaction: z.object({
    enabled: z.boolean().optional(),
    memoryLimit: z.number().optional(),
  }).optional(),
  embedding: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
  }).optional(),
  privacy: z.object({
    privateTagsEnabled: z.boolean().optional(),
    redactionEnabled: z.boolean().optional(),
  }).optional(),
  cleanup: z.object({
    maxMemories: z.number().optional(),
    maxAgeDays: z.number().optional(),
  }).optional(),
});

type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = {
  storagePath: join(homedir(), ".opencode-mem", "data"),
  webServerEnabled: true,
  webServerPort: 4747,
  webServerHost: "127.0.0.1",
  autoCaptureEnabled: true,
  autoCaptureLanguage: "auto",
  memoryProvider: "openai-chat",
  memoryModel: "gpt-4o-mini",
  memoryApiUrl: "https://api.openai.com/v1",
  memoryApiKey: "",
  memoryTemperature: 0.3,
  showAutoCaptureToasts: true,
  showUserProfileToasts: true,
  showErrorToasts: true,
  userProfileAnalysisInterval: 10,
  maxMemories: 10,
  chatMessage: {
    enabled: true,
    maxMemories: 3,
    excludeCurrentSession: true,
    maxAgeDays: undefined,
    injectOn: "first",
  },
  compaction: {
    enabled: true,
    memoryLimit: 5,
  },
  embedding: {
    enabled: false,
    model: "Xenova/nomic-embed-text-v1",
  },
  privacy: {
    privateTagsEnabled: true,
    redactionEnabled: true,
  },
  cleanup: {
    maxMemories: 100,
    maxAgeDays: undefined,
  },
};

let configInstance: Config | null = null;

function resolvePath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

function resolveConfigValue(value: any): any {
  if (typeof value === "string" && value.startsWith("~")) {
    return resolvePath(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const resolved: any = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveConfigValue(v);
    }
    return resolved;
  }
  return value;
}

function parseJsonc(content: string): any {
  const lines = content.split("\n");
  const cleanedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) {
      return "";
    }
    if (trimmed.startsWith("/*")) {
      return "";
    }
    return line;
  });
  
  let result = cleanedLines.join("\n");
  
  result = result.replace(/\/\/.*$/gm, "");
  
  return JSON.parse(result);
}

function loadConfig(): Config {
  if (configInstance) {
    return configInstance;
  }

  const configPath = join(homedir(), ".config", "opencode", "opencode-mem.jsonc");
  const configPathAlt = join(homedir(), ".config", "opencode-mem.jsonc");

  let userConfig: Partial<Config> = {};

  const paths = [configPath, configPathAlt];
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const parsed = parseJsonc(content);
        userConfig = resolveConfigValue(parsed);
        break;
      } catch (e) {
        console.error(`Failed to load config from ${path}:`, e);
      }
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig) as Config;
  
  try {
    configInstance = ConfigSchema.parse(merged);
  } catch (e) {
    console.warn("Config validation failed, using defaults:", e);
    configInstance = DEFAULT_CONFIG;
  }
  
  return configInstance;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === "object" &&
        source[key] !== null &&
        !Array.isArray(source[key])
      ) {
        result[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  return result;
}

export const CONFIG = loadConfig();

export function isConfigured(): boolean {
  return !!CONFIG;
}

export function getConfig(): Config {
  return CONFIG;
}

export function resetConfig(): void {
  configInstance = null;
}

export type { Config };
