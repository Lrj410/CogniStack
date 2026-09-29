/*
 * 控制台版式体检 —— 程序化，可进 CI。
 *
 * 为什么要有这个文件（而不是就职于一次性脚本）：
 *   缩略图会骗人。一个 65px 的徽标被挤到 21px 这类问题，在截图、typecheck、
 *   单测、控制台日志里**都看不出来**。这个脚本把「被裁掉 / 撑破视口 / 命中区过小 /
 *   对比度不足 / chrome 吃掉多少垂直空间」变成数字，于是每次改 CSS 都有回归网。
 *
 * 用法：
 *   node console/tools/qa-layout.cjs                 # 自动灌数据（若为空）+ 全量扫描
 *   node console/tools/qa-layout.cjs --no-seed       # 不灌数据（只验空态）
 *   node console/tools/qa-layout.cjs --url http://127.0.0.1:7331
 *
 * 依赖：playwright-core 来自隔离工作区 + **系统 Edge**（不下载 Chromium）。
 * 退出码：有 FAIL → 1；只有 WARN → 0。
 */
"use strict";

const { createRequire } = require("node:module");

const NODE_WORKSPACE = "C:/Users/18755/.workbuddy/binaries/node/workspace/";
const { chromium } = createRequire(NODE_WORKSPACE)("playwright-core");

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BASE = flag("--url", "http://127.0.0.1:7331").replace(/\/$/, "");
const SEED = !args.includes("--no-seed");

/** 宽度档：产品断点（Tailwind sm/md/lg/xl）±1 + 常用桌面/移动档。 */
const WIDTHS = [1600, 1280, 1279, 1100, 1024, 1023, 768, 640, 639, 430];

/**
 * 两套主题都要扫。
 *
 * 只在暗色下体检会漏掉一整类缺陷：容器背景写死深色、而文字色走主题变量 ——
 * 切到亮色时只有文字跟着翻、背景不翻，于是「浅字压浅底」。
 * 密度同理：紧凑模式改的是内边距与字号，最容易把命中区和截断一起改坏。
 */
const THEMES = ["light", "dark"];
const DENSITIES = ["comfortable", "compact"];

const ROUTES = [
  ["/", "总览"],
  ["/stream", "回合流"],
  ["/hosts", "主机"],
  ["/topology", "拓扑"],
  // 网关是三网隔离工作台：满屏栅格 + 四张表 + 四档视图，密度最高的一页，
  // 之前没进体检表，等于整页没被对比度/溢出/焦点环守着。
  ["/gateway", "网关"],
  ["/playground", "调试台"],
  ["/cluster", "集群"],
  ["/settings", "设置"],
];

/* ------------------------------------------------------------------ */
/* 灌数据：走公开的 /api/turn 通道，不碰任何存储内部结构              */
/* ------------------------------------------------------------------ */

