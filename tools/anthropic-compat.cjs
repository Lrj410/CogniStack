#!/usr/bin/env node
/**
 * Anthropic Messages 协议兼容中间件（cognistack-protocol-bridge）
 * 把 CogniStack 上下文与预算引擎无缝接入 Anthropic Claude 客户端与模型之间。
 *
 * 对外暴露标准 Anthropic 端点：
 *   POST /v1/messages
 *
 * 核心设计：
 * 1. 顶层 system 映射：Anthropic 协议将 system 提示抽离在顶层参数中（string 或 content blocks）。
 *    中间件将其直接挂载到 CogniStack 的 systemRules 与 fragments.systemPrefix，统一纳入预算考量。
 * 2. 对话素材拟合：将客户端 messages 作为 dialogue 输入，经由 CogniStack 进行分词记忆化、
 *    软顶（soft-trim）和紧急安全裁剪（fitMessagesUnderTokenCap），再转换为标准输出。
 * 3. 真实分词与降级：支持 --tokenize-url 注入真实分词器；缺省时回退为 exactCharTokenCounter。
 * 4. 流式反压与客户端断流：针对 stream: true，以 SSE 转发流事件；客户端断开时通过 AbortController
 *    即时中止上游生成，避免算力浪费。
 */
"use strict";

const http = require("node:http");
const {
  CogniStackEngine,
  exactCharTokenCounter,
  createHttpTokenCounter,
} = require("../dist/index.js");

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", process.env.PORT || 8792));
const HOST = arg("host", process.env.HOST || "127.0.0.1");
const UPSTREAM = arg("upstream", process.env.UPSTREAM || "https://api.anthropic.com");
const TOKENIZE_URL = arg("tokenize-url", process.env.TOKENIZE_URL || "");
const CONTEXT_LIMIT = Number(arg("context-limit", 8192));
const RESERVE = Number(arg("reserve", 1024));
const AGENT_NAME = arg("agent-name", "Claude助手");
const MAX_BODY = 4_000_000;
/**
 * 上游「响应头」超时。只覆盖到收到响应头为止 —— 一旦开始流式回包就清除定时器，
 * 否则一次长文本生成会被这个超时腰斩。作用是把"上游无响应"从无限等待变成可读的 502。
 */
const UPSTREAM_HEADER_TIMEOUT_MS = Number(process.env.COGNISTACK_UPSTREAM_TIMEOUT_MS || 120_000);

function messagesUrl(base) {
  const b = String(base).replace(/\/+$/, "");
  if (b.endsWith("/v1/messages") || b.endsWith("/messages")) return b;
  return `${b}/v1/messages`;
}
const UPSTREAM_MESSAGES = messagesUrl(UPSTREAM);

/* ------------------------------------------------------------------ */
/* 引擎实例与分词器                                                     */
/* ------------------------------------------------------------------ */

let tokenCounter;
let hasRealTokenizer = false;

if (TOKENIZE_URL) {
  tokenCounter = createHttpTokenCounter({ url: TOKENIZE_URL });
  hasRealTokenizer = true;
} else {
  tokenCounter = exactCharTokenCounter();
  hasRealTokenizer = false;
}

const engine = new CogniStackEngine({
  systemRules: "遵守用户指令；回答准确、简洁。",
  host: { id: "anthropic-compat", name: "Anthropic 兼容中间件", kind: "service" },
});

/* ------------------------------------------------------------------ */
/* 消息与格式转换                                                      */
/* ------------------------------------------------------------------ */

/**
 * 提取 Anthropic 格式的 system 字段为纯文本
 */
function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((item) => (typeof item === "string" ? item : item.text || ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/**
 * 将 Anthropic messages 转换为 CogniStack dialogue 格式
 */
function toCogniStackDialogue(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m, idx) => {
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part.type === "text") return part.text || "";
          if (part.type === "tool_result") return typeof part.content === "string" ? part.content : JSON.stringify(part.content);
          if (part.type === "tool_use") return JSON.stringify(part);
          if (part.type === "thinking") return part.thinking || "";
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return {
      id: `msg-${idx + 1}`,
      role: m.role === "assistant" ? "assistant" : "user",
      content,
      _raw: m,
    };
  });
}

/**
 * 将 CogniStack 装配出的 messages 转换回 Anthropic messages 数组
 * （过滤掉 system 消息，因为 Anthropic 要求 system 放在顶层）
 */
