import { SessionMode, MODE_CONFIGS, ModeConfig, DomainContext } from "./types.js";

export class ModeManager {
  private static instance: ModeManager | null = null;
  private sessionModes: Map<string, SessionMode> = new Map();
  private sessionContexts: Map<string, DomainContext> = new Map();

  static getInstance(): ModeManager {
    if (!ModeManager.instance) {
      ModeManager.instance = new ModeManager();
    }
    return ModeManager.instance;
  }

  getMode(sessionId: string): SessionMode {
    return this.sessionModes.get(sessionId) || "normal";
  }

  setMode(sessionId: string, mode: SessionMode): void {
    this.sessionModes.set(sessionId, mode);
  }

  getModeConfig(sessionId: string): ModeConfig {
    const mode = this.getMode(sessionId);
    return MODE_CONFIGS[mode];
  }

  initSession(sessionId: string, project: string, mode: SessionMode = "normal"): DomainContext {
    const context: DomainContext = {
      sessionId,
      project,
      mode,
      startTime: Date.now(),
      promptCount: 0,
      observationCount: 0,
    };
    this.sessionContexts.set(sessionId, context);
    this.sessionModes.set(sessionId, mode);
    return context;
  }

  getContext(sessionId: string): DomainContext | undefined {
    return this.sessionContexts.get(sessionId);
  }

  incrementPromptCount(sessionId: string): void {
    const context = this.sessionContexts.get(sessionId);
    if (context) {
      context.promptCount += 1;
    }
  }

  incrementObservationCount(sessionId: string): void {
    const context = this.sessionContexts.get(sessionId);
    if (context) {
      context.observationCount += 1;
    }
  }

  endSession(sessionId: string): void {
    this.sessionContexts.delete(sessionId);
  }

  getActiveSessions(): DomainContext[] {
    return Array.from(this.sessionContexts.values());
  }

  switchMode(sessionId: string, newMode: SessionMode): void {
    this.sessionModes.set(sessionId, newMode);
    const context = this.sessionContexts.get(sessionId);
    if (context) {
      context.mode = newMode;
    }
  }
}

export const modeManager = ModeManager.getInstance();
