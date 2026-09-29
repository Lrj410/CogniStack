# 接入手册 · INTEGRATION

> 面向**把 CogniStack 接进宿主系统**的开发者。引擎自身的字段语义见 [USAGE.md](./USAGE.md)；
> 六份可直接运行的参考实现见 [examples/REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md)。

引擎无状态：它不持有会话、不落盘、不发网络请求（除了你注入的分词器/端口实现）。
「宿主」负责持有对话与记忆状态，并在每一轮按 §6 的时序调用引擎。

---

## 1. 四种接入方式

| 方式 | 形态 | 适用 | 落地文件 |
|---|---|---|---|
| **SDK 直连** | 进程内 `require("cognistack-engine")` | 同语言宿主（Node） | `examples/minimal.cjs` |
| **HTTP 网关** | `tools/viz-server.cjs` 提供 `/v1/prepare` 等 | 跨进程 / 跨语言宿主 + 自带控制台 | `examples/http-call.cjs` |
| **兼容中间件** | 「OpenAI/Anthropic 客户端 → 中间件 → 上游模型」 | 想零改造复用现成客户端 | `tools/openai-compat.cjs`、`tools/anthropic-compat.cjs` |
| **端口注入** | `engine.connect(manifest)` | 让外部服务向引擎提供能力 | `tools/example-client.cjs` |

---

## 2. 端口接入协议

外部系统通过 `connect()` 声明「我是谁、我能提供哪些端口」：

```js
const engine = new CogniStackEngine({ telemetry: getGlobalTelemetry() });

const conn = engine.connect({
  id: "my-service",          // 稳定 id：重复 connect 同一 id 是刷新而非新建
  name: "我的服务",
  kind: "worker",            // service / client / worker / cli …（面板按此着色）
  version: "1.0.0",
  provides: { lore, card, macros },   // 提供哪个接哪个，其余用引擎缺省
  requires: ["lore"],                 // 信息性：面板画依赖
  priority: 10,
});

conn.update({ version: "1.0.1" });
conn.close();
```

- 端口名：`PORT_NAMES` = `card` / `macros` / `lore` / `state` / `preset` / `regex` / `vector` / `tools` / `mcp`。
- **解析优先级**：构造函数注入（`collaborators`/`wire`）＞ `connect()` ＞ 引擎缺省。
- **`priority` 小者胜**；同端口多方注册时其余进 `shadowed`。
- 诊断：`engine.portDiagnostics()` → `[{ port, bound, winner, shadowed, source }]`；
  `engine.portTable()` 给绑定表。
  ⚠ 诊断只统计 `connect()` 注册表，**不反映构造函数注入的 `collaborators`**（已知不一致）。

---

## 3. HTTP 网关（`tools/viz-server.cjs`）

```bash
node tools/viz-server.cjs --port 7331          # 默认只绑 127.0.0.1
npm run viz                                     # = build + 上面这条
```

三网隔离（`local` / `lan` / `wan`）**同一套 handler，按 `SURFACE` 放行路径**。
默认只起 `local`（`127.0.0.1:7331`）。

### 端点

| 方法 路径 | 段 | 请求体 / 响应要点 |
|---|---|---|
| `GET /v1` | 全 | 自描述：`name,version,zone,base,endpoints,auth,lore,note` |
| `GET /v1/health` | 全 | `ok,zone,engine,version,uptimeMs,auth,prepareQueue…`（wan 仅 `ok,zone`） |
| `POST /v1/prepare` | 全 | 见下；错误 400/413/415/503；响应头 `x-worker-id` |
| `GET /api/snapshot` | local,lan | 遥测快照 + `portDiagnostics,system,gateway` |
| `GET /api/metrics`、`GET /metrics` | local,lan / 仅 local | Prometheus 文本 |
| `GET /api/stream` | local,lan | SSE：`event:snapshot` / `event:progress` |
| `POST /api/stream-ticket` | local,lan | 发一次性 SSE ticket |
| `POST /api/host` | local,lan | `id`(必) `name,kind,version,provides[],requires[]` → `{ok:true}` |
| `POST /api/turn` | local,lan | `hostId`(必) + turn-map 扁平字段 → `{ok:true}` |
| `POST /api/ports` | local,lan | `hostId`(必) `ports[]`(必) → `{ok:true,hosts}` |
| `POST /api/reset` | 仅 local | 清遥测与端口报告 → `{ok:true,turnLog:"kept…"}` |
| `GET /api/turn-log` | 仅 local | `limit,hostId,from,to` → `turns,scanned,malformed,stats` |
| `POST /api/turn-log/replay`、`/clear` | 仅 local | 回放 / 清空回合日志 |
| `POST /api/zones/start|stop` | 仅 local | 起停 lan/wan 监听 |
| `POST /api/cluster/scale|reload|config|bench` | 仅 local | Worker 热伸缩 / 重载 / 限流配置 / 压测 |
| `POST /api/gateway/block|unblock|clear-clients|clear-rejects` | 仅 local | 网关治理 |

