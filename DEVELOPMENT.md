# 开发手册 · DEVELOPMENT

> 面向**改这个仓库**的人。使用引擎见 [USAGE.md](./USAGE.md)，接入宿主见 [INTEGRATION.md](./INTEGRATION.md)。

## 0. 环境

- **Node.js ≥ 22**（`engines.node`），npm。
- 本仓库有**两个独立的 TypeScript 工程**：根包（TS `^5.9.2`，引擎 + 网关 + 脚本）与
  `console/`（TS `~6.0.2`，Vite + React 控制台）。两者各自编译，互不干扰。
- 本机已知限制（脚本已针对性规避，见 §9）：`spawnSync` 起 node 子进程稳定 EBUSY；
  Playwright 用**系统 Edge**（`channel: "msedge"`），**不下载 Chromium**。

```bash
npm install
npm --prefix console install     # 或 npm run console:install
npm run build
npm test
```

---

## 1. 目录职责

| 目录 | 职责 |
|---|---|
| `src/` | 引擎 TS 源码。**零运行时依赖**；分 `fusion/`（融合管线）、`memory/`、`context/`、`host/`，加 `ports.ts` / `protocol.ts` / `telemetry.ts` / `types.ts`。 |
| `tools/` | HTTP 网关与配套：`viz-server.cjs`、`lib/`（prepare-api、turn-map、viz-auth、viz-zones、turn-log）、OpenAI/Anthropic 兼容中间件、示例客户端。 |
| `console/` | **独立** Vite + React 控制台包（产物 `console/dist`，由网关托管）。见 `console/DESIGN.md`。 |
| `examples/` | 可直接运行的宿主示例 + `REFERENCE-HOSTS.md`。 |
| `test/` | 测试：`.ts` 编译进 `dist-test/`，`.cjs` 直接跑。 |
| `scripts/` | 构建、门禁、验证、模拟、基准。 |
| `dist/` | **发布产物**（`npm run build`）。 |
| `dist-test/` | **测试编译产物**（`npm run build:test`）。 |
| `repro_outputs/` | `npm run eval` 的报告（生成物，不提交）。 |

---

## 2. 常用命令

### 开发与运行

| 命令 | 做什么 |
|---|---|
| `npm start` | 一键：build → （缺则）`console install` → **挑空闲端口**（7331 / 5173 起各试 40 个顺延）→ 默认起**多核集群**（`--single` 则用 `node tools/viz-server.cjs`）→ 等 `/v1/health` 就绪 → 起 Vite（注入 API 端口代理）并开浏览器。 |
| `npm run start:prod` / `start:cluster` | build + console:build + `start-server.cjs`（单端口 7331 集群）。 |
| `npm run viz` | build + 单进程网关（`tools/viz-server.cjs`）。 |
| `npm run console:dev` | 仅前端（需另开引擎）。`console:build` 出产物。 |

### 构建与测试

| 命令 | 做什么 |
|---|---|
| `npm run typecheck` | `tsc --noEmit`。 |
| `npm run build` | `tsc -p tsconfig.build.json` + `postbuild.cjs`（写 `dist/package.json` = `{"type":"commonjs"}`）→ `dist/`。 |
| `npm run build:test` | 编译到 `dist-test/`（含测试 `.ts`）。 |
| `npm test` | `build:test` + `node --test dist-test/test/*.test.js test/*.test.cjs`。 |
| `npm run test:fast` | 跳过编译，直接跑（需已 `build:test`）。 |
| `npm run test:coverage` | 同上 + `--experimental-test-coverage`。 |

### 分析 / 演练

`npm run probe`（探针）、`npm run bench`（prepare 记忆化命中基准）、`npm run sim`
（多轮降级演练）、`npm run eval`（脚本化用例 → `repro_outputs/eval-report.json`）、
`npm run eval:turn`（从回合 JSONL 生成用例）。

### 示例与兼容中间件

`npm run example*`（minimal / summarize / jsonl / tenant / langchain）、
`npm run api:example`、`npm run openai:compat`、`npm run anthropic:compat`、
`npm run viz:client`。

---

## 3. 门禁（改完必跑）

