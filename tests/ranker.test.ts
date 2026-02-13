import { describe, test, expect } from "bun:test";
import { Ranker } from "../src/services/search/ranker.js";

describe("Ranker Service", () => {
  describe("score", () => {
    const ranker = new Ranker({
      lexicalWeight: 0.45,
      semanticWeight: 0,
      recencyWeight: 0.35,
      tagBoostWeight: 0.2,
    });

    test("should sort by final score descending", () => {
      const results = [
        { id: 1, title: "Test A", text: "content", type: "fact", created_at_epoch: Date.now() - 100000 },
        { id: 2, title: "Test B", text: "test content", type: "workflow", created_at_epoch: Date.now() },
        { id: 3, title: "Test C", text: "other", type: "general", created_at_epoch: Date.now() - 500000 },
      ];

      const scored = ranker.score(results, "test");

      expect(scored[0].id).toBe(2); // Most recent + matches query
      expect(scored[0].finalScore).toBeGreaterThan(0);
    });

    test("should calculate lexical score based on query match", () => {
      const results = [
        { id: 1, title: "Test", text: "exact match test", type: "fact", created_at_epoch: Date.now() },
      ];

      const scored = ranker.score(results, "test");
      
      expect(scored[0].lexicalScore).toBeGreaterThan(0.5);
    });

    test("should calculate recency score based on timestamp", () => {
      const now = Date.now();
      const recent = { id: 1, title: "Recent", text: "text", type: "fact", created_at_epoch: now };
      const old = { id: 2, title: "Old", text: "text", type: "fact", created_at_epoch: now - 1000000000 };

      const scored = ranker.score([recent, old], "text");

      expect(scored[0].recencyScore).toBeGreaterThan(scored[1].recencyScore);
    });

    test("should apply tag boost when tags match query", () => {
      const withTags = { 
        id: 1, 
        title: "Test", 
        text: "content", 
        type: "fact", 
        tags: ["authentication", "login"],
        created_at_epoch: Date.now() 
      };
      const withoutTags = { 
        id: 2, 
        title: "Test", 
        text: "content", 
        type: "fact", 
        created_at_epoch: Date.now() 
      };

      const scored = ranker.score([withTags, withoutTags], "authentication");

      expect(scored[0].tagBoost).toBeGreaterThan(scored[1].tagBoost);
    });

    test("should handle empty results", () => {
      const scored = ranker.score([], "test");
      expect(scored).toEqual([]);
    });

    test("should handle results with missing fields", () => {
      const results = [
        { id: 1, created_at_epoch: Date.now() },
        { id: 2, title: "Test", text: "content", type: "fact", created_at_epoch: Date.now() },
      ];

      const scored = ranker.score(results, "test");
      expect(scored.length).toBe(2);
    });
  });

  describe("getWeights/setWeights", () => {
    test("should return current weights", () => {
      const ranker = new Ranker({ lexicalWeight: 0.5, semanticWeight: 0.3 });
      const weights = ranker.getWeights();
      
      expect(weights.lexicalWeight).toBe(0.5);
      expect(weights.semanticWeight).toBe(0.3);
    });

    test("should update specific weights", () => {
      const ranker = new Ranker({ lexicalWeight: 0.5, semanticWeight: 0.3 });
      ranker.setWeights({ lexicalWeight: 0.7 });
      
      const weights = ranker.getWeights();
      expect(weights.lexicalWeight).toBe(0.7);
      expect(weights.semanticWeight).toBe(0.3); // unchanged
    });
  });

  describe("scoreWithSemantic", () => {
    test("should incorporate semantic scores when provided", () => {
      const ranker = new Ranker({
        lexicalWeight: 0.3,
        semanticWeight: 0.5,
        recencyWeight: 0.2,
        tagBoostWeight: 0,
      });

      const results = [
        { id: 1, title: "A", text: "content", type: "fact", created_at_epoch: Date.now() },
        { id: 2, title: "B", text: "content", type: "fact", created_at_epoch: Date.now() },
      ];

      const semanticScores = new Map([[1, 0.9], [2, 0.1]]);
      const scored = ranker.scoreWithSemantic(results, "query", semanticScores);

      expect(scored[0].id).toBe(1); // Higher semantic score
      expect(scored[0].semanticScore).toBe(0.9);
    });

    test("should handle missing semantic scores", () => {
      const ranker = new Ranker({
        lexicalWeight: 0.5,
        semanticWeight: 0.3,
        recencyWeight: 0.2,
        tagBoostWeight: 0,
      });

      const results = [
        { id: 1, title: "Test", text: "content", type: "fact", created_at_epoch: Date.now() },
      ];

      const semanticScores = new Map(); // empty
      const scored = ranker.scoreWithSemantic(results, "test", semanticScores);

      expect(scored[0].semanticScore).toBe(0);
    });
  });
});
