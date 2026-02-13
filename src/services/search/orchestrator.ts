import { DatabaseManager } from "../sqlite/schema.js";
import { vectorService } from "./vectors.js";
import { ranker } from "./ranker.js";
import type { SearchFilter, SearchFilterInput } from "./filters/index.js";
import { logger } from "../logger.js";

export interface SearchStrategy {
  name: string;
  search(query: string, options: SearchOptions): Promise<SearchFilterInput[]>;
}

export interface SearchOptions {
  project?: string;
  type?: string;
  dateStart?: Date;
  dateEnd?: Date;
  limit?: number;
  offset?: number;
  useSemantic?: boolean;
  useFTS?: boolean;
}

export interface SearchResult {
  results: SearchFilterInput[];
  total: number;
  timing: number;
  strategies: string[];
  diagnostics: SearchDiagnostics;
}

export interface SearchDiagnostics {
  query: string;
  strategyTimingsMs: Record<string, number>;
  strategyResultCounts: Record<string, number>;
  filterResultCounts: Record<string, number>;
  startedAtEpoch: number;
  endedAtEpoch: number;
}

export class SearchOrchestrator {
  private static instance: SearchOrchestrator | null = null;
  private strategies: Map<string, SearchStrategy> = new Map();
  private filters: SearchFilter[] = [];
  private lastDiagnostics: SearchDiagnostics | null = null;

  static getInstance(): SearchOrchestrator {
    if (!SearchOrchestrator.instance) {
      SearchOrchestrator.instance = new SearchOrchestrator();
    }
    return SearchOrchestrator.instance;
  }

  registerStrategy(strategy: SearchStrategy): void {
    this.strategies.set(strategy.name, strategy);
    logger.info("SEARCH", `Registered strategy: ${strategy.name}`);
  }

  addFilter(filter: SearchFilter): void {
    this.filters.push(filter);
  }

  setFilters(filters: SearchFilter[]): void {
    this.filters = filters;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const startTime = performance.now();
    const startedAtEpoch = Date.now();
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const strategies: string[] = [];

    const strategyTimingsMs: Record<string, number> = {};
    const strategyResultCounts: Record<string, number> = {};
    const filterResultCounts: Record<string, number> = {};

    let results: SearchFilterInput[] = [];

    const useFTS = options.useFTS !== false;
    const useSemantic = options.useSemantic !== false && vectorService.isEnabled();

    if (useFTS) {
      const s = performance.now();
      const ftsResults = await this.executeFTSStrategy(query, options);
      strategyTimingsMs.fts = Number((performance.now() - s).toFixed(2));
      strategyResultCounts.fts = ftsResults.length;
      results = this.mergeResults(results, ftsResults);
      strategies.push("fts");
    }

    if (useSemantic && options.project) {
      const s = performance.now();
      const semanticResults = await this.executeSemanticStrategy(query, options);
      strategyTimingsMs.semantic = Number((performance.now() - s).toFixed(2));
      strategyResultCounts.semantic = semanticResults.length;
      results = this.mergeResults(results, semanticResults);
      strategies.push("semantic");
    }

    if (results.length === 0) {
      const s = performance.now();
      const fallbackResults = await this.executeFallbackStrategy(query, options);
      strategyTimingsMs.fallback = Number((performance.now() - s).toFixed(2));
      strategyResultCounts.fallback = fallbackResults.length;
      results = fallbackResults;
      strategies.push("fallback");
    }

    for (const filter of this.filters) {
      results = filter.filter(results);
      filterResultCounts[filter.name] = results.length;
    }

    const rankedResults = this.rankResults(results, query);

    const finalResults = rankedResults.slice(offset, offset + limit);

    const diagnostics: SearchDiagnostics = {
      query,
      strategyTimingsMs,
      strategyResultCounts,
      filterResultCounts,
      startedAtEpoch,
      endedAtEpoch: Date.now(),
    };
    this.lastDiagnostics = diagnostics;

    return {
      results: finalResults,
      total: results.length,
      timing: performance.now() - startTime,
      strategies,
      diagnostics,
    };
  }

