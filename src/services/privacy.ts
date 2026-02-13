import { CONFIG } from "../config.js";

const PRIVATE_TAG_REGEX = /<private>([\s\S]*?)<\/private>/gi;
const SECRET_PATTERNS = [
  /api[_-]?key["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
  /secret["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
  /password["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
  /token["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
  /(sk-[a-zA-Z0-9]{20,})/g,
  /(ghp_[a-zA-Z0-9]{36})/g,
  /(gho_[a-zA-Z0-9]{36})/g,
];

export function stripPrivateContent(text: string): string {
  if (!CONFIG.privacy?.privateTagsEnabled) {
    return text;
  }

  return text.replace(PRIVATE_TAG_REGEX, "").trim();
}

export function isFullyPrivate(text: string): boolean {
  if (!CONFIG.privacy?.privateTagsEnabled) {
    return false;
  }

  const stripped = text.replace(PRIVATE_TAG_REGEX, "").trim();
  return stripped.length === 0;
}

export function redactSecrets(text: string): string {
  if (!CONFIG.privacy?.redactionEnabled) {
    return text;
  }

  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }

  return redacted;
}

export function sanitizeForStorage(text: string): string {
  let sanitized = stripPrivateContent(text);
  sanitized = redactSecrets(sanitized);
  return sanitized;
}
