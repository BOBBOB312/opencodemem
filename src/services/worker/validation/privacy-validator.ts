import { logger } from "../../logger.js";
import { getConfig } from "../../../config.js";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  severity: "error";
}

export interface ValidationWarning {
  field: string;
  message: string;
  severity: "warning";
}

export interface Validatable {
  [key: string]: unknown;
}

export interface PrivacyValidatorRule {
  name: string;
  validate(value: unknown, context: Validatable): ValidationResult;
}

export class PrivateTagValidator implements PrivacyValidatorRule {
  name = "privateTag";

  privateTags: Set<string>;

  constructor() {
    this.privateTags = new Set(["private", "confidential", "secret", "password", "api_key", "token"]);
  }

  validate(value: unknown, context: Validatable): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const tags = context.tags as string[] | undefined;
    if (tags) {
      for (const tag of tags) {
        if (this.privateTags.has(tag.toLowerCase())) {
          warnings.push({
            field: "tags",
            message: `Sensitive tag detected: ${tag}`,
            severity: "warning",
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

export class RedactionValidator implements PrivacyValidatorRule {
  name = "redaction";

  privatePatterns: RegExp[] = [
    /(?<![a-zA-Z])(?:\d{3}-\d{2}-\d{4})/, // SSN
    /(?<![a-zA-Z])[A-Z]{2}\d{6,10}(?![a-zA-Z])/, // API keys
    /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/, // Bearer tokens
    /ghp_[a-zA-Z0-9]{36}/, // GitHub tokens
    /sk-[a-zA-Z0-9]{32,}/, // OpenAI keys
  ];

  validate(value: unknown, context: Validatable): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const text = context.text as string || context.content as string || context.description as string;
    if (text) {
      for (const pattern of this.privatePatterns) {
        if (pattern.test(text)) {
          warnings.push({
            field: "text",
            message: "Potential sensitive data pattern detected",
            severity: "warning",
          });
          break;
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

export class ContentValidator implements PrivacyValidatorRule {
  name = "content";

  maxLength: number;

  constructor(maxLength: number = 50000) {
    this.maxLength = maxLength;
  }

  validate(value: unknown, context: Validatable): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const text = context.text as string || context.content as string || "";
    
    if (text.length > this.maxLength) {
      errors.push({
        field: "text",
        message: `Content exceeds maximum length of ${this.maxLength} characters`,
        severity: "error",
      });
    }

    if (text.trim().length === 0) {
      errors.push({
        field: "text",
        message: "Content cannot be empty",
        severity: "error",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

export class PrivacyCheckValidator {
  private static instance: PrivacyCheckValidator | null = null;
  private rules: PrivacyValidatorRule[] = [];

  static getInstance(): PrivacyCheckValidator {
    if (!PrivacyCheckValidator.instance) {
      PrivacyCheckValidator.instance = new PrivacyCheckValidator();
    }
    return PrivacyCheckValidator.instance;
  }

  constructor() {
    this.registerDefaultRules();
  }

  private registerDefaultRules(): void {
    const config = getConfig();

    if (config.privacy?.privateTagsEnabled !== false) {
      this.registerRule(new PrivateTagValidator());
    }

    if (config.privacy?.redactionEnabled !== false) {
      this.registerRule(new RedactionValidator());
    }

    this.registerRule(new ContentValidator());
  }

  registerRule(rule: PrivacyValidatorRule): void {
    this.rules.push(rule);
    logger.info("PRIVACY", `Registered validator rule: ${rule.name}`);
  }

  unregisterRule(name: string): void {
    this.rules = this.rules.filter(r => r.name !== name);
  }

  validate(data: Validatable): ValidationResult {
    const allErrors: ValidationError[] = [];
    const allWarnings: ValidationWarning[] = [];

    for (const rule of this.rules) {
      const result = rule.validate(data, data);
      allErrors.push(...result.errors);
      allWarnings.push(...result.warnings);
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
    };
  }

  validateAndRedact(data: Validatable): { result: ValidationResult; redacted: Validatable } {
    const result = this.validate(data);
    const redacted = this.redact(data);

    return { result, redacted };
  }

  redact(data: Validatable): Validatable {
    const redacted = { ...data };
    const text = redacted.text as string || redacted.content as string;

    if (text) {
      let redactedText = text;
      
      const patterns = [
        { pattern: /(?<![a-zA-Z])(?:\d{3}-\d{2}-\d{4})/g, replacement: "[SSN REDACTED]" },
        { pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, replacement: "Bearer [TOKEN REDACTED]" },
        { pattern: /ghp_[a-zA-Z0-9]{36}/g, replacement: "[GITHUB TOKEN REDACTED]" },
        { pattern: /sk-[a-zA-Z0-9]{32,}/g, replacement: "[API KEY REDACTED]" },
      ];

      for (const { pattern, replacement } of patterns) {
        redactedText = redactedText.replace(pattern, replacement);
      }

      if (redacted.text !== undefined) {
        redacted.text = redactedText;
      } else if (redacted.content !== undefined) {
        (redacted as any).content = redactedText;
      }
    }

    return redacted;
  }
}

export const privacyValidator = PrivacyCheckValidator.getInstance();
