/**
 * 框架适配示例（G-30）：把 CogniStack 包成「记忆 / 历史处理器」。
 *
 * 运行（内置了一段不依赖任何框架的演示）：
 *   node examples/langchain-adapter.cjs
 *
 * 这个示例只导出两个**纯函数**（不改入参、不做 I/O）：
 *
 *   loadMemory(history)      → { dialogue, summaryBlocks, summarizedThroughMessageId, summarizedCount }
 *   saveMemory(prepareResult)→ { summaryBlocks, summarizedThroughMessageId, summarizedCount, shouldSummarize, toSummarize }
 *
 * 它解决的是"框架的历史 ↔ CogniStack 的入参"之间的翻译：
 *   - 框架侧：一串 messages（role/content）；
 *   - CogniStack 侧：dialogue + 记忆块 + 水位。
 *
 * `history` 既可以是一个 messages 数组，也可以是带 `.messages` 的对象（比如
 * LangChain 的 ChatMessageHistory）。记忆状态按约定挂在它的 `cognistackMemory`
 * 字段上，随框架自己的 state 一起持久化——这样适配器无需自己开一个数据库连接。
 *
 * 接进真实框架时，挂在这两个钩子上
 * ---------------------------------
 *   - LangChain（JS/TS）：用 `RunnableWithMessageHistory` 时，在 `getSessionHistory`
 *     拿到 history 之后、调用模型之前调 loadMemory；在模型返回之后用
 *     `addMessage`/`addUserMessage` 落库的同时调 saveMemory 把记忆写回。若用
 *     `RunnableLambda` 自串，就是「model 之前一个 lambda + model 之后一个 lambda」。
 *   - Vercel AI SDK：`streamText({ messages })` 之前调 loadMemory 拿 dialogue/记忆；
 *     在 `onFinish({ response, messages })` 里调 saveMemory，把返回的记忆状态存进你
 *     自己的 store（AI SDK 不替你存任何东西）。
 *
 * 本文件刻意**不 import 任何框架包**——示例必须能直接 `node examples/langchain-adapter.cjs`。
 */
"use strict";

const {
  CogniStackEngine,
  MemoryBlocksEngine,
  SummaryEngine,
  exactCharTokenCounter,
} = require("../dist/index.js");

/* ------------------------------------------------------------------ */
/* 两个纯函数                                                           */
/* ------------------------------------------------------------------ */

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function messagesOf(history) {
  if (Array.isArray(history)) return history;
  if (history && Array.isArray(history.messages)) return history.messages;
  return [];
}

/**
 * 框架历史 → CogniStack 入参片段。
 *
 * id 策略：优先用框架消息自带的稳定 id；否则用 `m<序>_<内容指纹>`。指纹让"内容被
 * 改写"的消息拿到新 id，水位不会误覆盖旧版本。前提是历史是追加式的（常见行为）。
 */
function loadMemory(history) {
  const msgs = messagesOf(history);
  const dialogue = [];
  let i = 0;
  for (const m of msgs) {
    const role = m && m.role;
    if (role !== "user" && role !== "assistant") continue; // 框架的 system 由你的 systemRules 负责
    const content = typeof m.content === "string" ? m.content : "";
    const id = m.id != null ? String(m.id) : `m${i}_${djb2(content)}`;
    dialogue.push({ id, role, content });
    i += 1;
  }
  const mem = (history && history.cognistackMemory) || {};
  return {
    dialogue,
    summaryBlocks: Array.isArray(mem.summaryBlocks) ? mem.summaryBlocks : [],
    summarizedThroughMessageId: mem.summarizedThroughMessageId ?? null,
    summarizedCount: Number(mem.summarizedCount ?? 0) || 0,
  };
}

/**
 * prepare 结果 → 要写回框架 state 的记忆状态。
 *
 * ⚠️ 一个必须讲清的坑：`nextSummarizedThroughMessageId` **只有在本轮真的规划了
 * 压缩批次时才有值**；不触发摘要的轮次它是 `null`。如果无脑 `state.watermark =
 * result.nextSummarizedThroughMessageId`，那么"不摘要的那一轮"就会把已有水位抹成
 * null，下一轮又开始重复摘要，甚至丢失记忆。所以这里的规则是：
 *
 *   只有当块列表里**真的出现了** planned 锚点（= 摘要已成功提交）时，才把水位推进
 *   到它；否则沿用"最后一个块的 throughMessageId"（块的追加顺序就是水位）。
 *
 * 若本轮触发了摘要但摘要失败，请不要 commitBlock——这样这里的 committed 为 false，
 * 水位就不会错误前进，对白不会被跳过。
 *
 * 传 `{ ...result, summaryBlocks: mergedBlocks }` 即可把"本轮刚提交的块"纳入计算。
 */
