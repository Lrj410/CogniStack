# 使用手册 · USAGE

> 面向**用引擎装配 prompt** 的开发者。把引擎接到宿主系统（HTTP 网关 / 兼容中间件 / 端口注入）请看
> [INTEGRATION.md](./INTEGRATION.md)；六份可直接运行的参考实现见
> [examples/REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md)。

CogniStack 是「上下文 × 记忆」融合引擎：把对话、人格档案、知识条目、世界状态、长期记忆块
按 token 预算装配成一条可直接发给模型的 prompt，并在超预算时按优先级软裁剪、在到达水位时
给出摘要任务。**引擎无状态、零运行时依赖**——token 计数通过 `TokenCounter` 注入，领域数据
通过端口（ports）注入。

---

## 0. 安装与构建

```bash
# Node >= 22
npm install
npm run build        # 编译到 dist/
node examples/minimal.cjs
```

包名 `cognistack-engine`，`exports` 三个入口：`.`（引擎全部公开面）、`./ports`、`./types`。

```js
const { CogniStackEngine, exactCharTokenCounter } = require("cognistack-engine");
```

---

## 1. 最小示例

与 [`examples/minimal.cjs`](./examples/minimal.cjs) 一致：

```js
const { CogniStackEngine, exactCharTokenCounter } = require("../dist/index.js");

const lore = {
  selectEntries(entries, scanText) {
    return entries.filter(
      (e) =>
        e.enabled !== false &&
        (e.constant || (e.keys || []).some((k) => String(scanText).includes(k))),
    );
  },
};

const engine = new CogniStackEngine({
  systemRules: "回答准确、简洁；不确定时说明假设。",
  collaborators: { lore },        // 知识端口：命中哪些条目
  maxLoreEntries: 8,
});

const result = engine.prepare({
  profile: { name: "阿铁", description: "机房运维助手。我是{{char}}。" },
  dialogue: [
    { id: "1", role: "user", content: "你好" },
    { id: "2", role: "assistant", content: "你好。" },
    { id: "3", role: "user", content: "显卡型号？" },
  ],
  loreEntries: [
    { id: "gpu", name: "显卡", keys: ["显卡"], content: "RTX 5070 Laptop 8GB",
      enabled: true, constant: false, insertionOrder: 0 },
  ],
  contextTokenLimit: 2048,
  completionReserveTokens: 256,
  tokenCounter: exactCharTokenCounter(),   // ⚠ 仅演示；生产必须用真实分词器，见 §4
  cacheScope: "demo",
});

console.log(result.messages);        // → 直接发给模型
console.log(result.promptTokens);    // → 本条 prompt 的 token 数
console.log(result.memory.shouldSummarize);
```

---

## 2. `prepare()` 输入

签名：`engine.prepare(input: CogniStackPrepareInput): CogniStackPrepareResult`（同步）。

### 必填

| 字段 | 类型 | 说明 |
|---|---|---|
| `profile` **或** `card` | `AgentProfileLike` | 人格/系统档案。两者至少给一个；同时给时 `profile` 优先。都不给是**编译期错误**。 |
| `dialogue` | `DialogueMessage[]` | 完整对话，最旧 → 最新。`{ id?, role, content }`。 |
| `tokenCounter` | `TokenCounter` | 真实分词器，见 §4。**拒绝启发式**。 |

