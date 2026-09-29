#!/usr/bin/env node
/**
 * OpenAI 兼容中间件（G-29）：把 CogniStack 插进「OpenAI 客户端 → 模型」之间。
 *
 * 现状：宿主接 CogniStack 得自己写"调 prepare → 拿 messages → 转发给模型"的胶水。
 * 本工具把这层胶水做成一个可直接跑的服务：对外暴露标准的
 * `POST /v1/chat/completions`，任何 OpenAI 客户端把 baseURL 指过来即可，例如
 * llama.cpp 的 `llama-server`、Ollama 的兼容层、或你自己的网关。
 *
 *   # 1) 先起一个 OpenAI 兼容上游（这里以 llama.cpp 为例）
 *   llama-server -m model.gguf --port 8080
 *
 *   # 2) 再起中间件（默认只绑 127.0.0.1，无需 API key）
 *   node tools/openai-compat.cjs --upstream http://127.0.0.1:8080
 *
 *   # 3) 把 OpenAI 客户端指向中间件
 *   curl http://127.0.0.1:8790/v1/chat/completions -H "content-type: application/json" \
 *     -d '{"model":"local","messages":[{"role":"user","content":"你好"}]}'
 *
 * ---------------------------------------------------------------------------
 * 关键设计点 1：不要把对话历史重复注入
 * ---------------------------------------------------------------------------
 * OpenAI 协议是**无状态**的：客户端每次都会把完整 messages（含它自己的 system
 * 提示）重传一遍。而 CogniStack 也要装配历史（它有水位线、记忆块、token 预算）。
 * 如果两边都注入，历史就会重复，预算也会算错。
 *
 * 本工具的显式取舍：**把客户端传来的 messages 当作对话素材，唯一真相源交给
 * CogniStack**。具体由 `--system-mode` 控制，且必须有默认值：
 *   - `drop`（默认）：丢弃客户端的 system/developer 消息。system 提示由 CogniStack
 *     的 `systemRules` + profile 统一负责（本工具用 `--agent-name` 合成 profile）。
 *   - `prefix`：把客户端的 system 文本保留下来，作为 CogniStack 的
 *     `fragments.systemPrefix` 注入，仍然受 CogniStack 的预算与排序统一管理。
 * 无论哪种，客户端的历史都只作为 `dialogue` 进入一次。
 *
 * ---------------------------------------------------------------------------
 * 关键设计点 2：真实分词器
 * ---------------------------------------------------------------------------
 * 传 `--tokenize-url`（指向上游的 /tokenize，llama.cpp 自带）时，本工具用引擎导出的
 * `createHttpTokenCounter({url})` 注入**真实**分词器，并配合 `engine.prepareAsync(
 * { hydrate, hydrateOne })` 使用：`createHttpTokenCounter.count()` 在缓存未命中时抛
 * `CACHE_MISS`，正是 prepareAsync 期望的契约（它会 hydrateOne 后重试）。
 * 不传 `--tokenize-url` 时退化为 `exactCharTokenCounter()`（1 字符 ≈ 1 token），
 * 此时 token 数字**不可用于生产判断**——启动时会大声警告。
 *
 * ---------------------------------------------------------------------------
 * 安全 / 范围
 * ---------------------------------------------------------------------------
 * 这是本地工具：不做 API key 校验。默认**只绑 127.0.0.1**，要暴露到局域网得显式
 * 传 `--host 0.0.0.0`，风险自负。零运行时依赖，仅用 node:http + 全局 fetch。
 */
"use strict";

const http = require("node:http");

const {
  CogniStackEngine,
  exactCharTokenCounter,
  createHttpTokenCounter,
  SummaryEngine,
  MemoryBlocksEngine,
} = require("../dist/index.js");

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const PORT = Number(arg("port", process.env.PORT || 8790));
const HOST = arg("host", process.env.HOST || "127.0.0.1"); // 默认仅本机
const UPSTREAM = arg("upstream", process.env.UPSTREAM || "http://127.0.0.1:8080");
const TOKENIZE_URL = arg("tokenize-url", process.env.TOKENIZE_URL || "");
const CONTEXT_LIMIT = Number(arg("context-limit", 8192));
const RESERVE = Number(arg("reserve", 1024));
const PAIR_BATCH = Number(arg("pair-batch", 10));
const AGENT_NAME = arg("agent-name", "助手");
const SYSTEM_MODE = arg("system-mode", "drop"); // drop | prefix
const SUMMARIZE = flag("summarize"); // 默认关闭：开启后会额外向上游发摘要请求
const MAX_BODY = 4_000_000;
/**
 * 上游「响应头」超时。只覆盖到收到响应头为止 —— 一旦开始流式回包就清除定时器，
 * 否则一次长文本生成会被这个超时腰斩。作用是把"上游无响应"从无限等待变成可读的 502。
 */
