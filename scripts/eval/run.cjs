/**
 * Behavioral eval harness — gold contracts for budget / memory / sanitize.
 * Complements unit tests; uses exactCharTokenCounter as a relative meter.
 *
 *   npm run eval
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  CogniStackEngine,
  exactCharTokenCounter,
  createKeywordLoreProvider,
  clipStructuredSummary,
  minStructuredDocumentLength,
  VectorMemoryEngine,
} = require("../../dist/index.js");

const ROOT = path.join(__dirname, "../..");
const casesDir = path.join(__dirname, "cases");
const counter = exactCharTokenCounter();

function loadCases() {
  return fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      ...JSON.parse(fs.readFileSync(path.join(casesDir, f), "utf8")),
    }));
}

function runCase(c) {
  const failures = [];
  const engine = new CogniStackEngine({
    systemRules: c.systemRules || "RULE",
    collaborators: { lore: createKeywordLoreProvider() },
    maxLoreEntries: c.maxLoreEntries ?? 8,
  });

  if (c.kind === "hard_fit") {
    const r = engine.prepare({
      profile: c.profile || { name: "Agent", description: "x".repeat(c.cardPad || 200) },
      dialogue: c.dialogue,
      loreEntries: c.loreEntries || [],
      vectorHits: c.vectorHits || [],
      contextTokenLimit: c.contextTokenLimit,
      completionReserveTokens: c.completionReserveTokens ?? 64,
      tokenCounter: counter,
      cacheScope: `eval-${c.name}`,
    });
    const hard = r.budget.hardFit;
    if (r.promptTokens > hard) {
      failures.push(`promptTokens ${r.promptTokens} > hardFit ${hard}`);
    }
    if (c.expectPressure && !r.warnings.some((w) => String(w).startsWith("pressure-"))) {
      failures.push("expected pressure-* warning");
    }
  } else if (c.kind === "hard_fact_retention") {
    const r = engine.prepare({
      profile: { name: "阿铁", description: "助手" },
      dialogue: c.dialogue,
      summaryBlocks: c.summaryBlocks,
      summarizedThroughMessageId: c.summarizedThroughMessageId,
      contextTokenLimit: c.contextTokenLimit,
      completionReserveTokens: c.completionReserveTokens ?? 128,
      softTrimTokenCap: c.softTrimTokenCap,
      tokenCounter: counter,
      cacheScope: `eval-${c.name}`,
    });
    const sys = r.messages.find((m) => m.role === "system")?.content || "";
    for (const needle of c.mustContain || []) {
      if (!sys.includes(needle) && !(r.summary || "").includes(needle)) {
        failures.push(`missing retained fact: ${needle}`);
      }
    }
  } else if (c.kind === "clip_structured") {
    const min = minStructuredDocumentLength();
    for (const trial of c.trials || []) {
      const out = clipStructuredSummary(c.doc, trial.max);
      if (trial.max < min) {
        if (out !== "") failures.push(`max=${trial.max} expected "" got len=${out.length}`);
      } else if (out.length > trial.max) {
        failures.push(`max=${trial.max} OVER len=${out.length}`);
      }
    }
  } else if (c.kind === "vector_sanitize") {
    const vec = new VectorMemoryEngine();
    const hits = vec.sanitizeHits(c.hits, {
      summaryText: c.summaryText,
      maxHits: c.maxHits ?? 6,
      maxCharsEach: c.maxCharsEach ?? 800,
    });
    if (c.expectMaxHits != null && hits.length > c.expectMaxHits) {
      failures.push(`hits ${hits.length} > ${c.expectMaxHits}`);
    }
    for (const needle of c.mustNotContain || []) {
      if (hits.some((h) => h.content.includes(needle))) {
        failures.push(`sanitize leaked: ${needle}`);
      }
    }
  } else {
    failures.push(`unknown kind: ${c.kind}`);
  }

  return { name: c.name, ok: failures.length === 0, failures };
}

function main() {
  const results = loadCases().map(runCase);
  const failed = results.filter((r) => !r.ok);
  const report = {
    engine: "CogniStackEngine",
    at: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  const outDir = path.join(ROOT, "repro_outputs");
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "eval-report.json"), JSON.stringify(report, null, 2));
  } catch {
    /* optional */
  }
  if (failed.length) process.exit(1);
}

main();