### 常用可选

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `"generate"` | `generate` 全量装配 + 软裁剪；`status` 只算水位/切片（不产 prompt）。 |
| `summaryBlocks` | — | 已提交的长期记忆块（旧 → 新）。 |
| `summary` | — | 扁平摘要串（预览/兼容用）。 |
| `summarizedCount` | `0` | 整数水位（已覆盖消息条数）。 |
| `summarizedThroughMessageId` | — | 消息 id 水位；**可解析时优先于 `summarizedCount`**。 |
| `pairBatchSize` | — | 触发摘要的完整 UA 回合数 N（覆盖策略里的 N）。 |
| `memory` | — | `Partial<MemoryCompressPolicy>` 覆写压缩策略，见 §7。 |
| `loreEntries` | — | 知识/政策/FAQ 条目（旧名 `worldEntries` 仍可用）。 |
| `loreEnabled` | `true` | `false` 则本轮不做知识选择。 |
| `scanText` | 自动（尾部偏置） | 知识 key 扫描用文本。 |
| `worldState` | — | `{ entries: [{ key, value }] }` 结构化会话快照。 |
| `personaBio` | — | 终端用户画像，注入在档案附近。 |
| `macros` | 取自 `profile.name` | `{{char}}` / `{{user}}` 的替换名。 |
| `vectorHits` | — | 语义召回命中 `[{ name?, content }]`。 |
| `contextTokenLimit` | — | n_ctx（token）。覆盖策略里的 `contextCharLimit`。 |
| `completionReserveTokens` | — | 为补全预留的 token（`max_tokens` / 服务端默认）。 |
| `softTrimTokenCap` | 由 n_ctx 自动 | 显式软裁剪上限；`0`/省略 = 自动。 |
| `budget` | — | 微调 `safetyPadTokens` / `templateOverheadTokens` / `softTrimRatio` / `minPromptShareOfContext`。 |
| `softTrimProfile` | `"balanced"` | `protectLore` / `protectMemory` 重映射牺牲优先级。 |
| `cacheScope` | 全局桶 | 装配缓存分区（如 chatId）。不同 scope 绝不共享缓存结果。 |
| `host` | 引擎级 `host` | 谁在问。一个引擎服务多调用方时逐轮覆盖。 |
| `label` | — | 面板上显示的操作名（如「发送消息」「状态探针」）。 |
| `meta` | — | 逐轮上下文（chatId / route / userId…），与 `host.meta` 合并。 |
| `priorAssembledPromptTokens` | — | `mode:"status"` 时传入上次真实装配量，让 `contextUsed` 忠于 generate。 |
| `assembleOptions` / `assembleLimits` | — | 分段开关与分段字符预算。 |
| `loreRuntime` / `loreTick` | — | sticky/cooldown/delay 计时器；`loreTick:false` 时注入但不推进计时。 |
| `fragments` / `preset` / `authorsNote` / `regexScripts` | — | 分段文本、预设与正则（宿主自有形状，引擎不解析）。 |

> 已删除的旧字段：`memoryWindow`、`maxContextChars`（静默丢历史的行为已移除；
> `maxContextChars` 会映射到 `totalPromptCharCap`）。

---

## 3. `prepare()` 返回

| 字段 | 说明 |
|---|---|
| `messages` | **要发送的 prompt**（`{role, content}[]`）。`status` 模式为空数组。 |
| `systemSections` | 与首条 system 对齐的分段 + 各自的裁剪 `priority`。 |
| `promptTokens` / `promptChars` | 装配后 prompt 的 token / 字符数。 |
| `budget` | `ResolvedBudget`，含 `contextLimit` / `completionReserve` / `safetyPad` / `templateOverhead` / **`hardFit`** / `softTrimTokenCap` / `softTrimEnabled` / `warnings`。 |
| `memory` | `CogniStackStatus`（= `MemoryStatus` + `watermarkEnd`），见 §7。 |
| `summary` / `summaryBlocks` | 本轮生效的摘要串与记忆块。 |
| `toSummarize` | **待摘要的消息切片**（`{id?, role, content}[]`）。 |
| `toSummarizePairCount` | 该切片含几个完整 UA 对。 |
| `nextSummarizedThroughMessageId` | 摘要成功后应推进到的消息 id 水位（否则 `null`，见 §8 陷阱）。 |
| `nextSummarizedCount` | 摘要成功后应推进到的整数水位。 |
| `loreInjected` | 本轮注入的知识 `[{ id, name }]`。 |
| `loreRuntime` | 更新后的 sticky/cooldown/delay 计时器。 |
| `warnings` | 人类可读告警列表。 |
| `prefixStability` | 前缀稳定性：`comparable` / `reuseRatio` / `firstDivergenceIndex` / `prefixTokens` / `previousTokens` / `midPromptDrift`。 |
| `diagnostics` | 结构化诊断，见下。 |
| `engine` / `version` / `mode` | 常量与模式回显。 |

