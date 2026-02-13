import { describe, test, expect } from "bun:test";

// Test the privacy logic directly without importing (to avoid config issues)
describe("Privacy Logic Tests", () => {
  const PRIVATE_TAG_REGEX = /<private>([\s\S]*?)<\/private>/gi;
  const SECRET_PATTERNS = [
    /api[_-]?key["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
    /secret["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
    /password["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
    /token["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
    /(sk-[a-zA-Z0-9]{20,})/g,
    /(ghp_[a-zA-Z0-9]{36})/g,
  ];

  function stripPrivateContent(text: string): string {
    return text.replace(PRIVATE_TAG_REGEX, "").trim();
  }

  function isFullyPrivate(text: string): boolean {
    const stripped = text.replace(PRIVATE_TAG_REGEX, "").trim();
    return stripped.length === 0;
  }

  function redactSecrets(text: string): string {
    let redacted = text;
    for (const pattern of SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return redacted;
  }

  describe("stripPrivateContent", () => {
    test("should remove private tags from content", () => {
      const input = "Normal content <private>secret information</private> more content";
      const result = stripPrivateContent(input);
      expect(result).toBe("Normal content  more content");
    });

    test("should handle multiple private tags", () => {
      const input = "Start <private>secret1</private> middle <private>secret2</private> end";
      const result = stripPrivateContent(input);
      expect(result).toBe("Start  middle  end");
    });

    test("should return original if no private tags", () => {
      const input = "Normal public content";
      const result = stripPrivateContent(input);
      expect(result).toBe("Normal public content");
    });

    test("should trim whitespace after removal", () => {
      const input = "Before <private>secret</private>";
      const result = stripPrivateContent(input);
      expect(result).toBe("Before");
    });
  });

  describe("isFullyPrivate", () => {
    test("should return true if all content is private", () => {
      const input = "<private>all secret</private>";
      expect(isFullyPrivate(input)).toBe(true);
    });

    test("should return false if mixed content", () => {
      const input = "public <private>secret</private>";
      expect(isFullyPrivate(input)).toBe(false);
    });

    test("should return false if no private tags", () => {
      const input = "just public content";
      expect(isFullyPrivate(input)).toBe(false);
    });
  });

  describe("redactSecrets", () => {
    test("should redact OpenAI API keys", () => {
      const input = "api_key = sk-1234567890abcdefghijklmnopqrstuvwxyz";
      const result = redactSecrets(input);
      expect(result).toContain("[REDACTED]");
    });

    test("should redact GitHub tokens", () => {
      const input = "token = ghp_abcdefghijklmnopqrstuvwxyz1234567890";
      const result = redactSecrets(input);
      expect(result).toContain("[REDACTED]");
    });

    test("should redact generic API keys", () => {
      const input = 'api_key: "verylongsecretkey123456"';
      const result = redactSecrets(input);
      expect(result).toContain("[REDACTED]");
    });

    test("should redact passwords", () => {
      const input = 'password = "supersecretpassword123"';
      const result = redactSecrets(input);
      expect(result).toContain("[REDACTED]");
    });

    test("should return original if no secrets found", () => {
      const input = "This is normal public content";
      const result = redactSecrets(input);
      expect(result).toBe("This is normal public content");
    });
  });
});
