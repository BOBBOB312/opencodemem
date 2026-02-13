export interface MemoryType {
  bugfix?: string;
  decision?: string;
  fact?: string;
  workflow?: string;
  config?: string;
  architecture?: string;
  learning?: string;
  general?: string;
}

export type MemoryTypeValue = 
  | "bugfix" 
  | "decision" 
  | "fact" 
  | "workflow" 
  | "config" 
  | "architecture" 
  | "learning" 
  | "general";

export interface Observation {
  id: number;
  session_id: string;
  project: string;
  type: string;
  title: string;
  subtitle?: string;
  text?: string;
  facts?: string;
  files_read?: string;
  files_modified?: string;
  prompt_number: number;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface DBSession {
  id: number;
  session_id: string;
  project: string;
  started_at: string;
  completed_at?: string;
  status: "active" | "completed" | "failed";
}

export interface UserPrompt {
  id: number;
  session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export interface MemoryRecord {
  id: string;
  content: string;
  summary: string;
  type: string;
  tags: string[];
  metadata: Record<string, any>;
  createdAt: string;
}

export interface SearchResult {
  id: string;
  memory: string;
  similarity: number;
  type?: string;
  tags?: string[];
}

export interface TimelineEntry {
  observation: Observation;
  userPrompts: UserPrompt[];
  before: Observation[];
  after: Observation[];
}

export interface InjectContextOptions {
  sessionId: string;
  project: string;
  maxTokens?: number;
  mode?: "first" | "always" | "compaction";
}

export interface Config {
  storagePath: string;
  webServerEnabled: boolean;
  webServerPort: number;
  webServerHost: string;
  autoCaptureEnabled: boolean;
  autoCaptureLanguage: string;
  memoryProvider: string;
  memoryModel: string;
  memoryApiUrl: string;
  memoryApiKey: string;
  memoryTemperature: number;
  showAutoCaptureToasts: boolean;
  showUserProfileToasts: boolean;
  showErrorToasts: boolean;
  userProfileAnalysisInterval: number;
  maxMemories: number;
  chatMessage: {
    enabled: boolean;
    maxMemories: number;
    excludeCurrentSession: boolean;
    maxAgeDays?: number;
    injectOn: "first" | "always";
  };
  compaction: {
    enabled: boolean;
    memoryLimit: number;
  };
  embedding: {
    enabled: boolean;
    model: string;
  };
  privacy: {
    privateTagsEnabled: boolean;
    redactionEnabled: boolean;
  };
  cleanup: {
    maxMemories: number;
    maxAgeDays?: number;
  };
}

export interface ProjectTag {
  tag: string;
  displayName: string;
  projectPath: string;
  projectName: string;
}

export interface UserTag {
  userEmail: string;
  userName: string;
}