### 根包

```bash
npm run typecheck
npm test
npm run verify:turn-log
npm run api:surface:check
npm run bundle:audit
npm run verify:viz-http
npm run doc:numbers:check
```

| 门禁 | 判据 |
|---|---|
| `typecheck` / `test` | 0 错误 / `fail 0`。 |
| `api:surface:check` | `removed + changed = 0`；`--strict-additions` 时 `added` 也算。差异是**保守口径**（含 private 成员、声明重排），须**逐条审阅**后 `--write`，**不要为变绿直接覆盖**。基线缺失退 0。 |
| `doc:numbers:check` | 标记值与实测不符退出 1；**「0 处校验」也算失败**。 |
| `bench` | 默认只打印；仅当设了 `BENCH_MAX_MS` / `MIN_AVOIDED_PCT` / `MAX_HEAP_MB` / `MAX_SPREAD_PCT` 才按中位数门禁。 |
| `sim` | `SIM_EXPECT_NO_DEGRADE=1` 时任何降级 → 1。 |
| `eval` | `failed > 0` → 1。 |
| `bundle:audit` | 只测量，不判定。 |

### 控制台包（脚本在 `console/package.json`，不在根）

```bash
npm --prefix console run qa:classes   # 静态类名审计（CSS 定义 ↔ TSX 引用求差集）
npm --prefix console run qa:layout    # 浏览器版式体检（需先起网关）
npm --prefix console run qa           # 两者
```

- `qa:classes`：「用了但没定义」> 0 → 1；孤儿类仅 WARN。判据 CSS 定义数 · 类名语境引用数，**双向差集均 0**。
- `qa:layout`：自动灌 46 轮梯度遥测（走公开 `/api/turn`，**限速**每 20 条歇 1 秒），
  再扫 **2 主题 × 2 密度 × 10 档宽度 × 8 路由**。判据 **`FAIL 0` 且「WARN·可处理 0」**；
  `WARN` 绝对条数随灌入数据浮动，不必对数字。

---

## 4. 文档数字自动校验

文档里的实测数字会漂移，所以**只改写显式带标记的区间**：

```
<!-- N:tests -->457<!-- /N -->
```

```bash
node scripts/doc-numbers.cjs                 # 默认处理 README.md
node scripts/doc-numbers.cjs --check         # CI：不一致退出 1
node scripts/doc-numbers.cjs --print-markers # 打印建议标记（不写文件）
```

支持的键：`tests` / `tests_pass` / `tests_fail` / `memo_avoided_pct` / `tokenizations` /
`prompt_tokens` / `soft_trim_cap` / `fill`。**脚本不会替你插入标记**——加标记是文档作者的编辑决定。
改了测试数等指标后跑 `npm run doc:numbers` 重写标记区间。

---

## 5. 公共 API 基线守卫

`scripts/api-surface.cjs` 用 TS 编译器 API 把当前导出面冻结成 `scripts/api-surface.baseline.json`。

```bash
node scripts/api-surface.cjs --check    # 破坏性变更 → 1
node scripts/api-surface.cjs            # 打印 新增/移除/变更
node scripts/api-surface.cjs --write    # 人工确认后覆盖基线
```

维护约定：

1. **基线必须在其他改动全部落定后再 `--write`**（它是「已确认的契约快照」，不是当前状态缓存）。
2. `--check` 不符时**第一个怀疑 `dist/` 落后于 `src/`**：`npm test` 只更新 `dist-test/`，
   **不更新 `dist/`**；`api:surface` / `bundle:audit` 读的是 `dist/`。先 `npm run build` 再复测。
3. 逐条审阅「移除/变更」后再覆盖，**不要为了变绿而关掉守卫**。

---

## 6. 控制台开发

- 视觉与版式基线是 `console/DESIGN.md`（**改样式前先读**）；令牌唯一来源 `console/src/styles/tokens.css`。
- 版本目录：`console/src`（原语 `ui/`、图表 `charts/`、页面 `pages/`、样式 `styles/`）。
- **导入顺序即层叠顺序**：`App` 必须晚于样式导入。
- 版式问题**缩略图会骗人**，一律用 `qa:layout` 的数字查（对比度、溢出、焦点圈、内容被容器吃掉）。
- Playwright 用 `playwright-core` + 系统 Edge（`channel: "msedge"`）；**不要下载 Chromium**。

