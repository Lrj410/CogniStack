/**
 * One-click local launcher (Windows-safe):
 *   1) build engine
 *   2) ensure console deps
 *   3) pick free ports (default API 7331, UI 5173; auto-bump if busy)
 *   4) start API, wait until healthy
 *   5) start Vite (proxy → chosen API port), open browser
 *
 *   start.bat  |  npm start  |  node scripts/start-all.cjs
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

const root = path.join(__dirname, "..");
const consoleDir = path.join(root, "console");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const nodeBin = process.execPath;

const DEFAULT_API_PORT = 7331;
const DEFAULT_UI_PORT = 5173;
const HOST = "127.0.0.1";

const children = [];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || root,
      stdio: "inherit",
      env: opts.env || process.env,
      shell: opts.shell === true,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code) reject(new Error(`${cmd} ${args.join(" ")} → exit ${code}`));
      else resolve();
    });
  });
}

/** True if nothing accepts connections on host:port (more reliable than listen-probe on Windows). */
function canConnect(port, host = HOST) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(400, () => {
      socket.destroy();
      resolve(true); // treat ambiguous as busy
    });
    socket.on("error", (err) => {
      resolve(err.code !== "ECONNREFUSED" && err.code !== "EHOSTUNREACH");
    });
  });
}

function canListen(port, host = HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function isPortFree(port, host = HOST) {
  if (await canConnect(port, host)) return false;
  return canListen(port, host);
}

async function findFreePort(start, label, reserved = new Set(), maxTries = 40) {
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    if (reserved.has(port)) continue;
    if (await isPortFree(port)) {
      if (port !== start) {
        console.log(`  ${label} 端口 ${start} 占用 → 改用 ${port}`);
      }
      return port;
    }
  }
  throw new Error(`${label} 无可用端口（从 ${start} 起试了 ${maxTries} 个）`);
}

function trackChild(child, label) {
  child.on("error", (err) => {
    console.error(`  [${label}] failed to spawn:`, err.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (code || signal) {
      console.error(`  [${label}] exited code=${code} signal=${signal || ""}`);
      process.exitCode = code || 1;
    }
  });
  children.push(child);
  return child;
}

function startNode(scriptPath, args = []) {
  const child = spawn(nodeBin, [scriptPath, ...args], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
    windowsHide: true,
  });
  return trackChild(child, "API");
}

/** Spawn Vite directly (avoid npm arg loss on Windows). */
function startVite(uiPort, apiPort) {
  const viteJs = path.join(consoleDir, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteJs)) {
    throw new Error("未找到 Vite，请先在 console/ 执行 npm install");
  }

  const child = spawn(
    nodeBin,
    [viteJs, "--host", HOST, "--port", String(uiPort)],
    {
      cwd: consoleDir,
      stdio: "inherit",
      env: { ...process.env, COGNISTACK_API_PORT: String(apiPort) },
      shell: false,
      windowsHide: true,
    },
  );
  return trackChild(child, "UI");
}

