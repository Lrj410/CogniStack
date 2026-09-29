/*
 * `/api/turn` 载荷映射器 —— 扁平 HTTP body → `telemetry.record()` 的输入。
 *
 * 为什么单独成模块：这批字段此前直接手写在 `viz-server.cjs` 的 handler 里，
 * 而同一个概念还要在 `src/telemetry.ts` 的 `record()` 与 `console/src/lib/types.ts`
 * 各维护一遍 —— **没有任何机制保证三处对齐**。实测代价：`counterId` /
 * `prefixStability` / `budgetTiers` 曾在网关侧被静默丢弃，宿主上报了、控制台永远看不到。
 *
 * 现在清单即实现：`FIELD_READERS` 的键**就是**覆盖面，`COVERED_KEYS` 由它导出；
 * `test/turn-map.test.cjs` 拿它与 `telemetry.TELEMETRY_RECORD_INPUT_KEYS` 求差集，
 * 差集非空即失败。新增字段时，读者表与引擎侧清单必须同时更新。
 */

/** 与 viz-server 同口径的取值辅助（原样搬自该文件，行为不得改变）。 */
function str(v, max = 128, fallback = "") {
  if (typeof v !== "string") return fallback;
  const t = v.trim();
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

function num(v, { min = 0, max = 1e9, fallback = 0 } = {}) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function strList(v, allowed, max = 32) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x !== "string" || !x) continue;
    if (allowed && !allowed.has(x)) continue;
    out.push(x.slice(0, 64));
    if (out.length >= max) break;
  }
  return out;
}

/** 只留 string/number/boolean，键 ≤64 / 字符串值 ≤512，最多 32 条。 */
function cleanMeta(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => ["string", "number", "boolean"].includes(typeof x))
      .slice(0, 32)
      .map(([k, x]) => [String(k).slice(0, 64), typeof x === "string" ? x.slice(0, 512) : x]),
  );
}

/** 数字型 timings（键 ≤64，最多 32 条）。 */
function cleanTimings(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => Number.isFinite(Number(x)))
      .slice(0, 32)
      .map(([k, x]) => [String(k).slice(0, 64), Number(x)]),
  );
}

/** 有限数字，否则回落（用于 -1 这类哨兵值）。 */
function finiteOr(v, fallback) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

/**
 * 字段 → 读取器。键集必须与 `TelemetryRecordInput` 一致（测试守着）。
 *
 * 约定：返回 `undefined` 表示"本轮没有这个字段"，映射结果里会被省略；
 * 返回具体值（含 `0` / `[]` / `{}`）表示"总是带"——与改造前的行为一致。
 */
