/**
 * HTTP prepare gateway helpers — shared by viz-server / api-server.
 * Zero deps. Server owns the TokenCounter; clients never send one.
 */
"use strict";

function createPrepareGateway(S, opts = {}) {
  const telemetry = opts.telemetry || S.getGlobalTelemetry();
  const lore =
    opts.lore ||
    (opts.keywordLore ? S.createKeywordLoreProvider?.(opts.keywordLore === true ? undefined : opts.keywordLore) : null);
  const engine =
    opts.engine ||
    new S.CogniStackEngine({
      telemetry,
      /*
       * 网关**不给自己登记宿主身份**。
       *
       * 旧版在这里写死 `host: { id: "cognistack-http", name: "CogniStack HTTP API" }`，
       * 而引擎构造时会把 `defaultHost` 注册进遥测 —— 于是控制台的「接入主机」里
       * 常年挂着一条 0 次调用的「CogniStack HTTP API」。它**永远不可能**有调用：
       * 走 HTTP 进来的每一轮都由 buildInput 里的 asHost(body) 盖上调用方的戳
       * （没声明身份时落到 http-client），引擎的 defaultHost 只在 input.host
       * 缺失时才兜底，而这条路径在网关里根本不存在。
       * 一条纯幽灵记录比没有记录更糟：它让人以为有个系统连着，实际什么都没有。
       *
       * `input.host` 缺失时的兜底由引擎自己负责（UNKNOWN_HOST / 未登记调用方），
       * 不需要网关再编一个身份出来。
       */
      systemRules: opts.systemRules || "CogniStack HTTP gateway.",
      collaborators: lore ? { lore } : undefined,
    });

  const defaultCharsPerToken = Number(opts.charsPerToken) > 0 ? Number(opts.charsPerToken) : 0;
  const injectedCounter = opts.tokenCounter || null;

  /*
   * Counter selection.
   *
   * Every branch MUST return a counter with an `id`. That id is the only thing
   * that makes "this host is running on an estimate" visible downstream
   * (`diagnostics.counterId` → telemetry `counter_ids` → console). Measured
   * before the fix: the estimate branch returned a bare `{ count }`, and the
   * HTTP response dropped `counterId` entirely, so a host sending
   * `charsPerToken: 4` got budget arithmetic off by ~4x for Chinese text with
   * nothing anywhere saying the numbers were estimates.
   */
  function heuristicCounter(charsPerToken, suffix = "") {
    const n = charsPerToken;
    return {
      id: `http:chars-per-token(${n})${suffix}`,
      count: (text) => Math.ceil((text ? text.length : 0) / n),
    };
  }

  /**
   * 网关自己产生的「输入契约」错误 —— 这类原因可以如实回给调用方。
   *
   * 与引擎/端口抛出的错误严格区分：那些文本可能来自宿主回调（含内部细节），
   * 一律只留在服务端 stderr 与本地面板的「最近被拒」里。这里的 `expose` 是本模块
   * 自己写的契约说明，不含任何内部实现。
   *
   * 背景：这些错误此前一律被网关折成 `{"error":"invalid request","code":"bad_request"}`，
   * 客户端（例如「测试连接」探针）拿到后无从判断是缺 dialogue、缺 priorTokens 还是别的问题，
   * 而面板上又不留任何痕迹 —— 「测试连接成功但系统里什么都没有」于是无法自查。
   */
  function inputError(message, code = "invalid_request") {
    const err = new Error(message);
    err.code = code;
    err.expose = message;
    return err;
  }

  function pickCounter(body) {
    if (injectedCounter) return injectedCounter;
    const cpt = Number(body?.charsPerToken);
    if (Number.isFinite(cpt) && cpt > 0) {
      return heuristicCounter(cpt, "-heuristic");
    }
    if (defaultCharsPerToken > 0) {
      return heuristicCounter(defaultCharsPerToken, "-heuristic-default");
    }
    // Default: exact char counter (1 char = 1 token). Over-counts CJK rather than
    // under-counting it, which is the safe direction. Production: inject a real
    // tokenizer via createPrepareGateway({ tokenCounter }).
    return S.exactCharTokenCounter();
  }

  /*
   * 调用方没声明身份时的兜底。
   *
   * id 仍是 `http-client` —— 它是遥测里的稳定键，历史 JSONL 与导出的快照都在用它。
   * 但**显示名必须说人话**：旧版让 name 也回落成 id，于是控制台的「接入主机」里
   * 出现一条标题就叫 `http-client` 的记录，谁也不知道那是什么（用户实测时问过）。
   */
  const FALLBACK_HOST_ID = "http-client";
  const FALLBACK_HOST_NAME = "未声明宿主";

  function asHost(body) {
    const h = body?.host && typeof body.host === "object" ? body.host : {};
    const id =
      String(h.id || body.hostId || FALLBACK_HOST_ID).trim().slice(0, 128) || FALLBACK_HOST_ID;
    const declaredName = String(h.name || body.hostName || "").trim().slice(0, 128);
    return {
      id,
      // 声明了 id 但没给 name：用调用方自己选的 id 当名字；连 id 都没声明才用兜底名。
      name: declaredName || (id === FALLBACK_HOST_ID ? FALLBACK_HOST_NAME : id),
      kind: String(h.kind || body.kind || "external").trim().slice(0, 32) || "external",
      version: h.version ? String(h.version).slice(0, 64) : undefined,
      meta: sanitizeMeta(h.meta),
    };
  }

  function sanitizeMeta(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { via: "http" };
    const out = { via: "http" };
    let n = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (n >= 16) break;
      const key = String(k).slice(0, 64);
      if (typeof v === "string") {
        out[key] = v.slice(0, 512);
        n += 1;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        out[key] = v;
        n += 1;
      } else if (typeof v === "boolean") {
        out[key] = v;
        n += 1;
      }
    }
    return out;
  }

  function asDialogue(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 2000).map((m, i) => ({
      id: m && m.id != null ? String(m.id).slice(0, 128) : `m${i}`,
      role: m && (m.role === "assistant" || m.role === "system") ? m.role : "user",
      content: m && m.content != null ? String(m.content).slice(0, 100_000) : "",
    }));
  }

  function asCard(raw) {
    if (!raw || typeof raw !== "object") return { name: "Agent" };
    const ALLOWED = new Set([
      "name",
      "description",
      "personality",
      "scenario",
      "first_mes",
      "mes_example",
      "system_prompt",
      "post_history_instructions",
    ]);
    const out = {
      name: raw.name != null ? String(raw.name).slice(0, 256) : "Agent",
      description: raw.description != null ? String(raw.description).slice(0, 50_000) : undefined,
      personality: raw.personality != null ? String(raw.personality).slice(0, 50_000) : undefined,
      scenario: raw.scenario != null ? String(raw.scenario).slice(0, 50_000) : undefined,
      first_mes: raw.first_mes != null ? String(raw.first_mes).slice(0, 50_000) : undefined,
      mes_example: raw.mes_example != null ? String(raw.mes_example).slice(0, 50_000) : undefined,
      system_prompt: raw.system_prompt != null ? String(raw.system_prompt).slice(0, 50_000) : undefined,
      post_history_instructions:
        raw.post_history_instructions != null
          ? String(raw.post_history_instructions).slice(0, 50_000)
          : undefined,
    };
    // Extra string fields only — never pass through nested objects/arrays.
    let extras = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (ALLOWED.has(k) || typeof v !== "string") continue;
      out[String(k).slice(0, 64)] = v.slice(0, 20_000);
      if (++extras >= 16) break;
    }
    return out;
  }

  function asSummaryBlocks(raw) {
    if (!Array.isArray(raw)) return undefined;
    return raw.slice(0, 200).map((b, i) => {
      if (!b || typeof b !== "object") {
        const text = String(b ?? "").slice(0, 50_000);
        return { id: `b${i}`, text, throughMessageId: "" };
      }
      const text = String(b.text ?? b.content ?? "").slice(0, 50_000);
      const kind = b.kind === "episode" || b.kind === "full" ? b.kind : undefined;
      const pairRaw = Number(b.pairCount);
      return {
        id: b.id != null ? String(b.id).slice(0, 128) : `b${i}`,
        text,
        throughMessageId:
          b.throughMessageId != null ? String(b.throughMessageId).slice(0, 128) : "",
        pairCount: Number.isFinite(pairRaw) ? Math.max(0, Math.floor(pairRaw)) : undefined,
        kind,
        importance:
          typeof b.importance === "number" && Number.isFinite(b.importance)
            ? Math.max(0, Math.min(100, b.importance))
            : undefined,
      };
    });
  }

  function asWorldEntries(raw) {
    if (!Array.isArray(raw)) return undefined;
    return raw.slice(0, 500).map((e, i) => {
      if (!e || typeof e !== "object") {
        return { id: `w${i}`, name: "", content: "", keys: [], enabled: true, constant: false, insertionOrder: i };
      }
      const keys = Array.isArray(e.keys)
        ? e.keys.filter((k) => typeof k === "string").slice(0, 32).map((k) => k.slice(0, 128))
        : [];
      const secondaryKeys = Array.isArray(e.secondaryKeys)
        ? e.secondaryKeys.filter((k) => typeof k === "string").slice(0, 32).map((k) => k.slice(0, 128))
        : undefined;
      const orderRaw = e.insertionOrder ?? e.order;
      const insertionOrder =
        typeof orderRaw === "number" && Number.isFinite(orderRaw) ? orderRaw : i;
      return {
        id: e.id != null ? String(e.id).slice(0, 128) : `w${i}`,
        name: e.name != null ? String(e.name).slice(0, 256) : "",
        content: e.content != null ? String(e.content).slice(0, 20_000) : "",
        keys,
        secondaryKeys,
        enabled: e.enabled !== false,
        constant: Boolean(e.constant),
        position: typeof e.position === "string" ? e.position.slice(0, 64) : undefined,
        depth: typeof e.depth === "number" && Number.isFinite(e.depth) ? e.depth : undefined,
        insertionOrder,
        order: insertionOrder,
        sticky: typeof e.sticky === "number" && Number.isFinite(e.sticky) ? e.sticky : undefined,
        cooldown: typeof e.cooldown === "number" && Number.isFinite(e.cooldown) ? e.cooldown : undefined,
        delay: typeof e.delay === "number" && Number.isFinite(e.delay) ? e.delay : undefined,
      };
    });
  }

  function asVectorHits(raw) {
    if (!Array.isArray(raw)) return undefined;
    return raw.slice(0, 32).map((h) => ({
      name: h && h.name != null ? String(h.name).slice(0, 256) : undefined,
      content: h && h.content != null ? String(h.content).slice(0, 8_000) : "",
      score:
        h && typeof h.score === "number" && Number.isFinite(h.score) ? h.score : undefined,
    }));
  }

  function asMemory(raw) {
    if (!raw || typeof raw !== "object") return undefined;
    const out = {};
    if (raw.summarizedCount != null) out.summarizedCount = Number(raw.summarizedCount) || 0;
    if (raw.summarizedThroughMessageId != null) {
      out.summarizedThroughMessageId = String(raw.summarizedThroughMessageId).slice(0, 128);
    }
    if (raw.pairBatchSize != null) out.pairBatchSize = Number(raw.pairBatchSize) || undefined;
    if (raw.contextTriggerRatio != null) {
      const r = Number(raw.contextTriggerRatio);
      if (Number.isFinite(r)) out.contextTriggerRatio = Math.max(0, Math.min(1, r));
    }
    return out;
  }

  function buildInput(body) {
    if (!body || typeof body !== "object") throw inputError("JSON body required", "invalid_body");
    const dialogue = asDialogue(body.dialogue);
    if (!dialogue.length) {
      throw inputError("dialogue[] required (at least 1 message)", "missing_dialogue");
    }

    const mode = ["generate", "status"].includes(body.mode) ? body.mode : "generate";
    if (mode === "status" && body.priorAssembledPromptTokens == null) {
      throw inputError(
        "mode=status requires priorAssembledPromptTokens (last generate promptTokens)",
        "missing_prior_tokens",
      );
    }
    const profile = asCard(body.profile ?? body.card);
    const input = {
      mode,
      profile,
      card: profile,
      dialogue,
      tokenCounter: pickCounter(body),
      host: asHost(body),
    };

    if (body.summary != null) input.summary = String(body.summary).slice(0, 200_000);
    const blocks = asSummaryBlocks(body.summaryBlocks);
    if (blocks) input.summaryBlocks = blocks;
    if (body.summarizedCount != null) input.summarizedCount = Number(body.summarizedCount) || 0;
    if (body.summarizedThroughMessageId != null) {
      input.summarizedThroughMessageId = String(body.summarizedThroughMessageId).slice(0, 128);
    }
    if (body.pairBatchSize != null) input.pairBatchSize = Number(body.pairBatchSize) || undefined;
    const mem = asMemory(body.memory);
    if (mem) input.memory = mem;

    const world = asWorldEntries(body.loreEntries ?? body.worldEntries);
    if (world) {
      input.loreEntries = world;
      input.worldEntries = world;
    }
    if (body.loreEnabled != null || body.worldBookEnabled != null) {
      const on = Boolean(body.loreEnabled ?? body.worldBookEnabled);
      input.loreEnabled = on;
      input.worldBookEnabled = on;
    }
    if (body.scanText != null) input.scanText = String(body.scanText).slice(0, 100_000);
    if (body.personaBio != null) input.personaBio = String(body.personaBio).slice(0, 50_000);
    if (body.worldState && typeof body.worldState === "object" && !Array.isArray(body.worldState)) {
      const entries = Array.isArray(body.worldState.entries)
        ? body.worldState.entries.slice(0, 64).map((e) => ({
            key: e && e.key != null ? String(e.key).slice(0, 128) : "",
            value: e && e.value != null ? String(e.value).slice(0, 4_000) : "",
          }))
        : [];
      input.worldState = { entries };
    }
    if (body.macros && typeof body.macros === "object" && !Array.isArray(body.macros)) {
      const macros = {};
      for (const [k, v] of Object.entries(body.macros).slice(0, 64)) {
        if (typeof v === "string") macros[String(k).slice(0, 64)] = v.slice(0, 4_000);
      }
      input.macros = macros;
    }
    if (body.contextTokenLimit != null) input.contextTokenLimit = Number(body.contextTokenLimit) || undefined;
    if (body.completionReserveTokens != null) {
      input.completionReserveTokens = Number(body.completionReserveTokens) || undefined;
    }
    if (body.softTrimTokenCap != null) input.softTrimTokenCap = Number(body.softTrimTokenCap);
    if (body.maxContextChars != null) input.maxContextChars = Number(body.maxContextChars) || undefined;
    if (body.cacheScope != null) input.cacheScope = String(body.cacheScope).slice(0, 256);
    if (body.label != null) input.label = String(body.label).slice(0, 128);
    if (body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
      const meta = {};
      let n = 0;
      for (const [k, v] of Object.entries(body.meta)) {
        if (n >= 32) break;
        const key = String(k).slice(0, 64);
        if (typeof v === "string") {
          meta[key] = v.slice(0, 512);
          n += 1;
        } else if (typeof v === "number" && Number.isFinite(v)) {
          meta[key] = v;
          n += 1;
        } else if (typeof v === "boolean") {
          meta[key] = v;
          n += 1;
        }
      }
      if (Object.keys(meta).length) input.meta = meta;
    }
    if (body.budget && typeof body.budget === "object" && !Array.isArray(body.budget)) {
      const b = {};
      for (const k of [
        "safetyPadTokens",
        "softTrimRatio",
        "minPromptShareOfContext",
        "completionReserveTokens",
        "templateOverheadTokens",
      ]) {
        if (body.budget[k] != null && Number.isFinite(Number(body.budget[k]))) {
          b[k] = Number(body.budget[k]);
        }
      }
      if (Object.keys(b).length) input.budget = b;
    }
    if (body.priorAssembledPromptTokens != null) {
      input.priorAssembledPromptTokens = Number(body.priorAssembledPromptTokens) || 0;
    }
    const hits = asVectorHits(body.vectorHits);
    if (hits) input.vectorHits = hits;
    // Drop host-supplied fragments/preset/authorsNote over HTTP — too easy to smuggle
    // deep/unbounded graphs; in-process callers still pass them via the library API.
    void body.fragments;
    void body.preset;
    void body.authorsNote;

    return input;
  }

  async function prepare(body) {
    const input = buildInput(body);
    // prepareLive yields between stages so SSE progress reaches the console
    // before this HTTP response completes (sync prepare blocks the event loop).
    const result =
      typeof engine.prepareLive === "function"
        ? await engine.prepareLive(input)
        : engine.prepare(input);
    // Strip non-serializable / oversized debug noise for wire
    return {
      ok: true,
      engine: result.engine,
      version: result.version,
      mode: result.mode,
      messages: result.messages,
      systemSections: result.systemSections,
      promptTokens: result.promptTokens,
      promptChars: result.promptChars,
      summary: result.summary,
      summaryBlocks: result.summaryBlocks,
      memory: result.memory,
      budget: {
        contextLimit: result.budget?.contextLimit,
        completionReserve: result.budget?.completionReserve,
        softTrimTokenCap: result.budget?.softTrimTokenCap,
        softTrimEnabled: result.budget?.softTrimEnabled,
        hardFit: result.budget?.hardFit,
        safetyPad: result.budget?.safetyPad,
        templateOverhead: result.budget?.templateOverhead,
        warnings: result.budget?.warnings,
      },
      loreInjected: result.loreInjected,
      toSummarize: result.toSummarize,
      toSummarizePairCount: result.toSummarizePairCount,
      nextSummarizedCount: result.nextSummarizedCount,
      nextSummarizedThroughMessageId: result.nextSummarizedThroughMessageId,
      warnings: result.warnings,
      /*
       * Prefix reuse belongs at top level too: a local runtime's prefix cache
       * reads it, and it was previously unreachable over HTTP.
       */
      prefixStability: result.prefixStability,
      /*
       * Forward the engine's diagnostics object whole, instead of re-listing fields.
       *
       * The hand-written allowlist that used to live here silently dropped
       * `prefixStability`, `budgetAttribution` and `memoryAudit` — every new
       * engine field had to be remembered in this file, and forgetting one is
       * invisible (exactly how `counterId` went missing before it was restored).
       * Diagnostics are plain JSON data, so there is nothing to strip here.
       */
      diagnostics: result.diagnostics,
    };
  }

  return { engine, telemetry, prepare, buildInput, asHost, asSummaryBlocks, asWorldEntries };
}

module.exports = { createPrepareGateway };