const UPSTREAM_HEADER_TIMEOUT_MS = Number(process.env.COGNISTACK_UPSTREAM_TIMEOUT_MS || 120_000);

if (!["drop", "prefix"].includes(SYSTEM_MODE)) {
  console.error(`--system-mode 只能是 drop 或 prefix（收到 ${SYSTEM_MODE}）`);
  process.exit(1);
}

/** 把上游基址规范成 chat/completions 端点。 */
function completionsUrl(base) {
  const b = String(base).replace(/\/+$/, "");
  if (b.endsWith("/v1/chat/completions") || b.endsWith("/chat/completions")) return b;
  return `${b}/v1/chat/completions`;
}
const UPSTREAM_COMPLETIONS = completionsUrl(UPSTREAM);

/**
 * 上游地址是否可以在 HTTP 响应里回显。
 *
 * 默认绑 127.0.0.1 时它对使用者有用（本机排错）；一旦用 `--host` 绑到非 loopback，
 * 同一个字段就成了内网拓扑泄漏 —— 而响应是交给任意调用方的。
 */
const EXPOSE_UPSTREAM = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

/* ------------------------------------------------------------------ */
/* 引擎 + 分词器                                                       */
/* ------------------------------------------------------------------ */

const engine = new CogniStackEngine({
  systemRules: "遵守用户指令；回答准确、简洁。",
  host: { id: "openai-compat", name: "OpenAI 兼容中间件", kind: "service" },
});

// 真实分词器（推荐）或退化计数器（仅本机试跑）。
const httpCounter = TOKENIZE_URL ? createHttpTokenCounter({ url: TOKENIZE_URL }) : null;
const fallbackCounter = exactCharTokenCounter();
const counter = httpCounter ?? fallbackCounter;

const summary = new SummaryEngine();
const blocksEngine = new MemoryBlocksEngine();

/* ------------------------------------------------------------------ */
/* 会话记忆（可选，按 x-session-id / body.user 归并）                   */
/* ------------------------------------------------------------------ */

/*
 * OpenAI 协议本身没有会话 id，所以中间件天然是无状态转发的。要让"多轮记忆"真正
 * 跨请求生效，需要给同一会话一个稳定键。本工具按优先级取：
 *   请求头 x-session-id  →  body.user  →  无（此时退化为无状态，不做记忆）。
 * 存储是进程内 Map；生产应换成你的数据库，并把 summaryBlocks/水位按 §6 持久化。
 */
const sessions = new Map();
/** Cap so a client cycling `x-session-id` values cannot grow the Map without limit. */
const MAX_SESSIONS = 1000;
const EMPTY_MEM = { summaryBlocks: [], summarizedThroughMessageId: null, summarizedCount: 0 };

function loadMemory(key) {
  if (!key) return EMPTY_MEM;
  return sessions.get(key) ?? EMPTY_MEM;
}
function saveMemory(key, state) {
  if (!key) return;
  // Re-insert so the newest entry sorts last, then evict the oldest past the cap.
  sessions.delete(key);
  sessions.set(key, state);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/* ------------------------------------------------------------------ */
/* 把 OpenAI messages 翻译成 CogniStack 入参                           */
/* ------------------------------------------------------------------ */

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 只用 user/assistant 作为 dialogue。
 * id = `m<序>_<内容指纹>`：指纹让「内容被改写」的消息拿到新 id，水位不会误覆盖旧版本；
 * 序号让重复内容可分。前提是客户端**追加式**重传历史（OpenAI 客户端的常规行为）。
 */
function toDialogue(messages) {
  const out = [];
  let i = 0;
  for (const m of messages) {
    const role = m?.role;
    let mappedRole = role;
    if (role === "tool" || role === "function") {
      mappedRole = "user";
    } else if (role !== "user" && role !== "assistant") {
      continue;
    }
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .map((p) => (typeof p === "string" ? p : p?.text || ""))
        .filter(Boolean)
        .join("\n");
    } else if (m.tool_calls && Array.isArray(m.tool_calls)) {
      content = JSON.stringify(m.tool_calls);
    }
    const item = { id: `m${i}_${djb2(content)}`, role: mappedRole, content };
    if (m) item._raw = m;
    out.push(item);
    i += 1;
  }
  return out;
}

