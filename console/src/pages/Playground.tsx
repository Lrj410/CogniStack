import { useMemo, useState } from "react";
import { ApiError, apiText } from "@/lib/api";
import { dur, n } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Code,
  DataTable,
  Empty,
  Row,
  Segmented,
  Stack,
  Textarea,
  Toolbar,
  useToast,
} from "@/ui";
import type { Tone } from "@/ui";
import { PageFlush } from "@/app/Page";
import "./playground.css";

/** 默认请求体：一条用户消息 + 明确的上下文预算,便于直接点「发送」。 */
const SAMPLE = JSON.stringify(
  {
    // 显式声明调用方身份。不带 host 时网关只能把它记成「未声明宿主」——
    // 控制台的接入主机列表里就看不出这些调用其实是调试台发出来的。
    // 它是请求体的一部分，可以随手改掉或删掉。
    host: { id: "console-playground", name: "控制台调试台", kind: "client" },
    mode: "generate",
    dialogue: [{ role: "user", content: "解释一下这次装配结果为什么被裁剪。" }],
    contextTokenLimit: 8192,
    completionReserveTokens: 1024,
  },
  null,
  2,
);

const LONG_CHAT_SAMPLE = JSON.stringify(
  {
    host: { id: "console-stress-test", name: "长会话压测", kind: "client" },
    mode: "generate",
    profile: { name: "助手", description: "你是一个专业可靠的智能系统助手。" },
    contextTokenLimit: 2048,
    completionReserveTokens: 512,
    dialogue: Array.from({ length: 16 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `第 ${i + 1} 轮交互：请继续汇报上一阶段任务的推进状态和当前系统的资源占用情况。这是一段测试长文本内容。`,
    })),
  },
  null,
  2,
);

const OVERRIDE_A = JSON.stringify({ contextTokenLimit: 4096 }, null, 2);
const OVERRIDE_B = JSON.stringify({ contextTokenLimit: 8192, pairBatchSize: 4 }, null, 2);

type ChatMessage = { role?: string; content?: unknown };

type PrepareResult = {
  messages?: ChatMessage[];
  promptTokens?: number;
  promptChars?: number;
  budget?: Record<string, unknown>;
  diagnostics?: { counterId?: string };
  [key: string]: unknown;
};

/** 一次 prepare 的结果。status / error 并存,错误也保留 HTTP 码。 */
type Side = {
  status: number | null;
  result: PrepareResult | null;
  error: string | null;
  ms: number;
};

type Mode = "single" | "compare";

type SingleView = { status: number | null; text: string };

type DiffStatus = "same" | "changed" | "onlyA" | "onlyB";

type DiffRow = {
  i: number;
  role: string;
  status: DiffStatus;
  a: number | null;
  b: number | null;
};

const DIFF_LABEL: Record<DiffStatus, string> = {
  same: "一致",
  changed: "变化",
  onlyA: "仅 A",
  onlyB: "仅 B",
};

const DIFF_TONE: Record<DiffStatus, Tone> = {
  same: "ok",
  changed: "warn",
  onlyA: "neutral",
  onlyB: "neutral",
};

/** 内容长度：字符串取字符数,结构化块取序列化长度。 */
function contentLen(c: unknown): number {
  if (typeof c === "string") return c.length;
  if (c == null) return 0;
  return JSON.stringify(c).length;
}

/** 能格式化就格式化,否则原样回显（服务端可能返回非 JSON）。 */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 逐条对齐两组消息,产出可核对的差异行。 */
function buildDiff(a: Side | null, b: Side | null): DiffRow[] {
  const am = a?.result?.messages;
  const bm = b?.result?.messages;
  if (!am || !bm) return [];
  const rows: DiffRow[] = [];
  const max = Math.max(am.length, bm.length);
  for (let i = 0; i < max; i += 1) {
    const ma = am[i];
    const mb = bm[i];
    if (!ma && !mb) continue;
    let status: DiffStatus;
    if (ma && mb) {
      const same = ma.role === mb.role && JSON.stringify(ma.content) === JSON.stringify(mb.content);
      status = same ? "same" : "changed";
    } else {
      status = ma ? "onlyA" : "onlyB";
    }
    rows.push({
      i: i + 1,
      role: ma?.role ?? mb?.role ?? "—",
      status,
      a: ma ? contentLen(ma.content) : null,
      b: mb ? contentLen(mb.content) : null,
    });
  }
  return rows;
}

