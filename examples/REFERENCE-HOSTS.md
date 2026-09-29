# 参考宿主 / 接入示例

这页给六份**可直接运行**的参考实现定位，并说明它们各自解决什么问题、怎么跑、
以及边界差异。全部零运行时依赖，跑之前先构建引擎：

```bash
npm run build
```

---

## 文件一览

| 文件 | 解决的问题 | 运行 |
|------|-----------|------|
| `examples/minimal.cjs` | 最小 SDK 接入（已有） | `node examples/minimal.cjs` |
| `examples/http-call.cjs` | 通过 HTTP 调网关（已有） | 先 `npm run viz`，再 `node examples/http-call.cjs` |
| `examples/summarize-loop.cjs` | 摘要闭环的最小示范（已有，**真实摘要接法的起点**） | `node examples/summarize-loop.cjs` |
| `examples/jsonl-session-host.cjs` | **记忆状态存哪、怎么存**：JSONL 落盘 + 信封校验 + 重启续跑 | `node examples/jsonl-session-host.cjs` |
| `examples/multi-tenant-host.cjs` | **一个 engine 服务多租户**：隔离断言 + `forHost` 用法 + 端口诊断 | `node examples/multi-tenant-host.cjs` |
| `tools/openai-compat.cjs` | **OpenAI 兼容中间件**：`/v1/chat/completions` → prepare → 转发（含流式） | `node tools/openai-compat.cjs --upstream http://127.0.0.1:8080` |
| `examples/langchain-adapter.cjs` | **框架适配**：`loadMemory` / `saveMemory` 两个纯函数 + 框架钩子说明 | `node examples/langchain-adapter.cjs` |

---

## 1. `examples/jsonl-session-host.cjs` —— 会话存储参考宿主

**它回答的问题**：引擎无状态，那"记忆状态"到底是什么、该怎么落盘、重启后怎么接上？

- 每轮：读会话快照 → `engine.prepare()` → 需要时用**确定性假摘要**生成记忆块 →
  推进水位 → 用 `serializeMemoryState()` 把记忆写成**信封**追加进 JSONL。
- 每行一条快照，崩溃只损坏最后一行；读回时从后往前找第一条完整记录。
- `deserializeMemoryState()` 负责校验与修复，修复明细打印在 `repaired` 里。
- 演示 30+ 轮、触发多次摘要，能一眼看到水位 `- → 3a → 6a → …` 在推进；
  最后**模拟重启**（丢掉内存、只从磁盘恢复）并续跑，证明可无缝续接。

```bash
node examples/jsonl-session-host.cjs
node examples/jsonl-session-host.cjs --dir ./_sessions --session alice --turns 40
```

输出看点：`[summarize]` 行的水位推进、重启后的 `[load]` 恢复行、末尾的 `[repair]` 演示。

---

## 2. `examples/multi-tenant-host.cjs` —— 多租户参考

**它回答的问题**：一个 engine 同时服务多个用户时，怎么保证不串味、句柄怎么用？

- 一个 engine + 3 个租户，**交错调用**；每个租户独立的 `cacheScope` 与对话/记忆。
- 用 `engine.forHost({ id, name, kind })` 拿**长期持有**的句柄（放 `Map` 复用）。
  注释里说明了为什么**不该**每轮新建：句柄不承载会话状态，每轮新建会诱导你给每轮
  编新 `host.id`，把遥测宿主表刷爆。
- **实测断言**：给每个租户的卡片/知识放唯一标记串，跑完断言"A 的 prompt 里不出现
  B/C 的标记"；断言失败以非 0 退出码结束。
- 打印每租户最后一次的 `promptTokens` 与 `prefixStability`（`firstDivergenceIndex=-1`
  表示上一轮 prompt 是这一轮的前缀，本地 prefix cache 可整段复用）。
- 末尾用两个租户各 `connect` 一个同端口（`regex`）提供方、`priority` 不同，
  用 `engine.portDiagnostics()` 展示"谁生效、谁被压制（shadowed）"。

```bash
node examples/multi-tenant-host.cjs
```

---

## 3. `tools/openai-compat.cjs` —— OpenAI 兼容中间件

**它回答的问题**：怎么把 CogniStack 塞进"OpenAI 客户端 → 模型"之间，而不重复注入历史？

- 用 `node:http` 起一个服务，提供 `POST /v1/chat/completions`：收 OpenAI 请求
  → `engine.prepare()` 装配 → 把 `result.messages` 转发给上游 OpenAI 兼容服务
  → 响应原样回传（`stream: true` 时 SSE 原样透传）。
- **历史不重复注入**的显式取舍（由 `--system-mode` 控制，有默认值）：
  把客户端 messages 当作 `dialogue`，历史/记忆/预算的唯一真相源交给 CogniStack。

  | 值 | 行为 |
  |----|------|
  | `drop`（默认） | 丢弃客户端的 system/developer 消息，system 由 CogniStack 负责 |
  | `prefix` | 把客户端 system 文本作为 `fragments.systemPrefix` 保留，仍受预算管理 |
- **真实分词器**：传 `--tokenize-url`（指向上游 `/tokenize`）时，用
  `createHttpTokenCounter({ url })` 注入真实分词，并走 `prepareAsync({ hydrate, hydrateOne })`；
  不传则退化为 `exactCharTokenCounter()` 并在启动时**大声警告** token 数字不可用于生产。
