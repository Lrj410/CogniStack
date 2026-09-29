/**
 * 外部系统接入示例 —— 可选。不会被 npm start 自动拉起。
 *
 *   node tools/viz-server.cjs            # 终端 1
 *   node tools/example-client.cjs        # 终端 2（可开多个，用 --id 区分）
 *
 * 选项：
 *   --id <hostId>     宿主 id（默认 example-service）
 *   --name <label>    显示名
 *   --kind <kind>     类别：service / client / worker / cli
 *   --every <ms>      调用间隔（默认 2000）
 *   --url <base>      面板服务地址（默认 http://localhost:7331）
 */
const http = require("node:http");

const ROOT = __dirname + "/..";
const S = require(ROOT + "/dist/index.js");

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const HOST = {
  id: arg("id", "example-service"),
  name: arg("name", "示例外部服务"),
  kind: arg("kind", "service"),
  version: arg("version", "1.0.0"),
  meta: { pid: process.pid, node: process.version },
};

const EVERY = Number(arg("every", 2000)) || 2000;
const BASE = arg("url", "http://localhost:7331");
const API_KEY =
  arg("key", "") || process.env.COGNISTACK_API_KEY || "";

/* ---- 1. 引擎照常跑，只是挂上自己的 telemetry ---- */

const telemetry = new S.CogniStackTelemetry();
const engine = new S.CogniStackEngine({
  telemetry,
  host: HOST,
  systemRules: "示例服务规则：保持角色一致。",
});

// 世界书 / 世界状态是宿主侧实现，通过接入协议交给引擎 —— 引擎本身没有这些领域逻辑。
const lore = {
  selectEntries(entries) {
    return entries.filter(
      (e) => e.enabled !== false && (e.constant || e.keys.some((k) => ["显存", "显卡", "GPU"].includes(k))),
    );
  },
};
const state = {
  formatForPrompt(st) {
    const rows = (st && st.entries ? st.entries : [])
      .slice(0, 12)
      .map((e) => `- ${e.key}：${e.value}`)
      .filter((l) => l.length > 4);
    return rows.length ? ["当前世界状态（示例宿主提供）：", ...rows].join("\n") : "";
  },
};

const connection = engine.connect({
  id: HOST.id,
  name: HOST.name,
  kind: HOST.kind,
  version: HOST.version,
  meta: HOST.meta,
  provides: { lore, state },
});

/* ---- 2. 订阅 → 转发 ---- */

function post(path, body) {
  const payload = JSON.stringify(body);
  const url = new URL(path, BASE);
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  };
  if (API_KEY) {
    headers.authorization = `Bearer ${API_KEY}`;
    headers["x-api-key"] = API_KEY;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.setTimeout(15_000, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

let failStreak = 0;

telemetry.subscribe((turn) => {
  // TurnRecord 已经是可直接序列化的结构，整条转发即可。
  // 失败只按间隔提示：面板服务没起时不要每轮刷一条错误。
  post("/api/turn", { ...turn, hostName: HOST.name, kind: HOST.kind })
    .then(() => {
      if (failStreak > 0) {
        failStreak = 0;
        console.log("上报已恢复。");
      }
    })
    .catch((e) => {
      failStreak += 1;
      if (failStreak === 1 || failStreak % 20 === 0) {
        console.error(`上报失败（连续 ${failStreak} 次，面板服务未启动？）:`, e.message);
      }
    });
});

// 接入协议已经把身份 + 提供的端口登记到引擎遥测；这里把归属信息同步给面板。
post("/api/host", { ...HOST, provides: connection.wired }).catch(() => {});

/* ---- 3. 正常业务：一个不断增长的对白 ---- */

const dialogue = [{ id: "g0", role: "assistant", content: "示例服务已就绪。" }];
let n = 0;

/* 世界书：关键词触发的设定资料库。对白里出现「显存」「显卡」才会注入。 */
const WORLD_ENTRIES = [
  {
    id: "w-gpu",
    name: "硬件档案",
    keys: ["显存", "显卡", "GPU"],
    content: "RTX 5070 Laptop 8GB（sm_120），开机空闲显存约 7013 MiB，nvidia-smi 不可用。",
    enabled: true,
    constant: false,
    insertionOrder: 0,
  },
  {
    id: "w-never",
    name: "永不触发",
    keys: ["绝对不出现的关键词"],
    content: "这条不该被注入。",
    enabled: true,
    constant: false,
    insertionOrder: 1,
  },
];

function tick() {
  n += 1;
  dialogue.push({ id: `u${n}`, role: "user", content: `第 ${n} 次请回答：当前显存占用多少？` });
  dialogue.push({ id: `a${n}`, role: "assistant", content: `第 ${n} 次回答：先跑一次对照再下结论。` });
  if (dialogue.length > 30) dialogue.splice(0, dialogue.length - 30);

  const r = engine.prepare({
    card: { name: "阿铁", description: "住在机房里的技术搭子", personality: "直接" },
    dialogue,
    pairBatchSize: 2,
    contextTokenLimit: 4096,
    tokenCounter: S.exactCharTokenCounter(),
    cacheScope: HOST.id,
    // 世界书条目（上面定义的两条）
    loreEntries: WORLD_ENTRIES,
    // 结构化世界状态 → 「当前世界状态」段落
    worldState: { entries: [{ key: "地点", value: "深夜的机房" }, { key: "任务", value: "压测本地推理" }] },
    // 用户人设 → 「用户人设」段落
    personaBio: "中文交流，说话简短偏技术，讨厌罐头答案。",
  });

  console.log(
    `#${n} ${r.mode} tokens=${r.promptTokens} 待压=${r.memory.pendingPairs} 触发=${r.memory.compressReason ?? "-"} `
      + `知识=${r.loreInjected.map((e) => e.name).join("/") || "无"} 告警=${r.warnings.length}`,
  );
}

console.log(`外部接入示例：${HOST.name} (${HOST.id}) → ${BASE}，每 ${EVERY}ms 一轮`);
tick();
setInterval(tick, EVERY);