/** 造一轮有梯度的真实记录：不同主机、不同预算压力、不同计数器身份。 */
function turnBody(i) {
  const hostIdx = i % 3;
  const hosts = [
    { id: "web-chat", name: "Web 聊天端", kind: "client", provides: ["card", "macros"] },
    { id: "erp-etl", name: "ERP 夜间 ETL", kind: "worker", provides: ["lore"] },
    { id: "cli-probe", name: "压测探针", kind: "cli", provides: [] },
  ];
  const h = hosts[hostIdx];
  const cap = [4096, 8192, 2048][hostIdx];
  const tokens = Math.min(cap, 300 + ((i * 137) % (cap - 400)));
  const fill = tokens / cap;
  const degraded = i % 11 === 0;
  const drift = i % 7 === 0;
  const softTrimmed = fill > 0.85;
  const badCounter = hostIdx === 1 && i % 5 === 0;
  const warnings = [];
  if (softTrimmed) warnings.push(`prompt-budget-trimmed:${tokens}>${Math.floor(cap * 0.95)}`);
  if (degraded) warnings.push("degraded:assemble-failed:boom-in-collaborator");
  if (i % 13 === 0) warnings.push("memory-lost-protected:【硬事实】:火");
  if (i % 9 === 0) warnings.push("hard-fit-violated:300>288");
  if (i % 17 === 0) warnings.push(`emergency-dialogue-window:dropped-${1 + (i % 3)}`);
  if (i % 6 === 0) warnings.push("lore-capped:24");
  return {
    hostId: h.id,
    hostName: h.name,
    kind: h.kind,
    hostVersion: "0.3.1",
    hostMeta: { region: "cn-east", build: "2026.09" },
    mode: i % 4 === 0 ? "status" : "generate",
    label: ["正常聊天", "回复后记忆规划", "发送前压缩重装", "状态探针"][i % 4],
    meta: { chatId: `c-${1000 + i}`, route: "/v1/chat" },
    cacheScope: `chat-${i % 5}`,
    messages: 12 + (i % 40),
    systemSections: 4 + (i % 6),
    promptTokens: tokens,
    promptChars: tokens * 2,
    loreCount: i % 5,
    vectorHits: i % 3,
    loreInjected: i % 5 ? [{ id: `l${i % 5}`, name: `知识条目 ${i % 5}` }] : [],
    softTrimCap: Math.floor(cap * 0.95),
    hardFit: cap - 260,
    contextLimit: cap,
    completionReserve: 256,
    counter: {
      hits: 200 + (i % 90),
      misses: 20 + (i % 30),
      distinct: 20 + (i % 30),
      evictions: i % 40,
    },
    counterId: badCounter ? "char-exact(test-only)" : "http:tokenize(127.0.0.1:8080)",
    durationMs: 4 + (i % 60) * 0.7,
    timings: {
      budget: 0.3 + (i % 5) * 0.1,
      memoryWindow: 0.2 + (i % 3) * 0.1,
      lore: 0.7 + (i % 4) * 0.2,
      fragments: 0.2,
      assemble: 3.1 + (i % 7) * 0.4,
      account: 1.2,
      trim: fill > 0.85 ? 4.4 : 0.1,
    },
    memory: {
      shouldSummarize: i % 6 === 0,
      compressReason: i % 6 === 0 ? "batch" : fill > 0.9 ? "context" : null,
      pendingPairs: i % 9,
      contextUsed: tokens + 120,
      contextTriggerAt: Math.floor(cap * 0.7),
      watermarkEnd: i * 2,
      summarizedCount: i * 2,
    },
    toSummarizePairCount: i % 6 === 0 ? 4 : 0,
    warnings,
    degraded,
    cacheHit: i % 3 === 0,
    emergencyDropped: i % 17 === 0 ? 1 + (i % 3) : 0,
    softTrimmed,
    steps: [
      "budget.resolve",
      "memory.window",
      "lore.select",
      "assemble",
      "status+slice",
      softTrimmed ? "softTrim" : "",
    ].filter(Boolean),
    ports: ["card", "lore", "macros"],
    budgetTiers: [
      { priority: 100, before: 900, after: softTrimmed ? 700 : 900 },
      { priority: 80, before: 500, after: softTrimmed ? 200 : 500 },
      { priority: 60, before: 300, after: softTrimmed ? 0 : 300 },
    ],
    prefixStability: {
      prefixTokens: 800,
      previousTokens: 1000,
      freshTokens: drift ? 700 : 120,
      reuseRatio: drift ? 0.3 : 0.88,
      firstDivergenceIndex: drift ? 3 : -1,
      midPromptDrift: drift,
    },
    inputSnapshot: null,
  };
}

