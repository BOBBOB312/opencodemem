import { logger } from "../logger.js";

export type ShutdownPhase = "init" | "draining" | "stopped";

export interface ShutdownHook {
  name: string;
  priority: number;
  handler: () => Promise<void> | void;
}

export class GracefulShutdown {
  private static instance: GracefulShutdown | null = null;
  private hooks: ShutdownHook[] = [];
  private phase: ShutdownPhase = "init";
  private isShuttingDown = false;

  static getInstance(): GracefulShutdown {
    if (!GracefulShutdown.instance) {
      GracefulShutdown.instance = new GracefulShutdown();
    }
    return GracefulShutdown.instance;
  }

  registerHook(hook: ShutdownHook): void {
    this.hooks.push(hook);
    this.hooks.sort((a, b) => a.priority - b.priority);
    logger.info("SHUTDOWN", `Registered shutdown hook: ${hook.name}`);
  }

  async shutdown(reason: string): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn("SHUTDOWN", "Shutdown already in progress");
      return;
    }

    this.isShuttingDown = true;
    this.phase = "draining";

    logger.info("SHUTDOWN", `Starting graceful shutdown: ${reason}`);

    for (const hook of this.hooks) {
      try {
        logger.info("SHUTDOWN", `Executing hook: ${hook.name}`);
        const result = hook.handler();
        if (result instanceof Promise) {
          await result;
        }
        logger.info("SHUTDOWN", `Hook completed: ${hook.name}`);
      } catch (error) {
        logger.error("SHUTDOWN", `Hook failed: ${hook.name}`, {
          error: String(error),
        });
      }
    }

    this.phase = "stopped";
    logger.info("SHUTDOWN", "Graceful shutdown complete");
  }

  getPhase(): ShutdownPhase {
    return this.phase;
  }

  isDraining(): boolean {
    return this.phase === "draining";
  }
}

export const gracefulShutdown = GracefulShutdown.getInstance();

export function setupProcessShutdownHandlers(): void {
  const shutdown = gracefulShutdown.shutdown.bind(gracefulShutdown);

  process.on("SIGTERM", () => {
    logger.info("PROCESS", "Received SIGTERM");
    shutdown("SIGTERM").then(() => process.exit(0)).catch(() => process.exit(1));
  });

  process.on("SIGINT", () => {
    logger.info("PROCESS", "Received SIGINT");
    shutdown("SIGINT").then(() => process.exit(0)).catch(() => process.exit(1));
  });

  process.on("uncaughtException", (error) => {
    logger.error("PROCESS", "Uncaught exception", error);
    shutdown("uncaughtException").then(() => process.exit(1)).catch(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("PROCESS", "Unhandled rejection", {
      reason: String(reason),
    });
  });

  logger.info("PROCESS", "Process shutdown handlers registered");
}
