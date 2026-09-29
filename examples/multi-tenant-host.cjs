/**
 * 参考宿主（G-28）：一个 engine 服务多个租户（用户）。
 *
 * 运行：
 *   node examples/multi-tenant-host.cjs
 *
 * 这个示例要让人看懂两件事：
 *   1. 一个 engine 实例同时服务多个租户是**设计内的用法**，隔离靠「cacheScope +
 *      每租户自己的 dialogue / 记忆 + 每租户自己的入参」，而不是靠多开进程；
 *   2. forHost() 得到的句柄要**长期持有**，它不是会话容器，也不该每轮新建。
 *
 * 两个高频坑（本示例都实测并断言）
 * ---------------------------------
 * 坑 A：跨租户缓存串味。
 *   组装缓存按 `cacheScope` 分区。两个租户若共用同一个 cacheScope 且内容足够像，
 *   就可能命中对方的缓存 → A 的 prompt 里出现 B 的人设/知识。本示例给每个租户
 *   一个唯一标记串，跑完直接断言「A 的 prompt 里不出现 B/C 的标记」。
 *
 * 坑 B：把 forHost 当成"每次请求建一个新句柄"。
 *   forHost 只做两件事：给每轮调用盖上 host 身份戳（遥测归属）+ 登记宿主。
 *   它**不**承载会话状态；会话状态在 cacheScope + 你自己存的 dialogue/记忆里。
 *   每轮新建句柄：轻则产生无谓垃圾对象，重则诱导你给每轮编一个新 host.id，
 *   把遥测的宿主表刷爆（表满会淘汰最久未见的宿主，真实租户反被挤掉）。
 *   正确做法：按租户建一次，放进 Map 长期复用（见下方 handles）。
 *
 * 分词器警告：本示例用 exactCharTokenCounter()（1 字符 ≈ 1 token）仅为了零依赖
 * 可跑；生产必须注入与模型一致的真实分词器。
 */
"use strict";

const {
  CogniStackEngine,
  exactCharTokenCounter,
  createKeywordLoreProvider,
} = require("../dist/index.js");

const counter = exactCharTokenCounter();

const engine = new CogniStackEngine({
  systemRules: "回答简洁、准确。",
  // 引擎级缺省：关键词 lore（各租户再各自传自己的 loreEntries）。
  collaborators: { lore: createKeywordLoreProvider() },
  maxLoreEntries: 4,
});

/* ------------------------------------------------------------------ */
/* 三个租户：各自的人设、对话、记忆、cacheScope                         */
/* ------------------------------------------------------------------ */

function makeTenant(id, name, marker, flavor) {
  return {
    id,
    name,
    marker, // 唯一标记：用来断言"没有串味"
    flavor,
    cacheScope: `chat-${id}`, // 隔离的关键：每个租户独立的组装缓存分区
    card: { name: flavor, description: `运维助手。租户内部标记 ${marker}。` },
    lore: [
      {
        id: `${id}-secret`,
        name: `${flavor}的私有知识`,
        keys: [flavor],
        content: `只有 ${marker} 才该看到的私有知识：${flavor} 的机房在 ${id} 楼层。`,
        enabled: true,
        constant: false,
        insertionOrder: 0,
      },
    ],
    dialogue: [],
    last: null,
  };
}

const TENANTS = [
  makeTenant("tenant-a", "租户 A", "MARKER_A_7f3", "猕猴桃"),
  makeTenant("tenant-b", "租户 B", "MARKER_B_2k9", "火龙果"),
  makeTenant("tenant-c", "租户 C", "MARKER_C_5x1", "杨桃"),
];

// 坑 B 的正确做法：每个租户建一次句柄，长期复用。
// 反例（别这么写）：engine.forHost({...}) 放进每轮循环里新建。
const handles = new Map();
for (const t of TENANTS) {
  handles.set(t.id, engine.forHost({ id: t.id, name: t.name, kind: "service" }));
}

/* ------------------------------------------------------------------ */
/* 交错跑多轮                                                          */
/* ------------------------------------------------------------------ */

const ROUNDS = 6;

function tenantTurn(t, n) {
  const userText = `第${n}轮：${t.flavor}那边还好吗？(${t.marker})`;
  t.dialogue.push({ id: `${t.id}-${n}u`, role: "user", content: userText });
  t.dialogue.push({
    id: `${t.id}-${n}a`,
    role: "assistant",
    content: `第${n}轮：一切正常。`,
  });

  const handle = handles.get(t.id);
  const result = handle.prepare({
    profile: t.card,
    dialogue: t.dialogue,
    summaryBlocks: [], // 本示例不触发摘要（pairBatchSize 大、预算大），专注隔离
    summarizedCount: 0,
    summarizedThroughMessageId: null,
    loreEntries: t.lore,
    pairBatchSize: 20,
    contextTokenLimit: 8192,
    completionReserveTokens: 1024,
    tokenCounter: counter,
    cacheScope: t.cacheScope, // 每个租户独立分区
    label: `${t.name} 第${n}轮`,
  });
  t.last = result;
  return result;
}

