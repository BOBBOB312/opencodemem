import type { Observation, TimelineEntry } from "../../types/index.js";
import { DatabaseManager } from "../sqlite/schema.js";

export interface CompiledObservation {
  id: number;
  sessionId: string;
  project: string;
  type: string;
  title: string;
  subtitle?: string;
  content: string;
  facts: string[];
  filesRead: string[];
  filesModified: string[];
  promptNumber: number;
  timestamp: number;
}

export class ObservationCompiler {
  private static instance: ObservationCompiler | null = null;

  static getInstance(): ObservationCompiler {
    if (!ObservationCompiler.instance) {
      ObservationCompiler.instance = new ObservationCompiler();
    }
    return ObservationCompiler.instance;
  }

  compile(observation: Observation): CompiledObservation {
    return {
      id: observation.id,
      sessionId: observation.session_id,
      project: observation.project,
      type: observation.type,
      title: observation.title,
      subtitle: observation.subtitle || undefined,
      content: observation.text || "",
      facts: observation.facts ? JSON.parse(observation.facts) : [],
      filesRead: observation.files_read ? JSON.parse(observation.files_read) : [],
      filesModified: observation.files_modified ? JSON.parse(observation.files_modified) : [],
      promptNumber: observation.prompt_number,
      timestamp: observation.created_at_epoch,
    };
  }

  compileBatch(observations: Observation[]): CompiledObservation[] {
    return observations.map((obs) => this.compile(obs));
  }

  getBySession(sessionId: string): CompiledObservation[] {
    const db = DatabaseManager.getInstance().getDatabase();
    const rows = db.query(`
      SELECT id, session_id, project, type, title, subtitle, text, facts, files_read, files_modified, prompt_number, created_at_epoch
      FROM observations
      WHERE session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(sessionId) as any[];

    return rows.map((row) => this.compile({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      text: row.text,
      facts: row.facts,
      files_read: row.files_read,
      files_modified: row.files_modified,
      prompt_number: row.prompt_number,
      created_at_epoch: row.created_at_epoch,
    }));
  }

  getByProject(project: string, limit: number = 100): CompiledObservation[] {
    const db = DatabaseManager.getInstance().getDatabase();
    const rows = db.query(`
      SELECT id, session_id, project, type, title, subtitle, text, facts, files_read, files_modified, prompt_number, created_at_epoch
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, limit) as any[];

    return rows.map((row) => this.compile({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      text: row.text,
      facts: row.facts,
      files_read: row.files_read,
      files_modified: row.files_modified,
      prompt_number: row.prompt_number,
      created_at_epoch: row.created_at_epoch,
    }));
  }

  buildTimeline(anchorId: number, depthBefore: number = 3, depthAfter: number = 3): TimelineEntry | null {
    const db = DatabaseManager.getInstance().getDatabase();
    
    const anchor = db.query(`
      SELECT id, session_id, project, type, title, subtitle, text, facts, files_read, files_modified, prompt_number, created_at_epoch
      FROM observations WHERE id = ?
    `).get(anchorId) as any;

    if (!anchor) return null;

    const anchorEpoch = anchor.created_at_epoch;

    const before = db.query(`
      SELECT id, session_id, project, type, title, subtitle, text, facts, files_read, files_modified, prompt_number, created_at_epoch
      FROM observations
      WHERE session_id = ? AND created_at_epoch < ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(anchor.session_id, anchorEpoch, depthBefore) as any[];

    const after = db.query(`
      SELECT id, session_id, project, type, title, subtitle, text, facts, files_read, files_modified, prompt_number, created_at_epoch
      FROM observations
      WHERE session_id = ? AND created_at_epoch > ?
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `).all(anchor.session_id, anchorEpoch, depthAfter) as any[];

    const prompts = db.query(`
      SELECT id, session_id, prompt_number, prompt_text, created_at_epoch
      FROM user_prompts
      WHERE session_id = ?
      ORDER BY prompt_number
    `).all(anchor.session_id) as any[];

    return {
      observation: {
        id: anchor.id,
        session_id: anchor.session_id,
        project: anchor.project,
        type: anchor.type,
        title: anchor.title,
        subtitle: anchor.subtitle,
        text: anchor.text,
        facts: anchor.facts,
        files_read: anchor.files_read,
        files_modified: anchor.files_modified,
        prompt_number: anchor.prompt_number,
        created_at_epoch: anchor.created_at_epoch,
      },
      userPrompts: prompts.map((p) => ({
        id: p.id,
        session_id: p.session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        created_at_epoch: p.created_at_epoch,
      })),
      before: before.map((o: any) => ({
        id: o.id,
        session_id: o.session_id,
        project: o.project,
        type: o.type,
        title: o.title,
        subtitle: o.subtitle,
        text: o.text,
        facts: o.facts,
        files_read: o.files_read,
        files_modified: o.files_modified,
        prompt_number: o.prompt_number,
        created_at_epoch: o.created_at_epoch,
      })),
      after: after.map((o: any) => ({
        id: o.id,
        session_id: o.session_id,
        project: o.project,
        type: o.type,
        title: o.title,
        subtitle: o.subtitle,
        text: o.text,
        facts: o.facts,
        files_read: o.files_read,
        files_modified: o.files_modified,
        prompt_number: o.prompt_number,
        created_at_epoch: o.created_at_epoch,
      })),
    };
  }
}

export const observationCompiler = ObservationCompiler.getInstance();