`POST /v1/prepare` 请求字段（别名 `card`/`dialogue` …）：必填 `dialogue[]`（≥1，
`role ∈ user/assistant/system`）；`mode ∈ generate|status`（`status` 必须带
`priorAssembledPromptTokens`）。可选：`profile`/`card`、`summary`、`summaryBlocks[]`、
`summarizedCount`、`summarizedThroughMessageId`、`pairBatchSize`、`memory{}`、
`loreEntries()`/`worldEntries[]`、`loreEnabled`、`scanText`、`personaBio`、`worldState{entries[]}`、
`macros{}`、`contextTokenLimit`、`completionReserveTokens`、`softTrimTokenCap`、`maxContextChars`、
`cacheScope`、`label`、`meta{}`、`budget{}`、`vectorHits[]`、`charsPerToken`、
`host{id,name,kind,version,meta}`。`fragments`/`preset`/`authorsNote` 被显式丢弃。

### 鉴权与限流

- key 来源：`--local-key`/`--key`（或 `COGNISTACK_LOCAL_KEY`/`COGNISTACK_API_KEY`）；
  lan `--lan-key`；wan `--wan-key` 另需代理头 `x-cognistack-proxy-key`。
- 需鉴权：所有 `/api/*` + `/metrics` + `POST /v1/prepare`（`/v1`、`/v1/health` 不鉴权）。
  头 `Authorization: Bearer <key>` 或 `x-api-key`；SSE 可用一次性 `?ticket=`。
- **固定窗口 1000ms，按客户端 IP**，默认 local/lan **30/s**、wan 10/s。
- 开放监听却无 key 会直接 FATAL（除非 `--allow-open`）。

### 静态托管

仅 `local` 段服务 `console/dist`（SPA 回退 `index.html`），`cache-control: no-store`，
并下 `nosniff` / `DENY` / `no-referrer` 与收紧的 CSP（`font-src 'self'`，无外部源）。

---

## 4. 兼容中间件

把现成客户端零改造接进来——中间件在客户端与模型之间做装配，转发后原样回传（支持流式）。

### OpenAI 兼容（`tools/openai-compat.cjs`）

```bash
node tools/openai-compat.cjs \
  --upstream http://127.0.0.1:8080 \
  --tokenize-url http://127.0.0.1:8080/tokenize
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `8790` | 监听端口 |
| `--host` | `127.0.0.1` | 默认只绑回环 |
| `--upstream` | `http://127.0.0.1:8080` | 上游 OpenAI 兼容服务 |
| `--tokenize-url` | 空 | 真实分词；不传则用 `exactChar` 并**大声警告** |
| `--context-limit` | `8192` | n_ctx |
| `--reserve` | `1024` | 补全预留 |
| `--pair-batch` | `10` | 摘要回合数 N |
| `--agent-name` | `助手` | 宏名 |
| `--system-mode` | `drop` | `drop` 丢客户端 system；`prefix` 保留为 `fragments.systemPrefix` |
| `--summarize` | 关 | 响应后压摘要并推进水位 |

路由：`GET /health`、`GET /v1/health`、`POST /v1/chat/completions`（及 `/chat/completions`）。
会话键：`x-session-id` → `body.user`。错误体 `{error:{message,type,code}}`。

### Anthropic 兼容（`tools/anthropic-compat.cjs`）

