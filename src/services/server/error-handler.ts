import { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { logger } from "../logger.js";

export interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  details?: unknown;
  timestamp: number;
}

export class ErrorHandler {
  private static instance: ErrorHandler | null = null;

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  middleware(): ErrorRequestHandler {
    return (err: Error, req: Request, res: Response, _next: NextFunction) => {
      const statusCode = this.getStatusCode(err);
      const errorResponse = this.formatError(err, statusCode, req);

      logger.error("ERROR", `${req.method} ${req.path} failed`, {
        error: err.message,
        stack: err.stack,
        statusCode,
        body: req.body,
      });

      res.status(statusCode).json(errorResponse);
    };
  }

  private getStatusCode(err: Error): number {
    if ("statusCode" in err) {
      return (err as any).statusCode;
    }

    if (err.name === "ValidationError") {
      return 400;
    }
    if (err.name === "UnauthorizedError") {
      return 401;
    }
    if (err.name === "ForbiddenError") {
      return 403;
    }
    if (err.name === "NotFoundError") {
      return 404;
    }

    return 500;
  }

  private formatError(err: Error, statusCode: number, req: Request): ErrorResponse {
    let message = err.message;
    let code: string | undefined;

    if (statusCode >= 500) {
      message = "Internal server error";
      code = "INTERNAL_ERROR";
    } else if (statusCode === 404) {
      message = "Resource not found";
      code = "NOT_FOUND";
    } else if (statusCode === 403) {
      message = "Forbidden";
      code = "FORBIDDEN";
    } else if (statusCode === 401) {
      message = "Unauthorized";
      code = "UNAUTHORIZED";
    } else if (statusCode === 400) {
      code = "BAD_REQUEST";
    }

    const response: ErrorResponse = {
      success: false,
      error: message,
      timestamp: Date.now(),
    };

    if (code) {
      response.code = code;
    }

    if (process.env.NODE_ENV !== "production" && err.stack) {
      response.details = {
        stack: err.stack,
        path: req.path,
        method: req.method,
      };
    }

    return response;
  }
}

export class NotFoundHandler {
  middleware() {
    return (req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: `Route ${req.method} ${req.path} not found`,
        code: "NOT_FOUND",
        timestamp: Date.now(),
      });
    };
  }
}

export class AsyncHandler {
  static wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }
}

export const errorHandler = ErrorHandler.getInstance();
export const notFoundHandler = new NotFoundHandler();