function collectSystemText(messages) {
  return messages
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");
}

/* ------------------------------------------------------------------ */
/* 上游转发                                                            */
/* ------------------------------------------------------------------ */

async function forward(bodyObj, signal) {
  return fetch(UPSTREAM_COMPLETIONS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
    signal,
  });
}

/** 把上游响应的状态/头/正文（含 SSE 流）原样透传回客户端。 */
async function relay(upstreamRes, res) {
  const headers = { "content-type": upstreamRes.headers.get("content-type") || "application/json" };
  // SSE 需要禁止中间缓冲，才能边生成边推。
  if ((headers["content-type"] || "").includes("text/event-stream")) {
    headers["cache-control"] = "no-cache";
    headers.connection = "keep-alive";
  }
  res.writeHead(upstreamRes.status, headers);
  res.flushHeaders?.();

  if (!upstreamRes.body) {
    res.end(await upstreamRes.text());
    return;
  }
  const reader = upstreamRes.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      /*
       * Backpressure: `res.write()` returns false once the kernel buffer is
       * full, and without waiting for `drain` this loop keeps pulling from the
       * upstream and buffering in the V8 heap. Measured with a client that stops
       * reading: the middleware's RSS climbed 39 → 79 MB while the upstream kept
       * producing — i.e. the memory is bounded only by how much the model emits.
       *
       * Also stop early when the client is gone, so a disconnected socket cannot
       * keep the loop alive.
       */
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(buf)) {
        await new Promise((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      }
      if (res.destroyed || res.writableEnded) break;
    }
  } finally {
    try {
      reader.cancel?.();
    } catch {}
    res.end();
  }
}

/* ------------------------------------------------------------------ */
/* 可选的摘要闭环（--summarize）                                       */
/* ------------------------------------------------------------------ */

/**
 * 后台摘要：把 result.toSummarize 交给上游模型压成记忆块，成功后推进水位并写入会话。
 * 失败绝不推进水位（否则会丢对白）。真实宿主也可以换成独立的摘要模型。
 */