function readers(knownPorts) {
  return {
    host: (b) => ({
      id: str(b?.hostId, 128),
      name: str(b?.hostName, 128, str(b?.hostId, 128)),
      kind: str(b?.kind, 32, "external"),
      version: str(b?.hostVersion, 64) || undefined,
      meta: cleanMeta(b?.hostMeta),
    }),
    // Enum-clamped：任意字符串会落进 TurnRecord.mode（类型是 PrepareMode），
    // 污染控制台的分组。
    mode: (b) => (b?.mode === "status" ? "status" : "generate"),
    label: (b) => str(b?.label, 128) || undefined,
    meta: (b) => cleanMeta(b?.meta),
    cacheScope: (b) => str(b?.cacheScope, 256) || undefined,
    messages: (b) => num(b?.messages),
    systemSections: (b) => num(b?.systemSections),
    promptTokens: (b) => num(b?.promptTokens),
    promptChars: (b) => num(b?.promptChars),
    loreCount: (b) => num(b?.loreCount),
    vectorHits: (b) => num(b?.vectorHits),
    loreInjected: (b) =>
      Array.isArray(b?.loreInjected)
        ? b.loreInjected.slice(0, 32).map((e) => ({
            id: str(e?.id, 128),
            name: str(e?.name, 128),
          }))
        : undefined,
    budget: (b) => {
      const softTrimCap = num(b?.softTrimCap);
      return {
        policy: {},
        basePolicy: {},
        contextLimit: num(b?.contextLimit),
        completionReserve: num(b?.completionReserve),
        safetyPad: 64,
        hardFit: num(b?.hardFit, { fallback: softTrimCap }),
        softTrimTokenCap: softTrimCap,
        softTrimEnabled: softTrimCap > 0,
        warnings: [],
      };
    },
    memory: (b) => ({
      shouldSummarize: Boolean(b?.memory?.shouldSummarize),
      compressReason: b?.memory?.compressReason ?? null,
      pendingPairs: num(b?.memory?.pendingPairs),
      contextUsed: num(b?.memory?.contextUsed),
      contextTriggerAt: num(b?.memory?.contextTriggerAt),
      watermarkEnd: finiteOr(b?.memory?.watermarkEnd, -1),
      summarizedCount: num(b?.memory?.summarizedCount),
    }),
    toSummarizePairCount: (b) => num(b?.toSummarizePairCount),
    warnings: (b) =>
      Array.isArray(b?.warnings)
        ? b.warnings.filter((w) => typeof w === "string").slice(0, 64).map((w) => w.slice(0, 512))
        : [],
    degraded: (b) => Boolean(b?.degraded),
    cacheHit: (b) => Boolean(b?.cacheHit),
    emergencyDropped: (b) => num(b?.emergencyDropped),
    softTrimmed: (b) => Boolean(b?.softTrimmed),
    steps: (b) =>
      Array.isArray(b?.steps)
        ? b.steps.filter((s) => typeof s === "string").slice(0, 64).map((s) => s.slice(0, 128))
        : undefined,
    durationMs: (b) => num(b?.durationMs),
    timings: (b) => cleanTimings(b?.timings),
    counter: (b) => ({
      hits: num(b?.counter?.hits),
      misses: num(b?.counter?.misses),
      distinct: num(b?.counter?.distinct),
      evictions: num(b?.counter?.evictions),
    }),
    /*
     * 下面三个是"引擎能算、但只有宿主知道"的那部分。漏掉任何一个，跨进程宿主的
     * 回合在控制台上就永远显示"没有这项数据" —— 面板看着正常，其实少了一整块。
     */
    counterId: (b) => str(b?.counterId, 96) || undefined,
    prefixStability: (b) =>
      b?.prefixStability
        ? {
            prefixTokens: num(b.prefixStability.prefixTokens),
            previousTokens: num(b.prefixStability.previousTokens),
            freshTokens: num(b.prefixStability.freshTokens),
            reuseRatio: num(b.prefixStability.reuseRatio),
            firstDivergenceIndex: finiteOr(b.prefixStability.firstDivergenceIndex, -1),
            midPromptDrift: b.prefixStability.midPromptDrift === true,
          }
        : undefined,
    budgetTiers: (b) =>
      Array.isArray(b?.budgetTiers)
        ? b.budgetTiers.slice(0, 32).map((t) => ({
            priority: num(t?.priority),
            before: num(t?.before),
            after: num(t?.after),
          }))
        : undefined,
    // 仅显式开启 captureInputs 的宿主机发送；telemetry 自己再做体积上限。
    // 注意它包含对话正文。
    inputSnapshot: (b) => b?.inputSnapshot,
    ports: (b) => strList(b?.ports, knownPorts),
  };
}

/**
 * 扁平 body → `telemetry.record()` 输入。
 *
 * `knownPorts` 是可选的白名单 Set（网关侧用 KNOWN_PORTS 过滤未知端口名）。
 */
function mapTurnPayload(body, opts = {}) {
  const table = readers(opts.knownPorts);
  const out = {};
  for (const [key, read] of Object.entries(table)) {
    const value = read(body);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 覆盖面 = 读者表的键。任何对齐检查都应该用它，而不是另抄一份清单。 */
const COVERED_KEYS = Object.freeze(Object.keys(readers(undefined)));

module.exports = { mapTurnPayload, COVERED_KEYS };