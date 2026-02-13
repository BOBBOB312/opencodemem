# OpenCodeMem

Persistent memory system for OpenCode - preserves context across sessions.

## Installation

Add to your OpenCode configuration at `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["opencodemem"],
}
```

## Configuration

Create `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "storagePath": "~/.opencode-mem/data",
  "webServerEnabled": true,
  "webServerPort": 4747,
  "autoCaptureEnabled": true,
  "chatMessage": {
    "enabled": true,
    "maxMemories": 3,
    "injectOn": "first"
  },
  "compaction": {
    "enabled": true,
    "memoryLimit": 5
  }
}
```

## Usage

```typescript
memory({ mode: "add", content: "Project uses microservices architecture" });
memory({ mode: "search", query: "architecture" });
memory({ mode: "list", limit: 10 });
```

## Development

```bash
bun install
bun run build
bun run worker:start
```