function waitHttp(url, tries = 80) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      n += 1;
      const req = http.get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const code = res.statusCode || 0;
          if (code !== 200) {
            if (n >= tries) reject(new Error(`健康检查失败 HTTP ${code}: ${url}`));
            else setTimeout(tick, 250);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (body && body.ok === true) resolve(200);
            else if (n >= tries) reject(new Error(`健康检查 JSON 无 ok: ${url}`));
            else setTimeout(tick, 250);
          } catch {
            if (n >= tries) reject(new Error(`健康检查非 JSON: ${url}`));
            else setTimeout(tick, 250);
          }
        });
      });
      req.on("error", () => {
        if (n >= tries) reject(new Error(`等待超时: ${url}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

/** UI / static pages: any 2xx is enough (HTML, not JSON). */
function waitHttpOk(url, tries = 80) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      n += 1;
      const req = http.get(url, (res) => {
        res.resume();
        const code = res.statusCode || 0;
        if (code >= 200 && code < 400) resolve(code);
        else if (n >= tries) reject(new Error(`UI 健康检查失败 HTTP ${code}: ${url}`));
        else setTimeout(tick, 250);
      });
      req.on("error", () => {
        if (n >= tries) reject(new Error(`等待超时: ${url}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function openBrowser(url) {
  if (isWin) {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

/**
 * 退出码必须如实反映结果：之前这里恒 `process.exit(0)`，于是启动失败（API 起不来）
 * 也退 0，`start.bat` 跟着报"成功"。trackChild 里设的 process.exitCode 同样被它覆盖。
 */
function shutdown(code = 0) {
  for (const c of children) {
    try {
      if (isWin && c.pid) spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else c.kill("SIGTERM");
    } catch {}
  }
  process.exit(code);
}

// 用户 Ctrl+C / 被 kill 是正常收尾，退 0；启动失败路径显式传 1。
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const cliArgs = process.argv.slice(2);
const isSingle = cliArgs.includes("--single") || process.env.COGNISTACK_SINGLE === "1";
let cliWorkers = null;
const wIdx = cliArgs.indexOf("--workers");
if (wIdx >= 0 && cliArgs[wIdx + 1]) {
  cliWorkers = Math.max(1, Number(cliArgs[wIdx + 1]) || 1);
} else if (process.env.COGNISTACK_WORKERS) {
  cliWorkers = Math.max(1, Number(process.env.COGNISTACK_WORKERS) || 1);
}

(async () => {
  console.log("");
  console.log(`  CogniStack — ${isSingle ? "单进程标准模式" : "高并发多核集群模式"} 一键启动`);
  console.log("  编译引擎…");
  await run(npmCmd, ["run", "build"], { shell: isWin });

  if (!fs.existsSync(path.join(consoleDir, "node_modules", "vite"))) {
    console.log("  安装控制台依赖…");
    await run(npmCmd, ["install"], { cwd: consoleDir, shell: isWin });
  }

  const apiPort = await findFreePort(DEFAULT_API_PORT, "API");
  const uiPort = await findFreePort(DEFAULT_UI_PORT, "控制台", new Set([apiPort]));

  if (!isSingle) {
    const clusterArgs = ["--port", String(apiPort)];
    if (cliWorkers) clusterArgs.push("--workers", String(cliWorkers));
    console.log(`  启动多核集群 API → http://${HOST}:${apiPort} (支持动态进程伸缩与多核负载均衡)`);
    startNode(path.join(root, "scripts", "start-cluster.cjs"), clusterArgs);
  } else {
    console.log(`  启动单进程 API   → http://${HOST}:${apiPort} (单事件循环模式)`);
    startNode(path.join(root, "tools", "viz-server.cjs"), ["--port", String(apiPort)]);
  }

  try {
    await waitHttp(`http://${HOST}:${apiPort}/v1/health`);
    console.log("  API 就绪");
  } catch (e) {
    console.error("  API 未能启动:", e.message);
    console.error(`  请手动执行: node ${isSingle ? "tools/viz-server.cjs" : "scripts/start-cluster.cjs"} --port ${apiPort}`);
    shutdown(1);
    return;
  }

  console.log(`  启动 UI   → http://${HOST}:${uiPort}`);
  startVite(uiPort, apiPort);

  const uiUrl = `http://${HOST}:${uiPort}/`;
  try {
    await waitHttpOk(uiUrl);
    openBrowser(uiUrl);
  } catch {
    console.log(`  （浏览器未自动打开，请手动访问 ${uiUrl} ）`);
  }

  console.log("");
  console.log(`  控制台: ${uiUrl.replace(/\/$/, "")}`);
  console.log(`  API:    http://${HOST}:${apiPort}/v1/prepare`);
  console.log(`  运行态: ${isSingle ? "单进程标准模式" : "多进程高并发集群模式 (Cluster)"}`);
  console.log("  结束:   在此窗口按 Ctrl+C");
  console.log("");
})().catch((err) => {
  console.error(err);
  shutdown(1);
});
