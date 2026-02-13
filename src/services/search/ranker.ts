import { getConfig } from "../../config.js";

export interface RankOptions {
  lexicalWeight?: number;
  semanticWeight?: number;
  recencyWeight?: number;
  tagBoostWeight?: number;
}

export interface ScoredResult {
  id: number;
  title: string;
  text: string;
  type: string;
  tags?: string[];
  files?: string[];
  created_at_epoch: number;
  lexicalScore: number;
  semanticScore: number;
  recencyScore: number;
  tagBoost: number;
  finalScore: number;
}

const DEFAULT_WEIGHTS: RankOptions = {
  lexicalWeight: 0.45,
  semanticWeight: 0.35,
  recencyWeight: 0.15,
  tagBoostWeight: 0.05,
};

function normalizeScore(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

function calculateLexicalScore(text: string, query: string): number {
  const textLower = text.toLowerCase();
  const queryLower = query.toLowerCase();

  if (textLower.includes(queryLower)) {
    const ratio = queryLower.length / textLower.length;
    return Math.min(0.5 + ratio * 0.5, 1.0);
  }

  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);
  if (queryWords.length === 0) return 0;

  const matchedWords = queryWords.filter(word => textLower.includes(word));
  return matchedWords.length / queryWords.length;
}

function calculateRecencyScore(createdAtEpoch: number, now: number = Date.now()): number {
  const ageMs = now - createdAtEpoch;
  const dayMs = 24 * 60 * 60 * 1000;
  const ageDays = ageMs / dayMs;

  if (ageDays <= 1) return 1.0;
  if (ageDays <= 7) return 0.8;
  if (ageDays <= 30) return 0.5;
  if (ageDays <= 90) return 0.3;
  return 0.1;
}

function calculateTagBoost(resultTags: string[] | undefined, query: string): number {
  if (!resultTags || resultTags.length === 0) return 0;

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const matchedTags = resultTags.filter(tag => 
    queryWords.some(word => tag.toLowerCase().includes(word))
  );

  return matchedTags.length / resultTags.length;
}

export class Ranker {
  private weights: RankOptions;

  constructor(weights?: RankOptions) {
    const config = getConfig();
    this.weights = {
      lexicalWeight: weights?.lexicalWeight ?? DEFAULT_WEIGHTS.lexicalWeight,
      semanticWeight: weights?.semanticWeight ?? (config.embedding?.enabled ? DEFAULT_WEIGHTS.semanticWeight : 0),
      recencyWeight: weights?.recencyWeight ?? DEFAULT_WEIGHTS.recencyWeight,
      tagBoostWeight: weights?.tagBoostWeight ?? DEFAULT_WEIGHTS.tagBoostWeight,
    };
  }

  score(results: any[], query: string): ScoredResult[] {
    if (results.length === 0) return [];

    const now = Date.now();
    const minTime = Math.min(...results.map(r => r.created_at_epoch));
    const maxTime = Math.max(...results.map(r => r.created_at_epoch));

    const scored = results.map(result => {
      const fullText = `${result.title || ""} ${result.subtitle || ""} ${result.text || ""}`;
      
      const lexicalScore = calculateLexicalScore(fullText, query);
      const recencyScore = normalizeScore(result.created_at_epoch, minTime, maxTime);
      const tagBoost = calculateTagBoost(result.tags, query);
      
      const semanticScore = result.similarity || 0;

      const finalScore = 
        (this.weights.lexicalWeight || 0) * lexicalScore +
        (this.weights.semanticWeight || 0) * semanticScore +
        (this.weights.recencyWeight || 0) * recencyScore +
        (this.weights.tagBoostWeight || 0) * tagBoost;

      return {
        id: result.id,
        title: result.title,
        text: result.text,
        type: result.type,
        tags: result.tags,
        files: result.files,
        created_at_epoch: result.created_at_epoch,
        lexicalScore,
        semanticScore,
        recencyScore,
        tagBoost,
        finalScore,
      };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);

    return scored;
  }

  scoreWithSemantic(results: any[], query: string, semanticScores: Map<number, number>): ScoredResult[] {
    if (results.length === 0) return [];

    const now = Date.now();
    const minTime = Math.min(...results.map(r => r.created_at_epoch));
    const maxTime = Math.max(...results.map(r => r.created_at_epoch));

    const scored = results.map(result => {
      const fullText = `${result.title || ""} ${result.subtitle || ""} ${result.text || ""}`;
      
      const lexicalScore = calculateLexicalScore(fullText, query);
      const recencyScore = normalizeScore(result.created_at_epoch, minTime, maxTime);
      const tagBoost = calculateTagBoost(result.tags, query);
      
      const semanticScore = semanticScores.get(result.id) || 0;

      const finalScore = 
        (this.weights.lexicalWeight || 0) * lexicalScore +
        (this.weights.semanticWeight || 0) * semanticScore +
        (this.weights.recencyWeight || 0) * recencyScore +
        (this.weights.tagBoostWeight || 0) * tagBoost;

      return {
        id: result.id,
        title: result.title,
        text: result.text,
        type: result.type,
        tags: result.tags,
        files: result.files,
        created_at_epoch: result.created_at_epoch,
        lexicalScore,
        semanticScore,
        recencyScore,
        tagBoost,
        finalScore,
      };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);

    return scored;
  }

  getWeights(): RankOptions {
    return { ...this.weights };
  }

  setWeights(weights: Partial<RankOptions>): void {
    this.weights = { ...this.weights, ...weights };
  }
}

export const ranker = new Ranker();
