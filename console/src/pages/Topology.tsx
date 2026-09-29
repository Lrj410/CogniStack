import { Boxes } from "lucide-react";
import { useTelemetry } from "@/hooks/useTelemetry";
import type { PortDiagnostic, PortReport, TelemetrySnapshot } from "@/lib/types";
import {
  Alert,
  Badge,
  Code,
  Empty,
  Panel,
  PanelBody,
  PanelHead,
  Row,
  cx,
} from "@/ui";
import type { Tone } from "@/ui";
import { Blocked, PageScroll } from "@/app/Page";
import "./topology.css";

/**
 * 接入拓扑页 —— 端口接线归属。
 *
 * 端口归属由宿主的 PortRegistry 持有，控制台只能读宿主上报的数据；
 * `POST /api/ports` 带 `engine.portDiagnostics()` 时才看得到真实归属与「接上了却没生效」
 * 的被压制方，否则退化为用 host 声明拼出的粗略视图（并显式标注）。
 */

const PORT_LABEL: Record<string, string> = {
  tools: "工具与函数 (Tools)",
  mcp: "MCP 资源协议 (MCP)",
  lore: "知识资料 (Lore / RAG)",
  vector: "语义召回 (Vector)",
  card: "Agent 档案 (Profile)",
  macros: "宏变量绑定 (Macros)",
  state: "会话状态 (State)",
  preset: "系统预设 (Preset)",
  regex: "找替脚本 (Regex)",
};

/** `source` 枚举的展示名：构造注入 / wire() 不在注册表里，必须单独说明来源。 */
const SOURCE_LABEL: Record<string, string> = {
  connection: "连接注册",
  constructor: "构造注入",
  builtin: "引擎内建",
  none: "无",
};

function labelFor(port: string): string {
  return PORT_LABEL[port] ?? port;
}

