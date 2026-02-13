# OpenCodeMem vs ClaudeMem 对齐清单

本文档按 `claude-mem-ref/src/services` 结构对照当前 `opencodemem` 实现，标注每个模块的对齐状态。

状态定义：

- `已对齐`：能力和职责基本一致
- `部分对齐`：能力有实现，但架构深度或覆盖不足
- `缺失`：当前没有对应实现

## 1. 模块对齐总表

| 参考模块 | 状态 | opencodemem 对应 | 说明 |
|---|---|---|---|
| `context/`（ContextBuilder/TokenCalculator/formatters） | **已对齐** | `src/services/context/*` | 有 config loader、observation compiler、多个 formatters (compact/detailed/timeline/markdown)。 |
| `domain/`（ModeManager/types） | **已对齐** | `src/domain/*` | 有 ModeManager、SessionMode、DomainContext、DomainEvent 类型。 |
| `infrastructure/`（GracefulShutdown/HealthMonitor/ProcessManager） | **已对齐** | `src/services/infrastructure/*` | 有 GracefulShutdown、HealthMonitor、ProcessManager。 |
| `integrations/`（hooks installer） | **已对齐** | `src/services/integrations/*` | 有 HookInstaller、事件系统、Claude hook 支持。 |
| `queue/SessionQueueProcessor` | **已对齐** | `src/services/queue/*` | 有通用会话事件队列处理器、重试、dead letter 支持。 |
| `server/`（ErrorHandler/Middleware/Server） | **已对齐** | `src/services/server/*` | 有 RequestLogger、RateLimiter、CORS、ErrorHandler、NotFoundHandler。 |
| `sqlite/migrations/runner` | **已对齐** | `src/services/sqlite/schema.ts`, `src/services/sqlite/migrations/*` | 有 migration 集合和执行。 |
| `sqlite/observations/*` | **已对齐** | `src/services/context/observation-compiler.ts` | 有 observation 编译器和 repository 功能。 |
| `sqlite/prompts/*` | **已对齐** | `src/services/worker/server.ts` | 有 `user_prompts` 写入与 timeline 查询。 |
| `sqlite/sessions/*` | **已对齐** | `src/services/worker/session/*` | 有独立 SessionStore 和 SessionService。 |
| `sqlite/summaries/*` | **已对齐** | `src/services/sqlite/summaries/*` | 有 SummaryRepository 和 SummaryGenerator。 |
| `sqlite/timeline/queries.ts` | **已对齐** | `src/services/context/observation-compiler.ts` | 有完整的 timeline 构建功能。 |
| `sqlite/PendingMessageStore` | **已对齐** | `src/services/sqlite/pending-message-store.ts` | 有 pending 消息持久层。 |
| `sqlite/transactions.ts` | **已对齐** | `src/services/sqlite/transactions.ts` | 有显式事务工具模块。 |
| `sync/ChromaSync.ts` | **已对齐** | `src/services/sync/*` | 有 ChromaSync 外部向量库同步层。 |
| `worker/search/*`（Orchestrator/strategies/filters） | **已对齐** | `src/services/search/*` | 有 SearchOrchestrator、filters (date/type/project/relevance/limit/dedup)。 |
| `worker/session/*` | **已对齐** | `src/services/worker/session/*` | 有独立 SessionStore 和 SessionService。 |
| `worker/validation/PrivacyCheckValidator` | **已对齐** | `src/services/worker/validation/*` | 有独立 PrivacyCheckValidator pipeline。 |
| `worker/SSEBroadcaster` | **已对齐** | `src/services/worker/sse-broadcaster.ts` | 有 SSE/实时广播功能。 |
| `worker/SettingsManager` | **已对齐** | `src/services/worker/settings-manager.ts` | 有运行时 SettingsManager。 |
| `worker/TimelineService` | **已对齐** | `src/services/context/observation-compiler.ts` | 有完整 TimelineService 功能。 |
| `worker-service.ts`（总编排器） | **已对齐** | `src/services/worker/server.ts` | 有 worker 服务编排。 |
| `Context.ts` / `context-generator.ts` 兼容层 | **已对齐** | `src/context.ts` | 有兼容性导出层。 |
| Web Viewer（调试界面） | 部分对齐 | `src/services/web-server/viewer.html`, `src/services/web-server.ts` | viewer 可用，但工程化与功能深度低于参考。 |
| 测试覆盖 | 部分对齐 | `tests/*.test.ts` | 已有单测与基础集成测试；缺可靠性/性能/端到端深测。 |

## 2. 结论

- 当前状态：**高对齐（核心链路已接入）**
- 可以认为：主路径已具备 `search -> timeline -> get_observations`、队列处理、SSE、运行时设置、隐私校验、会话与总结生成。
- 尚未完全等价：Web Viewer 工程化深度、Chroma 生态能力（高级治理/回溯工具）、可靠性与性能专项测试仍低于 `claude-mem-ref`。

## 3. 已完成模块（2026-02-13）

### 核心模块
- `src/domain/` - 域模型层（ModeManager, types）
- `src/services/infrastructure/` - 基础设施层（GracefulShutdown, HealthMonitor, ProcessManager）
- `src/services/sqlite/summaries/` - Summaries 生成/读取
- `src/services/sqlite/pending-message-store.ts` - Pending 消息持久层
- `src/services/sqlite/transactions.ts` - 事务工具
- `src/services/context/` - Context 子模块（config-loader, observation-compiler, formatters）
- `src/services/worker/session/` - 会话逻辑独立目录
- `src/services/search/orchestrator.ts` - 搜索策略编排
- `src/services/search/filters/` - 搜索过滤器

### 次要模块
- `src/services/worker/sse-broadcaster.ts` - SSE 广播
- `src/services/worker/settings-manager.ts` - 运行时设置管理
- `src/services/sync/chroma-sync.ts` - Chroma 同步
- `src/services/integrations/hooks.ts` - IDE Hooks 安装
- `src/services/server/` - Middleware 和 ErrorHandler
- `src/services/worker/validation/` - Privacy 验证管道
- `src/services/queue/session-queue-processor.ts` - 队列处理器
- `src/context.ts` - 兼容性导出层

## 4. 待改进
- Web Viewer 工程化增强（权限、分页、交互性能、错误态可视化）
- Chroma 同步能力增强（冲突处理、批量回补、失败重放可观测性）
- 测试覆盖（可靠性/性能/端到端）
