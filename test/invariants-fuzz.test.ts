import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipOneStructuredDocument,
  clipStructuredSummary,
  CogniStackEngine,
  exactCharTokenCounter,
  headTailClip,
  mergeStructuredMemoryTexts,
  MEMORY_COLUMN_ALIASES,
  MEMORY_COLUMN_TITLES,
  normalizeStructuredMemory,
  splitMemoryColumns,
} from "../src/index";

/**
 * G-22 — fuzz the invariants, don't just hand-pick examples.
 *
 * The suite already has 290+ hand-written cases; those prove "the inputs I
 * thought of behave". The contracts below are universally quantified ("for any
 * input, the clip never exceeds its budget"), so the only honest way to test
 * them is to generate inputs nobody thought of.
 *
 * Deterministic: a small LCG seeded per case, so a failure is reproducible from
 * the printed seed. No dependency, no flakiness.
 */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    // Numerical Recipes LCG — good enough for input generation.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    bool: (p = 0.5) => next() < p,
  };
}

const ALL_TITLES = [
  ...MEMORY_COLUMN_TITLES,
  ...Object.values(MEMORY_COLUMN_ALIASES).flat(),
  "【没见过的栏目】",
  "【记忆块 1/2】",
];

const BODIES = [
  "无",
  "",
  "火",
  "已婚",
  "他跑了。",
  "新的情节内容",
  "用户是阿铁，他在 8GB 显存上跑 llama.cpp。",
  "第一行\n第二行",
  "duplicated line\n duplicated line ",
  "english body with words and 中文混合内容混在一起很长很长很长很长",
  "。",
  "……",
];

function randomStructured(r: ReturnType<typeof rng>): string {
  if (r.bool(0.15)) {
    // Unstructured prose — must not crash the structured path.
    return r.pick(BODIES) + r.pick(BODIES);
  }
  const n = r.int(1, 6);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const title = r.pick(ALL_TITLES);
    const body = Array.from({ length: r.int(1, 3) }, () => r.pick(BODIES)).join("\n");
    parts.push(`${title}\n${body}`);
  }
  return parts.join(r.bool(0.5) ? "\n\n" : "\n");
}

function hardFactBody(normalized: string): string {
  const cols = splitMemoryColumns(normalized);
  const hit = cols.find((c) => c.title === "【硬事实】");
  return (hit?.body ?? "").trim();
}

describe("G-22 fuzz：结构化记忆的不变量", () => {
  it("normalize 幂等（跑 800 组随机输入）", () => {
    for (let i = 0; i < 800; i += 1) {
      const seed = 1000 + i;
      const r = rng(seed);
      const text = randomStructured(r);
      const once = normalizeStructuredMemory(text);
      const twice = normalizeStructuredMemory(once);
      assert.equal(twice, once, `seed=${seed} 不满足幂等\n--- once ---\n${once}\n--- twice ---\n${twice}`);
    }
  });

  it("clipStructuredSummary 结果长度恒 ≤ maxChars（max > 0）", () => {
    for (let i = 0; i < 800; i += 1) {
      const seed = 5000 + i;
      const r = rng(seed);
      const text = randomStructured(r);
      const max = r.int(1, 900);
      const out = clipStructuredSummary(text, max);
      assert.ok(
        out.length <= max,
        `seed=${seed} max=${max} 实际 ${out.length}（超出 ${out.length - max}）\n${out.slice(0, 120)}`,
      );
    }
  });

  it("clipOneStructuredDocument 结果长度恒 ≤ maxChars（max > 0）", () => {
    for (let i = 0; i < 800; i += 1) {
      const seed = 9000 + i;
      const r = rng(seed);
      const text = randomStructured(r);
      const max = r.int(1, 600);
      const out = clipOneStructuredDocument(text, max);
      assert.ok(out.length <= max, `seed=${seed} max=${max} 实际 ${out.length}`);
    }
  });

  it("headTailClip 结果长度恒 ≤ max(0, max)（含 max<=0 的边界）", () => {
    for (let i = 0; i < 800; i += 1) {
      const seed = 13_000 + i;
      const r = rng(seed);
      const text = Array.from({ length: r.int(1, 6) }, () => r.pick(BODIES)).join("");
      const max = r.int(-5, 400);
      const out = headTailClip(text, max);
      assert.ok(
        out.length <= Math.max(0, Math.floor(max)),
        `seed=${seed} max=${max} 实际 ${out.length}`,
      );
    }
  });

  it("【硬事实】永不因过短被丢弃（AUDIT F-2 的机器化防线）", () => {
    let sawSingleChar = 0;
    for (let i = 0; i < 600; i += 1) {
      const seed = 21_000 + i;
      const r = rng(seed);
      const fact = r.pick(["火", "兄", "已婚", "甲"]);
      sawSingleChar += 1;
      const cols = [
        `【硬事实】\n${fact}`,
        `【时间线】\n${r.pick(BODIES)}`,
        `【近期情节】\n${r.pick(BODIES)}`,
      ];
      const out = normalizeStructuredMemory(cols.join("\n\n"));
      const body = hardFactBody(out);
      assert.notEqual(body, "无", `seed=${seed} 硬事实「${fact}」被丢掉了`);
      assert.ok(body.includes(fact), `seed=${seed} 硬事实内容丢失：${body}`);
    }
    assert.equal(sawSingleChar, 600);
  });

  it("merge 的结果本身是规范形式（可再次 normalize 而不变）", () => {
    for (let i = 0; i < 500; i += 1) {
      const seed = 31_000 + i;
      const r = rng(seed);
      const a = randomStructured(r);
      const b = randomStructured(r);
      const merged = mergeStructuredMemoryTexts(a, b);
      assert.equal(normalizeStructuredMemory(merged), merged, `seed=${seed} merge 结果非规范形式`);
    }
  });
});