/** 解析一段 JSON 对象；失败时抛出带字段名的中文错误。 */
function parseObject(src: string, label: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(src);
  } catch {
    throw new Error(`${label}不是合法 JSON,无法运行对照`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return v as Record<string, unknown>;
}

type ParsedOverrides =
  | { ok: false; error: string }
  | { ok: true; base: Record<string, unknown>; a: Record<string, unknown>; b: Record<string, unknown> };

function parseOverrides(body: string, overrideA: string, overrideB: string): ParsedOverrides {
  try {
    return {
      ok: true,
      base: parseObject(body, "请求体"),
      a: parseObject(overrideA, "A 覆盖"),
      b: parseObject(overrideB, "B 覆盖"),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function numOr(v: number | undefined): string {
  return v == null ? "—" : n(v);
}

export function PlaygroundPage() {
  const [mode, setMode] = useState<Mode>("single");
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState(SAMPLE);
  const [overrideA, setOverrideA] = useState(OVERRIDE_A);
  const [overrideB, setOverrideB] = useState(OVERRIDE_B);
  const [note, setNote] = useState<string | null>(null);
  const [single, setSingle] = useState<SingleView | null>(null);
  const [sideA, setSideA] = useState<Side | null>(null);
  const [sideB, setSideB] = useState<Side | null>(null);

  const diff = useMemo(() => buildDiff(sideA, sideB), [sideA, sideB]);
  const bothMessages = Boolean(sideA?.result?.messages && sideB?.result?.messages);

  async function runSingle() {
    setBusy(true);
    setNote(null);
    try {
      const { status, text } = await apiText("/v1/prepare", {
        method: "POST",
        body,
        json: false,
        headers: { "content-type": "application/json" },
      });
      setSingle({ status, text: pretty(text) });
    } catch (e) {
      if (e instanceof ApiError) setSingle({ status: e.status, text: e.body || e.message });
      else setSingle({ status: null, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** 计时并归一化结果：HTTP 错误保留状态码与响应体片段。 */
  async function send(side: string, payload: unknown): Promise<Side> {
    const t0 = performance.now();
    try {
      const { status, text } = await apiText("/v1/prepare", { method: "POST", body: payload });
      const ms = performance.now() - t0;
      let result: PrepareResult | null = null;
      try {
        result = JSON.parse(text) as PrepareResult;
      } catch {
        result = null;
      }
      return { status, result, error: null, ms };
    } catch (e) {
      const ms = performance.now() - t0;
      if (e instanceof ApiError) {
        return { status: e.status, result: null, error: e.body.slice(0, 800), ms };
      }
      return { status: null, result: null, error: `${side}: ${String(e)}`, ms };
    }
  }

  async function runCompare() {
    const parsed = parseOverrides(body, overrideA, overrideB);
    if (!parsed.ok) {
      setNote(parsed.error);
      return;
    }
    setNote(null);
    setBusy(true);
    try {
      const [ra, rb] = await Promise.all([
        send("A", { ...parsed.base, ...parsed.a }),
        send("B", { ...parsed.base, ...parsed.b }),
      ]);
      setSideA(ra);
      setSideB(rb);
    } finally {
      setBusy(false);
    }
  }

  const notify = useToast();

  function exportAsTest() {
    try {
      const parsed = JSON.parse(body);
      const testCode = `const test = require("node:test");
const assert = require("node:assert/strict");
const { CogniStackEngine, exactCharTokenCounter } = require("cognistack-engine");

test("regression - playground exported turn", () => {
  const engine = new CogniStackEngine();
  const input = ${JSON.stringify(parsed, null, 2)};
  const result = engine.prepare({
    ...input,
    tokenCounter: exactCharTokenCounter(),
  });
  assert.ok(result.messages.length > 0);
});
`;
      navigator.clipboard.writeText(testCode);
      notify("已复制测试用例到剪贴板", "ok");
    } catch {
      notify("请求体非合法 JSON，无法导出测试用例", "bad");
    }
  }

  return (
    <PageFlush>
      <Toolbar>
        <div className="pg-heading">
          <span className="pg-title">调试台</span>
          <span className="pg-sub">{mode === "single" ? "POST /v1/prepare" : "同一输入 · 两组覆盖"}</span>
        </div>
        <div className="spacer" />
        <Button variant="ghost" size="sm" onClick={() => setBody(SAMPLE)} title="恢复默认标准测试请求体">
          标准模板
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setBody(LONG_CHAT_SAMPLE)} title="载入多轮长对话软裁剪压测请求体">
          多轮压测
        </Button>
        <Button variant="ghost" onClick={exportAsTest} title="将当前请求体转化为 Node.js 测试用例代码并复制">
          导出测试用例
        </Button>
        <Segmented
          label="调试模式"
          value={mode}
          onChange={setMode}
          options={[
            { value: "single", label: "单次" },
            { value: "compare", label: "对照 A/B" },
          ]}
        />
        <Button variant="solid" loading={busy} onClick={mode === "single" ? runSingle : runCompare}>
          {mode === "single" ? "发送" : "运行 A / B"}
        </Button>
      </Toolbar>

      {note ? (
        <div className="pg-note">
          <Alert tone="bad" title="输入无法解析" onDismiss={() => setNote(null)}>
            {note}
          </Alert>
        </div>
      ) : null}

      {mode === "single" ? (
        <div className="split split--half">
          <section className="split-pane">
            <div className="pane-head">请求体 · JSON</div>
            <div className="pane-body pg-flush-body">
              <Textarea
                className="pg-editor"
                aria-label="请求体 JSON"
                value={body}
                spellCheck={false}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          </section>

          <section className="split-pane">
            <div className="pane-head">
              <span>响应</span>
              <Code>{single && single.status != null ? `HTTP ${single.status}` : "等待发送"}</Code>
            </div>
            <div className="pane-body pg-well-body">
              <pre className="well pg-well">{single ? single.text : "// 发送后显示结果"}</pre>
            </div>
          </section>
        </div>
      ) : (
        <div className="split split--half">
          <div className="pg-col">
            <section className="split-pane pg-req">
              <div className="pane-head">请求体 · JSON</div>
              <div className="pane-body pg-flush-body">
                <Textarea
                  className="pg-editor"
                  aria-label="请求体 JSON"
                  value={body}
                  spellCheck={false}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
            </section>

            <div className="pg-ov-grid">
              <section className="split-pane">
                <div className="pane-head">A 覆盖</div>
                <div className="pane-body pg-flush-body">
                  <Textarea
                    className="pg-editor"
                    aria-label="A 覆盖 JSON"
                    value={overrideA}
                    spellCheck={false}
                    onChange={(e) => setOverrideA(e.target.value)}
                  />
                </div>
              </section>
              <section className="split-pane">
                <div className="pane-head">B 覆盖</div>
                <div className="pane-body pg-flush-body">
                  <Textarea
                    className="pg-editor"
                    aria-label="B 覆盖 JSON"
                    value={overrideB}
                    spellCheck={false}
                    onChange={(e) => setOverrideB(e.target.value)}
                  />
                </div>
              </section>
            </div>
          </div>

          <div className="pg-col">
            <ResultPane letter="A" side={sideA} />
            <ResultPane letter="B" side={sideB} />

            {bothMessages ? (
              <section className="split-pane">
                <div className="pane-head">
                  <span>消息差异</span>
                  <Code>{`${diff.length} 条`}</Code>
                </div>
                <div className="pane-body pg-pad-body">
                  {diff.length ? (
                    <DataTable minWidth={420} label="消息差异">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>角色</th>
                          <th>状态</th>
                          <th>A</th>
                          <th>B</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.map((r) => (
                          <tr key={r.i}>
                            <td className="num">{r.i}</td>
                            <td className="truncate" title={r.role}>
                              {r.role}
                            </td>
                            <td>
                              <Badge tone={DIFF_TONE[r.status]}>{DIFF_LABEL[r.status]}</Badge>
                            </td>
                            <td className="num">{r.a ?? "—"}</td>
                            <td className="num">{r.b ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </DataTable>
                  ) : (
                    <Empty title="两组消息一致" text="没有可对比的差异。" />
                  )}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      )}
    </PageFlush>
  );
}

/** 单侧结果面板：等待 / 失败 / 成功三态。 */
function ResultPane({ letter, side }: { letter: string; side: Side | null }) {
  const label = `结果 ${letter}`;
  const result = side?.result ?? null;

  return (
    <section className="split-pane">
      <div className="pane-head">
        <span>{label}</span>
        {side ? <Code>{side.status != null ? `HTTP ${side.status}` : "无响应"}</Code> : null}
      </div>
      <div className="pane-body pg-pad-body">
        {side === null ? (
          <p className="pg-wait">{`等待 ${letter}…`}</p>
        ) : side.error !== null ? (
          <Stack gap="var(--sp-4)">
            <Row gap="var(--sp-3)" wrap={false}>
              <span className="micro pg-result-label">{label}</span>
              <Badge tone="bad" variant="solid">
                {side.status != null ? `HTTP ${side.status}` : "失败"}
              </Badge>
              <span className="micro num pg-ms">{dur(side.ms)}</span>
            </Row>
            <pre className="well pg-well">{side.error || "（无响应体）"}</pre>
          </Stack>
        ) : result ? (
          <Stack gap="var(--sp-4)">
            <Row gap="var(--sp-3)" wrap={false}>
              <Badge tone="ok" variant="solid">
                {side.status != null ? `HTTP ${side.status}` : "HTTP ?"}
              </Badge>
              <span className="micro num pg-ms">{dur(side.ms)}</span>
            </Row>
            <div className="pg-kv">
              <Kv label="promptTokens" value={numOr(result.promptTokens)} />
              <Kv label="messages" value={String(result.messages?.length ?? 0)} />
              <Kv label="softTrimCap" value={budgetCap(result)} />
              <Kv label="counterId" value={result.diagnostics?.counterId ?? "—"} />
            </div>
          </Stack>
        ) : (
          <p className="pg-wait">响应不是合法 JSON</p>
        )}
      </div>
    </section>
  );
}

function budgetCap(result: PrepareResult): string {
  const cap = result.budget?.softTrimTokenCap;
  if (typeof cap === "number") return n(cap);
  if (cap == null) return "—";
  return String(cap);
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="pg-kv-item">
      <span className="micro pg-kv-k">{label}</span>
      <span className="pg-kv-v num truncate" title={value}>
        {value}
      </span>
    </div>
  );
}
