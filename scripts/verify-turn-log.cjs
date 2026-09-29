/* 端到端验证：回合持久化 + 回放 + 不影响指标的语义 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// 写系统临时目录，不写进仓库根 —— 之前留在 cwd 会污染工作区（还得靠 .gitignore 兜底）。
const LOG = path.join(os.tmpdir(), `cognistack-turns-${process.pid}.jsonl`);
for (const f of [LOG, LOG + ".1", LOG + ".2"]) {
  try {
    fs.unlinkSync(f);
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Port handling — deliberately not hardcoded.
 *
 * This script used to spawn on a fixed 7399 and then talk to it unconditionally.
 * Measured failure mode: when *any* other CogniStack instance already owned 7399,
 * our child died with EADDRINUSE and the script cheerfully talked to **the other
 * server** — `POST /api/turn` returned 200s from a process that had never been
 * started with `--turn-log`, so `GET /api/turn-log` 404'd and the run ended in an
 * unreadable ENOENT. The self-check reported a failure caused entirely by its own
 * harness (and, worse, could have *passed* against the wrong server).
 *
 * Two fixes: pick a port nothing is listening on, and *prove* the server we talk
 * to is the one we started (fresh `uptimeMs` + our child still alive).
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function pickFreePort(start = 7399, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`从 ${start} 起连续 ${tries} 个端口都被占用，无法启动验证服务`);
}

function turnBody(n) {
  return {
    hostId: "verify-host",
    hostName: "验证宿主",
    kind: "test",
    mode: "generate",
    messages: 2,
    systemSections: 1,
    promptTokens: 100 + n,
    promptChars: 200,
    loreCount: 0,
    vectorHits: 0,
    softTrimCap: 4000,
    hardFit: 4096,
    contextLimit: 8192,
    completionReserve: 512,
    softTrimEnabled: true,
    counter: { hits: 1, misses: 2, distinct: 2, evictions: 0 },
    durationMs: 3 + n,
    timings: {},
    memory: {
      shouldSummarize: false,
      compressReason: null,
      pendingPairs: 0,
      contextUsed: 0,
      contextTriggerAt: 0,
      watermarkEnd: 0,
      summarizedCount: 0,
    },
    warnings: [],
    degraded: false,
    cacheHit: false,
    emergencyDropped: 0,
    softTrimmed: false,
    toSummarizePairCount: 0,
    ports: ["card"],
  };
}

(async () => {
  const port = await pickFreePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(
    process.execPath,
    ["tools/viz-server.cjs", "--port", String(port), "--turn-log", LOG],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  srv.stdout.on("data", () => {});
  srv.stderr.on("data", (d) => process.stderr.write(d));

  let failed = false;
  try {
    /* 等就绪，而不是固定 sleep；并且拒绝对着别人的服务做自检 */
    let health = null;
    for (let i = 0; i < 40; i += 1) {
      if (srv.exitCode !== null) {
        throw new Error(
          `验证服务提前退出（退出码 ${srv.exitCode}）——端口 ${port} 探测后仍被抢占？`,
        );
      }
      try {
        const res = await fetch(base + "/v1/health");
        if (res.ok) {
          health = await res.json();
          break;
        }
      } catch {}
      await sleep(150);
    }
    if (!health) throw new Error(`等不到 ${base}/v1/health 就绪`);
    if (!(Number(health.uptimeMs) < 30_000)) {
      throw new Error(
        `连上的不是刚启动的实例（uptimeMs=${health.uptimeMs}）——有人在 ${port} 上，拒绝继续`,
      );
    }
    console.log(`服务就绪: ${base} | uptimeMs=${health.uptimeMs} | version=${health.version}`);

    const statuses = [];
    for (const n of [1, 2, 3]) {
      const res = await fetch(base + "/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(turnBody(n)),
      });
      statuses.push(res.status);
    }
    console.log("POST /api/turn x3 ->", statuses.join(","));
    await sleep(300);

    const logRes = await fetch(base + "/api/turn-log?limit=10");
    const logBody = await logRes.json();
    console.log(
      "GET /api/turn-log ->",
      logRes.status,
      "| turns:",
      logBody.turns ? logBody.turns.length : 0,
      "| scanned:",
      logBody.scanned,
      "| malformed:",
      logBody.malformed,
    );
    const diskLines = fs.readFileSync(LOG, "utf8").trim().split("\n").length;
    console.log("磁盘行数:", diskLines);
    const first = logBody.turns && logBody.turns[0];
    console.log("记录里 messages 字段类型:", first ? typeof first.messages : "-", "(应为 number=计数，而非消息数组)");

    const replayRes = await fetch(base + "/api/turn-log/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 3 }),
    });
    const replayBody = await replayRes.json();
    console.log("POST replay ->", replayRes.status, JSON.stringify(replayBody));

    const snap = await (await fetch(base + "/api/snapshot")).json();
    const replayedCount = snap.turns.filter((t) => t.replayed).length;
    console.log(
      "回放后 ring:",
      snap.turns.length,
      "| replayed 标记:",
      replayedCount,
      "| totalTurns(不应被回放污染):",
      snap.totalTurns,
    );
    const met = await (await fetch(base + "/api/metrics")).text();
    console.log("metrics:", met.split("\n").find((l) => l.startsWith("cognistack_turns_total ")));

    /*
     * 被拒请求的可见性（本轮新增）。
     *
     * 事故形态：客户端「测试连接」通常只打 /v1/health（纯探活，不注册宿主也不记账），
     * 而真实 prepare 一旦被拒，此前只写 stderr —— 面板永远是「暂无主机 / 0 回合」，
     * 「测试连接成功但系统里什么都没有」无从自查。这里把两件事钉死：
     *   1) 输入契约类错误必须**如实回传原因**（不再一律 "invalid request"）；
     *   2) 被拒必须出现在 snapshot / metrics 上，且清空遥测不会抹掉它。
     */
    const badRes = await fetch(base + "/v1/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "status",
        card: { name: "联通探测" },
        dialogue: [{ id: "1", role: "user", content: "ping" }],
      }),
    });
    const badBody = await badRes.json();
    console.log("被拒 prepare ->", badRes.status, JSON.stringify(badBody));

    const snap2 = await (await fetch(base + "/api/snapshot")).json();
    const rejects = snap2.gateway && snap2.gateway.rejects;
    console.log("snapshot.gateway.rejects ->", JSON.stringify(rejects));
    const met2 = await (await fetch(base + "/api/metrics")).text();
    console.log(
      "metrics rejects:",
      met2.split("\n").filter((l) => l.includes("gateway_rejects_total")).join(" | ") || "(无)",
    );

    const clr = await fetch(base + "/api/turn-log/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log("clear 不带 confirm ->", clr.status, JSON.stringify(await clr.json()));

    const reset = await fetch(base + "/api/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const resetBody = await reset.json();
    console.log(
      "reset 后磁盘日志:",
      fs.existsSync(LOG) ? "保留" : "被删",
      "| 响应:",
      JSON.stringify(resetBody),
    );
    const snap3 = await (await fetch(base + "/api/snapshot")).json();
    const rejectsAfterReset = snap3.gateway && snap3.gateway.rejects;
    console.log("reset 后 rejected.total:", rejectsAfterReset && rejectsAfterReset.total, "(不清零=设计)");

    /* 断言：跑完必须真的验过东西，别又变成"看着绿其实没跑" */
    if (badRes.status !== 400 || badBody.code !== "missing_prior_tokens") {
      throw new Error(
        `被拒原因未如实回传：status=${badRes.status} code=${badBody.code} error=${badBody.error}`,
      );
    }
    if (!/priorAssembledPromptTokens/.test(String(badBody.error))) {
      throw new Error(`被拒原因不可诊断：${badBody.error}`);
    }
    if (!rejects || rejects.total < 1 || !(rejects.byReason && rejects.byReason.bad_request >= 1)) {
      throw new Error(`snapshot 未暴露被拒读数：${JSON.stringify(rejects)}`);
    }
    if (!rejects.last || rejects.last.path !== "/v1/prepare") {
      throw new Error(`最近被拒上下文不对：${JSON.stringify(rejects.last)}`);
    }
    if (!met2.includes("cognistack_gateway_rejects_total")) {
      throw new Error("metrics 缺少 cognistack_gateway_rejects_total");
    }
    if (!rejectsAfterReset || rejectsAfterReset.total < 1) {
      throw new Error("reset 不应清零被拒读数（它是网关侧流量事实）");
    }
    if (logRes.status !== 200 || !logBody.turns || logBody.turns.length !== 3) {
      throw new Error(`回合持久化校验失败：status=${logRes.status} turns=${logBody.turns && logBody.turns.length}`);
    }
    if (diskLines !== 3) throw new Error(`磁盘应为 3 行，实际 ${diskLines}`);
    if (Number(snap.totalTurns) !== 3) {
      throw new Error(`回放污染了指标：totalTurns=${snap.totalTurns}（应为 3）`);
    }
    if (clr.status !== 400) throw new Error(`clear 缺 confirm 应为 400，实际 ${clr.status}`);
    if (!fs.existsSync(LOG)) throw new Error("reset 不应删除磁盘日志");
    console.log("全部断言通过");
  } catch (e) {
    failed = true;
    console.error("FAIL", e && e.message ? e.message : e);
  } finally {
    srv.kill();
    await sleep(250);
    try {
      fs.unlinkSync(LOG);
    } catch {}
  }
  process.exit(failed ? 1 : 0);
})();
