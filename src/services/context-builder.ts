interface MemoryWithScore {
  similarity: number;
  memory: string;
}

interface SearchResponse {
  results: MemoryWithScore[];
  total: number;
  timing: number;
}

export function formatContextForPrompt(
  userId: string | null,
  memories: SearchResponse
): string | null {
  if (!memories.results || memories.results.length === 0) {
    return null;
  }

  let context = "## Relevant Project Context\n\n";

  for (const result of memories.results) {
    const memoryText = result.memory.substring(0, 300);
    context += `- ${memoryText}${result.memory.length > 300 ? "..." : ""}\n`;
  }

  context += "\n*This context is from your previous sessions.*";

  return context;
}

export function formatMemoriesList(memories: any[]): string {
  if (memories.length === 0) {
    return "No memories found.";
  }

  let output = "## Recent Memories\n\n";

  for (const memory of memories) {
    const date = new Date(memory.createdAt).toLocaleDateString();
    output += `### [${memory.id}] ${date}\n`;
    output += `${memory.summary || memory.content}\n\n`;
  }

  return output;
}

export function calculateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return text;
  }
  return text.substring(0, maxChars - 100) + "...[truncated]";
}