/*
 * 灌数据必须**自己限速**。
 *
 * 服务端有按 IP 的固定窗口限流（默认 30 次/秒，见 viz-server 的 RATE_LIMIT_PER_SEC）。
 * 一口气 POST 46 轮会当场把这一秒的额度用光，紧接着第一格体检的 `/api/snapshot` 就吃到
 * 429 —— 而 429 在浏览器里是一条 console error，体检把它记成「页面异常」。
 * 实测：会灌数据的那一轮 FAIL 18，跳过的下一轮 FAIL 0。**那是体检在打自己**，
 * 不是控制台的缺陷。所以这里每 20 条歇 1 秒，把速率压在窗口之下。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(n = 46) {
  let ok = 0;
  for (let i = 1; i <= n; i += 1) {
    if (i > 1 && (i - 1) % 20 === 0) await sleep(1000);
    const res = await fetch(`${BASE}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turnBody(i)),
    });
    if (res.ok) ok += 1;
  }
  // 端口诊断也灌一份，否则拓扑页永远停在"粗略视图"
  await fetch(`${BASE}/api/ports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostId: "web-chat",
      hostName: "Web 聊天端",
      ports: [
        { port: "card", bound: true, source: "constructor", winner: { providerId: null, providerName: "构造注入 / wire()", priority: null, builtin: false }, shadowed: [] },
        { port: "macros", bound: true, source: "connection", winner: { providerId: "kw", providerName: "关键词宏", priority: 100, builtin: false }, shadowed: [{ providerId: "loser", providerName: "被压制的宏提供方", priority: 100 }] },
        { port: "lore", bound: true, source: "connection", winner: { providerId: "kw2", providerName: "关键词知识条目", priority: 100, builtin: false }, shadowed: [] },
        { port: "vector", bound: false, source: "builtin", winner: { providerId: null, providerName: "引擎内置", priority: null, builtin: true }, shadowed: [] },
      ],
    }),
  });
  return ok;
}

/* ------------------------------------------------------------------ */
/* 页内体检                                                            */
/* ------------------------------------------------------------------ */

