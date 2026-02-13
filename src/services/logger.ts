import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".opencode-mem", "logs");

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFileName(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  return join(LOG_DIR, `opencode-mem-${date}.log`);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = "info";

function formatMessage(
  level: LogLevel,
  category: string,
  message: string,
  context?: Record<string, any>,
  error?: Error
): string {
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] [${level.toUpperCase()}] [${category}] ${message}`;

  if (context && Object.keys(context).length > 0) {
    logLine += ` | ${JSON.stringify(context)}`;
  }

  if (error) {
    logLine += ` | Error: ${error.message}\n${error.stack}`;
  }

  return logLine;
}

function writeLog(line: string): void {
  try {
    ensureLogDir();
    appendFileSync(getLogFileName(), line + "\n");
  } catch (e) {
    console.error("Failed to write to log file:", e);
  }
}

export const logger = {
  debug(category: string, message: string, context?: Record<string, any>): void {
    if (LOG_LEVELS.debug >= LOG_LEVELS[currentLevel]) {
      const line = formatMessage("debug", category, message, context);
      console.debug(line);
      writeLog(line);
    }
  },

  info(category: string, message: string, context?: Record<string, any>): void {
    if (LOG_LEVELS.info >= LOG_LEVELS[currentLevel]) {
      const line = formatMessage("info", category, message, context);
      console.info(line);
      writeLog(line);
    }
  },

  warn(category: string, message: string, context?: Record<string, any>): void {
    if (LOG_LEVELS.warn >= LOG_LEVELS[currentLevel]) {
      const line = formatMessage("warn", category, message, context);
      console.warn(line);
      writeLog(line);
    }
  },

  error(
    category: string,
    message: string,
    context?: Record<string, any>,
    error?: Error
  ): void {
    if (LOG_LEVELS.error >= LOG_LEVELS[currentLevel]) {
      const line = formatMessage("error", category, message, context, error);
      console.error(line);
      writeLog(line);
    }
  },
};

export function log(message: string, context?: Record<string, any>): void {
  logger.info("PLUGIN", message, context);
}
