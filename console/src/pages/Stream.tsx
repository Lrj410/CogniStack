import { useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useTelemetry } from "@/hooks/useTelemetry";
import { clock, dur, hitRate, n } from "@/lib/format";
import { STAGE_META, modeLabel, warnLabel } from "@/lib/i18n";
import type { TurnRecord } from "@/lib/types";
import {
  Badge,
  Button,
  DataTable,
  Dot,
  Drawer,
  Empty,
  Row,
  Select,
  TextInput,
  Toolbar,
  useToast,
} from "@/ui";
import { Blocked, PageFlush } from "@/app/Page";
import { useMediaQuery } from "@/app/useMediaQuery";
import "./stream.css";

/** 操作名兜底候选：宿主自定义 meta 里常见的键。 */
const OP_KEYS = ["action", "operation", "op", "route", "event", "purpose"] as const;

const MODE_OPTIONS = [
  { value: "generate", label: "生成" },
  { value: "status", label: "状态" },
];

const OP_OPTIONS = [
  "正常聊天",
  "回复后记忆规划",
  "压缩后重规划",
  "发送前压缩重装",
  "世界状态整理",
  "状态探针",
].map((label) => ({ value: label, label }));

/** 操作名兜底链：label → meta 常见键 → 缓存域 → 模式。 */
function turnOpLabel(t: TurnRecord): string {
  const label = t.label?.trim();
  if (label) return label;
  for (const k of OP_KEYS) {
    const v = t.meta?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (t.cacheScope) return `会话 ${t.cacheScope}`;
  return modeLabel(t.mode);
}

/** 预算填充：优先按软顶自算,否则用宿主上报的 fill。 */
function fillLabel(t: TurnRecord): string {
  const cap = t.softTrimCap ?? 0;
  const ratio = cap > 0 ? t.promptTokens / cap : t.fill;
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export function StreamPage() {
  const { viewSnap, status, authHint, paused, setPaused, reset } = useTelemetry();
  const snap = viewSnap;
  const toast = useToast();
  const isWide = useMediaQuery("(min-width: 960px)");

  const [search, setSearch] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("");
  const [opFilter, setOpFilter] = useState("");
  const [pinned, setPinned] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const hostOptions = useMemo(
    () => (snap ? snap.hosts.map((h) => ({ value: h.id, label: h.name })) : []),
    [snap],
  );

  const filtered = useMemo(() => {
    if (!snap) return [];
    const q = search.trim().toLowerCase();
    return snap.turns.filter((t) => {
      if (hostFilter && t.hostId !== hostFilter) return false;
      if (modeFilter && t.mode !== modeFilter) return false;
      if (opFilter && turnOpLabel(t) !== opFilter && t.label !== opFilter) return false;
      if (!q) return true;
      // 检索串：主机名/类型 + 回合自带标签与 meta,拼成一个不区分大小写的 blob
      const host = snap.hosts.find((h) => h.id === t.hostId);
      const blob = [
        host?.name,
        t.hostName,
        t.hostId,
        host?.kind,
        t.hostKind,
        t.label,
        t.cacheScope,
        t.meta ? JSON.stringify(t.meta) : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });
  }, [snap, search, hostFilter, modeFilter, opFilter]);

  if (!snap) {
    const down = status === "down";
    return (
      <Blocked
        busy={!down}
        title={down ? (authHint ?? "无法连接 API") : "正在连接 API"}
        text={
          down
            ? "确认引擎已在 7331 端口运行,或在「设置」里填写 API Key。"
            : "正在通过代理订阅遥测流…"
        }
      />
    );
  }

  // 钉住优先；否则回落到过滤后的第一条
  const detail =
    (pinned !== null ? filtered.find((t) => t.seq === pinned) : undefined) ?? filtered[0] ?? null;
  const selectedSeq = detail?.seq ?? null;

  const clearPin = () => {
    setPinned(null);
    setSheet(false);
  };
  const selectRow = (seq: number) => {
    const next = pinned === seq ? null : seq;
    setPinned(next);
    if (!isWide) setSheet(next !== null);
  };

  /*
   * 行键盘可达：整表只有当前行占一个 Tab 停留点（roving tabindex），
   * 上下方向键在行间移动并选中。此前 <tr> 只有 onClick ——
   * 「点一行看详情」是这一页的核心动作，键盘/读屏用户却完全做不到。
   */
  const navSeq = selectedSeq ?? filtered[0]?.seq ?? null;
  function moveRow(from: number, delta: number) {
    if (filtered.length === 0) return;
    const next = Math.max(0, Math.min(filtered.length - 1, from + delta));
    const row = filtered[next];
    if (!row) return;
    setPinned(row.seq);
    if (!isWide) setSheet(true);
    bodyRef.current?.querySelector<HTMLTableRowElement>(`tr[data-row="${next}"]`)?.focus();
  }
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cognistack-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出快照");
  };
  const clearAll = async () => {
    if (!window.confirm("确定清空全部遥测数据？此操作不可撤销。")) return;
    clearPin();
    await reset();
  };

  const listState = paused ? "列表暂停（仍接收）" : `实时 · ${n(filtered.length)} 条`;
  const stateLabel = pinned !== null ? `${listState} · 钉住 #${pinned}` : listState;

  return (
    <PageFlush>
      <Toolbar>
        <TextInput
          className="st-search"
          icon={<Search size={14} aria-hidden />}
          placeholder="搜索主机 / 操作 / 会话…"
          aria-label="搜索回合"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearPin();
          }}
        />
        <Select
          className="st-select"
          aria-label="按主机筛选"
          placeholder="全部主机"
          options={hostOptions}
          value={hostFilter}
          onChange={(e) => {
            setHostFilter(e.target.value);
            clearPin();
          }}
        />
        <Select
          className="st-select"
          aria-label="按模式筛选"
          placeholder="全部模式"
          options={MODE_OPTIONS}
          value={modeFilter}
          onChange={(e) => {
            setModeFilter(e.target.value);
            clearPin();
          }}
        />
        <Select
          className="st-select"
          aria-label="按操作筛选"
          placeholder="全部操作"
          options={OP_OPTIONS}
          value={opFilter}
          onChange={(e) => {
            setOpFilter(e.target.value);
            clearPin();
          }}
        />
        <div className="spacer" />
        <span className="st-state">
          <Dot tone={paused ? "neutral" : "brand"} pulse={!paused} />
          <span className="truncate" title={stateLabel}>
            {stateLabel}
          </span>
        </span>
        <Button variant="ghost" onClick={() => setPaused(!paused)}>
          {paused ? "继续刷新" : "暂停列表"}
        </Button>
        <Button onClick={exportJson}>导出</Button>
        <Button variant="danger" onClick={clearAll}>
          清空
        </Button>
      </Toolbar>

      <div className="split split--ms">
        <div className="split-pane">
          <div className="pane-body">
            <DataTable minWidth={620} label="回合列表">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">主机</th>
                  <th scope="col">操作</th>
                  <th scope="col">模式</th>
                  <th scope="col">
                    词元
                  </th>
                  <th scope="col">
                    耗时
                  </th>
                  <th scope="col">结果</th>
                </tr>
              </thead>
              <tbody ref={bodyRef}>
                {filtered.map((t, i) => {
                  const op = turnOpLabel(t);
                  const hostName = t.hostName ?? t.hostId;
                  const selected = t.seq === selectedSeq;
                  return (
                    <tr
                      key={t.seq}
                      className="st-row"
                      data-row={i}
                      data-selected={selected ? "true" : undefined}
                      aria-selected={selected}
                      tabIndex={t.seq === navSeq ? 0 : -1}
                      onClick={() => selectRow(t.seq)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectRow(t.seq);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          moveRow(i, 1);
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          moveRow(i, -1);
                        } else if (e.key === "Home") {
                          e.preventDefault();
                          moveRow(0, 0);
                        } else if (e.key === "End") {
                          e.preventDefault();
                          moveRow(filtered.length - 1, 0);
                        }
                      }}
                    >
                      <td className="num">{clock(t.at)}</td>
                      <td className="truncate" title={hostName}>
                        {hostName}
                      </td>
                      <td className="truncate" title={op}>
                        {op}
                      </td>
                      <td>{modeLabel(t.mode)}</td>
                      <td className="num">{n(t.promptTokens)}</td>
                      <td className="num">{dur(t.durationMs)}</td>
                      <td>
                        <Row gap="var(--sp-2)" wrap={false}>
                          <Badge tone={t.degraded ? "bad" : "brand"}>
                            {t.degraded ? "降级" : "正常"}
                          </Badge>
                          {t.cacheHit ? (
                            <Badge tone="warn" variant="outline">
                              缓存
                            </Badge>
                          ) : null}
                        </Row>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <Empty
                        title="没有匹配的回合"
                        text="放宽筛选条件,或等待宿主发来新的装配请求。"
                      />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </DataTable>
          </div>
        </div>

        {isWide ? (
          <div className="split-pane">
            <div className="pane-head">回合详情</div>
            <div className="pane-body">
              {detail ? (
                <TurnDetail t={detail} />
              ) : (
                <Empty title="未选择回合" text="点左侧列表的任意一行查看该回合的装配详情。" />
              )}
            </div>
          </div>
        ) : (
          <Drawer open={sheet} onClose={() => setSheet(false)} title="回合详情" side="bottom">
            {detail ? (
              <TurnDetail t={detail} />
            ) : (
              <Empty title="未选择回合" text="点左侧列表的任意一行查看该回合的装配详情。" />
            )}
          </Drawer>
        )}
      </div>
    </PageFlush>
  );
}

function TurnDetail({ t }: { t: TurnRecord }) {
  const op = turnOpLabel(t);
  const hostName = t.hostName ?? t.hostId;
  const stages = STAGE_META.map((s) => ({ ...s, ms: t.timings[s.key] ?? 0 })).filter(
    (s) => s.ms > 0,
  );
  const total = stages.reduce((a, s) => a + s.ms, 0);
  const rate = hitRate(t.counter);
  const steps = t.steps ?? [];
  const meta = t.meta;

  return (
    <div className="st-detail">
      <div className="st-detail-head">
        <h3 className="st-detail-title truncate" title={`#${t.seq} · ${op}`}>
          #{t.seq} · {op}
        </h3>
        <p className="st-detail-sub truncate" title={`${hostName} · ${clock(t.at)}`}>
          {hostName} · {clock(t.at)}
        </p>
      </div>

      <Row gap="var(--sp-3)">
        <Badge tone={t.degraded ? "bad" : "ok"}>{t.degraded ? "降级" : "健康"}</Badge>
        <Badge tone="neutral">{modeLabel(t.mode)}</Badge>
        {t.cacheHit ? (
          <Badge tone="warn" variant="outline">
            装配缓存
          </Badge>
        ) : null}
      </Row>

      <div className="st-kv">
        <KvCell label="词元" value={n(t.promptTokens)} />
        <KvCell label="耗时" value={dur(t.durationMs)} />
        <KvCell label="填充" value={fillLabel(t)} />
        <KvCell label="分词命中" value={rate === null ? "—" : `${Math.round(rate * 100)}%`} />
        <KvCell label="消息" value={n(t.messages)} />
        <KvCell label="紧急丢弃" value={n(t.emergencyDropped)} />
      </div>

      <section className="st-sec">
        <h4 className="micro st-sec-title">阶段耗时</h4>
        {stages.length ? (
          <div className="st-stages">
            {stages.map((s) => (
              <div key={s.key} className="st-stage">
                <span className="st-stage-label truncate" title={s.label}>
                  {s.label}
                </span>
                <span className="st-stage-track">
                  <span
                    className="st-stage-fill"
                    style={{
                      ["--fill" as string]: (total > 0 ? s.ms / total : 0).toFixed(4),
                      background: s.color,
                    }}
                  />
                </span>
                <span className="num st-stage-ms">{dur(s.ms)}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="无阶段计时" text="该回合未上报任何阶段耗时。" />
        )}
      </section>

      <section className="st-sec">
        <h4 className="micro st-sec-title">告警</h4>
        {t.warnings.length ? (
          <ul className="st-warns">
            {t.warnings.map((w, i) => (
              <li key={`${i}-${w}`} className="st-warn truncate" title={warnLabel(w)}>
                {warnLabel(w)}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="无告警" text="装配过程未产生告警。" />
        )}
      </section>

      <section className="st-sec">
        <h4 className="micro st-sec-title">步骤</h4>
        {steps.length ? (
          <ol className="st-steps">
            {steps.map((s, i) => (
              <li key={`${i}-${s}`} className="st-step mono truncate" title={s}>
                {s}
              </li>
            ))}
          </ol>
        ) : (
          <Empty title="无步骤记录" text="宿主未上报装配步骤。" />
        )}
      </section>

      {meta ? (
        <section className="st-sec">
          <h4 className="micro st-sec-title">上下文</h4>
          <div className="st-meta">
            {Object.entries(meta).map(([k, v]) => {
              const val = String(v);
              return (
                <div key={k} className="st-meta-row">
                  <span className="st-meta-key truncate" title={k}>
                    {k}
                  </span>
                  <span className="st-meta-val mono truncate" title={val}>
                    {val}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function KvCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="st-kv-cell">
      <span className="micro st-kv-label">{label}</span>
      <span className="num st-kv-value truncate" title={value}>
        {value}
      </span>
    </div>
  );
}