/** 在页面里跑的检查；返回结构化结果。写成字符串以避免闭包序列化问题。 */
const PAGE_CHECKS = () => {
  const out = {
    docOverflow: 0,
    overflow: [],
    clipped: [],
    small: [],
    contrast: [],
    density: null,
    errors: [],
  };
  out.docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;

  const describe = (el) => {
    const cls = String(el.className || "").slice(0, 60);
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls.split(/\s+/).slice(0, 2).join(".") : ""}${txt ? ` "${txt}"` : ""}`;
  };

  /* ---- 遍历：裁切 / 撑破 / 命中区 ------------------------------------ */
  for (const el of document.querySelectorAll("body *")) {
    // SVG <text> 没有 CSS 盒模型，比较 scrollWidth 会把每个刻度误报成裁切
    if (el instanceof SVGElement) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    const scrollable = cs.overflowX === "auto" || cs.overflowX === "scroll";
    if (!scrollable && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
      const intentional = cs.textOverflow === "ellipsis" || cs.whiteSpace === "nowrap";
      const hasTitle = Boolean(el.getAttribute("title") ?? el.querySelector("[title]"));
      const rec = {
        el: describe(el),
        lost: el.scrollWidth - el.clientWidth,
        hasTitle,
      };
      if (intentional) out.clipped.push(rec);
      else out.overflow.push(rec);
    }

    if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) {
      if (r.height < 20 || r.width < 20) {
        out.small.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
  }

  /* ---- 对比度：走祖先链找不透明底色 --------------------------------- */
  /*
   * 颜色解析必须认全现代格式。
   *
   * `color-mix()` 的计算结果是 `oklab(...)` / `color(srgb ...)`，**不是** rgb() ——
   * 只认 rgba() 时解析返回 null，就取祖先底色当底，于是深色段落上的深色文字
   * 被误报成 1.04:1（实测 108 个假 FAIL，全是这么来的）。
   */
  const parse = (c) => {
    const rgba = c.match(/rgba?\(([^)]+)\)/);
    if (rgba) {
      const p = rgba[1].split(",").map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    }
    // color(srgb r g b [/ a]) —— sRGB 分量是 0..1 的伽马编码值
    const cs = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
    if (cs) {
      return {
        r: parseFloat(cs[1]) * 255,
        g: parseFloat(cs[2]) * 255,
        b: parseFloat(cs[3]) * 255,
        a: cs[4] === undefined ? 1 : parseFloat(cs[4]),
      };
    }
    // oklab(L a b [/ a]) → 线性 sRGB → gamma
    const ok = c.match(/oklab\(([\d.-]+)%?\s+([\d.-]+)\s+([\d.-]+)(?:\s*\/\s*([\d.]+))?\)/);
    if (ok) {
      const L = parseFloat(ok[1]);
      const A = parseFloat(ok[2]);
      const B = parseFloat(ok[3]);
      const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
      const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
      const s_ = L - 0.0894841775 * A - 1.291485548 * B;
      const l = l_ * l_ * l_;
      const m = m_ * m_ * m_;
      const sb = s_ * s_ * s_;
      /*
       * LMS -> 线性 sRGB 的标准矩阵（Björn Ottosson）。
       * 第一版漏了这一步，把 LMS 立方体直接当线性 RGB —— 颜色全错，
       * 对比度全变成 1~2:1 的假 FAIL（oklab 是 color-mix 的计算结果格式）。
       */
      const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sb;
      const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sb;
      const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sb;
      const gam = (v) => {
        const x = Math.min(1, Math.max(0, v));
        return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
      };
      return {
        r: gam(rLin) * 255,
        g: gam(gLin) * 255,
        b: gam(bLin) * 255,
        a: ok[4] === undefined ? 1 : parseFloat(ok[4]),
      };
    }
    return null;
  };
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const bgOf = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c && c.a >= 0.95) return c;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const seenText = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (el instanceof SVGElement) continue;
    // 只看直接承载文本的叶子节点，避免父节点重复计
    const direct = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
    );
    if (!direct) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a < 0.9) continue;
    const bg = bgOf(el);
    const cr = ratio(fg, bg);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need) {
      const key = `${cs.color}|${Math.round(size)}|${describe(el)}`;
      if (seenText.has(key)) continue;
      seenText.add(key);
      out.contrast.push({
        el: describe(el),
        ratio: Number(cr.toFixed(2)),
        need,
        size: Math.round(size),
      });
    }
  }

  /* ---- 焦点圈：CSS 里写了 :focus-visible 不等于真能看见 -------------- */
  out.focusBad = [];
  const focusables = Array.from(
    document.querySelectorAll(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).slice(0, 24);
  for (const el of focusables) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    el.focus();
    const cs = getComputedStyle(el);
    const visible =
      cs.outlineStyle !== "none" &&
      parseFloat(cs.outlineWidth) > 0 &&
      cs.outlineColor !== "transparent";
    if (!visible) {
      out.focusBad.push(
        `${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 40)} "${(el.textContent || "").trim().slice(0, 18)}"`,
      );
    }
    el.blur();
  }

  /* ---- 密度：chrome 吃掉多少垂直空间 --------------------------------- */
  const h = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { h: Math.round(r.height), top: Math.round(r.top) };
  };
  const main = document.querySelector("main");
  const mainR = main ? main.getBoundingClientRect() : null;
  const rows = document.querySelectorAll("table.ledger tbody tr").length;
  /* ---- 降级动效：不能只在 CSS 里写，要实测计算样式 ------------------ */
  out.reducedMotion = {
    stageChild: document.querySelector(".stage > *")
      ? getComputedStyle(document.querySelector(".stage > *")).animationName
      : null,
    railDash: document.querySelector(".rail-dash")
      ? getComputedStyle(document.querySelector(".rail-dash")).animationName
      : null,
  };

  out.density = {
    vh: window.innerHeight,
    header: h("header"),
    annunciator: h('section[aria-label="告警指示灯"]'),
    pipeline: h('section[aria-label="装配流水线"]'),
    mainTop: mainR ? Math.round(mainR.top) : null,
    mainH: mainR ? Math.round(mainR.height) : null,
    chromePct: mainR ? Number((((mainR.top) / window.innerHeight) * 100).toFixed(1)) : null,
    ledgerRows: rows,
  };

  return out;
};

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  // 1. 服务前置探活：避免未起服时抛出 uncaughtException 难懂的堆栈
  try {
    const probe = await fetch(`${BASE}/api/snapshot`, { signal: AbortSignal.timeout(2500) });
    if (!probe.ok && probe.status !== 401 && probe.status !== 403) {
      console.error(`\n[qa-layout] 服务响应异常 (${probe.status})，请检查服务状态。`);
      process.exit(1);
    }
  } catch {
    console.error(`\n[qa-layout] 控制台服务未运行 (无法连接到 ${BASE})。`);
    console.error(`请先在另一终端启动服务，例如:`);
    console.error(`  npm run start:prod   # 生产样式单端口服务`);
    console.error(`  或 node tools/viz-server.cjs`);
    console.error(`启动后重新运行此体检。\n`);
    process.exit(1);
  }

  const browser = await chromium.launch({ channel: "msedge", headless: true });

  if (SEED) {
    const snap = await (await fetch(`${BASE}/api/snapshot`)).json();
    if (snap.totalTurns < 20) {
      const n = await seed(46);
      console.log(`已灌入 ${n}/46 轮真实梯度的遥测数据 + 一份端口诊断`);
      // 等限流窗口翻页：否则第一格体检会替刚才那波灌数据吃 429（见 seed 的注释）
      await sleep(1100);
    } else {
      console.log(`遥测已有 ${snap.totalTurns} 轮，跳过灌数据`);
    }
  }

  const fails = [];
  const warns = [];
  const lines = [];

  /*
   * 降级动效专项：CSS 里写了 `animation: none` 不等于它真的生效
   * （被更靠后的规则覆盖、被删掉、选择器写错都会静默失效）。
   * 用 emulateMedia 打开 reduce，读计算样式断言。
   */
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await ctx.addInitScript(() => {
      localStorage.setItem("cs-theme", "light");
      localStorage.setItem("cs-density", "comfortable");
    });
    const page = await ctx.newPage();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 15000 });
    const rm = await page.evaluate(PAGE_CHECKS);
    if (rm.reducedMotion.stageChild && rm.reducedMotion.stageChild !== "none") {
      fails.push(`reduced-motion · .stage > * 仍在播动画（${rm.reducedMotion.stageChild}）`);
    }
    if (rm.reducedMotion.railDash && rm.reducedMotion.railDash !== "none") {
      fails.push(`reduced-motion · .rail-dash 仍在播动画（${rm.reducedMotion.railDash}）`);
    }
    lines.unshift(
      `  reduced-motion 实测：.stage>* = ${rm.reducedMotion.stageChild} · .rail-dash = ${
        rm.reducedMotion.railDash ?? "（无此元素）"
      }`,
    );
    await page.close();
    await ctx.close();
  }

  // 密度档只在 1600 跑一遍：它改的是内边距/字号，不是断点行为
  const matrix = [];
  for (const theme of THEMES) {
    for (const density of DENSITIES) {
      for (const width of WIDTHS) {
        // 紧凑档跑两端：1600（桌面主场景）与 430（紧凑×窄屏最容易打架的地方）
        if (density === "compact" && width !== 1600 && width !== 430) continue;
        matrix.push({ theme, density, width });
      }
    }
  }

  for (const { theme, density, width } of matrix) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
    });
    // 在应用启动前写 localStorage，否则 readInitial 已经跑过了
    await ctx.addInitScript(
      ([t, d]) => {
        localStorage.setItem("cs-theme", t);
        localStorage.setItem("cs-density", d);
      },
      [theme, density],
    );
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => {
      const s = String(e).slice(0, 160);
      if (/ERR_NO_BUFFER_SPACE|ERR_ABORTED/i.test(s)) return;
      pageErrors.push(s);
    });
    page.on("console", (m) => {
      if (m.type() === "error") {
        const t = m.text().slice(0, 160);
        if (/ERR_NO_BUFFER_SPACE|ERR_ABORTED|Failed to load resource: net::ERR_/i.test(t)) return;
        pageErrors.push(`console: ${t}`);
      }
    });

    for (const [route, label] of ROUTES) {
      pageErrors.length = 0;
      await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
      // 等真实元素出现，不用固定 sleep（固定 sleep 会在应用变慢时静默跳过整段检查）
      await page.waitForSelector("main", { timeout: 15000 });
      await page.waitForTimeout(220); // 只用于让错峰入场动画落到终态

      const r = await page.evaluate(PAGE_CHECKS);
      const tag = `${theme}/${density} ${width}px ${label}`;

      if (r.docOverflow > 0) {
        fails.push(`${tag} · 文档横向溢出 ${r.docOverflow}px`);
      }
      if (r.overflow.length) {
        for (const o of r.overflow.slice(0, 4)) {
          fails.push(`${tag} · 内容被裁 ${o.lost}px：${o.el}`);
        }
      }
      for (const c of r.clipped) {
        const note = c.hasTitle ? "" : "（无 title，读不到全串）";
        warns.push(`${tag} · 省略号截断 ${c.lost}px${note}：${c.el}`);
      }
      for (const s of r.small) {
        warns.push(`${tag} · 命中区过小 ${s.w}×${s.h}：${s.el}`);
      }
      for (const c of r.contrast) {
        fails.push(`${tag} · 对比度 ${c.ratio}:1（需 ${c.need}）${c.size}px：${c.el}`);
      }
      for (const e of pageErrors) {
        fails.push(`${tag} · 页面异常：${e}`);
      }
      for (const f of r.focusBad ?? []) {
        fails.push(`${tag} · 焦点圈不可见：${f}`);
      }

      if (width === 1600 && theme === "light") {
        lines.push(
          `  ${density === "compact" ? "紧凑" : "舒适"} ${label.padEnd(5)} chrome ${String(r.density.chromePct).padStart(4)}% · ` +
            `main ${String(r.density.mainH).padStart(4)}px · ` +
            `流水线 ${String(r.density.pipeline?.h ?? "—").padStart(3)}px · ` +
            `告警排 ${String(r.density.annunciator?.h ?? "—").padStart(3)}px · ` +
            `账本行 ${r.density.ledgerRows}`,
        );
      }
    }
    await page.close();
    await ctx.close();
  }

  await browser.close();

  console.log("\n--- 1600px 下的垂直空间账（密度）---");
  console.log(lines.join("\n"));

  const uniq = (arr) => [...new Set(arr)];
  const allWarn = uniq(warns);
  /*
   * WARN 要**分组**，不能一锅端。
   * 「有意截断且有 title」是设计决定（读得到全串），把它和「命中区过小」「截断却读不到全串」
   * 混在一张清单里，真问题会被淹掉 —— 技能里明确写过这条。
   */
  const actionable = allWarn.filter((w) => w.includes("无 title") || w.includes("命中区过小"));
  const cosmetic = allWarn.filter((w) => !actionable.includes(w));

  console.log(`\n--- 结果 ---`);
  console.log(`FAIL ${fails.length} · WARN ${allWarn.length}（可处理 ${actionable.length} · 有意截断 ${cosmetic.length}）`);
  if (fails.length) {
    console.log("\nFAIL（必须修）:");
    for (const f of uniq(fails)) console.log("  ✗ " + f);
  }
  if (actionable.length) {
    console.log("\nWARN·可处理（截断却读不到全串 / 命中区 < 20px）:");
    for (const w of actionable) console.log("  ! " + w);
  }
  if (cosmetic.length) {
    console.log(`\nWARN·有意截断 ${cosmetic.length} 条（元素自带 title，悬停可读全串），按页面归类：`);
    const byPage = new Map();
    for (const w of cosmetic) {
      const page = w.split("·").slice(-1)[0].trim();
      byPage.set(page, (byPage.get(page) ?? 0) + 1);
    }
    for (const [k, v] of [...byPage.entries()].sort((a, z) => z[1] - a[1])) {
      console.log(`    ${String(v).padStart(3)} 次  ${k}`);
    }
  }
  process.exit(fails.length ? 1 : 0);
})();