- 无 API key 校验（本地工具），**默认只绑 127.0.0.1**，启动日志会打印这一点。
- 可选 `--summarize`：响应发出后，用上游模型把 `toSummarize` 压成记忆块并推进水位
  （按 `x-session-id` / `body.user` 归并会话；默认关闭）。

```bash
# 上游（示例用 llama.cpp）
llama-server -m model.gguf --port 8080

# 中间件（推荐带真实分词）
node tools/openai-compat.cjs \
  --upstream http://127.0.0.1:8080 \
  --tokenize-url http://127.0.0.1:8080/tokenize

# 用法：把 OpenAI 客户端的 baseURL 指过来
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"你好"}]}'
```

参数：`--port`(8790) `--host`(127.0.0.1) `--upstream` `--tokenize-url` `--context-limit`(8192)
`--reserve`(1024) `--pair-batch`(10) `--agent-name`(助手) `--system-mode`(drop) `--summarize`。

---

## 4. `examples/langchain-adapter.cjs` —— 框架适配示例

**它回答的问题**：怎么把 CogniStack 挂进 LangChain / Vercel AI SDK 这类框架？

- 导出两个**纯函数**（不改入参、不做 I/O）：
  - `loadMemory(history)` → `{ dialogue, summaryBlocks, summarizedThroughMessageId, summarizedCount }`
  - `saveMemory(prepareResult)` → 要写回框架 state 的记忆状态
- 记忆按约定挂在 history 的 `cognistackMemory` 字段上，随框架自己的 state 持久化。
- 文件里给了一段**不依赖任何框架**的用法示例，并在注释里写明真实框架的两个钩子位置
  （LangChain：`getSessionHistory` 之后 / 模型返回之后；AI SDK：`streamText` 之前 /
  `onFinish` 里）。

```bash
node examples/langchain-adapter.cjs
```

---

## 边界差异（三者速查）

| 维度 | jsonl-session-host | multi-tenant-host | openai-compat |
|------|--------------------|-------------------|----------------|
| 关注点 | 状态**持久化格式** | **多租户隔离** | **协议适配 / 转发** |
| 会话数 | 1（可按 `--session` 多开） | 3（交错） | 任意（按会话键） |
| 记忆 | 完整闭环，落盘 + 信封校验 | 不触发（专注隔离） | 可选 `--summarize` |
| 分词 | `exactChar`（假） | `exactChar`（假） | 可选真实 `/tokenize` |
| 网络/模型 | 完全不碰 | 完全不碰 | 真实上游 + 流式 |
| 断言/退出码 | 无摘要触发即失败 | 跨租户串味即失败 | — |

---

## 关于"假摘要"

以上示例（含 `summarize-loop.cjs`）里的摘要都是**确定性假摘要**——一个纯函数，
**不调用任何模型**，目的是让示例离线可跑、可复现。摘要闭环的**真实接法**请以
`examples/summarize-loop.cjs` 为准，把 `fakeSummarizeLlm` 换成你的摘要模型调用即可，
其余步骤完全一致：

```
prepare → shouldSummarize? → SummaryEngine.buildUserPrompt → 摘要模型 →
parseStructuredCompress → makeReplaceBlock → MemoryBlocksEngine.commitBlock →
推进水位（nextSummarizedThroughMessageId / nextSummarizedCount）→ 下一轮带回
```

铁律：**只有摘要成功提交了块，才推进水位**；失败或跳过时必须沿用旧水位
（`examples/langchain-adapter.cjs` 的 `saveMemory` 注释里详细说明了为什么）。

---

## 已知文档 / 行为不一致（本页记录，未改源码或文档）

以下是搭这些示例时**实测**到、与手册描述或直觉不符的地方，供排查参考：

1. **`deserializeMemoryState` 的整数水位校验存在单位不一致。**
   引擎的 `nextSummarizedCount` / `MemoryStatus.summarizedCount` 是
   「已覆盖的**消息条数**」（见 `ContextEngine.toSummarizeSlice`：`lastEnd + 1`，
   以及 `MemoryEngine.watermarkEndIndex` 按消息索引消费它），而
   `memoryEnvelope.ts` 用「块 `pairCount` 之和（**回合对数**）」去校验它
   （`memoryEnvelope.ts:216-221`）。两者单位不同，于是**每次读盘都会产生一次
   `summarized-count-repaired` 误报**，并把整数水位改成"对数"。
   由于 `summarizedThroughMessageId` 优先，装配结果不受影响；只影响**只用整数水位**
   的宿主。示例里对此有显式提示，未改动源码。

2. **`portDiagnostics()` / `portTable()` 不反映构造函数注入的 `collaborators`。**
   解析优先级是「构造函数注入 ＞ `connect()` ＞ 缺省」，但诊断只统计
   `connect()` 注册表。因此可能出现：诊断显示某个 `connect` 提供方 `bound=true`、
   是 `winner`，实际生效的却是构造函数里那一个同端口实现。排查"接了却没生效"时
   要把这一点算进去。`examples/multi-tenant-host.cjs` 的 `lore` 行就是这种情况
   （显示"未接入"，但其实构造函数的 keyword lore 在生效）。

3. **非摘要轮次 `result.nextSummarizedThroughMessageId` 为 `null`。**
   `toSummarizeSlice` 在未触发时返回 `idle`，其 `nextSummarizedThroughMessageId`
   是 `null`。若宿主无脑用它覆盖本地水位，会把已有水位抹掉
   （`examples/langchain-adapter.cjs` 的 `saveMemory` 专门处理了这个坑）。