`diagnostics` 关键字段：`counterId`（注入的分词器身份，裸 `{count}` 记为 `"unnamed"`）、
`counter`（`CounterStats`）、`timings`、`cacheHit`、`prefixStability`、`stages`
（`watermarkOnPath` / `loreSelected` / `loreCapped` / `vectorInject` / `assembleCacheHit` /
`softTrimmed` / `emergencyDropped` / `fitsHardFit`）、`severity`（`isDegraded` 等）、
可选 `memoryAudit`、`budgetAttribution`。

---

## 4. 分词器（必须真实）

预算 / 软裁剪 / 紧急丢弃的**每一个决定**都由 `count()` 推出，所以引擎要求注入真实分词器。
`diagnostics.counterId` 会把「误用了测试替身」这件事变成**可见**而不是静默失真。

| 工厂 | 用途 |
|---|---|
| `exactCharTokenCounter()` | 每字符 1 token 的**确定性替身**，只用于示例/测试。 |
| `approximateTokenCounter()` | 启发式近似，**禁止用于生产预算**。 |
| `createHttpTokenCounter({ url })` | 打上游 `/tokenize`（如 llama.cpp），生产首选。 |
| `createFunctionTokenCounter(fn)` | 包一个同步 `(text) => number`（如 tiktoken）。 |
| `memoizeCounter(counter)` | 记忆化包装，返回 `MemoizedCounter`（含 `stats`）。 |

```js
const { createHttpTokenCounter } = require("cognistack-engine");

const tokenCounter = createHttpTokenCounter({ url: "http://127.0.0.1:8080/tokenize" });
const result = engine.prepare({ /* … */ tokenCounter });
console.log(result.diagnostics.counterId);   // 例如 "http:/tokenize"
```

---

## 5. 预算与软裁剪

```
n_ctx (contextTokenLimit)
   └─ 减去 completionReserveTokens
   └─ 减去 safetyPadTokens      （默认 64，小窗口自适应放大）
   └─ 减去 templateOverheadTokens（角色标记/BOS/EOS，小窗口 24–32）
   = hardFit —— 仍放得下补全的最大 prompt
```

- 软裁剪目标为 `contextLimit × softTrimRatio`（默认 `0.95`），且**不小于 `hardFit`**；
  `resolveBudget` 负责把四处夹取算清：`ResolvedBudget.hardFit` 是判据。
- 预留量会被夹取以让 prompt 至少保留 n_ctx 的 **25%**（`minPromptShareOfContext`），
  并有 64 token 硬下限。
- `BUDGET_DEFAULTS = { safetyPadTokens: 64, softTrimRatio: 0.95, minPromptShareOfContext: 0.25 }`。
- 自适应函数：`adaptiveSafetyPad(contextLimit)` / `adaptiveTemplateOverhead(contextLimit)`。

**超预算时的牺牲顺序**由 `SECTION_PRIORITY` 决定（**值小者先被裁**）：

| 段 | priority |
|---|---|
| systemRules | 10 |
| mesExample | 30 |
| promptFragment | 40 |
| persona | 45 |
| card | 50 |
| lore（= worldBook） | 60 |
| worldState | 70 |
| vectorMemory | 75 |
| memory | 80 |
| postHistory | 90 |

`softTrimProfile` 会在牺牲时重映射这套优先级：`protectLore`（知识留得久）、
`protectMemory`（长期记忆留得久）、`balanced`（默认）。

**明确不做的事**：软裁剪只压系统段（知识/记忆块），**从不丢弃未摘要的对话**；
真正放不下时只做有记录的紧急丢弃（`stages.emergencyDropped`）。

---

## 6. 四种调用方式

| 方法 | 场景 |
|---|---|
| `prepare(input)` | 同步装配（最常用）。 |
| `plan(input)` | 只估预算 → `CogniStackPlan`（`hardFit` / `overByTokens` / `dialogueExceedsHardFit`…），**不产 prompt**。 |
| `prepareLive(input)` | 异步装配（内部 hydrate，用于真实分词器预热）。 |
| `prepareAsync(input & { hydrate, hydrateOne })` | 全异步，把分词/取数交给你的回调：`hydrate(texts): Promise<void>`、`hydrateOne(text): Promise<number>`。 |

