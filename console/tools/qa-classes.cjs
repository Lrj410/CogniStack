#!/usr/bin/env node
/*
 * 类名审计 —— 静态求差集（CSS 定义 ↔ TSX 引用）。
 *
 * 为什么值得单独做一个脚本：**重构设计系统时最容易静默失效的一类问题**。
 * 改了 CSS 类名却忘了改调用点，元素就完全失去样式 —— 不报错、tsc 全过、
 * 单测全绿、缩略图里只是"看着有点怪"。所以它进 CI（不需要浏览器）。
 *
 * 用法：node console/tools/qa-classes.cjs
 * 退出码：有「用了但没定义」→ 1；只有「定义了没人用」→ 0（死代码，不阻断）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.resolve(__dirname, "../src");

function collect(dir, re, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, re, out);
    else if (re.test(e.name)) out.push(full);
  }
  return out;
}

/** 从 openIdx 处的开括号出发，按配平取到匹配的闭括号（返回括号之间的文本）。 */
function balanced(text, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return "";
}

/* ---- ① CSS：剥注释与 url() 后收集所有类名 ------------------------------- */
/*
 * url() 必须先剥掉：`url(foo.svg)` 里的 `.svg` 会被类名正则当成一个类，
 * 于是审计结果里混进 "svg" / "woff2" 这类噪声，真正的孤儿反而被淹。
 */
const defined = new Set();
for (const file of collect(SRC, /\.css$/)) {
  const css = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\([^)]*\)/g, "");
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
}

/* ---- ② TSX：只从「一定是用作类名」的位置收集 ---------------------------- */
/*
 * 不是所有字符串字面量都是类名（`kind: "client"` 就不是）。所以只扫两处：
 *   - class / className 属性
 *   - cx(...) 的实参
 * 两处都是类名语境，抽出来的 token 只要没在 CSS 里定义，就是真缺陷。
 */
const used = new Map();
const record = (raw, rel) => {
  for (const tok of raw.split(/\s+/)) {
    const c = tok.trim();
    // 跳过 `stage-${i}` 这类插值残片（只剩 "stage-"）与空串
    if (!c || !/^-?[_a-zA-Z][\w-]*$/.test(c)) continue;
    if (!used.has(c)) used.set(c, new Set());
    used.get(c).add(rel);
  }
};
/*
 * 模板串里的插值（`` `btn--${size}` ``）静态解不出来，但**静态前缀**是确定的。
 * 记下前缀（"btn--"），凡是带该前缀的定义就都算"被引用" —— 否则整个变体族
 * （btn--solid / btn--lg / tone-ok …）会被误报成死代码，审计就没人看了。
 */
const prefixes = new Set();
const literals = (chunk) => {
  for (const m of chunk.matchAll(/[`]([^`]*)`/g)) {
    const hole = m[1].indexOf("${");
    if (hole >= 0) {
      const p = m[1].slice(0, hole).trim();
      if (p) prefixes.add(p);
    }
  }
  // 先摘掉比较运算的右操作数（`size !== "md"`），它是枚举值，不是类名
  const only = chunk.replace(/(?:[=!<>]=?)\s*(["'`])[^"'`]*\1/g, " ");
  for (const m of only.matchAll(/["'`]([^"'`]*)["'`]/g)) record(m[1], current);
};

let current = "";
for (const file of collect(SRC, /\.(tsx|ts)$/)) {
  current = path.relative(SRC, file).replace(/\\/g, "/");
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*"([^"]*)"/g)) record(m[1], current);
  for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*\{/g)) {
    literals(balanced(text, m.index + m[0].length - 1, "{", "}"));
  }
  for (const m of text.matchAll(/\bcx\s*\(/g)) {
    literals(balanced(text, m.index + m[0].length - 1, "(", ")"));
  }
}

const missing = [...used.keys()].filter((k) => !defined.has(k)).sort();

/* ---- ③ 孤儿：定义了但整个 src 里都没出现过 ------------------------------ */
/* 按「整词」匹配（`btn` 不应被 `btn--outline` 命中），否则孤儿会被系统性低估。 */
const allText = collect(SRC, /\.(tsx|ts)$/)
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const orphan = [...defined]
  .filter((k) => !new RegExp(`(?:^|[^\\w-])${esc(k)}(?:$|[^\\w-])`).test(allText))
  .filter((k) => ![...prefixes].some((p) => k.startsWith(p)))
  .sort();

console.log("类名审计（CSS 定义 ↔ TSX 引用）");
console.log(`  CSS 定义 ${defined.size} 个 · 类名语境引用 ${used.size} 个\n`);

if (missing.length) {
  console.log(`用了但没定义（FAIL ${missing.length}）—— 这些元素会完全失去样式：`);
  for (const k of missing) console.log(`  ✗ .${k}  ← ${[...used.get(k)].join(", ")}`);
} else {
  console.log("用了但没定义：0 ✓");
}
if (orphan.length) {
  console.log(`\n定义了没人用（WARN ${orphan.length}）—— 死代码，可以删：`);
  console.log("  ! " + orphan.map((k) => `.${k}`).join(" "));
} else {
  console.log("\n定义了没人用：0 ✓");
}

process.exit(missing.length ? 1 : 0);