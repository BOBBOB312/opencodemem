import { DatabaseManager } from "../schema.js";
import { logger } from "../../logger.js";
import type { Summary } from "../../../types/index.js";

export interface CreateSummaryInput {
  sessionId: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  nextSteps?: string;
}

export class SummaryRepository {
  private static instance: SummaryRepository | null = null;

  static getInstance(): SummaryRepository {
    if (!SummaryRepository.instance) {
      SummaryRepository.instance = new SummaryRepository();
    }
    return SummaryRepository.instance;
  }

  create(input: CreateSummaryInput): Summary {
    const db = DatabaseManager.getInstance().getDatabase();
    const id = db.query(`
      INSERT INTO summaries (session_id, request, investigated, learned, completed, next_steps, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.request || null,
      input.investigated || null,
      input.learned || null,
      input.completed || null,
      input.nextSteps || null,
      Date.now()
    ).lastInsertRowid;

    return this.getById(Number(id))!;
  }

  getById(id: number): Summary | undefined {
    const db = DatabaseManager.getInstance().getDatabase();
    const row = db.query(`
      SELECT id, session_id, request, investigated, learned, completed, next_steps, created_at_epoch
      FROM summaries WHERE id = ?
    `).get(id) as any;

    if (!row) return undefined;

    return {
      id: row.id,
      session_id: row.session_id,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      next_steps: row.next_steps,
      created_at_epoch: row.created_at_epoch,
    };
  }

  getBySessionId(sessionId: string): Summary[] {
    const db = DatabaseManager.getInstance().getDatabase();
    const rows = db.query(`
      SELECT id, session_id, request, investigated, learned, completed, next_steps, created_at_epoch
      FROM summaries WHERE session_id = ?
      ORDER BY created_at_epoch DESC
    `).all(sessionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      next_steps: row.next_steps,
      created_at_epoch: row.created_at_epoch,
    }));
  }

  getLatestByProject(project: string, limit: number = 5): Summary[] {
    const db = DatabaseManager.getInstance().getDatabase();
    const rows = db.query(`
      SELECT s.id, s.session_id, s.request, s.investigated, s.learned, s.completed, s.next_steps, s.created_at_epoch
      FROM summaries s
      JOIN sessions se ON s.session_id = se.session_id
      WHERE se.project = ?
      ORDER BY s.created_at_epoch DESC
      LIMIT ?
    `).all(project, limit) as any[];

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      next_steps: row.next_steps,
      created_at_epoch: row.created_at_epoch,
    }));
  }

  update(id: number, updates: Partial<CreateSummaryInput>): void {
    const db = DatabaseManager.getInstance().getDatabase();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.request !== undefined) {
      fields.push("request = ?");
      values.push(updates.request);
    }
    if (updates.investigated !== undefined) {
      fields.push("investigated = ?");
      values.push(updates.investigated);
    }
    if (updates.learned !== undefined) {
      fields.push("learned = ?");
      values.push(updates.learned);
    }
    if (updates.completed !== undefined) {
      fields.push("completed = ?");
      values.push(updates.completed);
    }
    if (updates.nextSteps !== undefined) {
      fields.push("next_steps = ?");
      values.push(updates.nextSteps);
    }

    if (fields.length === 0) return;

    values.push(id);
    db.query(`UPDATE summaries SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  delete(id: number): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query("DELETE FROM summaries WHERE id = ?").run(id);
  }

  deleteBySessionId(sessionId: string): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query("DELETE FROM summaries WHERE session_id = ?").run(sessionId);
  }
}

export const summaryRepository = SummaryRepository.getInstance();