`--port`(8792) `--host`(127.0.0.1) `--upstream`(https://api.anthropic.com)
`--tokenize-url`(空) `--context-limit`(8192) `--reserve`(1024) `--agent-name`(Claude助手)。
路由 `POST /v1/messages`；`system` 提到顶层；`completionReserveTokens = min(max_tokens, 1024)`；
会话键 `x-session-id` → `body.metadata.user_id`；`cacheScope` = `anthropic-<key>` / `anthropic-anon`。

---

## 5. 探活 ≠ 接入

**`GET /v1/health` 只探活**：不登记宿主、不产生回合。面板里的主机/回合**只来自真实
`POST /v1/prepare`（或显式 `POST /api/host`）**。

因此客户端的「测试连接」若想被面板看见，必须打一发**带 host 的最小 `prepare` 探针**
（host id 与正式调用一致，例如 `label: "联通探测"`），而不是只打 `/v1/health`。
参考实现：反诈能力综合评估系统的 `testCognistackConnection()`。

---

## 6. 回合时序

一轮对话的**规范时序**（宿主侧；与 [`scripts/sim.cjs`](./scripts/sim.cjs) 的演练一致）：

```
① 宿主把本轮的【用户消息】追加进本地对白        ← 此刻对话以 user 结尾
② engine.prepare({ profile, dialogue, summaryBlocks,
                   summarizedThroughMessageId, summarizedCount,
                   pairBatchSize, contextTokenLimit, completionReserveTokens,
                   tokenCounter, cacheScope, host, label })
③ 把 result.messages 发给模型 → 拿到助手回复
④ 宿主把【助手消息】追加进本地对白
⑤ 若 result.memory.shouldSummarize：
     摘要闭环（buildUserPrompt → 模型 → parseStructuredCompress →
     makeReplaceBlock → commitBlock）→ 推进水位（summarizedThroughMessageId / summarizedCount）
⑥ （可选）把记忆状态用信封落盘（§7）
⑦ 进入下一轮，回到 ①
```

要点：

- **先追加 user、再 `prepare`**：`prepare` 时对话必须以 `user` 结尾；助手回复在 `prepare`
  **之后**才入对白，避免把「还没生成的回答」喂进本轮 prompt。
- **水位只在⑤摘要成功后推进**；跳过或失败沿用旧水位。
- 「压缩重规划」轮次用 `mode: "status"`（不产 prompt），并传 `priorAssembledPromptTokens`。
- 一轮里要多次装配（如重试/分支）时复用同一 `cacheScope`，让装配缓存命中。

---

## 7. 记忆状态存哪

引擎无状态 → 记忆状态由宿主决定存哪。参考做法：**JSONL 每行一条快照信封**。

```js
const { serializeMemoryState, deserializeMemoryState } = require("cognistack-engine");

// 写：摘要提交后
fs.appendFileSync(file, JSON.stringify(serializeMemoryState({
  summaryBlocks, summarizedCount, summarizedThroughMessageId,
})) + "\n");

// 读：从后往前找第一条完整记录，校验并修复
const { state, repaired } = deserializeMemoryState(lastGoodLine);
```

- 崩溃最多损坏最后一行；从后往前读即可恢复。
- `deserializeMemoryState` 返回 `repaired` 明细（信封校验 + 修复）。
- 完整示范（含重启续跑、`[repair]` 演示）：[`examples/jsonl-session-host.cjs`](./examples/jsonl-session-host.cjs)。
- 框架集成（LangChain / Vercel AI SDK）用两个纯函数 `loadMemory` / `saveMemory`：
  [`examples/langchain-adapter.cjs`](./examples/langchain-adapter.cjs)。

---

## 8. 错误边界与被拒可见性

网关区分两类错误：

1. **输入契约错误**：网关自己产生，带 `err.expose`（由 `inputError()` 构造），
   **如实回传**给调用方（400/413/415）。
2. **引擎/端口抛出的错误**：**不外传**，只记录进 `snapshot.gateway.rejects.last.detail`
   （避免暴露上游 URL 等内部信息）。

**被拒也要可见**：`noteReject()` 会同时累加

- `snapshot.gateway.rejects = { total, byReason, byZone, last, events }`
- Prometheus 指标 `cognistack_gateway_rejects_total{reason=…}` 与
  `cognistack_gateway_rejects_by_zone_total{zone=…}`
- 控制台**只在主机页**报一条告警

`POST /api/reset` **不清零** rejects（它只重置遥测与端口报告）；要清零请调
`POST /api/gateway/clear-rejects`。

---

## 9. MCP 适配

把 MCP server 的能力接到引擎上：

```js
const { createMcpLoreProvider, createMcpToolProvider,
        mcpPromptToCard, mcpResourceToLoreEntry, mcpToolToToolDefinition } = require("cognistack-engine");
```

- `createMcpLoreProvider({ listResources, readResource })` → 知识端口实现。
- `createMcpToolProvider(...)` → `tools` 端口。
- 纯转换：`mcpResourceToLoreEntry` / `mcpPromptToCard` / `mcpToolToToolDefinition`。

---

## 10. 继续阅读

- 字段级语义与预算：**[USAGE.md](./USAGE.md)**
- 六份参考宿主与边界差异：**[examples/REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md)**
- 开发、门禁与发版：**[DEVELOPMENT.md](./DEVELOPMENT.md)**
- 控制台视觉与版式基线：**[console/DESIGN.md](./console/DESIGN.md)**