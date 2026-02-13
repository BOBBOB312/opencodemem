import { describe, test, expect } from "bun:test";

// Test config parsing logic without filesystem
describe("Config Parsing Tests", () => {
  function parseJsonc(content: string): any {
    // Simple JSONC parser - remove comments first
    let result = content;
    
    // Remove single-line comments
    result = result.replace(/\/\/.*$/gm, "");
    
    // Remove multi-line comments  
    result = result.replace(/\/\*[\s\S]*?\*\//g, "");
    
    return JSON.parse(result);
  }

  function resolvePath(path: string): string {
    if (path.startsWith("~")) {
      return "/Users/test" + path.slice(1);
    }
    return path;
  }

  function resolveConfigValue(value: any): any {
    if (typeof value === "string" && value.startsWith("~")) {
      return resolvePath(value);
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const resolved: any = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = resolveConfigValue(v);
      }
      return resolved;
    }
    return value;
  }

  describe("parseJsonc", () => {
    test("should parse JSON with comments", () => {
      const jsonc = `{
        // This is a comment
        "storagePath": "/test/path",
        "enabled": true
      }`;
      
      const result = parseJsonc(jsonc);
      expect(result.storagePath).toBe("/test/path");
      expect(result.enabled).toBe(true);
    });

    test("should handle empty object", () => {
      const result = parseJsonc("{}");
      expect(result).toEqual({});
    });

    test("should handle nested objects", () => {
      const jsonc = `{
        "chatMessage": {
          "maxMemories": 5
        }
      }`;
      
      const result = parseJsonc(jsonc);
      expect(result.chatMessage.maxMemories).toBe(5);
    });
  });

  describe("resolvePath", () => {
    test("should resolve ~ to home directory", () => {
      const result = resolvePath("~/test/path");
      expect(result).toBe("/Users/test/test/path");
    });

    test("should return original if not ~", () => {
      const result = resolvePath("/absolute/path");
      expect(result).toBe("/absolute/path");
    });
  });

  describe("resolveConfigValue", () => {
    test("should resolve ~ in strings", () => {
      const result = resolveConfigValue("~/test");
      expect(result).toContain("/Users/test");
    });

    test("should resolve ~ in nested objects", () => {
      const input = {
        storage: {
          path: "~/data"
        }
      };
      const result = resolveConfigValue(input);
      expect(result.storage.path).toContain("/Users/test");
    });

    test("should pass through non-string values", () => {
      expect(resolveConfigValue(123)).toBe(123);
      expect(resolveConfigValue(true)).toBe(true);
      expect(resolveConfigValue(null)).toBe(null);
    });
  });
});