console.log("=== 交错调用：每轮依次问候 A / B / C ===");
for (let n = 1; n <= ROUNDS; n += 1) {
  for (const t of TENANTS) {
    const r = tenantTurn(t, n);
    console.log(
      `[${t.id}] round=${n} messages=${r.messages.length} promptTokens=${r.promptTokens}` +
        ` cacheHit=${r.diagnostics.cacheHit}` +
        ` prefix.comparable=${r.prefixStability.comparable}` +
        ` prefix.reuseRatio=${r.prefixStability.reuseRatio.toFixed(3)}` +
        ` midPromptDrift=${r.prefixStability.midPromptDrift}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 断言：跨租户没有串味                                                */
/* ------------------------------------------------------------------ */

let failed = false;
function assert(cond, msg) {
  if (cond) {
    console.log(`[assert-ok] ${msg}`);
  } else {
    console.error(`[assert-FAIL] ${msg}`);
    failed = true;
  }
}

console.log("\n=== 隔离断言：每个租户的 prompt 只能含自己的标记 ===");
for (const t of TENANTS) {
  const messages = t.last.messages;
  const sys = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const whole = messages.map((m) => m.content).join("\n");

  assert(sys.includes(t.marker), `${t.id} 的 system 含自己的标记 ${t.marker}`);
  // 整轮 messages（含对白）也不该出现别的租户标记。
  for (const other of TENANTS) {
    if (other.id === t.id) continue;
    assert(
      !whole.includes(other.marker),
      `${t.id} 的 prompt 不含 ${other.id} 的标记 ${other.marker}`,
    );
  }
}

console.log("\n=== 每租户最后一次装配的关键指标 ===");
for (const t of TENANTS) {
  const r = t.last;
  const ps = r.prefixStability;
  console.log(
    `[${t.id}] cacheScope=${t.cacheScope}` +
      ` promptTokens=${r.promptTokens}` +
      ` blocksUsed=${r.summaryBlocks.length}` +
      ` prefixTokens=${ps.prefixTokens}/${ps.previousTokens}` +
      ` firstDivergenceIndex=${ps.firstDivergenceIndex}` +
      ` midPromptDrift=${ps.midPromptDrift}` +
      ` reuseRatio=${ps.reuseRatio.toFixed(3)}`,
  );
}
console.log(
  "[说明] firstDivergenceIndex=-1 且 reuseRatio≈1 表示「上一轮 prompt 是这一轮的前缀」，" +
    "本地推理的 prefix cache 可整段复用——这正是每个租户独立 cacheScope 才能拿到的收益。",
);

/* ------------------------------------------------------------------ */
/* 端口竞争诊断：谁在生效、谁被压制                                     */
/* ------------------------------------------------------------------ */

/*
 * 端口是「引擎级」的，不是「租户级」的：谁 connect 上某个端口，是全局事件。
 * 所以「租户 A 和租户 B 各接一个同端口提供方」= 一场竞争，priority 小者赢。
 * portDiagnostics() 的 shadowed 列表专门暴露"接上了但没生效"的情况——只看
 * portTable() 是看不出来的。
 *
 * 注意 resolver 的优先级：构造函数里直接注入的 collaborators ＞ connect() ＞ 缺省。
 * 也就是说：即便 portDiagnostics 显示某个 connect 的提供方胜出，如果同端口在构造
 * 函数里也被显式注入过，实际生效的仍是构造函数那一个。本示例用 regex 端口演示，
 * 因为构造函数没有注入 regex（默认 noop 只在两者都缺省时才兜底），诊断与实况一致。
 */
const regexA = { applyMessages: (messages) => messages };
const regexB = { applyMessages: (messages) => messages };
engine.connect({
  id: "tenant-a-regex",
  name: "租户A的正则集",
  kind: "service",
  priority: 10,
  provides: { regex: regexA },
});
engine.connect({
  id: "tenant-b-regex",
  name: "租户B的正则集",
  kind: "service",
  priority: 50,
  provides: { regex: regexB },
});

console.log("\n=== portDiagnostics()：端口归属与压制 ===");
for (const d of engine.portDiagnostics()) {
  const winner = d.winner.providerId
    ? `${d.winner.providerId}@p${d.winner.priority}`
    : d.winner.builtin
      ? `内置(${d.winner.providerName})`
      : (d.winner.providerName ?? "未接入");
  const shadowed = d.shadowed.length
    ? d.shadowed.map((s) => `${s.providerId}@p${s.priority}`).join(", ")
    : "无";
  const mark = d.port === "regex" || d.shadowed.length ? " <-" : "";
  console.log(`  ${d.port.padEnd(7)} bound=${String(d.bound).padEnd(5)} winner=${winner} shadowed=[${shadowed}]${mark}`);
}
console.log(
  "[注意] 关键词 lore 是**构造函数注入**的：生效顺序为「构造注入/ wire() > connect() > 引擎缺省」，" +
    "portDiagnostics() 会把它的 source 报成 \"constructor\"，并把被它压制的 connect 提供方放进 shadowed。" +
    "（本提示曾写「构造函数注入不出现在诊断里」，那是旧行为，已修正。）",
);
const regexDiag = engine.portDiagnostics().find((d) => d.port === "regex");
assert(
  regexDiag?.winner.providerId === "tenant-a-regex" && regexDiag?.shadowed.length === 1,
  "regex 端口：priority=10 的租户A胜出，priority=50 的租户B被压制（shadowed）",
);

console.log(failed ? "\nFAIL multi-tenant-host" : "\nOK multi-tenant-host");
process.exit(failed ? 1 : 0);
