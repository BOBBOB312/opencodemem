import { logger } from "../logger.js";

export interface SSEClient {
  id: string;
  project?: string;
  sessionId?: string;
  send(data: string): void;
  close(): void;
}

export interface SSEMessage {
  type: string;
  payload: Record<string, unknown>;
  timestamp?: number;
}

export class SSEBroadcaster {
  private static instance: SSEBroadcaster | null = null;
  private clients: Map<string, SSEClient> = new Map();
  private projectClients: Map<string, Set<string>> = new Map();
  private sessionClients: Map<string, Set<string>> = new Map();

  static getInstance(): SSEBroadcaster {
    if (!SSEBroadcaster.instance) {
      SSEBroadcaster.instance = new SSEBroadcaster();
    }
    return SSEBroadcaster.instance;
  }

  addClient(client: SSEClient): void {
    this.clients.set(client.id, client);

    if (client.project) {
      if (!this.projectClients.has(client.project)) {
        this.projectClients.set(client.project, new Set());
      }
      this.projectClients.get(client.project)!.add(client.id);
    }

    if (client.sessionId) {
      if (!this.sessionClients.has(client.sessionId)) {
        this.sessionClients.set(client.sessionId, new Set());
      }
      this.sessionClients.get(client.sessionId)!.add(client.id);
    }

    logger.info("SSE", `Client ${client.id} connected`);
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (client.project) {
      this.projectClients.get(client.project)?.delete(clientId);
    }
    if (client.sessionId) {
      this.sessionClients.get(client.sessionId)?.delete(clientId);
    }

    this.clients.delete(clientId);
    logger.info("SSE", `Client ${clientId} disconnected`);
  }

  broadcast(message: SSEMessage, project?: string, sessionId?: string): void {
    const data = `data: ${JSON.stringify({ ...message, timestamp: message.timestamp || Date.now() })}\n\n`;
    const targetIds = new Set<string>();

    if (project) {
      const projectClientIds = this.projectClients.get(project);
      if (projectClientIds) {
        projectClientIds.forEach(id => targetIds.add(id));
      }
    }

    if (sessionId) {
      const sessionClientIds = this.sessionClients.get(sessionId);
      if (sessionClientIds) {
        sessionClientIds.forEach(id => targetIds.add(id));
      }
    }

    if (!project && !sessionId) {
      this.clients.forEach((_, id) => targetIds.add(id));
    }

    for (const clientId of targetIds) {
      const client = this.clients.get(clientId);
      if (client) {
        try {
          client.send(data);
        } catch (error) {
          logger.error("SSE", `Failed to send to client ${clientId}`, {
            error: String(error),
          });
          this.removeClient(clientId);
        }
      }
    }
  }

  sendToClient(clientId: string, message: SSEMessage): void {
    const client = this.clients.get(clientId);
    if (client) {
      const data = `data: ${JSON.stringify({ ...message, timestamp: Date.now() })}\n\n`;
      client.send(data);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getClientCountByProject(project: string): number {
    return this.projectClients.get(project)?.size || 0;
  }

  getClientCountBySession(sessionId: string): number {
    return this.sessionClients.get(sessionId)?.size || 0;
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.close();
      } catch (error) {
        logger.error("SSE", "Error closing client", {
          error: String(error),
        });
      }
    }
    this.clients.clear();
    this.projectClients.clear();
    this.sessionClients.clear();
  }
}

export const sseBroadcaster = SSEBroadcaster.getInstance();
