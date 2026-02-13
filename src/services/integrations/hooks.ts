import { logger } from "../logger.js";
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

export interface HookConfig {
  enabled: boolean;
  autoInstall: boolean;
  hooks: string[];
}

export interface HookEvent {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type HookHandler = (event: HookEvent) => void | Promise<void>;

export class HookInstaller {
  private static instance: HookInstaller | null = null;
  private handlers: Map<string, Set<HookHandler>> = new Map();
  private hookDir: string;

  static getInstance(): HookInstaller {
    if (!HookInstaller.instance) {
      HookInstaller.instance = new HookInstaller();
    }
    return HookInstaller.instance;
  }

  constructor() {
    this.hookDir = join(homedir(), ".opencode-mem", "hooks");
  }

  getHookDir(): string {
    return this.hookDir;
  }

  ensureHookDir(): void {
    if (!existsSync(this.hookDir)) {
      mkdirSync(this.hookDir, { recursive: true });
    }
  }

  registerHandler(eventType: string, handler: HookHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    logger.info("HOOKS", `Registered handler for: ${eventType}`);
  }

  unregisterHandler(eventType: string, handler: HookHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  async trigger(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const event: HookEvent = {
      type: eventType,
      timestamp: Date.now(),
      payload,
    };

    const handlers = this.handlers.get(eventType);
    if (!handlers || handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        logger.error("HOOKS", `Handler error for ${eventType}`, {
          error: String(error),
        });
      }
    }
  }

  installHook(hookName: string, content: string): boolean {
    this.ensureHookDir();
    const hookPath = join(this.hookDir, hookName);

    try {
      writeFileSync(hookPath, content, { mode: 0o755 });
      logger.info("HOOKS", `Installed hook: ${hookName}`);
      return true;
    } catch (error) {
      logger.error("HOOKS", `Failed to install hook: ${hookName}`, {
        error: String(error),
      });
      return false;
    }
  }

  uninstallHook(hookName: string): boolean {
    const hookPath = join(this.hookDir, hookName);

    if (!existsSync(hookPath)) {
      logger.warn("HOOKS", `Hook not found: ${hookName}`);
      return false;
    }

    try {
      unlinkSync(hookPath);
      logger.info("HOOKS", `Uninstalled hook: ${hookName}`);
      return true;
    } catch (error) {
      logger.error("HOOKS", `Failed to uninstall hook: ${hookName}`, {
        error: String(error),
      });
      return false;
    }
  }

  listHooks(): string[] {
    if (!existsSync(this.hookDir)) {
      return [];
    }

    try {
      return readdirSync(this.hookDir).filter((f) => {
        const stat = statSync(join(this.hookDir, f));
        return stat.isFile() && (stat.mode & 0o111) !== 0;
      });
    } catch {
      return [];
    }
  }

  createClaudeHook(): string {
    return `#!/bin/bash
# OpenCodeMem Claude Hook
# This hook integrates with Claude Code

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
MEM_DIR="$HOME/.opencode-mem"

# Source common functions if available
if [ -f "$MEM_DIR/common.sh" ]; then
  source "$MEM_DIR/common.sh"
fi

# Event: Claude session start
on_session_start() {
  echo "OpenCodeMem: Session started"
}

# Event: Claude command executed
on_command() {
  local cmd="$1"
  echo "OpenCodeMem: Command executed: $cmd"
}

# Event: File modified
on_file_modified() {
  local file="$1"
  echo "OpenCodeMem: File modified: $file"
}

# Parse command line arguments and trigger appropriate hooks
case "\${1:-}" in
  start)
    on_session_start
    ;;
  command)
    on_command "\${2:-}"
    ;;
  file-modified)
    on_file_modified "\${2:-}"
    ;;
esac
`;
  }

  installClaudeHook(): boolean {
    return this.installHook("claude-hook.sh", this.createClaudeHook());
  }
}

export const hookInstaller = HookInstaller.getInstance();
