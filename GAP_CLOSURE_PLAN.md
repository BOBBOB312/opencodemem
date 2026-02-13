# OpenCodeMem 补齐文档（对齐设计与 ClaudeMem）

## 1. 文档目标

本文档用于指导 `opencodemem` 从当前 MVP 状态补齐到：

1. 与 `opencodemem-design-doc.md` 定义一致；
2. 在核心能力上与 `claudemem` 达到“功能等价、体验接近”；
3. 满足可上线的稳定性、可观测性与测试覆盖要求。

---

## 2. 当前差距总览（基于代码审查）

### 2.1 接口层差距

- 已有：`/api/health`、`/api/stats`、`/api/search`、`/api/timeline`、`/api/observations/batch`、`/api/memory/save`、`/api/memory/list`、`/api/memory/:id`、`/api/context/inject`、`/api/events/ingest`
- 缺失：`/api/sessions/init`、`/api/sessions/complete`（设计文档要求）
- 建议：保留 `/api/events/ingest` 兼容层，但新增会话显式 API 并将插件调用切换到显式 API。

### 2.2 检索能力差距

- 当前 `search` 主要是 `LIKE` 查询 + 简单相似度函数，不是 FTS-first。
- `memory_index` 建了 FTS5 虚表，但未形成稳定写入/同步/排名链路。
- 向量检索仅配置层存在，未实现 `vectors` 表与召回逻辑。
- 缺失“混合排序”实现（lexical + semantic + recency + tag boost）。

### 2.3 注入与上下文预算差距

- 注入默认逻辑有，但 token 预算未严格执行。
- `/api/context/inject` 存在参数处理错误（多余参数 push）。
- 注入内容格式较简化，未充分满足“高置信、可追溯、预算可控”。

### 2.4 生命周期与异步处理差距

- 插件 warmup 时序与 worker 启动关系不稳（可能导致 not ready）。
- 缺少稳定的后台队列/重试机制（设计要求低延迟、异步化）。
- `session.idle`/`session.compacted` 有接入，但处理链路偏简化。

### 2.5 Web Viewer 与可观测性差距

- web server 目前为占位实现，无可用 UI。
- 缺少关键运行指标（队列长度、失败率、检索耗时分位数）。

### 2.6 配置与工程质量差距

- 配置文件标注 `jsonc`，实际使用 `JSON.parse`，不支持注释。
- `storagePath` 未真实驱动数据库文件路径。
- 自动化测试缺失（当前 0 test files）。

---

## 3. 补齐目标（Definition of Done）

满足以下全部条件视为补齐完成：

1. `search -> timeline -> get_observations` 端到端稳定可用；
2. `session start / first prompt / compaction` 三类注入触发可控；
3. 检索支持 FTS 排序，向量检索可选开关，混合排序生效；
4. 手动 memory 操作（save/list/delete）与自动捕获一致入库；
5. 隐私策略（private tag + secret redaction）可配置且可测试；
6. Web Viewer 可查看 timeline、搜索、详情、配置诊断；
7. 单元 + 集成 + 恢复性测试通过，CI 绿灯。

---

## 4. 实施路线图

## Phase 0（1-2 天）阻塞问题修复

### P0-1 Worker 启动与就绪流程

- 调整插件初始化顺序：先确保 worker 进程可用，再 warmup。
- 引入就绪探针重试（指数退避，最大等待 10~20s）。
- 若 worker 不可用，降级：插件功能提示 + 不阻塞主对话。

### P0-2 配置加载可靠性

- 用 `jsonc-parser` 或等效方案替换 `JSON.parse`。
- 正确支持 `~` 展开与 schema 校验（zod）。

### P0-3 context 注入 bug 修复

- 修复 `/api/context/inject` 参数绑定错误。
- 增加注入预算单测（max tokens、max memories、max age、排除当前会话）。

### P0-4 storagePath 生效

- DB 路径改为 `CONFIG.storagePath` 可配置。
- 首次迁移时兼容旧路径并给出迁移日志。

---

## Phase 1（3-5 天）设计文档核心能力补齐

### P1-1 API 对齐

- 新增并接入：
  - `POST /api/sessions/init`
  - `POST /api/sessions/complete`
- 保留 `/api/events/ingest` 作为兼容层，内部路由到统一 service。

### P1-2 数据层完善

- 确保以下表与索引完整并可迁移：
  - `sessions`、`user_prompts`、`observations`、`summaries`、`memory_index`
  - 可选 `vectors`
- 为 `memory_index` 增加写入策略：
  - 方案 A：触发器自动维护
  - 方案 B：repository 写入时同步更新（推荐先 B，后续再 A）

### P1-3 三层检索闭环