---

## 7. TypeScript 配置要点

- 根 `tsconfig.json`：`strict`、**`exactOptionalPropertyTypes: true`**、`noUncheckedIndexedAccess`，
  `lib` 仅 `["ES2022"]`（**刻意不引 DOM** —— 本包是 Node 库，避免误用 `window`/`localStorage`；
  唯一需要的 Crypto 已改为结构化类型）。
- `tsconfig.build.json`：CommonJS + `declaration` + `declarationMap` → `dist/`。
- `tsconfig.test.json`：继承 build，`rootDir: "."` → `dist-test/`，无声明。
- 两个 TS 版本并存：根 `^5.9.2`、console `~6.0.2`（其 tsconfig 带 `ignoreDeprecations`）。
  `api-surface` 基线记录 TS 版本，不一致只告警不判失败。

---

## 8. 发版流程

```bash
npm run typecheck && npm test        # 或直接 prepublishOnly 一并跑
npm run build                        # 产出 dist/
npm run pack:check                   # npm pack --dry-run，核对白名单
npm pack                             # 产出 cognistack-engine-<version>.tgz
```

- `prepack` = `npm run build`。
- `prepublishOnly` = `typecheck && test && build && api:surface:check && doc:numbers:check && bundle:audit`。
- `files` 白名单：`dist/**`、`examples/**`、`README.md`、`USAGE.md`、`INTEGRATION.md`、
  `DEVELOPMENT.md`、`CHANGELOG.md`、`LICENSE`、`docs/decisions/**`、`docs/eval.md`。

### GitHub Release（迭代更新的下载源）

1. `src/version.ts` 的 `COGNISTACK_VERSION` 与 `package.json` 的 `version` 同步升版本。
2. 提交并打标签：`git tag vX.Y.Z && git push origin vX.Y.Z`。
3. 在 GitHub 建 Release，附上 `npm pack` 的 `.tgz`（及可选的 `console/dist` 静态包）。
4. 「最新版」可用固定地址 `https://github.com/<owner>/<repo>/releases/latest/download/<asset>`，
   宿主/客户端据此做版本检查与迭代更新。

---

## 9. 本机环境坑（脚本已规避，改动时请留意）

| 坑 | 现象 | 现有对策 |
|---|---|---|
| `spawnSync` 起 node 子进程 | 稳定 **EBUSY** | `bundle-audit` / `doc-numbers` 改**异步 `spawn`**；`bundle-audit` 的 pack 走 `cmd.exe /d /s /c`。 |
| 服务端限流 | 默认按 IP **30/s** | QA 灌 46 轮时**每 20 条歇 1 秒**，否则 429 会在浏览器里被记成「页面异常」。 |
| 端口会被顺延 | 把「别人」的服务当成自己的 | `start-all` 从 7331/5173、`verify*` 从 7399/7531/7600 起各试 40 个；验证脚本先证「连上的就是刚起的」（`uptimeMs < 30s` + 子进程存活）。 |
| 浏览器 | 不想下载 Chromium | `playwright-core` + 系统 Edge（`channel:"msedge"`）。 |
| `dist` vs `dist-test` | 数字/差异是陈旧的 | 读 `dist/` 的脚本（`api:surface`、`bundle:audit`）在 `src` 比 `dist` 新时会告警 → 先 `npm run build`。 |
| 跨编码内容 | PowerShell `Invoke-RestMethod` 会写出 `??????` | 用 Node `fetch` 验证。 |

---

## 10. 继续阅读

- 引擎字段与预算：**[USAGE.md](./USAGE.md)**
- 宿主接入与回合时序：**[INTEGRATION.md](./INTEGRATION.md)**
- 参考宿主与已知差异：**[examples/REFERENCE-HOSTS.md](./examples/REFERENCE-HOSTS.md)**
- 控制台视觉基线：**[console/DESIGN.md](./console/DESIGN.md)**