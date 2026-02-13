import { logger } from "../../logger.js";
import { summaryRepository } from "./repository.js";
import { DatabaseManager } from "../schema.js";

export interface ObservationSummary {
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  nextSteps?: string;
}

export class SummaryGenerator {
  private static instance: SummaryGenerator | null = null;

  static getInstance(): SummaryGenerator {
    if (!SummaryGenerator.instance) {
      SummaryGenerator.instance = new SummaryGenerator();
    }
    return SummaryGenerator.instance;
  }

  async generateFromSession(sessionId: string): Promise<void> {
    const db = DatabaseManager.getInstance().getDatabase();

    const observations = db.query(`
      SELECT id, type, title, subtitle, text, facts
      FROM observations
      WHERE session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(sessionId) as any[];

    if (observations.length === 0) {
      logger.warn("SUMMARY", `No observations found for session ${sessionId}`);
      return;
    }

    const summary = this.compileSummary(observations);

    const existing = summaryRepository.getBySessionId(sessionId);
    if (existing.length > 0) {
      summaryRepository.update(existing[0].id, summary);
      logger.info("SUMMARY", `Updated summary for session ${sessionId}`);
    } else {
      summaryRepository.create({ sessionId, ...summary });
      logger.info("SUMMARY", `Created summary for session ${sessionId}`);
    }
  }

  private compileSummary(observations: any[]): ObservationSummary {
    const result: ObservationSummary = {
      request: "",
      investigated: "",
      learned: "",
      completed: "",
      nextSteps: "",
    };

    for (const obs of observations) {
      if (obs.type === "task" || obs.type === "workflow") {
        if (!result.request && obs.text) {
          result.request = obs.text.substring(0, 500);
        }
      }

      if (obs.type === "research" || obs.type === "fact") {
        if (obs.text) {
          result.investigated = (result.investigated + "\n" + obs.text).substring(0, 1000).trim();
        }
      }

      if (obs.type === "learning" || obs.type === "decision") {
        if (obs.text || obs.facts) {
          const content = obs.facts ? JSON.parse(obs.facts).join("; ") : obs.text;
          result.learned = (result.learned + "\n" + content).substring(0, 1000).trim();
        }
      }

      if (obs.type === "bugfix" || obs.type === "completed") {
        if (obs.text) {
          result.completed = (result.completed + "\n" + obs.text).substring(0, 1000).trim();
        }
      }
    }

    return result;
  }

  async generateBatch(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      try {
        await this.generateFromSession(sessionId);
      } catch (error) {
        logger.error("SUMMARY", `Failed to generate summary for ${sessionId}`, {
          error: String(error),
        });
      }
    }
  }
}

export const summaryGenerator = SummaryGenerator.getInstance();
