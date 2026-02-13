import { logger } from "./logger.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

export interface WebServerInstance {
  getUrl(): string;
  isServerOwner(): boolean;
  stop(): Promise<void>;
}

class WebServerManager implements WebServerInstance {
  private url: string = "";
  private isOwner: boolean = false;
  private server: any = null;

  async start(options: {
    port: number;
    host: string;
    enabled: boolean;
  }): Promise<WebServerInstance> {
    if (!options.enabled) {
      return this;
    }

    this.url = `http://${options.host}:${options.port}`;
    this.isOwner = false;

    const reachable = await this.waitForViewerEndpoint(this.url);
    if (reachable) {
      logger.info("WEB_SERVER", `Viewer available at ${this.url}/viewer`);
    } else {
      logger.warn("WEB_SERVER", "Viewer endpoint is not reachable yet", {
        url: this.url,
      });
    }

    return this;
  }

  private async waitForViewerEndpoint(baseUrl: string): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // no-op
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  getUrl(): string {
    return this.url;
  }

  isServerOwner(): boolean {
    return this.isOwner;
  }

  async stop(): Promise<void> {
    logger.info("WEB_SERVER", "Web server stopped");
  }
}

let webServerInstance: WebServerInstance | null = null;

export async function startWebServer(options: {
  port: number;
  host: string;
  enabled: boolean;
}): Promise<WebServerInstance> {
  if (webServerInstance) {
    return webServerInstance;
  }

  const manager = new WebServerManager();
  webServerInstance = await manager.start(options);
  return webServerInstance;
}

export async function stopWebServer(): Promise<void> {
  if (webServerInstance) {
    await webServerInstance.stop();
    webServerInstance = null;
  }
}

export function getViewerHtml(): string {
  const viewerPath = join(dirname(__dirname), "web-server", "viewer.html");
  
  if (existsSync(viewerPath)) {
    return readFileSync(viewerPath, "utf-8");
  }

  return `<!DOCTYPE html>
<html>
<head><title>OpenCodeMem Viewer</title></head>
<body>
  <h1>OpenCodeMem Viewer</h1>
  <p>Viewer HTML not found. Please ensure the plugin is properly installed.</p>
</body>
</html>`;
}
