import type { CompiledObservation } from "../observation-compiler.js";

export interface FormatOptions {
  maxLength?: number;
  includeFiles?: boolean;
  includeFacts?: boolean;
  includeTimestamp?: boolean;
}

export interface Formatter {
  name: string;
  format(observations: CompiledObservation[], options?: FormatOptions): string;
}

export class CompactFormatter implements Formatter {
  name = "compact";

  format(observations: CompiledObservation[], options: FormatOptions = {}): string {
    const lines: string[] = [];
    
    for (const obs of observations) {
      const timestamp = options.includeTimestamp 
        ? new Date(obs.timestamp).toISOString().split("T")[0] + ": "
        : "";
      const content = obs.content.substring(0, options.maxLength || 200);
      lines.push(`- ${timestamp}[${obs.type}] ${obs.title}: ${content}`);
    }

    return lines.join("\n");
  }
}

export class DetailedFormatter implements Formatter {
  name = "detailed";

  format(observations: CompiledObservation[], options: FormatOptions = {}): string {
    const sections: string[] = [];

    for (const obs of observations) {
      const lines: string[] = [];
      lines.push(`## ${obs.title}`);
      
      if (obs.subtitle) {
        lines.push(`*${obs.subtitle}*`);
      }
      lines.push("");

      if (options.includeFacts && obs.facts.length > 0) {
        lines.push("### Facts");
        for (const fact of obs.facts) {
          lines.push(`- ${fact}`);
        }
        lines.push("");
      }

      if (obs.content) {
        const content = options.maxLength 
          ? obs.content.substring(0, options.maxLength) + (obs.content.length > options.maxLength ? "..." : "")
          : obs.content;
        lines.push(content);
      }

      if (options.includeFiles) {
        if (obs.filesRead.length > 0) {
          lines.push("\n**Files read:** " + obs.filesRead.join(", "));
        }
        if (obs.filesModified.length > 0) {
          lines.push("\n**Files modified:** " + obs.filesModified.join(", "));
        }
      }

      if (options.includeTimestamp) {
        lines.push(`\n*Created: ${new Date(obs.timestamp).toLocaleString()}*`);
      }

      sections.push(lines.join("\n"));
    }

    return sections.join("\n\n---\n\n");
  }
}

export class TimelineFormatter implements Formatter {
  name = "timeline";

  format(observations: CompiledObservation[], options: FormatOptions = {}): string {
    const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = ["## Timeline", ""];

    for (const obs of sorted) {
      const date = new Date(obs.timestamp).toLocaleString();
      lines.push(`### ${date}`);
      lines.push(`- **Type:** ${obs.type}`);
      lines.push(`- **Title:** ${obs.title}`);
      if (obs.content) {
        const content = options.maxLength 
          ? obs.content.substring(0, options.maxLength) + (obs.content.length > options.maxLength ? "..." : "")
          : obs.content;
        lines.push(`- **Summary:** ${content}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

export class MarkdownFormatter implements Formatter {
  name = "markdown";

  format(observations: CompiledObservation[], options: FormatOptions = {}): string {
    const lines: string[] = ["# Observations", ""];

    for (const obs of observations) {
      lines.push(`## ${obs.title}`);
      lines.push("");
      lines.push(`> **Type:** ${obs.type} | **Session:** ${obs.sessionId}`);
      
      if (obs.content) {
        lines.push("");
        lines.push(obs.content);
      }

      if (options.includeFacts && obs.facts.length > 0) {
        lines.push("");
        lines.push("**Key Facts:**");
        for (const fact of obs.facts) {
          lines.push(`- ${fact}`);
        }
      }

      if (options.includeFiles) {
        if (obs.filesRead.length > 0 || obs.filesModified.length > 0) {
          lines.push("");
          if (obs.filesRead.length > 0) {
            lines.push(`*Read:* ${obs.filesRead.join(", ")}`);
          }
          if (obs.filesModified.length > 0) {
            lines.push(`*Modified:* ${obs.filesModified.join(", ")}`);
          }
        }
      }

      lines.push("");
      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }
}

export const formatters: Record<string, Formatter> = {
  compact: new CompactFormatter(),
  detailed: new DetailedFormatter(),
  timeline: new TimelineFormatter(),
  markdown: new MarkdownFormatter(),
};

export function getFormatter(name: string): Formatter {
  return formatters[name] || formatters.compact;
}
