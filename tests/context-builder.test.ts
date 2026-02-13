import { describe, test, expect } from "bun:test";
import { calculateTokenCount, truncateToTokenLimit } from "../src/services/context-builder.js";

describe("Context Builder Unit Tests", () => {
  describe("calculateTokenCount", () => {
    test("should estimate tokens as 1/4 of characters", () => {
      expect(calculateTokenCount("1234")).toBe(1);
      expect(calculateTokenCount("a")).toBe(1);
      expect(calculateTokenCount("abcdefgh")).toBe(2);
      expect(calculateTokenCount("")).toBe(0);
    });

    test("should handle unicode characters", () => {
      expect(calculateTokenCount("你好")).toBe(1);
    });

    test("should handle long text", () => {
      const text = "A".repeat(1000);
      expect(calculateTokenCount(text)).toBe(250);
    });
  });

  describe("truncateToTokenLimit", () => {
    test("should not truncate if under limit", () => {
      const text = "Short text";
      const result = truncateToTokenLimit(text, 10);
      expect(result).toBe("Short text");
    });

    test("should truncate with ellipsis if over limit", () => {
      const text = "A".repeat(100);
      const result = truncateToTokenLimit(text, 10);
      expect(result).toContain("...");
      expect(result.length).toBeLessThan(50);
    });

    test("should handle exact boundary", () => {
      const text = "1234567890123456789012345678901234567890"; // 40 chars = 10 tokens
      const result = truncateToTokenLimit(text, 10);
      expect(result).toBe(text);
    });
  });
});