async function maybeSummarize(sessionKey, result, model) {
  if (!sessionKey) return;
  if (!result.memory.shouldSummarize || !(result.toSummarize?.length > 0)) return;
  try {
    const priorJoined = (loadMemory(sessionKey).summaryBlocks || []).map((b) => b.text).join("\n\n");
    const userPrompt = summary.buildUserPrompt({
      priorJoined,
      transcript: summary.formatTranscript(result.toSummarize),
      mode: "replace",
      maxCharsHint: 800,
    });
    const up = await forward({
      model,
      stream: false,
      max_tokens: 600,
      messages: [
        { role: "system", content: summary.systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    if (!up.ok) throw new Error(`summarizer HTTP ${up.status}`);
    const json = await up.json();
    const text = json?.choices?.[0]?.message?.content ?? "";
    const parsed = summary.parseStructuredCompress(text);
    const through =
      result.nextSummarizedThroughMessageId ||
      result.toSummarize[result.toSummarize.length - 1]?.id ||
      "";
    const block = summary.makeReplaceBlock({
      text: parsed.summaryText,
      throughMessageId: through,
      pairCount: result.toSummarizePairCount || 0,
      kind: "full",
      importance: 80,
    });
    const nextBlocks = blocksEngine.commitBlock(
      loadMemory(sessionKey).summaryBlocks || [],
      block,
      6,
      2400,
      7200,
    );
    saveMemory(sessionKey, {
      summaryBlocks: nextBlocks,
      summarizedThroughMessageId: result.nextSummarizedThroughMessageId,
      summarizedCount: result.nextSummarizedCount,
    });
    console.log(
      `[summarize] session=${sessionKey} 压缩 ${result.toSummarizePairCount} 对；` +
        ` 水位 → ${result.nextSummarizedThroughMessageId}; blocks → ${nextBlocks.length}`,
    );
  } catch (e) {
    console.error(`[summarize] session=${sessionKey} 失败，水位不推进：${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 处理                                                           */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new Error("request body too large"));
        /*
         * Do NOT `req.destroy()` here.
         *
         * Destroying tears down the socket, so the 413 the handler wants to send
         * can never reach the client — the caller sees a connection reset instead
         * of a readable error. viz-server hit this first and fixed it there;
         * mirror the same shape: stop accumulating, drain the rest, let the
         * handler answer.
         */
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** OpenAI 风格的错误体，方便客户端统一处理。 */
function sendError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, { error: { message, type, code: null } });
}

async function handleCompletions(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (e) {
    sendError(res, 400, `无效的 JSON 请求体：${e.message}`);
    return;
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    sendError(res, 400, "messages 必须是非空数组");
    return;
  }

  const sessionKey =
    (req.headers["x-session-id"] && String(req.headers["x-session-id"])) ||
    (typeof body.user === "string" && body.user) ||
    "";
  const model = typeof body.model === "string" ? body.model : "local";
  const stream = body.stream === true;

  const dialogue = toDialogue(messages);
  const clientSystem = collectSystemText(messages);
  const systemCount = messages.filter((m) => m?.role === "system" || m?.role === "developer").length;
  if (dialogue.length === 0) {
    sendError(res, 400, "messages 里至少需要一条 user/assistant 消息");
    return;
  }

  // 显式取舍：system-mode=drop 丢掉客户端 system；=prefix 把它作为 systemPrefix 保留。
  const fragments =
    SYSTEM_MODE === "prefix" && clientSystem
      ? { systemPrefix: [clientSystem], systemSuffix: [], depthInserts: [] }
      : null;
  const mem = loadMemory(sessionKey);

  const baseInput = {
    profile: { name: AGENT_NAME, description: `你是 ${AGENT_NAME}。` },
    dialogue,
    summaryBlocks: mem.summaryBlocks,
    summarizedThroughMessageId: mem.summarizedThroughMessageId,
    summarizedCount: mem.summarizedCount,
    pairBatchSize: PAIR_BATCH,
    contextTokenLimit: CONTEXT_LIMIT,
    completionReserveTokens: RESERVE,
    tokenCounter: counter,
    cacheScope: sessionKey ? `oai-${sessionKey}` : "oai-anon",
    fragments,
    label: "oai-chat",
  };

  let result;
  try {
    // 有真实分词器 → 走 prepareAsync 的 hydrate/retry 契约；否则退化计数器 + prepareLive。
    result = httpCounter
      ? await engine.prepareAsync({
          ...baseInput,
          hydrate: (t) => httpCounter.hydrate(t),
          hydrateOne: (t) => httpCounter.hydrateOne(t),
        })
      : await engine.prepareAsync(baseInput);
  } catch (e) {
    sendError(res, 500, `CogniStack prepare 失败：${e.message}`, "server_error");
    return;
  }

  console.log(
    `[chat] session=${sessionKey || "(anon)"} model=${model} stream=${stream}` +
      ` dialogue=${dialogue.length} messages=${result.messages.length}` +
      ` promptTokens=${result.promptTokens} counter=${result.diagnostics.counterId}` +
      ` shouldSummarize=${result.memory.shouldSummarize}` +
      ` systemMode=${SYSTEM_MODE} clientSystemMsgs=${systemCount}` +
      (SYSTEM_MODE === "drop" ? ` (已丢弃 ${systemCount} 条 system)` : " (保留为 systemPrefix)"),
  );

  // 还原保留消息的原始扩展结构（如 role: "tool"、tool_call_id、tool_calls）
  const assembledMessages = [];
  const systemMsg = result.messages.find((m) => m.role === "system");
  if (systemMsg) assembledMessages.push(systemMsg);

  const nonSystemResult = result.messages.filter((m) => m.role !== "system");
  for (let idx = 0; idx < nonSystemResult.length; idx += 1) {
    const resMsg = nonSystemResult[idx];
    const origD = dialogue[idx];
    const raw = origD?._raw;
    if (raw) {
      assembledMessages.push({
        ...raw,
        content: typeof raw.content === "string" ? resMsg.content : raw.content,
      });
    } else {
      assembledMessages.push(resMsg);
    }
  }

  const upstreamBody = { ...body, messages: assembledMessages };

  const ac = new AbortController();
  /*
   * Client disconnect → stop generating upstream.
   *
   * `req.on("aborted")` does NOT work here and never will: that event only fires
   * while the *request body* is still being received, and by this point the body
   * has been fully read. Measured: with a client that disconnected mid-stream,
   * the upstream stub kept producing every chunk to completion and neither
   * `UPSTREAM_SOCKET_CLOSE` nor `REQ_ABORTED` ever fired. For a local llama.cpp
   * upstream that is pure wasted GPU time.
   *
   * `res.on("close")` is the correct signal — it fires when the response side
   * goes away, i.e. exactly when the client is gone.
   */
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  let headerExpired = false;
  const headerTimer = setTimeout(() => {
    headerExpired = true;
    ac.abort();
  }, UPSTREAM_HEADER_TIMEOUT_MS);

  try {
    const upstreamRes = await forward(upstreamBody, ac.signal);
    clearTimeout(headerTimer);
    await relay(upstreamRes, res);
  } catch (e) {
    clearTimeout(headerTimer);
    if (headerExpired && !res.headersSent) {
      console.error(`[upstream] ${UPSTREAM_COMPLETIONS} 响应头超时（${UPSTREAM_HEADER_TIMEOUT_MS}ms）`);
      sendError(res, 504, `上游响应头超时（${UPSTREAM_HEADER_TIMEOUT_MS}ms）`, "server_error");
      return;
    }
    if (!res.headersSent) {
      // 错误体会原样交给调用方，所以不回显上游 URL（非本机部署下那是内网拓扑）；
      // 真实地址进服务端日志，本机排错照样看得到。
      console.error(`[upstream] ${UPSTREAM_COMPLETIONS} 转发失败: ${e.message}`);
      sendError(res, 502, `上游转发失败：${e.message}`, "server_error");
    } else {
      res.end();
    }
  }

  // 响应已发出后再做摘要：不阻塞本轮，只影响下一轮的 prompt。
  if (SUMMARIZE) void maybeSummarize(sessionKey, result, model);
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
    sendJson(res, 200, {
      ok: true,
      // 仅 loopback 绑定时回显完整地址；否则只表明"已配置"。
      upstream: EXPOSE_UPSTREAM ? UPSTREAM_COMPLETIONS : "(hidden: non-loopback bind)",
      tokenizer: TOKENIZE_URL || "exactChar(退化)",
    });
    return;
  }
  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    handleCompletions(req, res).catch((e) => {
      if (!res.headersSent) sendError(res, 500, e.message, "server_error");
      else res.end();
    });
    return;
  }
  sendError(res, 404, `未知路径 ${req.method} ${url}`);
});

module.exports = {
  server,
  handleCompletions,
  toDialogue,
  collectSystemText,
  engine,
};

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log("OpenAI 兼容中间件已启动");
    console.log(`  监听:      http://${HOST}:${PORT}/v1/chat/completions`);
    console.log(`  上游:      ${UPSTREAM_COMPLETIONS}`);
    console.log(`  绑定:      ${HOST}${HOST === "127.0.0.1" ? "（仅本机；这是默认的安全选择）" : "（非本机！请确认你了解风险）"}`);
    console.log(`  system模式: ${SYSTEM_MODE}（drop=丢弃客户端 system，prefix=作为 systemPrefix 保留）`);
    console.log(`  摘要:      ${SUMMARIZE ? "开启（会在响应后向上游发摘要请求）" : "关闭（--summarize 可开启）"}`);
    if (TOKENIZE_URL) {
      console.log(`  分词器:    真实（${TOKENIZE_URL}），走 prepareAsync + CACHE_MISS retry`);
    } else {
      console.warn(
        "  分词器:    exactCharTokenCounter（1 字符 ≈ 1 token）—— 这不是真实分词，" +
          "token 数字不可用于生产判断！传 --tokenize-url http://<upstream>/tokenize 启用真实分词。",
      );
    }
  });

  process.on("SIGINT", () => {
    console.log("\n关闭中…");
    server.close(() => process.exit(0));
  });
}
