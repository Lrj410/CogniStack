/**
 * Call CogniStack over HTTP — other systems only need the base URL.
 *
 *   # terminal 1
 *   npm run viz
 *   # or: node tools/viz-server.cjs --port 7331
 *
 *   # terminal 2
 *   node examples/http-call.cjs
 *   node examples/http-call.cjs --url http://127.0.0.1:7331 --key SECRET
 */
const http = require("node:http");
const https = require("node:https");

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const BASE = arg("url", process.env.COGNISTACK_URL || "http://127.0.0.1:7331");
const KEY = arg("key", process.env.COGNISTACK_API_KEY || "");

function request(method, path, body) {
  const url = new URL(path, BASE);
  const lib = url.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  const headers = { accept: "application/json" };
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  if (KEY) {
    headers.authorization = `Bearer ${KEY}`;
    headers["x-api-key"] = KEY;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      { method, headers },
      (res) => {
        const chunks = [];
        let size = 0;
        const MAX = 8_000_000;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX) {
            req.destroy();
            reject(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            data = { raw };
          }
          if (res.statusCode >= 400) {
            reject(new Error(`${res.statusCode} ${data.error || raw}`));
          } else resolve(data);
        });
      },
    );
    req.setTimeout(30_000, () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const health = await request("GET", "/v1/health");
  console.log("health:", health);

  const result = await request("POST", "/v1/prepare", {
    host: { id: "http-demo", name: "HTTP 示例", kind: "client", version: "1.0.0" },
    label: "试调·自我介绍",
    meta: { chatId: "demo-chat", route: "/v1/prepare", action: "试调" },
    mode: "generate",
    card: { name: "阿铁", description: "冷静的机械师。" },
    dialogue: [
      { id: "1", role: "user", content: "你好，介绍一下你自己。" },
      { id: "2", role: "assistant", content: "我是阿铁。" },
      { id: "3", role: "user", content: "今天显卡温度怎么样？" },
    ],
    contextTokenLimit: 4096,
    completionReserveTokens: 512,
    cacheScope: "http-demo-chat",
    charsPerToken: 4,
  });

  console.log("ok:", result.ok);
  console.log("promptTokens:", result.promptTokens);
  console.log("messages:", result.messages?.length);
  console.log("memory.pendingPairs:", result.memory?.pendingPairs);
  console.log("--- first system (truncated) ---");
  const sys = result.messages?.find((m) => m.role === "system");
  console.log((sys?.content || "").slice(0, 400));
  console.log("---");
  console.log("把 result.messages 发给你的 LLM 即可。");
}

main().catch((e) => {
  console.error("failed:", e.message);
  console.error("先启动: npm run viz   或  node tools/viz-server.cjs");
  process.exit(1);
});
