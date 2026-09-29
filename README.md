# CogniStack

> **上下文 × 记忆融合引擎** · 面向任意宿主的 prompt 装配、token 预算与长期记忆管线。
> Context × memory fusion engine: prompt assembly, token budgeting and long-term memory for any host.

[中文](#中文) · [English](#english)

---

## 中文

CogniStack 把**对话、人格档案、知识条目、世界状态、长期记忆块**按 token 预算装配成一条
**可直接发给模型**的 prompt；放不下时按优先级软裁剪，到达水位时给出摘要任务，并把「这一轮
发生了什么」全量上报给观测面板。它**无状态、零运行时依赖**——token 计数由你注入，
领域数据由端口（ports）注入。

一句话：**给任何 LLM 宿主一套可解释、可观测、可插拔的 prompt 装配与长期记忆管线。**

### 特性

- **零运行时依赖**：`dependencies` 为空；分词器通过 `TokenCounter` 注入，引擎自身不引任何库。
- **预算与软裁剪**：`resolveBudget` 算出 `hardFit`；超预算按 `SECTION_PRIORITY` 牺牲系统段，
  **从不丢弃未摘要的对话**；`protectLore` / `protectMemory` 可重映射优先级。
- **长期记忆闭环**：水位（条数 + 消息 id）、双触发（回合数 N / 上下文阈值）、结构化记忆
  （`【硬事实】/【时间线】/【关系与称呼】/【未决】/【近期情节】`）、记忆块压缩与审计。
- **端口可插拔**：`card` / `macros` / `lore` / `state` / `preset` / `regex` / `vector` / `tools` / `mcp`
  九类端口，构造函数注入或运行时 `connect()` 接入，优先级 `小者胜`。
- **全链路遥测**：每轮记录 `counterId`、预算归因、前缀稳定性等，喂给随仓库附带的可视化控制台。
- **四种接入**：SDK 直连 · HTTP 网关 · OpenAI/Anthropic 兼容中间件 · MCP 适配。

### 快速开始

```bash
# 需要 Node.js >= 22
npm install
npm run build
node examples/minimal.cjs
```

```js
const { CogniStackEngine, createHttpTokenCounter } = require("cognistack-engine");

const engine = new CogniStackEngine({
  systemRules: "回答准确、简洁；不确定时说明假设。",
});

const result = engine.prepare({
  profile: { name: "阿铁", description: "机房运维助手。" },
  dialogue: [{ id: "1", role: "user", content: "显卡型号？" }],
  contextTokenLimit: 8192,
  completionReserveTokens: 1024,
  tokenCounter: createHttpTokenCounter({ url: "http://127.0.0.1:8080/tokenize" }),
  cacheScope: "chat-1",
});

// result.messages → 直接发给模型
// result.memory.shouldSummarize → 是否该压缩长期记忆
```

### 一条管线

```
dialogue · profile · lore · worldState · summaryBlocks · vectorHits
        │
        ▼
   prepare()
        ├─ resolveBudget          预算：n_ctx − 补全预留 − 安全垫 − 模板开销 = hardFit
        ├─ ContextAssembleEngine  装配：按 SECTION_PRIORITY 拼系统段
        ├─ fitMessagesUnderTokenCap  超预算 → 软裁剪 → 有记录的紧急丢弃
        └─ PrefixTracker          前缀稳定性：上一轮 prompt 还能复用多少
        │
        ▼
   messages[]  ──►  你的模型
        │
        └─ memory.shouldSummarize ──► 摘要闭环 ──► 提交记忆块 ──► 推进水位 ──► 下一轮
```

### 仓库结构

| 目录 | 内容 |
|---|---|
| `src/` | 引擎（TypeScript，零运行时依赖）：`fusion/` `memory/` `context/` `host/` |
| `tools/` | HTTP 网关、三网隔离、回合日志、OpenAI / Anthropic 兼容中间件 |
| `console/` | Vite + React 实时控制台（产物由网关托管） |
| `examples/` | 六份可直接运行的参考宿主 |
| `test/` · `scripts/` | 测试与构建/门禁脚本 |

### 文档

| 文档 | 内容 |
|---|---|
| [USAGE.md](./USAGE.md) | 引擎使用手册：`prepare()` 字段、预算、记忆、持久化、端口、遥测 |
| [INTEGRATION.md](./INTEGRATION.md) | 宿主接入手册：HTTP 网关端点、兼容中间件、**回合时序**、错误边界 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 开发手册：构建、测试、门禁、发版、环境坑 |
| [examples/REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md) | 参考宿主与已知行为差异 |
| [console/DESIGN.md](./console/DESIGN.md) | 控制台视觉与版式体检基线 |

### 质量

- 测试：`tests ` <!-- N:tests -->457<!-- /N --> · `fail ` <!-- N:tests_fail -->0<!-- /N -->（`npm test`）。
- 门禁：`typecheck` · `api:surface:check`（公共 API 冻结）· `doc:numbers:check`（文档数字防漂移）·
  `verify:viz-http` · `bundle:audit`；控制台另有 `qa:classes` / `qa:layout`。

### 许可

[MIT](./LICENSE) © 2026 Lrj410

---

## English

CogniStack assembles **dialogue, agent profiles, knowledge entries, world state and long-term
memory blocks** into a single prompt that is ready to send to a model — under an honest token
budget. When it does not fit, it soft-trims system sections by priority (never dropping
un-summarized dialogue); when the watermark is reached, it hands you a summarization job; and it
reports what happened every turn to a live dashboard. It is **stateless and has zero runtime
dependencies** — token counting and domain data are both injected.

**One line:** a transparent, observable, pluggable prompt-assembly and long-term-memory pipeline
for any LLM host.

### Features

- **Zero runtime deps** — `dependencies` is empty; you inject a real `TokenCounter`.
- **Budget & soft-trim** — `resolveBudget` derives `hardFit`; over-budget sections are sacrificed by
  `SECTION_PRIORITY` (`protectLore` / `protectMemory` remap it).
- **Long-term memory loop** — count + message-id watermarks, dual triggers (pair batch N / context
  ratio), structured memory columns, block compaction and auditing.
- **Pluggable ports** — `card` / `macros` / `lore` / `state` / `preset` / `regex` / `vector` /
  `tools` / `mcp`, injected via the constructor or `connect()`; lower `priority` wins.
- **Full telemetry** — per-turn `counterId`, budget attribution, prefix stability — feeding the
  bundled live console.
- **Four ways in** — SDK · HTTP gateway · OpenAI/Anthropic compat middleware · MCP adapter.

### Quick start

```bash
npm install && npm run build      # Node.js >= 22
node examples/minimal.cjs
```

```js
const { CogniStackEngine, createHttpTokenCounter } = require("cognistack-engine");

const engine = new CogniStackEngine({ systemRules: "Be accurate and concise." });
const result = engine.prepare({
  profile: { name: "OpsBot", description: "Datacenter ops assistant." },
  dialogue: [{ id: "1", role: "user", content: "Which GPU is installed?" }],
  contextTokenLimit: 8192,
  completionReserveTokens: 1024,
  tokenCounter: createHttpTokenCounter({ url: "http://127.0.0.1:8080/tokenize" }),
  cacheScope: "chat-1",
});
// result.messages → send to your model
// result.memory.shouldSummarize → time to compress long-term memory
```

### Docs

[USAGE.md](./USAGE.md) · [INTEGRATION.md](./INTEGRATION.md) · [DEVELOPMENT.md](./DEVELOPMENT.md) ·
[examples/REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md) · [console/DESIGN.md](./console/DESIGN.md)

### License

[MIT](./LICENSE) © 2026 Lrj410