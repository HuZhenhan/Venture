# Venture Local API Harness

## 当前状态

- 已实现：本地 REST/SSE API、`/api/health`、最小 TypeScript SDK、最小 Node JSONL CLI。
- 预留：JSON-RPC route / stdio harness / CLI 流式事件转发。
- 非目标：一次性替换现有前端 service 或迁移所有 Electron 调用路径。

## REST/SSE 契约盘点

| 能力 | Method | Path | 请求 | 响应 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Health | `GET` | `/api/health` | 无 | `{ status, version, nonce, pid, startedAt }` | 已实现 |
| Legacy Health | `GET` | `/health` | 无 | 同 `/api/health` | 已实现，兼容保留 |
| Provider 列表 | `GET` | `/api/providers` | 无 | `{ providers: VentureProvider[] }` | 已实现 |
| Provider 新增 | `POST` | `/api/providers` | `{ name, baseUrl, apiKey, models, inputContextWindow }` | `{ provider }` | 已实现 |
| Provider 更新 | `PATCH` | `/api/providers/:id` | `{ name?, baseUrl?, apiKey?, models?, inputContextWindow? }` | `{ provider }` | 已实现 |
| Provider 删除 | `DELETE` | `/api/providers/:id` | 无 | `{ success: true }` | 已实现 |
| Chat Stream | `POST` | `/api/chat/stream` | `{ providerId?, modelId, messages, temperature?, maxTokens?, traceUpstream? }` | SSE `StreamEvent` | 已实现 |
| Tool Execute | `POST` | `/api/tools/execute` | `{ tool, input, chatId, turnMessageId?, modelId? }` | `{ output, isError, structured? }` | 已实现 |
| File Changes | `GET` | `/api/files/changes` | Query `{ turnId?, path? }` | `{ changes }` | 已实现 |
| Skill List | `GET` | `/api/skills` | 无 | `{ skills, shadowed, errors, platform }` | 已实现 |

## TypeScript SDK

- 入口：`src/app/sdk/index.ts`。
- 客户端：`new VentureClient({ baseUrl })`，`baseUrl` 支持字符串或异步 resolver。
- 错误：所有 SDK HTTP/网络失败抛出 `VentureApiError`，字段为 `{ status, code, message, trace }`。
- 首期封装：`health`、Provider CRUD、`streamChat`、`executeTool`、`getFileChanges`、`listSkills`。
- 复用证明：`src/app/services/modelConfigService.ts` 已改为通过 SDK 访问 Provider endpoint。

## CLI JSONL 协议

### 运行

```powershell
$env:VENTURE_API_BASE_URL="http://127.0.0.1:49527"
npm run cli:jsonl
```

### 输入帧

```json
{"id":"1","method":"health"}
```

```json
{"id":"2","method":"tools.execute","params":{"tool":"Glob","input":{"pattern":"**/*.ts"},"chatId":"cli"}}
```

### 输出帧

```json
{"id":"1","ok":true,"result":{"status":"ok"}}
```

```json
{"id":"2","ok":false,"error":{"code":"METHOD_NOT_FOUND","message":"Unsupported method: x"}}
```

### 已实现方法

- `health` -> `GET /api/health`
- `providers.list` -> `GET /api/providers`
- `skills.list` -> `GET /api/skills`
- `tools.execute` -> `POST /api/tools/execute`
- `files.changes` -> `GET /api/files/changes`

### 预留方法

- `chat.stream`：后续以多行 JSONL 事件转发 SSE，建议输出 `{ id, ok: true, event }` 和终止 `{ id, ok: true, done: true }`。
- `providers.create/update/delete`：后续按 SDK 参数透传 REST。

## JSON-RPC 渐进路线

- 阶段 1：保留 REST/SSE，新增文档化方法名和错误映射，不增加 route。
- 阶段 2：新增 `POST /api/rpc`，仅桥接无流式方法：`health`、`providers.list`、`skills.list`、`tools.execute`、`files.changes`。
- 阶段 3：为 `chat.stream` 定义 JSON-RPC over SSE 或 JSONL transport，不把流式强塞进单响应。
- 阶段 4：CLI stdio JSON-RPC 与 Node/TS SDK 共享同一 DTO，REST 继续作为底层兼容层。

## JSON-RPC 错误映射

- `VentureApiError.code` 映射到 JSON-RPC `error.code` 的字符串扩展字段 `data.code`。
- HTTP status 写入 `error.data.status`。
- 后端 trace 或原始 payload 写入 `error.data.trace`，默认不展示敏感 header/body。