- `search`：FTS5 主召回（替代 LIKE 主路径）
- `timeline`：围绕 anchor 提供前后文 + prompt 关联
- `get_observations`：批量返回完整详情
- 响应结构统一且可扩展（含 score、reason、timing）。

### P1-4 注入策略补齐

- 触发点：首条消息、always、compaction
- 守卫：max observations、token budget、exclude current session、max age
- 输出格式：精简 bullet + observation ID + 置信过滤

---

## Phase 2（4-6 天）与 ClaudeMem 的能力对齐

### P2-1 混合排序实现

- 建立统一 `Ranker`：
  - `score = 0.45*lexical + 0.35*semantic + 0.15*recency + 0.05*tagBoost`
- 语义关闭时自动 fallback：`lexical + recency + tagBoost` 并归一化。

### P2-2 向量检索（可选）

- 增加 `vectors` 表与 embedding pipeline（异步）。
- 开关：`embedding.enabled`，失败不影响主链路。
- 首版可使用本地模型或远程 provider（按配置）。

### P2-3 自动捕获增强

- 从“工具名摘要”升级为结构化 observation：
  - type/title/subtitle/text/facts/files_read/files_modified/prompt_number
- 在 `session.idle` + `session.compacted` 做异步归档，避免 chat 路径阻塞。

### P2-4 可靠性与恢复

- 加入轻量任务队列（本地持久化或 WAL 事务重放）。
- 失败重试与死信记录。
- 进程重启后的幂等处理（避免重复 observation）。

---

## Phase 3（3-5 天）体验与可维护性

### P3-1 Web Viewer 可用版

- 页面能力：
  - 时间线
  - 关键词搜索
  - observation 详情
  - 配置与诊断（健康状态、索引状态、队列状态）

### P3-2 可观测性

- 指标：
  - API p50/p95
  - 检索命中率
  - 注入条数/预算消耗
  - 队列长度与失败率
- 日志：结构化 JSON + trace id/session id。

### P3-3 清理与治理

- 实现 retention（maxMemories、maxAgeDays）定时清理。
- 一键 purge（按 project / 全量）并二次确认。

---

## 5. API 对齐清单

| 设计项 | 当前状态 | 目标状态 | 优先级 |
|---|---|---|---|
| `POST /api/sessions/init` | 缺失 | 新增并接入插件 | P1 |
| `POST /api/sessions/complete` | 缺失 | 新增并接入插件 | P1 |
| `POST /api/events/ingest` | 已有 | 兼容保留，内部收敛 | P1 |
| `GET /api/search` | 已有（LIKE） | FTS + ranking | P1/P2 |
| `GET /api/timeline` | 已有 | 补强过滤与结构 | P1 |
| `POST /api/observations/batch` | 已有 | 保持并加校验 | P1 |
| `GET /api/context/inject` | 已有 | 修 bug + 严格预算 | P0/P1 |
| `GET /api/health` | 已有 | 增加依赖状态 | P3 |
| `GET /api/stats` | 已有 | 增加延迟/失败指标 | P3 |

---

## 6. 数据库迁移计划

1. 建立迁移目录：`src/services/sqlite/migrations/`
2. 迁移分层：
   - `001_init.sql`：核心表/索引
   - `002_fts_index.sql`：FTS 与回填
   - `003_vectors.sql`：向量表（可选）
3. 启动时执行未应用迁移（记录 `schema_migrations`）。
4. 对历史数据做一次性回填（observations -> memory_index）。

---

## 7. 测试补齐计划

## 7.1 单元测试

- `privacy.ts`：private tag / redaction
- `context-builder.ts`：token 预算、截断、格式
- `ranker.ts`：多信号打分与归一化
- `config.ts`：jsonc 加载、默认值合并、路径展开

## 7.2 集成测试

- plugin hook -> worker -> sqlite -> search/timeline/observations
- first prompt 注入 + compaction 注入
- memory CRUD 与 project 隔离

## 7.3 可靠性测试

- worker 异常退出后重启
- 写入中断（kill）后 WAL 恢复
- idle/compaction 并发触发下幂等性

## 7.4 性能测试

- 10k~100k observations 下 `search/timeline` p95
- 注入接口在 budget 限制下的耗时与稳定性

---

## 8. 交付验收（按阶段）

### Phase 0 验收

- 插件启动后 20s 内 worker ready（或明确降级提示）
- jsonc 含注释配置可加载
- context 注入 bug 回归测试通过

### Phase 1 验收

- 设计 API 全部可调用
- 三层检索 E2E 可用
- 注入触发点与守卫完整可配

### Phase 2 验收

- 混合排序稳定输出
- 向量开关启用/关闭均可工作
- 自动捕获结构化质量明显提升

