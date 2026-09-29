/*
 * 端到端验证：viz-server 的静态服务与读端点方法语义。
 *
 * 两条判据都来自实测缺陷（AUDIT-DEEP-2026-09-28 之后的第十一轮）：
 *   1. `GET /index.html::$DATA` 曾返回 200 —— Windows 备用数据流经 path.join 后是
 *      合法路径，existsSync/statSync 全为真，原文件被当成「另一个文件」发出去。
 *   2. `POST` / `DELETE /api/snapshot` 曾返回 200 —— 读 handler 不校验方法。
 *
 * 为什么起真服务而不是把判据抽成纯函数：这两条都取决于 handler 的**顺序**
 * （CSRF 守卫在前、静态分发在后），为了可测把它们重排，被测对象就变了。
 *
 * 就绪判定沿用 verify-turn-log 的口径：必须能证明「连上的就是我刚起的」
 * （子进程仍活着 + uptimeMs 很小），否则端口被别人占用时会对着别人的服务断言。
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WEB_INDEX = path.join(ROOT, "console", "dist", "index.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function pickFreePort(start = 7531, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`从 ${start} 起连续 ${tries} 个端口都被占用，无法启动验证服务`);
}

(async () => {
  const port = await pickFreePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(
    process.execPath,
    ["tools/viz-server.cjs", "--port", String(port)],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let banner = "";
  srv.stdout.on("data", (d) => {
    banner += String(d);
  });
  srv.stderr.on("data", (d) => {
    banner += String(d);
  });

  const cleanup = () => {
    if (srv.exitCode === null) srv.kill();
  };
  process.on("exit", cleanup);

  try {
    /* 等就绪，并拒绝连别人的服务 */
    let snap = null;
    for (let i = 0; i < 60; i += 1) {
      if (srv.exitCode !== null) {
        throw new Error(`验证服务提前退出（退出码 ${srv.exitCode}）\n${banner}`);
      }
      try {
        const res = await fetch(`${base}/api/snapshot`);
        if (res.ok) {
          const body = await res.json();
          if (typeof body.uptimeMs === "number") {
            snap = body;
            break;
          }
        }
      } catch {}
      await sleep(120);
    }
    if (!snap) throw new Error(`等不到 ${base}/api/snapshot 就绪\n${banner}`);
    if (!(Number(snap.uptimeMs) < 30_000)) {
      throw new Error(
        `连上的不是刚启动的实例（uptimeMs=${snap.uptimeMs}）——有人在 ${port} 上，拒绝继续`,
      );
    }
    console.log(`服务就绪: ${base} | uptimeMs=${snap.uptimeMs} | version=${snap.version}`);

    /* 1. 读端点只认 GET / HEAD */
    const get = await fetch(`${base}/api/snapshot`);
    assert.equal(get.status, 200, "GET /api/snapshot 应为 200");

    const head = await fetch(`${base}/api/snapshot`, { method: "HEAD" });
    assert.equal(head.status, 200, "HEAD /api/snapshot 应为 200");

    const post = await fetch(`${base}/api/snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(post.status, 405, "POST /api/snapshot 必须是 405");
    assert.equal(post.headers.get("allow"), "GET, HEAD", "405 必须带 Allow 头");

    const del = await fetch(`${base}/api/metrics`, { method: "DELETE" });
    assert.equal(del.status, 405, "DELETE /api/metrics 必须是 405");
    console.log("  ok  读端点只认 GET/HEAD，其余 405 + Allow: GET, HEAD");

    /* 2. 静态服务：Windows 备用数据流 */
    if (!fs.existsSync(WEB_INDEX)) {
      console.log("  skip 静态服务判据：console/dist 未构建（引擎侧 CI 不建控制台）");
    } else {
      const ads = await fetch(`${base}/index.html::$DATA`);
      assert.equal(ads.status, 404, "GET /index.html::$DATA 不得返回文件内容");

      const colonOnly = await fetch(`${base}/index.html::`);
      assert.equal(colonOnly.status, 404, "含 `:` 的相对路径一律拒绝");

      const plain = await fetch(`${base}/index.html`);
      assert.equal(plain.status, 200, "正常文件仍应 200");
      console.log("  ok  Windows 备用数据流被拒（404），正常文件仍 200");
    }

    console.log("\nEXIT=0  全部通过");
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error("\nFAIL:", e.message);
  process.exit(1);
});