/**
 * High-concurrency multi-worker cluster runner for CogniStack.
 * Utilizes multi-core architecture (e.g., 16 cores / 32 threads) with zero runtime dependencies.
 *
 * Usage:
 *   node scripts/start-cluster.cjs [--workers 16] [--port 7331]
 *   npm run start:cluster
 */
"use strict";

const cluster = require("node:cluster");
const os = require("node:os");
const path = require("node:path");

// 核心修复：Windows 系统下 Node.js 默认 schedulingPolicy 为 SCHED_NONE (系统内核分配)，
// 在高并发压测时 Windows IOCP 会将几乎全部请求倾泻给单一 Worker，导致多 Worker 性能与单 Worker 无异。
// 强制开启 cluster.SCHED_RR (Round-Robin 主控轮询分发)，主进程严格将并发均匀调度到各个独立 Worker！
cluster.schedulingPolicy = cluster.SCHED_RR;

const root = path.join(__dirname, "..");
const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;

function parseArgs(argv) {
  const out = { workers: 0, port: 7331, forwarded: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workers" && argv[i + 1]) {
      out.workers = Math.max(1, Number(argv[++i]) || 1);
    } else if (a === "--port" && argv[i + 1]) {
      out.port = Number(argv[++i]) || 7331;
    } else {
      out.forwarded.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
// 优化默认 Worker 策略：>=16 核硬件默认分配 16 个核心占满物理全大核，兼顾极限装配吞吐与调度稳定性；<16 核按硬件规格自适应
const defaultWorkers = cpus >= 16 ? 16 : Math.max(1, cpus);
const workersCount = Number(process.env.COGNISTACK_WORKERS) || args.workers || defaultWorkers;
const port = Number(process.env.PORT) || args.port;

if (cluster.isPrimary) {
  const cpuModel = os.cpus()[0]?.model ? os.cpus()[0].model.trim() : "Unknown CPU";
  console.log("\n========================================================");
  console.log("  CogniStack High-Concurrency Cluster Engine");
  console.log("========================================================");
  console.log(`  硬件架构:   ${cpus} 逻辑核心 (${cpuModel})`);
  console.log(`  工作进程:   ${workersCount} 个 Worker (Cluster 多核并行负载均衡)`);
  console.log(`  服务地址:   http://127.0.0.1:${port}`);
  console.log(`  装配端点:   http://127.0.0.1:${port}/v1/prepare`);
  console.log("  停止服务:   Ctrl+C\n");

  const primaryArgs = ["--port", String(port), ...args.forwarded];
  cluster.setupPrimary({
    exec: path.join(root, "tools", "viz-server.cjs"),
    args: primaryArgs,
  });

  let desiredWorkers = workersCount;
  const workers = new Map(); // worker.id -> worker
  const retiringWorkerIds = new Set(); // 正在计划退役或滚动重载的 Worker，避免误报为异常退出

  function broadcastClusterState() {
    const list = [];
    for (const [id, w] of workers) {
      const isOnline = w.state === "listening" || w.state === "online";
      list.push({
        id,
        pid: w.process ? w.process.pid : undefined,
        state: isOnline ? "online" : (w.state || "online"),
      });
    }
    const stateMsg = {
      type: "CLUSTER_STATE_UPDATE",
      primaryPid: process.pid,
      workersCount: list.length,
      workers: list,
    };
    for (const [, w] of workers) {
      try {
        if (w.isConnected()) w.send(stateMsg);
      } catch {}
    }
  }

  function forkWorker() {
    const worker = cluster.fork();
    workers.set(worker.id, worker);

    worker.on("online", () => {
      broadcastClusterState();
    });

    worker.on("listening", () => {
      broadcastClusterState();
    });

    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "GET_CLUSTER_STATE") {
        broadcastClusterState();
      } else if (msg.type === "SET_WORKERS") {
        const target = Math.max(1, Math.min(cpus * 2, Number(msg.count) || 1));
        scaleWorkers(target);
      } else if (msg.type === "ROLLING_RELOAD") {
        void rollingReload();
      } else if (msg.type === "BROADCAST_CONFIG") {
        for (const [, w] of workers) {
          try {
            if (w.isConnected()) w.send(msg);
          } catch {}
        }
      }
    });

    return worker;
  }

  function scaleWorkers(target) {
    desiredWorkers = target;
    const current = workers.size;
    console.log(`[cluster] 收到热伸缩指令: 当前 ${current} -> 目标 ${target} 个 Worker`);
    if (target > current) {
      const toAdd = target - current;
      for (let i = 0; i < toAdd; i++) {
        forkWorker();
      }
      broadcastClusterState();
    } else if (target < current) {
      const toRemove = current - target;
      const ids = Array.from(workers.keys());
      const toRemoveIds = ids.slice(-toRemove);
      for (const id of toRemoveIds) {
        const w = workers.get(id);
        if (!w) continue;
        retiringWorkerIds.add(id);
        workers.delete(id);
        try {
          if (w.isConnected()) {
            w.send({ type: "RETIRE" });
          }
          w.disconnect();
          setTimeout(() => {
            try {
              if (!w.isDead()) w.kill("SIGTERM");
            } catch {}
          }, 1000).unref();
        } catch {}
      }
      broadcastClusterState();
    }
  }

  async function rollingReload() {
    console.log(`[cluster] 开始零停机平滑滚动重启 ${workers.size} 个 Worker...`);
    const oldWorkerIds = Array.from(workers.keys());
    for (const oldId of oldWorkerIds) {
      const oldWorker = workers.get(oldId);
      if (!oldWorker) continue;
      
      const newWorker = forkWorker();
      await new Promise((resolve) => {
        newWorker.once("online", resolve);
        setTimeout(resolve, 3000);
      });

      retiringWorkerIds.add(oldId);
      workers.delete(oldId);
      try {
        if (oldWorker.isConnected()) {
          oldWorker.send({ type: "RETIRE" });
        }
        oldWorker.disconnect();
        setTimeout(() => {
          try {
            if (!oldWorker.isDead()) oldWorker.kill("SIGTERM");
          } catch {}
        }, 1000).unref();
      } catch {}
      broadcastClusterState();
    }
    console.log(`[cluster] 零停机平滑滚动重启全部完成，当前活跃 Worker: ${workers.size}`);
  }

  for (let i = 0; i < workersCount; i++) {
    forkWorker();
  }

  cluster.on("exit", (worker, code, signal) => {
    workers.delete(worker.id);
    const wasRetiring = retiringWorkerIds.has(worker.id);
    if (wasRetiring) {
      retiringWorkerIds.delete(worker.id);
    }
    broadcastClusterState();
    if (!signal && !shuttingDown && !wasRetiring && workers.size < desiredWorkers) {
      console.warn(`[cluster] Worker ${worker.process ? worker.process.pid : worker.id} 异常退出 (code ${code})，自动拉起新进程补充算力...`);
      forkWorker();
    }
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[cluster] 收到退出信号，正在优雅关闭所有工作进程...");
    for (const [, w] of workers) {
      try {
        w.kill("SIGTERM");
      } catch {}
    }
    setTimeout(() => process.exit(0), 1000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
