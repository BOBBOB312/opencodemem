import { getConfig, type Config } from "../../config.js";

export interface ContextConfig {
  maxTokens: number;
  maxMemories: number;
  excludeCurrentSession: boolean;
  maxAgeDays?: number;
  injectOn: "first" | "always";
  mode: "first" | "always" | "compaction";
}

export class ContextConfigLoader {
  private static instance: ContextConfigLoader | null = null;
  private config: ContextConfig | null = null;

  static getInstance(): ContextConfigLoader {
    if (!ContextConfigLoader.instance) {
      ContextConfigLoader.instance = new ContextConfigLoader();
    }
    return ContextConfigLoader.instance;
  }

  load(project?: string): ContextConfig {
    const config = getConfig();
    const chatConfig = config.chatMessage || {};

    return {
      maxTokens: 8000,
      maxMemories: chatConfig.maxMemories || 3,
      excludeCurrentSession: chatConfig.excludeCurrentSession ?? true,
      maxAgeDays: chatConfig.maxAgeDays,
      injectOn: chatConfig.injectOn || "first",
      mode: "first",
    };
  }

  loadForSession(sessionId: string, project: string): ContextConfig {
    const baseConfig = this.load(project);
    return baseConfig;
  }

  getConfig(): ContextConfig {
    if (!this.config) {
      this.config = this.load();
    }
    return this.config;
  }

  updateConfig(updates: Partial<ContextConfig>): void {
    if (!this.config) {
      this.config = this.load();
    }
    this.config = { ...this.config, ...updates };
  }

  resetConfig(): void {
    this.config = null;
  }
}

export const contextConfigLoader = ContextConfigLoader.getInstance();
