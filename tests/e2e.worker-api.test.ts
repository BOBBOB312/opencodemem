import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withWorker<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const port = 5600 + Math.floor(Math.random() * 200);
  const baseUrl = `http://127.0.0.1:${port}`;
  const worker = Bun.spawn({
    cmd: [process.execPath, "run", "worker:start"],
    cwd: rootDir,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  const waitForHealth = async (timeoutMs: number = 10000): Promise<void> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body.status === "ok") return;
        }
      } catch {
        // no-op
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    let stderr = "";
    if (worker.stderr) {
      stderr = await new Response(worker.stderr).text();
    }
    throw new Error(`Worker did not become healthy in time. stderr=${stderr}`);
  };

  await waitForHealth();

  try {
    return await fn(baseUrl);
  } finally {
    if (worker.exitCode === null) {
      worker.kill();
    }
  }
}

describe("E2E worker APIs", () => {
  test("search -> timeline -> get_observations -> context works", { timeout: 25000 }, async () => {
    await withWorker(async (baseUrl) => {
      const project = `e2e-project-${Date.now()}`;
      const sessionId = `e2e-session-${Date.now()}`;

      const initRes = await fetch(`${baseUrl}/api/sessions/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, project }),
      });
      expect(initRes.ok).toBe(true);

      const saveRes = await fetch(`${baseUrl}/api/memory/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Queue-backed ingestion is used for reliability and replay.",
          project,
          sessionId,
          type: "decision",
          title: "Use queue-backed ingestion",
        }),
      });
      expect(saveRes.ok).toBe(true);

      const searchParams = new URLSearchParams({ query: "queue", project, limit: "10" });
      const searchRes = await fetch(`${baseUrl}/api/search?${searchParams}`);
      expect(searchRes.ok).toBe(true);
      const searchBody = (await searchRes.json()) as { results?: Array<{ id: number }> };
      const ids = (searchBody.results || []).map((r) => r.id).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);

      const timelineParams = new URLSearchParams({
        anchor: String(ids[0]),
        project,
        depth_before: "2",
        depth_after: "2",
      });
      const timelineRes = await fetch(`${baseUrl}/api/timeline?${timelineParams}`);
      expect(timelineRes.ok).toBe(true);

      const batchRes = await fetch(`${baseUrl}/api/observations/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, project }),
      });
      expect(batchRes.ok).toBe(true);

      const injectParams = new URLSearchParams({
        project,
        maxTokens: "200",
        maxMemories: "2",
        sessionId,
      });
      const injectRes = await fetch(`${baseUrl}/api/context/inject?${injectParams}`);
      expect(injectRes.ok).toBe(true);

      await fetch(`${baseUrl}/api/cleanup/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, confirm: true }),
      });
    });
  });
});
