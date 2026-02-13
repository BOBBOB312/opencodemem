import { logger } from "../logger.js";
import { DatabaseManager } from "../sqlite/schema.js";

export interface HealthCheck {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  message?: string;
  lastCheck: number;
  responseTime?: number;
}

export interface HealthStatus {
  overall: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  checks: HealthCheck[];
}

export class HealthMonitor {
  private static instance: HealthMonitor | null = null;
  private checks: Map<string, HealthCheck> = new Map();
  private checkIntervals: Map<string, NodeJS.Timeout> = new Map();

  static getInstance(): HealthMonitor {
    if (!HealthMonitor.instance) {
      HealthMonitor.instance = new HealthMonitor();
    }
    return HealthMonitor.instance;
  }

  registerCheck(name: string, checkFn: () => Promise<boolean>, intervalMs: number = 30000): void {
    const check: HealthCheck = {
      name,
      status: "healthy",
      lastCheck: Date.now(),
    };
    this.checks.set(name, check);

    const runCheck = async () => {
      const start = performance.now();
      try {
        const result = await checkFn();
        check.status = result ? "healthy" : "unhealthy";
        check.message = result ? "OK" : "Check failed";
      } catch (error) {
        check.status = "unhealthy";
        check.message = String(error);
      }
      check.responseTime = performance.now() - start;
      check.lastCheck = Date.now();
    };

    runCheck();
    const interval = setInterval(runCheck, intervalMs);
    this.checkIntervals.set(name, interval);

    logger.info("HEALTH", `Registered health check: ${name}`);
  }

  unregisterCheck(name: string): void {
    const interval = this.checkIntervals.get(name);
    if (interval) {
      clearInterval(interval);
      this.checkIntervals.delete(name);
    }
    this.checks.delete(name);
  }

  async getStatus(): Promise<HealthStatus> {
    const checks = Array.from(this.checks.values());
    
    let overall: "healthy" | "degraded" | "unhealthy" = "healthy";
    if (checks.some(c => c.status === "unhealthy")) {
      overall = "unhealthy";
    } else if (checks.some(c => c.status === "degraded")) {
      overall = "degraded";
    }

    return {
      overall,
      timestamp: Date.now(),
      checks,
    };
  }

  getCheck(name: string): HealthCheck | undefined {
    return this.checks.get(name);
  }

  getAllChecks(): HealthCheck[] {
    return Array.from(this.checks.values());
  }

  stopAll(): void {
    for (const interval of this.checkIntervals.values()) {
      clearInterval(interval);
    }
    this.checkIntervals.clear();
  }
}

export const healthMonitor = HealthMonitor.getInstance();

export function registerDefaultHealthChecks(): void {
  healthMonitor.registerCheck("database", async () => {
    try {
      const db = DatabaseManager.getInstance().getDatabase();
      db.query("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }, 30000);
}