`mode: "status"` 只推进水位与切片（不装配 prompt），用于「压缩重规划」轮次；
配合 `priorAssembledPromptTokens` 让 `contextUsed` 与 generate 轮对齐。

`engine.forHost({ id, name, kind })` 返回**长期持有**的 `CogniStackHostHandle`
（`prepare` / `prepareLive` / `prepareAsync`）。它**不是会话容器**——不要每轮新建，
否则会诱导你给每轮编新 `host.id`，把遥测宿主表刷爆。

---

## 7. 长期记忆

### 触发（两种）

`memory`（`Partial<MemoryCompressPolicy>`）里：

| 字段 | 含义 |
|---|---|
| `pairBatchSize` (N) | ② **对话回合数触发**：未覆盖的完整 UA 对达到 N 即压。 |
| `contextCharLimit` / `contextTokenLimit` | ① **上下文长度触发**：占用达到 `contextTriggerRatio`（默认 `0.7`）× 该值即压。 |
| `contextTriggerRatio` | ① 的阈值比例，默认 `0.7`。 |
| `maxBlocks` (M) | 最多保留几个记忆块。 |
| `overlapPairs` (K) | 水位之上仍保留为原文的重叠对数。 |
| `maxBlockChars` / `maxTotalBlockChars` | 单块 / 全部块字符上限。 |
| `maxBatchChars` / `maxBatchTokenCap` | 单批转录 token 上限（保护摘要模型调用）。 |
| `totalPromptCharCap` / `totalPromptTokenCap` | prompt 软预算上限；`0` = 关闭。 |
| `softTrimOff` | `true` 时跳过 O-06 自动软裁剪默认值（不关显式上限）。 |

> 命名说明：`*Char*` 是历史名，单位其实是 **token**（由真实分词器计）。新代码请用
> `*Token*` 别名，`normalizeCompressPolicy` 会映射到规范字段。

### `result.memory`（`CogniStackStatus`）

`dialogueCount` / `summarizedCount` / `pending` / `pendingPairs` / `pendingChars` /
`pendingTokens` / `contextUsed` / `contextTriggerAt` / `shouldSummarize` /
`compressReason`（`"batch"` 或 `"context"`）/ `adaptivePairBatchSize` / `watermarkEnd`。

### 摘要闭环（**真实接法的起点**）

```
prepare
  → memory.shouldSummarize && toSummarize.length
  → summary.buildUserPrompt({ priorJoined, transcript: summary.formatTranscript(toSummarize),
                              mode: "replace", maxCharsHint })
  → 你的摘要模型
  → summary.parseStructuredCompress(text)          // 取 parsed.summaryText
  → summary.makeReplaceBlock({ text, throughMessageId, pairCount, kind: "full" })
  → blocks.commitBlock(blocks, block, maxBlocks, maxBlockChars, maxTotalBlockChars)
  → 推进水位：summarizedThroughMessageId = nextSummarizedThroughMessageId,
              summarizedCount = nextSummarizedCount
  → 下一轮带回
```

**铁律：只有摘要成功提交了块，才推进水位**；失败或跳过必须沿用旧水位。
完整可跑版见 [`examples/summarize-loop.cjs`](./examples/summarize-loop.cjs)。

### 结构化记忆与审计

- 固定栏目 `MEMORY_COLUMN_TITLES`：`【硬事实】/【时间线】/【关系与称呼】/【未决】/【近期情节】`。
- 裁剪牺牲顺序 `MEMORY_COLUMN_SACRIFICE_ORDER` 从 `【近期情节】` 开始，`【硬事实】`最后。
- `new CogniStackEngine({ auditMemory: true })` 会在改写前后审计记忆，保护列丢内容时发
  `memory-lost-protected` 告警（`result.diagnostics.memoryAudit`）。

---

## 8. 记忆持久化与陷阱

引擎无状态，记忆状态由宿主持久化。用信封序列化：

