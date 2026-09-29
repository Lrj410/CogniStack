import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowRight, Gauge, Layers, Timer, Zap } from "lucide-react";
import { useTelemetry, useWallNow } from "@/hooks/useTelemetry";
import { clock, dur, hostAge, LIVE_MS, n } from "@/lib/format";
import { AGE_LABEL, modeLabel } from "@/lib/i18n";
import { computeAlerts } from "@/lib/alerts";
import type { TurnRecord } from "@/lib/types";
import {
  Alert,
  Badge,
  Chip,
  DataTable,
  Empty,
  Panel,
  PanelBody,
  PanelHead,
  Row,
  Stat,
} from "@/ui";
import { AreaChart, Sparkline, StageRail } from "@/charts";
import { Blocked, PageScroll } from "@/app/Page";
import "./overview.css";

export function OverviewPage() {
  const { viewSnap, status, authHint, liveRun, latestTurn } = useTelemetry();
  const snap = viewSnap;
  const [focusHost, setFocusHost] = useState("");
  // 走心跳时钟而不是裸 Date.now()：渲染期调用 Date.now 是非纯操作，
  // 且该值不会随心跳更新，会和页面上其它「在线 / 时长」读数对不上。
  const now = useWallNow();

  const scopedTurns = useMemo(() => {
    if (!snap) return [];
    return focusHost ? snap.turns.filter((t) => t.hostId === focusHost) : snap.turns;
  }, [snap, focusHost]);

  const chartData = useMemo(
    () =>
      [...scopedTurns]
        .slice(0, 40)
        .reverse()
        .map((t) => ({ x: t.seq, y: t.promptTokens })),
    [scopedTurns],
  );

  const recent = useMemo(() => scopedTurns.slice(0, 12), [scopedTurns]);
  const summary = useMemo(() => summarize(recent), [recent]);
  // 告警与在线主机数都依赖整份快照：包 memo，免得每次心跳都全量重算
  const alerts = useMemo(() => (snap ? computeAlerts(snap.turns) : []), [snap]);
  const liveHosts = useMemo(
    () => (snap ? snap.hosts.filter((h) => now - h.lastSeen < LIVE_MS).length : 0),
    [snap, now],
  );

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

  const banner = liveBanner(liveRun, latestTurn);

  return (
    <PageScroll>
      <div className="ov-focus">
        <span className="micro ov-focus-label">聚焦主机</span>
        <Chip active={!focusHost} onClick={() => setFocusHost("")}>
          全部
        </Chip>
        {snap.hosts.map((h) => (
          <Chip
            key={h.id}
            active={focusHost === h.id}
            title={h.id}
            onClick={() => setFocusHost(focusHost === h.id ? "" : h.id)}
          >
            {h.name}
          </Chip>
        ))}
      </div>

      {alerts.length ? (
        <section className="ov-alerts" aria-label="告警指示灯">
          {alerts.map((a) => (
            <Alert key={a.id} tone={a.tone} title={a.title}>
              {a.detail}
            </Alert>
          ))}
        </section>
      ) : null}

      <div className="ov-stats">
        <Stat
          label="提示词均值"
          icon={<Layers size={13} aria-hidden />}
          value={n(summary.avgTokens)}
          unit="tok"
          foot="近 12 回合"
        />
        <Stat
          label="缓存命中"
          icon={<Zap size={13} aria-hidden />}
          tone={summary.cachePct >= 50 ? "ok" : "neutral"}
          value={String(summary.cachePct)}
          unit="%"
          foot="装配缓存复用"
        />
        <Stat
          label="降级率"
          icon={<Activity size={13} aria-hidden />}
          tone={summary.degradedPct > 0 ? "bad" : "ok"}
          value={String(summary.degradedPct)}
          unit="%"
          foot={summary.degradedPct > 0 ? "存在失败兜底" : "无降级"}
        />
        <Stat
          label="平均耗时"
          icon={<Timer size={13} aria-hidden />}
          value={dur(summary.avgMs)}
          foot="单次装配"
        />
        <Stat
          label="预算填充"
          icon={<Gauge size={13} aria-hidden />}
          tone={summary.fillPct >= 85 ? "warn" : "neutral"}
          value={summary.fillPct ? String(summary.fillPct) : "—"}
          unit={summary.fillPct ? "%" : undefined}
          foot="相对软顶"
        />
        <Stat
          label="紧急丢弃"
          tone={summary.dropped > 0 ? "bad" : "ok"}
          value={String(summary.dropped)}
          unit="tok"
          foot={summary.dropped > 0 ? "提示词装不下" : "未触发裁剪"}
        />
      </div>

      <Panel>
        <PanelHead
          title="装配阶段"
          sub={
            <Row gap="var(--sp-3)" wrap={false}>
              <Badge tone={liveRun?.phase === "running" ? "brand" : "neutral"}>{banner.state}</Badge>
            </Row>
          }
          right={<span className="sub num">{snap.tps.toFixed(1)} 回合/s</span>}
        />
        <PanelBody>
          <div className="ov-banner">
            <div className="ov-banner-text truncate" title={banner.summary}>
              <span className="dot" data-tone={liveRun?.phase === "running" ? "brand" : "ok"} aria-hidden />
              <span className="truncate" title={banner.summary}>{banner.summary}</span>
            </div>
            {latestTurn ? (
              <div className="ov-banner-meta">
                <span>耗时 {dur(latestTurn.durationMs)}</span>
                <span>·</span>
                <span>{n(latestTurn.promptTokens)} tok</span>
                {latestTurn.prefix ? (
                  <>
                    <span>·</span>
                    <span>复用 {(latestTurn.prefix.reuseRatio * 100).toFixed(0)}%</span>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <StageRail liveRun={liveRun} lastTurn={latestTurn} />
        </PanelBody>
      </Panel>

      <div className="ov-split">
        <Panel>
          <PanelHead
            title="提示词长度"
            sub={focusHost ? "已聚焦单个主机" : "全部主机"}
            right={
              <Link className="btn btn--ghost btn--sm" to="/stream">
                回合
                <ArrowRight size={13} aria-hidden />
              </Link>
            }
          />
          <PanelBody>
            {chartData.length >= 2 ? (
              <AreaChart
                data={chartData}
                label="提示词长度"
                unit=" tok"
                formatY={(v) => n(v)}
                formatX={(x) => `#${x}`}
              />
            ) : (
              <Empty
                title="采样点不足"
                text="至少需要两个回合才能画出趋势,先让宿主发几次 prepare 请求。"
              />
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHead
            title="接入主机"
            sub={`${liveHosts}/${snap.hosts.length} 在线`}
            right={
              <Link className="btn btn--ghost btn--sm" to="/hosts">
                全部
                <ArrowRight size={13} aria-hidden />
              </Link>
            }
          />
          <PanelBody>
            {snap.hosts.length === 0 ? (
              <Empty
                title="暂无接入"
                text="客户端第一次调用 /v1/prepare 后才注册；只做健康检查的「测试连接」不会出现在这里。"
              />
            ) : (
              <div className="ov-hosts">
                {snap.hosts.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className="ov-host"
                    data-active={focusHost === h.id ? "true" : undefined}
                    aria-pressed={focusHost === h.id}
                    onClick={() => setFocusHost(focusHost === h.id ? "" : h.id)}
                  >
                    <span className="ov-host-main">
                      <span className="ov-host-name truncate" title={h.name}>
                        {h.name}
                      </span>
                      <span className="ov-host-meta">
                        <HostAge lastSeen={h.lastSeen} />
                        <span className="num">{n(h.calls)} 次</span>
                        {h.degradedCalls > 0 ? (
                          <span className="num" style={{ color: "var(--bad)" }}>
                            降级 {h.degradedCalls}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <Sparkline values={h.spark} tone={h.degradedCalls > 0 ? "warn" : "brand"} />
                  </button>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHead
          title="最近回合"
          sub={focusHost ? "已聚焦" : `${n(snap.totalTurns)} 回合累计`}
          right={
            <Link className="btn btn--ghost btn--sm" to="/stream">
              查看全部
              <ArrowRight size={13} aria-hidden />
            </Link>
          }
        />
        <PanelBody flush>
          <DataTable label="最近回合" minWidth={680}>
            <thead>
              <tr>
                <th>#</th>
                <th>时间</th>
                <th>主机</th>
                <th>模式</th>
                <th>词元</th>
                <th>耗时</th>
                <th>标记</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.seq}>
                  <td className="num">{t.seq}</td>
                  <td className="num">{clock(t.at)}</td>
                  <td className="truncate" title={t.hostName ?? t.hostId}>
                    {t.hostName ?? t.hostId}
                  </td>
                  <td>{modeLabel(t.mode)}</td>
                  <td className="num">{n(t.promptTokens)}</td>
                  <td className="num">{dur(t.durationMs)}</td>
                  <td>
                    <Row gap="var(--sp-2)" wrap={false}>
                      {t.cacheHit ? <Badge tone="warn">缓存</Badge> : null}
                      {t.degraded ? <Badge tone="bad">降级</Badge> : null}
                      {t.emergencyDropped > 0 ? (
                        <Badge tone="bad">丢 {t.emergencyDropped}</Badge>
                      ) : null}
                      {!t.cacheHit && !t.degraded && t.emergencyDropped === 0 ? (
                        <span className="micro">—</span>
                      ) : null}
                    </Row>
                  </td>
                </tr>
              ))}
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <Empty title="尚无回合" text="等宿主发来第一次装配请求。" />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </DataTable>
        </PanelBody>
      </Panel>
    </PageScroll>
  );
}

function HostAge({ lastSeen }: { lastSeen: number }) {
  const now = useWallNow();
  return <span>{AGE_LABEL[hostAge(lastSeen, now)]}</span>;
}

function liveBanner(
  liveRun: ReturnType<typeof useTelemetry>["liveRun"],
  latestTurn: TurnRecord | null,
): { state: string; summary: string } {
  if (liveRun?.phase === "running") return { state: "运行中", summary: liveRun.banner };
  if (liveRun?.phase === "done") {
    return {
      state: "刚完成",
      summary: `${liveRun.hostName ?? "主机"} · ${liveRun.banner}`,
    };
  }
  if (latestTurn) {
    return {
      state: "最近一次",
      summary: `${latestTurn.hostName ?? latestTurn.hostId} · #${latestTurn.seq} · ${modeLabel(
        latestTurn.mode,
      )} · ${dur(latestTurn.durationMs)} · ${n(latestTurn.promptTokens)} tok`,
    };
  }
  return { state: "空闲", summary: "等待宿主发起 prepare 请求" };
}

function summarize(turns: TurnRecord[]) {
  if (!turns.length) {
    return { avgTokens: 0, cachePct: 0, degradedPct: 0, avgMs: 0, fillPct: 0, dropped: 0 };
  }
  const fills = turns.map((t) => t.fill ?? 0).filter((f) => f > 0);
  return {
    avgTokens: turns.reduce((a, t) => a + t.promptTokens, 0) / turns.length,
    cachePct: Math.round((turns.filter((t) => t.cacheHit).length / turns.length) * 100),
    degradedPct: Math.round((turns.filter((t) => t.degraded).length / turns.length) * 100),
    avgMs: turns.reduce((a, t) => a + t.durationMs, 0) / turns.length,
    fillPct: fills.length ? Math.round((fills.reduce((a, f) => a + f, 0) / fills.length) * 100) : 0,
    dropped: turns.reduce((a, t) => a + t.emergencyDropped, 0),
  };
}