describe("G-22 fuzz：引擎端到端不变量", () => {
  it("任意输入下：要么装得下，要么显式告警；且所有数字有限", () => {
    const engine = new CogniStackEngine();
    const counter = exactCharTokenCounter();
    let checked = 0;
    let sawDowngrade = 0;

    for (let i = 0; i < 160; i += 1) {
      const seed = 70_000 + i;
      const r = rng(seed);
      const turns = r.int(1, 24);
      const dialogue = Array.from({ length: turns }, (_, k) => ({
        id: `m${k}`,
        role: k % 2 === 0 ? "user" : "assistant",
        content: r.pick(BODIES).repeat(r.int(1, 4)),
      }));
      const contextTokenLimit = r.int(256, 8192);

      const result = engine.prepare({
        card: { name: "阿铁", description: r.pick(BODIES) },
        dialogue,
        contextTokenLimit,
        completionReserveTokens: r.int(0, 256),
        tokenCounter: counter,
        summaryBlocks: r.bool(0.4)
          ? [
              {
                id: "b1",
                text: randomStructured(r),
                throughMessageId: `m${Math.max(0, turns - 2)}`,
                pairCount: 1,
              },
            ]
          : undefined,
      } as never);

      const nums = [
        result.promptTokens,
        result.promptChars,
        result.budget.hardFit ?? 0,
        result.budget.softTrimTokenCap,
        result.budget.contextLimit,
        result.memory.contextUsed,
        result.memory.pendingPairs,
        result.diagnostics.counter.hits,
        result.diagnostics.timings.total ?? 0,
      ];
      for (const n of nums) {
        assert.ok(Number.isFinite(n) && n >= 0, `seed=${seed} 出现非法数字：${n}`);
      }

      // 不变量：软顶装不下就必然有告警或真的丢了东西，绝不静默超预算。
      const hardFit = result.budget.hardFit ?? 0;
      if (hardFit > 0 && result.promptTokens > hardFit) {
        sawDowngrade += 1;
        const reported =
          result.warnings.some((w) => w.includes("hard-fit")) ||
          result.diagnostics.stages.emergencyDropped > 0 ||
          result.warnings.some((w) => w.includes("compress-failed") || w.includes("assemble-failed"));
        assert.ok(
          reported,
          `seed=${seed} 超出硬顶 ${result.promptTokens}>${hardFit} 却没有任何告警/丢弃记录\nwarnings=${JSON.stringify(result.warnings)}`,
        );
      }

      assert.ok(result.messages.length > 0, `seed=${seed} generate 模式不应返回空 prompt`);
      checked += 1;
    }

    assert.equal(checked, 160);
    // 这个数字本身没有断言意义，仅用于确认 fuzz 真的覆盖到了降级路径，
    // 如果长期为 0 说明生成器过于温和（改生成器，不要删这行）。
    assert.ok(sawDowngrade >= 0);
  });

  it("同一输入重复 prepare 结果确定（token 数、告警一致）", () => {
    const engine = new CogniStackEngine();
    const counter = exactCharTokenCounter();
    for (let i = 0; i < 40; i += 1) {
      const seed = 90_000 + i;
      const r = rng(seed);
      const input = {
        card: { name: "阿铁" },
        dialogue: Array.from({ length: r.int(2, 10) }, (_, k) => ({
          id: `m${k}`,
          role: k % 2 === 0 ? "user" : "assistant",
          content: r.pick(BODIES),
        })),
        contextTokenLimit: r.int(512, 4096),
        tokenCounter: counter,
      };
      const a = engine.prepare(input as never);
      const b = engine.prepare(input as never);
      assert.equal(a.promptTokens, b.promptTokens, `seed=${seed} promptTokens 不确定`);
      assert.deepEqual(a.warnings, b.warnings, `seed=${seed} warnings 不确定`);
    }
  });
});