```js
const { serializeMemoryState, deserializeMemoryState } = require("cognistack-engine");

const line = JSON.stringify(serializeMemoryState({
  summaryBlocks, summarizedCount, summarizedThroughMessageId,
}));
// …追加进 JSONL（每行一条快照，崩溃最多损坏最后一行）

const { state, repaired } = deserializeMemoryState(jsonLine);
```

参考实现：[`examples/jsonl-session-host.cjs`](./examples/jsonl-session-host.cjs)（落盘 +
信封校验 + 重启续跑）。

**三个已知陷阱**（详见 [REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md) 末尾）：

1. 非摘要轮的 `result.nextSummarizedThroughMessageId` 是 `null`——**不要**无脑覆盖本地水位。
2. `deserializeMemoryState` 的整数水位校验单位不一致（条数 vs 对数）会误报一次
   `summarized-count-repaired`；`summarizedThroughMessageId` 优先，装配结果不受影响。
3. `portDiagnostics()` 只统计 `connect()` 注册表，不反映构造函数注入的 `collaborators`。

---

## 9. 向量召回

```js
const { VectorMemoryEngine, LOCAL_EMBED_DIM } = require("cognistack-engine");

const vm = new VectorMemoryEngine();
const emb = vm.buildLocalEmbedding("显卡是 RTX 5070");        // 本地确定性嵌入
const hits = vm.cosineTopK(queryVec, rows, 4);                 // → VectorHit[]
const text = vm.formatAssembleHits(hits, 4000);                // 可直接塞进 vectorHits
```

`VectorMemoryEngine` 提供 `buildLocalEmbedding` / `embedTexts` / `cosine` /
`lexicalOverlap` / `cosineTopK` / `formatAssembleHits` / `formatHitsForPrompt`。
也可在 `prepare({ vectorHits: [{ name, content }] })` 里直接注入命中。

---

## 10. 端口协作

引擎把领域能力抽象成端口（ports）。`PORT_NAMES`：

- **现代 Agent 主端口** `MODERN_PORT_NAMES`：`tools` / `mcp` / `lore` / `vector`
- **上下文与兼容端口** `CONTEXT_PORT_NAMES`：`card` / `macros` / `state` / `preset` / `regex`

两条注入路径：

1. **构造函数注入**（进程内、静态）：`new CogniStackEngine({ collaborators: { lore, card, … } })`
2. **运行时接入**：`engine.connect({ id, name, kind, priority, provides })`，
   返回一个 `CogniStackConnection`（可 `update()` / `close()`）。

解析优先级：**构造函数注入 / wire ＞ `connect()` ＞ 引擎缺省**；`priority` **小者胜**。
诊断：`engine.portDiagnostics()`（谁生效 `winner`、谁被压制 `shadowed`）、`engine.portTable()`。

缺省实现见 `./defaults` 导出（`defaultCardResolver` / `createKeywordLoreProvider` /
`defaultMacroBinder` / `defaultWorldStateProvider` …）。

---

## 11. 遥测

```js
const { CogniStackEngine, getGlobalTelemetry } = require("cognistack-engine");

const engine = new CogniStackEngine({ telemetry: getGlobalTelemetry() });
```

每个回合会被记录成 `TurnRecord`（含 `counterId`、前缀稳定性、预算归因等）。
`CogniStackTelemetry` 提供 `registerHost` / `record` / 快照；不传 `telemetry` 则**零开销**。
控制台面板消费的就是这份遥测（见 [INTEGRATION.md](./INTEGRATION.md) 的 HTTP 网关一节）。

---

## 12. 常见坑速查

- **不要用启发式分词器算生产预算**——`diagnostics.counterId` 会戳穿它。
- **软裁剪不丢未摘要对话**；若 `promptTokens > budget.hardFit`，看 `stages.emergencyDropped`。
- **水位只在提交块后推进**（§7）。
- **`forHost` 句柄长期持有**，别每轮新建。
- **`cacheScope` 是分区键**：同一会话用一个 scope，跨会话共用会串味。
- 更多实测差异见 [REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md) 末尾「已知文档 / 行为不一致」。