function sourceFor(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** 状态字符串：把 source 读进来，否则构造注入会误报「未接入」。 */
function statusOf(d: PortDiagnostic): string {
  if (!d.bound) return "未接入";
  if (d.source === "constructor") return "构造注入";
  if (d.winner.builtin) return "引擎缺省";
  return `已接线${d.shadowed.length ? " · 争抢" : ""}`;
}

function winnerOf(d: PortDiagnostic): string | null {
  const w = d.winner;
  if (w.providerName && w.priority != null) return `${w.providerName} · p${w.priority}`;
  return w.providerName ?? null;
}

function collectPorts(snap: TelemetrySnapshot, reports: PortReport[]): string[] {
  const set = new Set<string>();
  if (reports.length) {
    for (const r of reports) for (const p of r.ports) set.add(p.port);
  } else {
    for (const p of snap.ports) set.add(p);
    for (const h of snap.hosts) {
      for (const p of h.provides) set.add(p);
      for (const p of h.requires) set.add(p);
    }
  }
  return [...set].sort();
}

export function TopologyPage() {
  const { viewSnap, status } = useTelemetry();

  if (status === "down") {
    return <Blocked title="拓扑" text="API 未连接…" />;
  }
  const snap = viewSnap;
  if (!snap) {
    return <Blocked busy title="拓扑" text="正在读取端口接线…" />;
  }

  const reports: PortReport[] = snap.portDiagnostics ?? [];
  const allPorts = collectPorts(snap, reports);

  const total = reports.reduce((a, r) => a + r.ports.length, 0);
  const bound = reports.reduce((a, r) => a + r.ports.filter((p) => p.bound).length, 0);
  const shadowed = reports.reduce(
    (a, r) => a + r.ports.reduce((b, p) => b + p.shadowed.length, 0),
    0,
  );
  const sub = reports.length
    ? `${bound}/${total} 已绑定 · ${shadowed} 被压制`
    : "尚无宿主上报诊断";

  return (
    <PageScroll>
      <Alert tone="info" title="端口与拓扑机制">
        端口归属由宿主进程持有，宿主上报 <Code>POST /api/ports</Code>（附 <Code>engine.portDiagnostics()</Code>）可暴露真实接线与被压制方。
        纯业务/对话调用方直接使用引擎原生内建预算与滑动窗口，无需外置接线。
      </Alert>

      <Panel>
        <PanelHead
          title="端口活动"
          sub={sub}
          right={reports.length ? undefined : <Badge tone="warn">粗略视图</Badge>}
        />
        <PanelBody className={reports.length ? "tp-reports" : undefined}>
          {reports.length === 0 ? (
            <CoarseView snap={snap} ports={allPorts} />
          ) : (
            reports.map((report) => (
              <Panel key={report.hostId}>
                <PanelHead
                  title={report.hostName}
                  right={
                    <span className="tp-hostid truncate" title={report.hostId}>
                      <Code>{report.hostId}</Code>
                    </span>
                  }
                />
                <PanelBody>
                  <div className="grid-3">
                    {report.ports.map((d) => (
                      <PortCard
                        key={d.port}
                        port={d.port}
                        state={!d.bound ? "unbound" : d.shadowed.length ? "contested" : "wired"}
                        tone={!d.bound ? "neutral" : d.shadowed.length ? "warn" : "brand"}
                        status={statusOf(d)}
                        winner={winnerOf(d)}
                        source={d.source ?? null}
                        shadowed={d.shadowed.map((s) => ({
                          id: s.providerId,
                          name: s.providerName,
                          priority: s.priority,
                        }))}
                      />
                    ))}
                  </div>
                </PanelBody>
              </Panel>
            ))
          )}
        </PanelBody>
      </Panel>
    </PageScroll>
  );
}

/** 未上报诊断时的粗略视图：只能看「哪些端口出现过」。 */
function CoarseView({ snap, ports }: { snap: TelemetrySnapshot; ports: string[] }) {
  if (ports.length === 0) {
    return (
      <Empty
        icon={<Boxes size={22} aria-hidden />}
        title="还没有端口活动"
        text="引擎不内置任何合成流量，空面板是正常状态。"
      />
    );
  }
  return (
    <div className="grid-3">
      {ports.map((port) => {
        const providers = snap.hosts.filter((h) => h.provides.includes(port));
        const bound = providers.length > 0;
        const contested = providers.length > 1;
        return (
          <PortCard
            key={port}
            port={port}
            state={!bound ? "unbound" : contested ? "contested" : "wired"}
            tone={!bound ? "neutral" : contested ? "warn" : "brand"}
            status={bound ? `${providers.length} 提供方` : "未见提供方"}
            winner={bound ? providers.map((h) => h.name).join("、") : null}
            shadowed={[]}
          />
        );
      })}
    </div>
  );
}

type PortState = "unbound" | "contested" | "wired";

function PortCard({
  port,
  state,
  tone,
  status,
  winner,
  source,
  shadowed,
}: {
  port: string;
  state: PortState;
  tone: Tone;
  status: string;
  winner: string | null;
  source?: string | null;
  shadowed: { id: string; name: string; priority: number }[];
}) {
  const label = labelFor(port);
  const effective = winner ? `生效 · ${winner}` : "生效 · —";
  const sourceText = source ? `来源 · ${sourceFor(source)}` : "";
  return (
    <article className={cx("tp-card", `tp-card--${state}`)}>
      <Row gap="var(--sp-3)" justify="space-between" wrap={false}>
        <span className="tp-label truncate" title={label}>
          {label}
        </span>
        <Badge tone={tone}>{status}</Badge>
      </Row>
      <p className="tp-port truncate" title={port}>
        {port}
      </p>
      <p className={cx("tp-line", "truncate")} title={effective}>
        <span className="tp-key">生效</span>
        <span className="tp-val">{winner ?? "—"}</span>
      </p>
      {source ? (
        <p className={cx("tp-line", "truncate")} title={sourceText}>
          <span className="tp-key">来源</span>
          <span className="tp-val">{sourceFor(source)}</span>
        </p>
      ) : null}
      {shadowed.length ? (
        <div className="tp-shadow">
          <p className="tp-shadow-title">被压制</p>
          <ul className="tp-shadow-list">
            {shadowed.map((s) => {
              const text = `${s.name} · p${s.priority}`;
              return (
                <li key={s.id} className="tp-shadow-item truncate" title={text}>
                  {text}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