  getLastDiagnostics(): SearchDiagnostics | null {
    return this.lastDiagnostics;
  }

  private async executeFTSStrategy(query: string, options: SearchOptions): Promise<SearchFilterInput[]> {
    const db = DatabaseManager.getInstance().getDatabase();
    
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.project) {
      conditions.push("o.project = ?");
      params.push(options.project);
    }
    if (options.type) {
      conditions.push("o.type = ?");
      params.push(options.type);
    }
    if (options.dateStart) {
      conditions.push("o.created_at_epoch >= ?");
      params.push(options.dateStart.getTime());
    }
    if (options.dateEnd) {
      conditions.push("o.created_at_epoch <= ?");
      params.push(options.dateEnd.getTime());
    }

    const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";

    const ftsQuery = query
      .split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => `"${w}"*`)
      .join(" ");

    if (ftsQuery.length > 0) {
      try {
        return db.query(`
          SELECT o.id, o.project, o.title, o.subtitle, o.text, o.type, o.created_at_epoch, o.prompt_number,
                 bm25(memory_index) as fts_rank
          FROM observations o
          JOIN memory_index mi ON o.id = mi.observation_id
          WHERE memory_index MATCH ? AND ${whereClause}
          ORDER BY fts_rank
          LIMIT 100
        `).all(ftsQuery, ...params) as SearchFilterInput[];
      } catch {
        return [];
      }
    }

    return [];
  }

  private async executeSemanticStrategy(query: string, options: SearchOptions): Promise<SearchFilterInput[]> {
    if (!options.project) return [];

    try {
      const scores = await vectorService.searchSimilar(query, options.project, 100);
      const db = DatabaseManager.getInstance().getDatabase();

      const ids = Array.from(scores.keys());
      if (ids.length === 0) return [];

      const placeholders = ids.map(() => "?").join(",");
      const results = db.query(`
        SELECT o.id, o.project, o.title, o.subtitle, o.text, o.type, o.created_at_epoch, o.prompt_number
        FROM observations o
        WHERE o.id IN (${placeholders})
      `).all(...ids) as SearchFilterInput[];

      return results.map(r => ({
        ...r,
        semanticScore: scores.get(r.id) || 0,
      }));
    } catch (error) {
      logger.warn("SEARCH", "Semantic strategy failed", {
        error: String(error),
      });
      return [];
    }
  }

  private async executeFallbackStrategy(query: string, options: SearchOptions): Promise<SearchFilterInput[]> {
    const db = DatabaseManager.getInstance().getDatabase();
    
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.project) {
      conditions.push("project = ?");
      params.push(options.project);
    }
    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }

    const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
    const searchPattern = `%${query}%`;

    return db.query(`
      SELECT id, project, title, subtitle, text, type, created_at_epoch, prompt_number
      FROM observations
      WHERE ${whereClause}
      AND (title LIKE ? OR text LIKE ? OR subtitle LIKE ?)
      ORDER BY created_at_epoch DESC
      LIMIT 100
    `).all(...params, searchPattern, searchPattern, searchPattern) as SearchFilterInput[];
  }

  private mergeResults(existing: SearchFilterInput[], newResults: SearchFilterInput[]): SearchFilterInput[] {
    const map = new Map<number, SearchFilterInput>();
    
    for (const r of existing) {
      map.set(r.id, r);
    }
    for (const r of newResults) {
      if (!map.has(r.id)) {
        map.set(r.id, r);
      }
    }

    return Array.from(map.values());
  }

  private rankResults(results: SearchFilterInput[], query: string): SearchFilterInput[] {
    return ranker.scoreWithSemantic(results, query, new Map()) as SearchFilterInput[];
  }
}

export const searchOrchestrator = SearchOrchestrator.getInstance();
