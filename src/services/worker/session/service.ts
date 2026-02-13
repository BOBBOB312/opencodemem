import { sessionStore, type CreateSessionInput, type UpdateSessionInput } from "./store.js";
import { summaryGenerator } from "../../sqlite/summaries/generator.js";
import { modeManager } from "../../../domain/mode-manager.js";
import { logger } from "../../logger.js";
import type { SessionMode, DomainContext } from "../../../domain/types.js";

export interface SessionInitOptions {
  sessionId: string;
  project: string;
  mode?: SessionMode;
}

export interface SessionServiceEvents {
  sessionStart: (sessionId: string, project: string) => void;
  sessionEnd: (sessionId: string, status: "completed" | "failed") => void;
  observationAdded: (sessionId: string, observationId: number) => void;
}

export class SessionService {
  private static instance: SessionService | null = null;
  private eventHandlers: Map<string, Set<Function>> = new Map();

  static getInstance(): SessionService {
    if (!SessionService.instance) {
      SessionService.instance = new SessionService();
    }
    return SessionService.instance;
  }

  async initSession(options: SessionInitOptions): Promise<DomainContext> {
    const { sessionId, project, mode = "normal" } = options;

    const session = sessionStore.create({ sessionId, project });
    
    const context = modeManager.initSession(sessionId, project, mode);

    this.emit("sessionStart", sessionId, project);

    logger.info("SESSION", `Initialized session ${sessionId} for project ${project} in ${mode} mode`);

    return context;
  }

  async completeSession(sessionId: string, status: "completed" | "failed" = "completed"): Promise<void> {
    sessionStore.complete(sessionId, status);
    
    try {
      await summaryGenerator.generateFromSession(sessionId);
    } catch (error) {
      logger.error("SESSION", `Failed to generate summary for ${sessionId}`, {
        error: String(error),
      });
    }

    modeManager.endSession(sessionId);
    this.emit("sessionEnd", sessionId, status);

    logger.info("SESSION", `Session ${sessionId} completed with status ${status}`);
  }

  updateSession(sessionId: string, input: UpdateSessionInput): void {
    sessionStore.update(sessionId, input);
  }

  getSession(sessionId: string) {
    return sessionStore.getBySessionId(sessionId);
  }

  getActiveSessions() {
    return sessionStore.getActive();
  }

  on(event: keyof SessionServiceEvents, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: keyof SessionServiceEvents, handler: Function): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: keyof SessionServiceEvents, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (error) {
          logger.error("SESSION", `Event handler error for ${event}`, {
            error: String(error),
          });
        }
      }
    }
  }
}

export const sessionService = SessionService.getInstance();