function saveMemory(prepareResult) {
  const blocks = prepareResult.summaryBlocks ?? [];
  const lastThrough = blocks.length ? (blocks[blocks.length - 1].throughMessageId ?? null) : null;
  const planned = prepareResult.nextSummarizedThroughMessageId ?? null;
  const committed = Boolean(planned) && blocks.some((b) => b.throughMessageId === planned);
  const currentCount = Number(prepareResult.memory?.summarizedCount ?? 0) || 0;
  const nextCount = Number(prepareResult.nextSummarizedCount ?? 0) || currentCount;

  return {
    summaryBlocks: blocks,
    summarizedThroughMessageId: committed ? planned : lastThrough,
    summarizedCount: committed ? nextCount : currentCount,
    // 透传触发信息，方便调用方决定要不要去调摘要模型
    shouldSummarize: Boolean(prepareResult.memory?.shouldSummarize),
    toSummarize: prepareResult.toSummarize ?? [],
  };
}

module.exports = { loadMemory, saveMemory };

/* ------------------------------------------------------------------ */
/* 不依赖框架的用法演示                                                 */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const counter = exactCharTokenCounter(); // ⚠️ 仅为可跑；生产必须注入真实分词器
  const engine = new CogniStackEngine({ systemRules: "回答简洁。" });
  const summary = new SummaryEngine();
  const blocksEngine = new MemoryBlocksEngine();

  // 这就是"框架里的一个会话"：messages 数组 + 挂在它上面的记忆状态。
  const history = [
    { role: "system", content: "（框架自己的 system，本例被 loadMemory 忽略）" },
  ];
  history.cognistackMemory = null;

  function fakeSummarize(items) {
    void items;
    return "【硬事实】用户叫阿铁\n【时间线】开场问候\n【关系与称呼】无\n【未决】无\n【近期情节】助手确认配置";
  }

  function frameworkTurn(userText) {
    history.push({ role: "user", content: userText });

    // 钩子 1：取到 history 之后、调模型之前。
    const mem = loadMemory(history);
    const result = engine.prepare({
      profile: { name: "助手" },
      dialogue: mem.dialogue,
      summaryBlocks: mem.summaryBlocks,
      summarizedThroughMessageId: mem.summarizedThroughMessageId,
      summarizedCount: mem.summarizedCount,
      pairBatchSize: 2,
      contextTokenLimit: 4096,
      completionReserveTokens: 512,
      tokenCounter: counter,
      cacheScope: "lc-demo",
    });

    // 真实框架这里把 result.messages 交给模型；本例用固定回复。
    const assistantText = `收到：${userText}`;
    history.push({ role: "assistant", content: assistantText });

    // 钩子 2：模型返回之后。若触发摘要，先合并新块再 saveMemory。
    let saved;
    if (result.memory.shouldSummarize && result.toSummarize.length) {
      const prompt = summary.buildUserPrompt({
        priorJoined: result.summaryBlocks.map((b) => b.text).join("\n\n"),
        transcript: summary.formatTranscript(result.toSummarize),
        mode: "replace",
        maxCharsHint: 800,
      });
      void prompt; // 真实实现：把 prompt 发给摘要模型
      const parsed = summary.parseStructuredCompress(fakeSummarize(prompt));
      const block = summary.makeReplaceBlock({
        text: parsed.summaryText,
        throughMessageId: result.nextSummarizedThroughMessageId || "",
        pairCount: result.toSummarizePairCount || 0,
        kind: "full",
        importance: 80,
      });
      const mergedBlocks = blocksEngine.commitBlock(result.summaryBlocks, block, 4, 2000, 6000);
      saved = saveMemory({ ...result, summaryBlocks: mergedBlocks });
    } else {
      saved = saveMemory(result);
    }

    // 纯函数不改入参：由调用方把新状态写回框架 state。
    history.cognistackMemory = saved;
    return result;
  }

  console.log("=== 模拟 4 轮框架循环 ===");
  for (let n = 1; n <= 4; n += 1) {
    const r = frameworkTurn(`第${n}句`);
    console.log(
      `[turn ${n}] dialogue=${history.filter((m) => m.role !== "system").length}` +
        ` messages=${r.messages.length} promptTokens=${r.promptTokens}` +
        ` shouldSummarize=${r.memory.shouldSummarize}` +
        ` mem.blocks=${history.cognistackMemory.summaryBlocks.length}` +
        ` mem.watermark=${history.cognistackMemory.summarizedThroughMessageId ?? "-"}`,
    );
  }

  console.log("\nOK langchain-adapter");
}
