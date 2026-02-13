import { Request, Response, NextFunction } from "express";
import { logger } from "../logger.js";

export interface RequestLogEntry {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  ip: string;
  userAgent: string;
  timestamp: number;
  duration?: number;
  statusCode?: number;
}

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RequestLogger {
  private static instance: RequestLogger | null = null;
  private logs: RequestLogEntry[] = [];
  private maxLogs: number = 1000;

  static getInstance(): RequestLogger {
    if (!RequestLogger.instance) {
      RequestLogger.instance = new RequestLogger();
    }
    return RequestLogger.instance;
  }

  log(entry: RequestLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = performance.now();
      const entry: RequestLogEntry = {
        method: req.method,
        path: req.path,
        query: req.query as Record<string, unknown>,
        body: req.body as Record<string, unknown>,
        ip: req.ip || req.socket.remoteAddress || "unknown",
        userAgent: req.get("user-agent") || "unknown",
        timestamp: Date.now(),
      };

      res.on("finish", () => {
        entry.duration = performance.now() - start;
        entry.statusCode = res.statusCode;
        this.log(entry);

        if (res.statusCode >= 500) {
          logger.error("REQUEST", `${req.method} ${req.path} ${res.statusCode}`, {
            duration: entry.duration,
            ip: entry.ip,
          });
        } else if (res.statusCode >= 400) {
          logger.warn("REQUEST", `${req.method} ${req.path} ${res.statusCode}`, {
            duration: entry.duration,
            ip: entry.ip,
          });
        }
      });

      next();
    };
  }

  getLogs(limit: number = 100): RequestLogEntry[] {
    return this.logs.slice(-limit);
  }

  clearLogs(): void {
    this.logs = [];
  }
}

export class RateLimiter {
  private static instance: RateLimiter | null = null;
  private requests: Map<string, RateLimitEntry> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(windowMs: number = 60000, maxRequests: number = 100) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  static getInstance(windowMs?: number, maxRequests?: number): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter(windowMs, maxRequests);
    }
    return RateLimiter.instance;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const key = req.ip || req.socket.remoteAddress || "unknown";
      const now = Date.now();

      let entry = this.requests.get(key);

      if (!entry || entry.resetAt < now) {
        entry = {
          count: 0,
          resetAt: now + this.windowMs,
        };
        this.requests.set(key, entry);
      }

      entry.count++;

      if (entry.count > this.maxRequests) {
        return res.status(429).json({
          success: false,
          error: "Too many requests",
          retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        });
      }

      res.setHeader("X-RateLimit-Limit", String(this.maxRequests));
      res.setHeader("X-RateLimit-Remaining", String(this.maxRequests - entry.count));
      res.setHeader("X-RateLimit-Reset", String(entry.resetAt));

      next();
    };
  }

  clear(key?: string): void {
    if (key) {
      this.requests.delete(key);
    } else {
      this.requests.clear();
    }
  }
}

export class CORSMiddleware {
  private static instance: CORSMiddleware | null = null;
  private allowedOrigins: string[];

  constructor(allowedOrigins: string[] = ["*"]) {
    this.allowedOrigins = allowedOrigins;
  }

  static getInstance(allowedOrigins?: string[]): CORSMiddleware {
    if (!CORSMiddleware.instance) {
      CORSMiddleware.instance = new CORSMiddleware(allowedOrigins);
    }
    return CORSMiddleware.instance;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const origin = req.get("origin");

      if (this.allowedOrigins.includes("*") || (origin && this.allowedOrigins.includes(origin))) {
        res.setHeader("Access-Control-Allow-Origin", origin || "*");
      }

      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400");

      if (req.method === "OPTIONS") {
        return res.status(204).end();
      }

      next();
    };
  }
}

export const requestLogger = RequestLogger.getInstance();
export const rateLimiter = RateLimiter.getInstance();
export const corsMiddleware = CORSMiddleware.getInstance();
