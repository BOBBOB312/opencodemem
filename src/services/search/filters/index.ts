export interface SearchFilter {
  name: string;
  filter(results: SearchFilterInput[]): SearchFilterInput[];
}

export interface SearchFilterInput {
  id: number;
  title: string;
  subtitle?: string;
  text?: string;
  type: string;
  project?: string;
  created_at_epoch?: number;
  prompt_number?: number;
  [key: string]: any;
}

export interface DateRangeFilterOptions {
  startDate?: Date;
  endDate?: Date;
}

export class DateRangeFilter implements SearchFilter {
  name = "dateRange";
  private options: DateRangeFilterOptions;

  constructor(options: DateRangeFilterOptions) {
    this.options = options;
  }

  filter(results: SearchFilterInput[]): SearchFilterInput[] {
    if (!this.options.startDate && !this.options.endDate) {
      return results;
    }

    return results.filter((r) => {
      const timestamp = r.created_at_epoch || 0;
      const startOk = !this.options.startDate || timestamp >= this.options.startDate.getTime();
      const endOk = !this.options.endDate || timestamp <= this.options.endDate.getTime();
      return startOk && endOk;
    });
  }
}

export class TypeFilter implements SearchFilter {
  name = "type";
  private types: Set<string>;

  constructor(types: string | string[]) {
    this.types = new Set(Array.isArray(types) ? types : [types]);
  }

  filter(results: SearchFilterInput[]): SearchFilterInput[] {
    if (this.types.size === 0) {
      return results;
    }
    return results.filter((r) => this.types.has(r.type));
  }
}

export class ProjectFilter implements SearchFilter {
  name = "project";
  private projects: Set<string>;

  constructor(projects: string | string[]) {
    this.projects = new Set(Array.isArray(projects) ? projects : [projects]);
  }

  filter(results: SearchFilterInput[]): SearchFilterInput[] {
    if (this.projects.size === 0) {
      return results;
    }
    return results.filter((r) => r.project && this.projects.has(r.project));
  }
}

export class RelevanceThresholdFilter implements SearchFilter {
  name = "relevanceThreshold";
  private threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  filter(results: SearchFilterInput[]): SearchFilterInput[] {
    return results.filter((r) => {
      const similarity = r.finalScore || r.similarity || r.fts_rank || 0;
      return similarity >= this.threshold;
    });
  }
}

export class LimitFilter implements SearchFilter {
  name = "limit";
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  filter(results: SearchFilterInput[]): SearchFilterInput[] {
    return results.slice(0, this.limit);
  }
}

export class DeduplicateFilter implements SearchFilter {
  name = "deduplicate";
  private key: string;

  constructor(key: string = "title") {
    this.key = key;
  }

  filter(results: SearchFilterInput[]): SearchFilterInput[] {
    const seen = new Set<string>();
    return results.filter((r) => {
      const value = r[this.key] || "";
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
  }
}

export const builtInFilters = {
  dateRange: DateRangeFilter,
  type: TypeFilter,
  project: ProjectFilter,
  relevanceThreshold: RelevanceThresholdFilter,
  limit: LimitFilter,
  deduplicate: DeduplicateFilter,
};
