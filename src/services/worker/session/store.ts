import { DatabaseManager } from "../../sqlite/schema.js";
import type { DBSession } from "../../../types/index.js";
import { logger } from "../../logger.js";

export interface CreateSessionInput {
  sessionId: string;
  project: string;
}

export interface UpdateSessionInput {
  status?: "active" | "completed" | "failed";
  completedAt?: string;
}

export class SessionStore {
  private static instance: SessionStore | null = null;

  static getInstance(): SessionStore {
    if (!SessionStore.instance) {
      SessionStore.instance = new SessionStore();
    }
    return SessionStore.instance;
  }

  create(input: CreateSessionInput): DBSession {
    const db = DatabaseManager.getInstance().getDatabase();
    const now = new Date().toISOString();

    db.query(`
      INSERT OR REPLACE INTO sessions (session_id, project, started_at, status)
      VALUES (?, ?, ?, 'active')
    `).run(input.sessionId, input.project, now);

    return this.getBySessionId(input.sessionId)!;
  }

  getBySessionId(sessionId: string): DBSession | undefined {
    const db = DatabaseManager.getInstance().getDatabase();
    const row = db.query(`
      SELECT id, session_id, project, started_at, completed_at, status
      FROM sessions WHERE session_id = ?
    `).get(sessionId) as any;

    if (!row) return undefined;

    return {
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      started_at: row.started_at,
      completed_at: row.completed_at,
      status: row.status,
    };
  }

  getByProject(project: string, limit: number = 50): DBSession[] {
    const db = DatabaseManager.getInstance().getDatabase();
    const rows = db.query(`
      SELECT id, session_id, project, started_at, completed_at, status
      FROM sessions WHERE project = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(project, limit) as any[];

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      started_at: row.started_at,
      completed_at: row.completed_at,
      status: row.status,
    }));
  }

  getActive(): DBSession[] {
    const db = DatabaseManager.getInstance().getDatabase();
    const rows = db.query(`
      SELECT id, session_id, project, started_at, completed_at, status
      FROM sessions WHERE status = 'active'
      ORDER BY started_at DESC
    `).all() as any[];

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      started_at: row.started_at,
      completed_at: row.completed_at,
      status: row.status,
    }));
  }

  update(sessionId: string, input: UpdateSessionInput): void {
    const db = DatabaseManager.getInstance().getDatabase();
    const fields: string[] = [];
    const values: any[] = [];

    if (input.status) {
      fields.push("status = ?");
      values.push(input.status);
    }
    if (input.completedAt) {
      fields.push("completed_at = ?");
      values.push(input.completedAt);
    }

    if (fields.length === 0) return;

    values.push(sessionId);
    db.query(`UPDATE sessions SET ${fields.join(", ")} WHERE session_id = ?`).run(...values);
  }

  complete(sessionId: string, status: "completed" | "failed" = "completed"): void {
    const db = DatabaseManager.getInstance().getDatabase();
    const now = new Date().toISOString();

    db.query(`
      UPDATE sessions SET status = ?, completed_at = ? WHERE session_id = ?
    `).run(status, now, sessionId);

    logger.info("SESSION", `Session ${sessionId} completed with status ${status}`);
  }

  delete(sessionId: string): void {
    const db = DatabaseManager.getInstance().getDatabase();
    db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  deleteByProject(project: string): number {
    const db = DatabaseManager.getInstance().getDatabase();
    const result = db.query("DELETE FROM sessions WHERE project = ?").run(project);
    return result.changes;
  }

  getStats(project?: string): { total: number; active: number; completed: number; failed: number } {
    const db = DatabaseManager.getInstance().getDatabase();

    const total = project
      ? ((db.query(`SELECT COUNT(*) as count FROM sessions WHERE project = ?`).get(project) as any)
          ?.count || 0)
      : ((db.query(`SELECT COUNT(*) as count FROM sessions`).get() as any)?.count || 0);

    const active = project
      ? ((db
          .query(`SELECT COUNT(*) as count FROM sessions WHERE project = ? AND status = 'active'`)
          .get(project) as any)?.count || 0)
      : ((db.query(`SELECT COUNT(*) as count FROM sessions WHERE status = 'active'`).get() as any)
          ?.count || 0);

    const completed = project
      ? ((db
          .query(`SELECT COUNT(*) as count FROM sessions WHERE project = ? AND status = 'completed'`)
          .get(project) as any)?.count || 0)
      : ((db.query(`SELECT COUNT(*) as count FROM sessions WHERE status = 'completed'`).get() as any)
          ?.count || 0);

    const failed = project
      ? ((db
          .query(`SELECT COUNT(*) as count FROM sessions WHERE project = ? AND status = 'failed'`)
          .get(project) as any)?.count || 0)
      : ((db.query(`SELECT COUNT(*) as count FROM sessions WHERE status = 'failed'`).get() as any)
          ?.count || 0);

    return { total, active, completed, failed };
  }
}

export const sessionStore = SessionStore.getInstance();