### Phase 3 验收

- Viewer 可用于日常排障
- 指标与日志可定位主要故障
- 全测试集通过，CI 稳定

---

## 9. 推荐任务分解（可直接建 issue）

1. 修复 worker warmup 启动顺序与重试机制（P0）
2. 支持 jsonc 配置解析 + zod 校验（P0）
3. 修复 context/inject SQL 参数错误并补单测（P0）
4. storagePath 全链路生效 + 数据迁移（P0/P1）
5. 新增 sessions/init 与 sessions/complete（P1）
6. search 改造为 FTS5 主路径（P1）
7. ranker 抽象与混合排序实现（P2）
8. vectors 表与 embedding pipeline（P2）
9. 自动捕获结构化 observation（P2）
10. web viewer 可用版（P3）
11. 指标与诊断端点扩展（P3）
12. 单元/集成/可靠性/性能测试补齐（贯穿）

---

## 10. 风险与应对

- Hook 语义与 Claude 不完全一致：使用事件抽象层 + fallback checkpoint（idle/compacted）
- 向量服务冷启动慢：lazy init + lexical fallback
- 注入污染风险：默认保守阈值 + 类型白名单 + 置信过滤
- 本地部署环境差异：启动自检、错误可诊断、降级不阻塞主会话

---

## 11. 建议里程碑（10-18 天）

- M1（D2）：Phase 0 完成，可稳定启动与注入
- M2（D7）：Phase 1 完成，设计文档功能闭环
- M3（D13）：Phase 2 完成，检索质量对齐 ClaudeMem
- M4（D18）：Phase 3 完成，体验与可维护性达标

---

## 12. 仅剩余项清单（当前执行版）

以下为基于当前代码状态的“未完成/部分完成”任务清单，可直接用于排期：

### 12.1 P0（阻塞优先）

1. 打通 worker 启动闭环
   - 目标：确保“先 worker 可用，再 warmup”，并在 worker 不可用时给出降级提示（不阻塞主对话）。
   - 现状：client 层已有重试，但插件初始化顺序仍可能导致 not ready。

2. 补齐 `/api/context/inject` 回归测试
   - 覆盖：`maxTokens`、`maxAgeDays`、`excludeCurrentSession`、`maxMemories`。
   - 目标：避免注入预算和过滤逻辑回归。

### 12.2 P1（设计文档闭环）

3. 建立数据库迁移体系
   - 新增：`src/services/sqlite/migrations/`、`schema_migrations`。
   - 要求：支持版本化迁移、重复执行幂等、错误可回滚/可恢复。

4. 插件侧接入会话显式 API
   - 目标：在会话开始/结束时实际调用 `sessions/init` 与 `sessions/complete`。
   - 说明：目前 worker-client 已有封装，需完成插件调用链路。

5. 完成 FTS 索引增量维护
   - 目标：新增/更新 observation 时同步维护 `memory_index`。
   - 可选：触发器自动维护，或 repository 层同步写入。

### 12.3 P2（对齐 ClaudeMem 质量）

6. 向量检索链路闭环
   - 目标：启动时初始化 vector service，新增 observation 后异步 embedding。
   - 要求：embedding 失败不阻塞主检索，自动 fallback lexical。

7. 自动捕获升级为 observation-first
   - 目标：以结构化 observation 入库为主（`type/title/subtitle/text/facts/files_read/files_modified/prompt_number`）。
   - 要求：幂等去重，避免重复污染记忆。

8. 增加异步队列与可靠性机制
   - 包含：重试、死信、重启恢复、并发幂等。
   - 目标：满足低延迟 chat 路径与后台重处理需求。

### 12.4 P3（可用性与运维）

9. Web Viewer 工程化可用
   - 目标：timeline/search/detail/config-diagnostics 全链路可用。
   - 要求：不是占位页面，需可用于日常排障与检索验证。

10. 可观测性补齐
    - 指标：API p50/p95、错误率、检索命中率、注入预算使用率、队列长度/失败率。
    - 日志：结构化日志，携带 session/project 维度。

11. 清理治理安全化
    - 目标：retention 定时任务与 purge 安全机制完善。
    - 要求：project 范围约束、参数化 SQL、二次确认、审计日志。

### 12.5 测试（贯穿，当前缺口最大）

12. 测试体系补齐
    - 单元：`privacy/config/ranker/context-builder`
    - 集成：`hook -> worker -> db -> search/timeline/inject`
    - 可靠性：`kill/restart`、并发事件幂等
    - 性能：`10k~100k observations` 下 p95

> 交付建议：优先完成 1~5（P0+P1），可先达成“设计文档闭环”；再推进 6~12 做质量对齐与稳定性收口。
