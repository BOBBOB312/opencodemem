export type SessionMode = "normal" | "compaction" | "analysis";

export interface ModeConfig {
  name: SessionMode;
  maxContextTokens: number;
  autoSave: boolean;
  observationCapture: boolean;
  summaryGeneration: boolean;
}

export const MODE_CONFIGS: Record<SessionMode, ModeConfig> = {
  normal: {
    name: "normal",
    maxContextTokens: 8000,
    autoSave: true,
    observationCapture: true,
    summaryGeneration: false,
  },
  compaction: {
    name: "compaction",
    maxContextTokens: 4000,
    autoSave: true,
    observationCapture: true,
    summaryGeneration: true,
  },
  analysis: {
    name: "analysis",
    maxContextTokens: 12000,
    autoSave: true,
    observationCapture: true,
    summaryGeneration: true,
  },
};

export interface DomainContext {
  sessionId: string;
  project: string;
  mode: SessionMode;
  startTime: number;
  promptCount: number;
  observationCount: number;
}

export interface SessionStatus {
  sessionId: string;
  project: string;
  mode: SessionMode;
  status: "active" | "completed" | "failed";
  startedAt: Date;
  completedAt?: Date;
  promptCount: number;
  observationCount: number;
}

export type EventType = 
  | "session_start"
  | "session_end"
  | "observation"
  | "user_prompt"
  | "memory_saved"
  | "summary_generated"
  | "context_injected";

export interface DomainEvent {
  id: string;
  type: EventType;
  sessionId: string;
  project: string;
  timestamp: number;
  payload: Record<string, unknown>;
}
