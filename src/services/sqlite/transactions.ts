import { Database } from "bun:sqlite";
import { DatabaseManager } from "./schema.js";

export type TransactionCallback<T> = (tx: Database) => T;

export interface TransactionOptions {
  isolationLevel?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";
}

export class TransactionManager {
  private static instance: TransactionManager | null = null;

  static getInstance(): TransactionManager {
    if (!TransactionManager.instance) {
      TransactionManager.instance = new TransactionManager();
    }
    return TransactionManager.instance;
  }

  runTransaction<T>(fn: TransactionCallback<T>, options: TransactionOptions = {}): T {
    const db = DatabaseManager.getInstance().getDatabase();
    const runner = db.transaction(() => fn(db));
    return runner();
  }

  runTransactionAsync<T>(fn: (tx: Database) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const db = DatabaseManager.getInstance().getDatabase();
    const runner = db.transaction(() => fn(db));
    return runner();
  }

  withTransaction<T>(fn: TransactionCallback<T>): T {
    return this.runTransaction(fn);
  }

  withTransactionAsync<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.runTransactionAsync(fn);
  }

  getTransactionLevel(db: Database): string {
    return db.query("SELECT transaction()").get() as any || "none";
  }
}

export const transactionManager = TransactionManager.getInstance();

export function withTransaction<T>(fn: TransactionCallback<T>): T {
  return transactionManager.runTransaction(fn);
}

export async function withTransactionAsync<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
  return transactionManager.runTransactionAsync(fn);
}
