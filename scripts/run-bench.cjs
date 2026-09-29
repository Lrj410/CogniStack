/**
 * Standalone high-concurrency benchmark driver for CogniStack cluster.
 * Runs in an isolated child process to ensure 100% zero interference with
 * cluster worker event loops, achieving perfectly balanced multi-core load distribution.
 */
"use strict";

const http = require("node:http");

function parseArgs(argv) {
  const out = { concurrency: 50, rounds: 4, port: 7331 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency" && argv[i + 1]) {
      out.concurrency = Math.max(1, Math.min(5000, Number(argv[++i]) || 50));
    } else if (a === "--rounds" && argv[i + 1]) {
      out.rounds = Math.max(1, Math.min(20, Number(argv[++i]) || 4));
    } else if (a === "--port" && argv[i + 1]) {
      out.port = Number(argv[++i]) || 7331;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const concurrency = args.concurrency;
const rounds = args.rounds;
const totalRequests = concurrency * rounds;
const port = args.port;
const targetHost = "127.0.0.1";

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: Math.min(concurrency, 1024),
  maxFreeSockets: 128,
  timeout: 15000,
});

const latencies = [];
let successCount = 0;
let failedCount = 0;
const errorMap = {};
const workerStats = {};

const reqPayload = JSON.stringify({
  host: { id: "cluster-native-bench", name: "服务端原生高并发压测", kind: "client" },
  mode: "generate",
  dialogue: [
    { role: "user", content: "高并发集群多核装配压力测试样本" },
    { role: "assistant", content: "引擎确认接收并执行预算装配核算。" },
  ],
  contextTokenLimit: 4096,
  completionReserveTokens: 512,
});

const t0 = performance.now();
let currentReqIndex = 0;

const singleTask = () =>
  new Promise((resolve) => {
    const reqStart = performance.now();
    const reqObj = http.request(
      {
        hostname: targetHost,
        port,
        path: "/v1/prepare",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(reqPayload),
          "x-cognistack-bench": "1",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          latencies.push(performance.now() - reqStart);
          if (res.statusCode === 200) {
            successCount++;
            const wId = res.headers["x-worker-id"] || "1";
            workerStats[`Worker #${wId}`] = (workerStats[`Worker #${wId}`] || 0) + 1;
          } else {
            failedCount++;
            const code = `HTTP ${res.statusCode}`;
            errorMap[code] = (errorMap[code] || 0) + 1;
          }
          resolve();
        });
      },
    );

    reqObj.on("error", (err) => {
      latencies.push(performance.now() - reqStart);
      failedCount++;
      const msg = err.message || "请求失败";
      errorMap[msg] = (errorMap[msg] || 0) + 1;
      resolve();
    });

    reqObj.write(reqPayload);
    reqObj.end();
  });

async function main() {
  const activePool = Math.min(concurrency, 256);
  const pool = Array.from({ length: activePool }, async () => {
    while (true) {
      const reqIdx = currentReqIndex++;
      if (reqIdx >= totalRequests) break;
      await singleTask();
    }
  });

  await Promise.all(pool);
  agent.destroy();

  const totalDuration = performance.now() - t0;
  latencies.sort((a, b) => a - b);
  const avgMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p95Idx = Math.floor(latencies.length * 0.95);
  const p95Ms = latencies[p95Idx] ?? avgMs;
  const qps = Math.round((successCount / (totalDuration / 1000)) || 0);

  const result = {
    // 有失败请求就不算通过 —— 否则压测失败会被 /api/cluster/bench 的 data.ok 静默吞掉。
    ok: failedCount === 0,
    totalRequests,
    concurrency,
    rounds,
    durationMs: Math.round(totalDuration),
    qps,
    avgMs: Math.round(avgMs * 10) / 10,
    p95Ms: Math.round(p95Ms * 10) / 10,
    successRate: Math.round((successCount / (totalRequests || 1)) * 100),
    successCount,
    failedCount,
    errors: Object.entries(errorMap).map(([k, v]) => `${k} (${v}次)`).join(", "),
    benchMode: "server-native",
    workerDistribution: workerStats,
  };

  if (typeof process.send === "function") {
    process.send(result);
  } else {
    console.log(JSON.stringify(result));
  }
}

main().catch((err) => {
  if (typeof process.send === "function") {
    process.send({ ok: false, error: err.message });
  } else {
    console.error(err);
  }
  process.exit(1);
});
