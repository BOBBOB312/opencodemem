import { spawn, ChildProcess } from "child_process";
import { logger } from "../logger.js";

export interface ProcessConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  maxRestarts?: number;
  restartDelayMs?: number;
}

export interface ProcessStatus {
  name: string;
  running: boolean;
  pid?: number;
  restarts: number;
  uptime?: number;
  startedAt?: number;
}

export class ProcessManager {
  private static instance: ProcessManager | null = null;
  private processes: Map<string, { config: ProcessConfig; child?: ChildProcess; status: ProcessStatus }> = new Map();

  static getInstance(): ProcessManager {
    if (!ProcessManager.instance) {
      ProcessManager.instance = new ProcessManager();
    }
    return ProcessManager.instance;
  }

  async start(name: string, config: ProcessConfig): Promise<void> {
    if (this.processes.has(name)) {
      logger.warn("PROCESS_MGR", `Process ${name} already running`);
      return;
    }

    const status: ProcessStatus = {
      name,
      running: false,
      restarts: 0,
    };

    this.processes.set(name, { config, status });

    await this.spawnProcess(name);
  }

  private async spawnProcess(name: string): Promise<void> {
    const entry = this.processes.get(name);
    if (!entry) return;

    const { config, status } = entry;
    const maxRestarts = config.maxRestarts ?? 3;
    const restartDelayMs = config.restartDelayMs ?? 1000;

    return new Promise((resolve) => {
      const child = spawn(config.command, config.args || [], {
        env: { ...process.env, ...config.env },
        cwd: config.cwd,
        stdio: "pipe",
      });

      entry.child = child;
      status.running = true;
      status.pid = child.pid;
      status.startedAt = Date.now();

      child.on("exit", (code) => {
        status.running = false;
        status.pid = undefined;
        logger.info("PROCESS_MGR", `Process ${name} exited with code ${code}`);

        if (code !== 0 && status.restarts < maxRestarts) {
          status.restarts += 1;
          logger.info("PROCESS_MGR", `Restarting ${name} (attempt ${status.restarts}/${maxRestarts})`);
          setTimeout(() => {
            this.spawnProcess(name).then(resolve);
          }, restartDelayMs);
        } else {
          this.processes.delete(name);
          resolve();
        }
      });

      child.on("error", (error) => {
        logger.error("PROCESS_MGR", `Process ${name} error`, error);
        status.running = false;
      });

      resolve();
    });
  }

  stop(name: string): void {
    const entry = this.processes.get(name);
    if (!entry || !entry.child) {
      logger.warn("PROCESS_MGR", `Process ${name} not found`);
      return;
    }

    entry.child.kill("SIGTERM");
    entry.status.running = false;
    this.processes.delete(name);
    logger.info("PROCESS_MGR", `Stopped process ${name}`);
  }

  getStatus(name: string): ProcessStatus | undefined {
    const entry = this.processes.get(name);
    if (!entry) return undefined;

    const status = { ...entry.status };
    if (status.startedAt) {
      status.uptime = Date.now() - status.startedAt;
    }
    return status;
  }

  getAllStatuses(): ProcessStatus[] {
    return Array.from(this.processes.values()).map((entry) => {
      const status = { ...entry.status };
      if (status.startedAt) {
        status.uptime = Date.now() - status.startedAt;
      }
      return status;
    });
  }

  stopAll(): void {
    for (const [name] of this.processes) {
      this.stop(name);
    }
  }
}

export const processManager = ProcessManager.getInstance();
