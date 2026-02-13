import { getConfig, type Config } from "../../config.js";
import { logger } from "../logger.js";

export interface RuntimeSettings {
  context: {
    maxTokens: number;
    maxMemories: number;
    excludeCurrentSession: boolean;
    injectOn: "first" | "always";
  };
  search: {
    useSemantic: boolean;
    useFTS: boolean;
    semanticLimit: number;
  };
  capture: {
    autoCaptureEnabled: boolean;
    captureLanguage: string;
  };
  privacy: {
    privateTagsEnabled: boolean;
    redactionEnabled: boolean;
  };
  features: {
    sseEnabled: boolean;
    compactionEnabled: boolean;
  };
}

export class SettingsManager {
  private static instance: SettingsManager | null = null;
  private settings: RuntimeSettings;
  private listeners: Set<(settings: RuntimeSettings) => void> = new Set();

  static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  constructor() {
    this.settings = this.loadFromConfig();
  }

  private loadFromConfig(): RuntimeSettings {
    const config = getConfig();

    return {
      context: {
        maxTokens: 8000,
        maxMemories: config.chatMessage?.maxMemories || 3,
        excludeCurrentSession: config.chatMessage?.excludeCurrentSession ?? true,
        injectOn: config.chatMessage?.injectOn || "first",
      },
      search: {
        useSemantic: config.embedding?.enabled || false,
        useFTS: true,
        semanticLimit: 20,
      },
      capture: {
        autoCaptureEnabled: config.autoCaptureEnabled ?? true,
        captureLanguage: config.autoCaptureLanguage || "auto",
      },
      privacy: {
        privateTagsEnabled: config.privacy?.privateTagsEnabled ?? true,
        redactionEnabled: config.privacy?.redactionEnabled ?? true,
      },
      features: {
        sseEnabled: true,
        compactionEnabled: config.compaction?.enabled ?? true,
      },
    };
  }

  get(): RuntimeSettings {
    return { ...this.settings };
  }

  getContextSettings(): RuntimeSettings["context"] {
    return { ...this.settings.context };
  }

  getSearchSettings(): RuntimeSettings["search"] {
    return { ...this.settings.search };
  }

  getCaptureSettings(): RuntimeSettings["capture"] {
    return { ...this.settings.capture };
  }

  getPrivacySettings(): RuntimeSettings["privacy"] {
    return { ...this.settings.privacy };
  }

  update(updates: Partial<RuntimeSettings>): void {
    this.settings = this.deepMerge(this.settings, updates);
    this.notifyListeners();
    logger.info("SETTINGS", "Runtime settings updated");
  }

  updateContext(updates: Partial<RuntimeSettings["context"]>): void {
    this.settings.context = { ...this.settings.context, ...updates };
    this.notifyListeners();
  }

  updateSearch(updates: Partial<RuntimeSettings["search"]>): void {
    this.settings.search = { ...this.settings.search, ...updates };
    this.notifyListeners();
  }

  updateCapture(updates: Partial<RuntimeSettings["capture"]>): void {
    this.settings.capture = { ...this.settings.capture, ...updates };
    this.notifyListeners();
  }

  updatePrivacy(updates: Partial<RuntimeSettings["privacy"]>): void {
    this.settings.privacy = { ...this.settings.privacy, ...updates };
    this.notifyListeners();
  }

  updateFeatures(updates: Partial<RuntimeSettings["features"]>): void {
    this.settings.features = { ...this.settings.features, ...updates };
    this.notifyListeners();
  }

  reset(): void {
    this.settings = this.loadFromConfig();
    this.notifyListeners();
    logger.info("SETTINGS", "Runtime settings reset to defaults");
  }

  onChange(listener: (settings: RuntimeSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.settings);
      } catch (error) {
        logger.error("SETTINGS", "Listener error", {
          error: String(error),
        });
      }
    }
  }

  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] !== undefined) {
        if (
          typeof source[key] === "object" &&
          source[key] !== null &&
          !Array.isArray(source[key])
        ) {
          result[key] = this.deepMerge(target[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }
    return result;
  }
}

export const settingsManager = SettingsManager.getInstance();
