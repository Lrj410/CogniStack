import { useTelemetry, useWallNow } from "@/hooks/useTelemetry";
import { dur, hostAge, n } from "@/lib/format";
import { AGE_LABEL, modeLabel, rejectReasonLabel, zoneLabel } from "@/lib/i18n";
import type { GatewayRejects, HostStat } from "@/lib/types";
import { Alert, Badge, DataTable, Empty, Panel, PanelBody, PanelHead, Row, Code } from "@/ui";
import { Sparkline } from "@/charts";
import { Blocked, PageScroll } from "@/app/Page";
import "./hosts.css";

export function HostsPage() {
  const { viewSnap, status, authHint } = useTelemetry();
  const snap = viewSnap;

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

  const multiZone = (snap.gateway?.zones?.length ?? 0) > 1;
  const hostZones = snap.gateway?.hostZones;

  return (
    <PageScroll>
      {/* 被拒读数只在这一页报（全站同一条读数只报一次）。 */}
      <RejectsNote rejects={snap.gateway?.rejects} />

      {snap.hosts.length ? (
        <div className="grid-3">
          {snap.hosts.map((h) => {
            const z = hostZones?.[h.id]?.zone;
            return (
              <HostCard
                key={h.id}
                host={h}
                zoneBadge={multiZone && z && z !== "local" ? z : undefined}
              />
            );
          })}
        </div>
      ) : null}

      <Panel>
        <PanelHead
          title="主机明细"
          sub={`${snap.hosts.length} 接入 · 端口 ${snap.ports.join(" · ") || "无"}`}
        />
        <PanelBody flush>
          <DataTable minWidth={900} label="主机明细">
            <thead>
              <tr>
                <th>主机</th>
                <th>类型</th>
                <th>状态</th>
                <th>调用</th>
                <th>均值</th>
                <th>峰值</th>
                <th>缓存</th>
                <th>降级</th>
                <th>模式</th>
                <th>趋势</th>
              </tr>
            </thead>
            <tbody>
              {snap.hosts.map((h) => {
                const z = hostZones?.[h.id]?.zone;
                return (
                  <tr key={h.id}>
                    <td>
                      <div className="ho-host-cell">
                        <Row gap="var(--sp-2)">
                          <span className="ho-host-name truncate" title={h.name}>
                            {h.name}
                          </span>
                          {multiZone && z && z !== "local" ? (
                            <Badge tone="warn">{zoneLabel(z)}</Badge>
                          ) : null}
                        </Row>
                        <span className="ho-host-id truncate" title={h.id}>
                          {h.id}
                        </span>
                        {h.provides.length ? (
                          <Row gap="var(--sp-2)">
                            {h.provides.map((p) => (
                              <Badge key={p} tone="brand">
                                {`供 ${p}`}
                              </Badge>
                            ))}
                          </Row>
                        ) : null}
                      </div>
                    </td>
                    <td>{h.kind || "—"}</td>
                    <td>
                      <AgeBadge lastSeen={h.lastSeen} />
                    </td>
                    <td className="num">{n(h.calls)}</td>
                    <td className="num">{n(h.avgPromptTokens)}</td>
                    <td className="num">{n(h.maxPromptTokens)}</td>
                    <td className="num">{cachePercent(h)}%</td>
                    <td
                      className="num"
                      style={h.degradedCalls > 0 ? { color: "var(--bad)" } : undefined}
                    >
                      {h.degradedCalls}
                    </td>
                    <td>{modeLabel(h.lastMode)}</td>
                    <td>
                      <Sparkline values={h.spark} />
                    </td>
                  </tr>
                );
              })}
              {snap.hosts.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <Empty
                      title="暂无主机"
                      text="主机来自真实调用：客户端第一次 POST /v1/prepare（或显式 POST /api/host）后才注册。只做 GET /v1/health 的「测试连接」是纯探活，不会在这里留记录。"
                    />
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

function HostCard({ host: h, zoneBadge }: { host: HostStat; zoneBadge?: string }) {
  return (
    <Panel>
      <PanelBody>
        <div className="ho-card">
          <div className="ho-card-head">
            <div className="ho-card-id">
              <Row gap="var(--sp-2)">
                <span className="ho-card-name truncate" title={h.name}>
                  {h.name}
                </span>
                {zoneBadge ? <Badge tone="warn">{zoneLabel(zoneBadge)}</Badge> : null}
              </Row>
              <span className="ho-card-sub truncate" title={h.kind ? `${h.id} · ${h.kind}` : h.id}>
                {h.kind ? `${h.id} · ${h.kind}` : h.id}
              </span>
            </div>
            <AgeBadge lastSeen={h.lastSeen} />
          </div>

          <div className="ho-metrics">
            <Metric label="调用" value={n(h.calls)} />
            <Metric label="均值" value={n(h.avgPromptTokens)} />
            <Metric label="缓存" value={`${cachePercent(h)}%`} />
            <Metric label="降级" value={String(h.degradedCalls)} tone={h.degradedCalls > 0 ? "bad" : undefined} />
          </div>

          {h.provides.length ? (
            <Row gap="var(--sp-2)">
              {h.provides.slice(0, 4).map((p) => (
                <Badge key={p} tone="brand">
                  {`供 ${p}`}
                </Badge>
              ))}
            </Row>
          ) : null}

          <div className="ho-card-foot">
            <span className="micro">{modeLabel(h.lastMode)}</span>
            <Sparkline values={h.spark} tone={h.degradedCalls > 0 ? "warn" : "brand"} />
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

/** 标签在上、数值在下的迷你指标。 */
function Metric({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="ho-metric">
      <span className="micro">{label}</span>
      <span className="ho-metric-value num" data-tone={tone}>
        {value}
      </span>
    </div>
  );
}

/** 在线状态徽章：墙钟每秒推进,快照之间也不会「假在线」。 */
function AgeBadge({ lastSeen }: { lastSeen: number }) {
  const now = useWallNow();
  const age = hostAge(lastSeen, now);
  if (age === "live") return <Badge tone="ok">{AGE_LABEL.live}</Badge>;
  if (age === "idle") return <Badge tone="warn">{`${AGE_LABEL.idle} · ${dur(now - lastSeen)}`}</Badge>;
  return <Badge tone="neutral">{`${AGE_LABEL.off} · ${dur(now - lastSeen)}`}</Badge>;
}

function cachePercent(h: HostStat): number {
  return h.calls === 0 ? 0 : Math.round((h.cacheHits / h.calls) * 100);
}

/**
 * 被网关拒掉的请求。
 *
 * 这一块存在的唯一理由：把「客户端说它连上了、这里却什么都没有」拆成两种可区分的情况 ——
 * **它根本没调**（这里也不会有数字），与**它调了但被挡在门外**（这里有数字 + 真实原因）。
 * 被拒发生在进引擎之前，所以它不会出现在任何回合里；不报出来，就只剩「面板是空的」。
 */
function RejectsNote({ rejects }: { rejects?: GatewayRejects }) {
  if (!rejects || rejects.total === 0) return null;
  const last = rejects.last;
  const byZoneEntries = rejects.byZone
    ? Object.entries(rejects.byZone).filter(([, c]) => c > 0)
    : [];
  return (
    <Alert tone="warn" title={`有 ${n(rejects.total)} 次请求被网关拒绝（未进入引擎）`}>
      <p>
        最近一次：
        {last ? (
          <>
            <Code>{`${last.method ?? ""} ${last.path ?? ""}`.trim() || "请求"}</Code>{" "}
            · {rejectReasonLabel(last.reason)}
            {last.zone ? <> · {zoneLabel(last.zone)}段</> : null}
            {last.detail ? <> · {last.detail}</> : null}
          </>
        ) : (
          "（记录已过期）"
        )}
      </p>
      <p>
        按原因：
        {Object.entries(rejects.byReason)
          .map(([r, c]) => `${rejectReasonLabel(r)} ${c}`)
          .join(" · ")}
      </p>
      {byZoneEntries.length > 0 ? (
        <p>
          按段：
          {byZoneEntries.map(([z, c]) => `${zoneLabel(z)} ${c}`).join(" · ")}
        </p>
      ) : null}
    </Alert>
  );
}
