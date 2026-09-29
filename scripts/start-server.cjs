/**
 * Production-style start: multi-worker cluster engine + built console on one port.
 *
 *   npm run start:prod
 *   → http://127.0.0.1:7331
 *
 * Dev (hot reload): prefer start.bat / npm start (API + Vite).
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const cliArgs = process.argv.slice(2);
const isSingle = cliArgs.includes("--single") || process.env.COGNISTACK_SINGLE === "1";
const scriptToRun = isSingle ? "tools/viz-server.cjs" : "scripts/start-cluster.cjs";

const child = spawn(
  process.execPath,
  [path.join(root, scriptToRun), "--port", "7331", ...cliArgs.filter((a) => a !== "--single")],
  {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  },
);

console.log("");
console.log(`  CogniStack — ${isSingle ? "单进程标准服务" : "多核高并发集群服务"}`);
console.log("  Console: http://127.0.0.1:7331");
console.log("  API:     http://127.0.0.1:7331/v1/prepare");
console.log("  Stop:    Ctrl+C");
console.log("");

function shutdown() {
  try {
    child.kill();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code || 0));
