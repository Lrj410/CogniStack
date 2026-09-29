/**
 * Emit marker so the compiled tree runs as CommonJS regardless of the root
 * package's "type": "module".
 *
 *   node scripts/postbuild.cjs           → dist/package.json
 *   node scripts/postbuild.cjs dist-test → dist-test/package.json
 */
const fs = require("node:fs");
const path = require("node:path");

const rel = process.argv[2] || "dist";
const dir = path.join(__dirname, "..", rel);
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, "package.json");
fs.writeFileSync(out, `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
console.log(`${rel}/package.json -> { type: commonjs }`);
