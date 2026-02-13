import { DatabaseManager } from "./services/sqlite/schema.js";
import { observationCompiler, getFormatter } from "./services/context/index.js";
import { sessionStore } from "./services/worker/session/store.js";
import { summaryRepository } from "./services/sqlite/summaries/repository.js";

export interface ContextOptions {
  maxTokens?: number;
  project?: string;
  sessionId?: string;
  includeObservations?: boolean;
  includeSummary?: boolean;
  formatter?: string;
}

export interface GeneratedContext {
  content: string;
  tokens: number;
  observations: number;
  source: "observations" | "summary" | "empty";
}

export class Context {
  private static instance: Context | null = null;

  static getInstance(): Context {
    if (!Context.instance) {
      Context.instance = new Context();
    }
    return Context.instance;
  }

  async generate(options: ContextOptions = {}): Promise<GeneratedContext> {
    const {
      maxTokens = 8000,
      project,
      sessionId,
      includeObservations = true,
      includeSummary = false,
      formatter = "compact",
    } = options;

    if (!project) {
      return {
        content: "",
        tokens: 0,
        observations: 0,
        source: "empty",
      };
    }

    let observations: any[] = [];

    if (includeObservations) {
      observations = observationCompiler.getByProject(project, 50);
    }

    let summaryText = "";

    if (includeSummary && sessionId) {
      const summaries = summaryRepository.getBySessionId(sessionId);
      if (summaries.length > 0) {
        const summary = summaries[0];
        summaryText = `## Session Summary\n\n`;
        if (summary.request) summaryText += `**Request:** ${summary.request}\n`;
        if (summary.investigated) summaryText += `**Investigated:** ${summary.investigated}\n`;
        if (summary.learned) summaryText += `**Learned:** ${summary.learned}\n`;
        if (summary.completed) summaryText += `**Completed:** ${summary.completed}\n`;
        if (summary.next_steps) summaryText += `**Next Steps:** ${summary.next_steps}\n`;
      }
    }

    const formatFn = getFormatter(formatter);
    const formattedObservations = formatFn.format(observations, {
      maxLength: 500,
      includeTimestamp: false,
    });

    const content = summaryText
      ? `${summaryText}\n\n${formattedObservations}`
      : formattedObservations;

    const tokens = Math.ceil(content.length / 4);

    return {
      content,
      tokens,
      observations: observations.length,
      source: observations.length > 0 ? "observations" : "empty",
    };
  }

  async generateForSession(sessionId: string, project: string): Promise<GeneratedContext> {
    DatabaseManager.getInstance().getDatabase();

    const session = sessionStore.getBySessionId(sessionId);
    if (!session) {
      return {
        content: "",
        tokens: 0,
        observations: 0,
        source: "empty",
      };
    }

    return this.generate({
      project,
      sessionId,
      includeObservations: true,
      includeSummary: true,
    });
  }
}

export async function generateContext(options: ContextOptions): Promise<GeneratedContext> {
  return Context.getInstance().generate(options);
}

export async function generateSessionContext(sessionId: string, project: string): Promise<GeneratedContext> {
  return Context.getInstance().generateForSession(sessionId, project);
}

export { Context as ContextGenerator };