function toAnthropicMessages(cogniMessages, rawDialogue) {
  const nonSystem = cogniMessages.filter((m) => m.role === "user" || m.role === "assistant");
  return nonSystem.map((m, idx) => {
    const raw = rawDialogue?.[idx]?._raw;
    if (raw && Array.isArray(raw.content)) {
      return {
        role: raw.role,
        content: raw.content,
      };
    }
    return {
      role: m.role,
      content: m.content,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 上游转发与流式中继                                                  */
/* ------------------------------------------------------------------ */

async function forward(body, headers, signal) {
  const forwardHeaders = {
    "content-type": "application/json",
  };
  if (headers["x-api-key"]) forwardHeaders["x-api-key"] = headers["x-api-key"];
  if (headers["anthropic-version"]) forwardHeaders["anthropic-version"] = headers["anthropic-version"];
  if (headers["authorization"]) forwardHeaders["authorization"] = headers["authorization"];

  return fetch(UPSTREAM_MESSAGES, {
    method: "POST",
    headers: forwardHeaders,
    body: JSON.stringify(body),
    signal,
  });
}

async function relay(upstreamRes, res) {
  const headers = {
    "content-type": upstreamRes.headers.get("content-type") || "application/json",
  };
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
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(buf)) {
        await new Promise((resolve) => {
          const doneHandler = () => {
            res.off("drain", doneHandler);
            res.off("close", doneHandler);
            resolve();
          };
          res.once("drain", doneHandler);
          res.once("close", doneHandler);
        });
      }
      if (res.destroyed || res.writableEnded) break;
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(`[relay] 中继中断: ${err.message}`);
    }
  } finally {
    try {
      reader.cancel?.();
    } catch {}
    res.end();
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 服务处理                                                       */
/* ------------------------------------------------------------------ */

/**
 * 读取请求体，超限时**不** `req.destroy()`。
 *
 * Destroy 会连 socket 一起拆掉，handler 想回的 413 根本到不了客户端 —— 调用方看到的是
 * 连接重置而不是可读错误。正确做法：停止累积、把剩余数据排空、交给 handler 应答。
 */
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

async function handleMessages(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Malformed JSON" } }));
    return;
  }

  const systemText = extractSystemText(body.system);
  const dialogue = toCogniStackDialogue(body.messages);
  if (!Array.isArray(body.messages) || body.messages.length === 0 || dialogue.length === 0) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages 必须是非空有效对话数组" } }));
    return;
  }

  const sessionKey =
    (req.headers["x-session-id"] && String(req.headers["x-session-id"])) ||
    (typeof body.metadata?.user_id === "string" && body.metadata.user_id) ||
    "";

  const baseInput = {
    profile: { name: AGENT_NAME, description: `你是 ${AGENT_NAME}。` },
    dialogue,
    contextTokenLimit: CONTEXT_LIMIT,
    completionReserveTokens: body.max_tokens ? Math.min(body.max_tokens, RESERVE) : RESERVE,
    tokenCounter,
    cacheScope: sessionKey ? `anthropic-${sessionKey}` : "anthropic-anon",
    fragments: systemText ? { systemPrefix: [systemText] } : undefined,
    label: "anthropic-messages",
  };

  let prepareResult;
  try {
    prepareResult = hasRealTokenizer
      ? await engine.prepareAsync({
          ...baseInput,
          hydrate: (t) => tokenCounter.hydrate(t),
          hydrateOne: (t) => tokenCounter.hydrateOne(t),
        })
      : await engine.prepareAsync(baseInput);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: `CogniStack prepare 失败: ${err.message}`,
      },
    }));
    return;
  }

  // 装配后的消息重构为 Anthropic 协议格式
  const fittedMessages = toAnthropicMessages(prepareResult.messages, dialogue);

  const upstreamPayload = {
    ...body,
    messages: fittedMessages,
  };
  if (systemText) {
    upstreamPayload.system = systemText;
  }

  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      ac.abort();
    }
  });

  let headerExpired = false;
  const headerTimer = setTimeout(() => {
    headerExpired = true;
    ac.abort();
  }, UPSTREAM_HEADER_TIMEOUT_MS);

  try {
    const upstreamRes = await forward(upstreamPayload, req.headers, ac.signal);
    clearTimeout(headerTimer);
    await relay(upstreamRes, res);
  } catch (err) {
    clearTimeout(headerTimer);
    if (ac.signal.aborted) {
      // 客户端先断开 → 没人可回；上游响应头超时 → 客户端还在，必须给个可读错误。
      if (headerExpired && !res.headersSent) {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Upstream 响应头超时（${UPSTREAM_HEADER_TIMEOUT_MS}ms）` },
        }));
      }
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: `Upstream error: ${err.message}`,
        },
      }));
    } else {
      res.end();
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      protocol: "anthropic-messages",
      upstream: HOST === "127.0.0.1" ? UPSTREAM_MESSAGES : "(hidden)",
      realTokenizer: hasRealTokenizer,
      contextLimit: CONTEXT_LIMIT,
    }));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
    readBody(req)
      .then((raw) => handleMessages(req, res, raw))
      .catch((e) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        const tooLarge = String(e && e.message) === "request body too large";
        res.writeHead(tooLarge ? 413 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          type: "error",
          error: {
            type: tooLarge ? "invalid_request_error" : "api_error",
            message: tooLarge ? "request body too large" : String(e && e.message),
          },
        }));
      });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `Unknown endpoint ${url.pathname}` } }));
});

module.exports = {
  server,
  extractSystemText,
  toCogniStackDialogue,
  toAnthropicMessages,
};

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[CogniStack Anthropic Bridge] 启动成功:`);
    console.log(`  端点:   http://${HOST}:${PORT}/v1/messages`);
    console.log(`  上游:   ${UPSTREAM_MESSAGES}`);
    if (!hasRealTokenizer) {
      console.log(`  注意:   未指定真实分词器，当前使用字符估算 exactCharTokenCounter。`);
    }
  });
}
