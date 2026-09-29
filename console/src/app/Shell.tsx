import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import {
  CirclePause,
  CirclePlay,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
} from "lucide-react";
import { useTelemetry, useWallNow } from "@/hooks/useTelemetry";
import { LIVE_MS, n, uptime } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/i18n";
import { NAV, NAV_GROUPS, activeNav, isActive } from "./nav";
import { toggleScheme, usePrefs, setRail, setDensity } from "./prefs";
import { Badge, Dot, IconButton, Segmented, Tooltip } from "@/ui";
import type { Tone } from "@/ui";

type ConnTone = { tone: Tone; label: string };

function connTone(status: string): ConnTone {
  switch (status) {
    case "live":
      return { tone: "ok", label: STATUS_LABEL.live ?? "已连接" };
    case "paused":
      return { tone: "warn", label: STATUS_LABEL.paused ?? "已暂停" };
    case "reconnecting":
      return { tone: "warn", label: STATUS_LABEL.reconnecting ?? "重连中" };
    case "down":
      return { tone: "bad", label: STATUS_LABEL.down ?? "未连接" };
    default:
      return { tone: "info", label: STATUS_LABEL.boot ?? "连接中" };
  }
}

/** 品牌标记：三层堆叠,呼应「上下文 × 记忆 的栈」。 */
function BrandMark() {
  return (
    <span className="rail-mark" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 8.5 12 4l8 4.5-8 4.5-8-4.5Z" />
        <path d="M4 15.5 12 20l8-4.5" />
      </svg>
    </span>
  );
}

function Sidebar() {
  const { snap, viewSnap } = useTelemetry();
  const { rail } = usePrefs();
  const { pathname } = useLocation();
  const board = viewSnap ?? snap;
  const collapsed = rail === "collapsed";

  const counts: Record<string, number | undefined> = {
    "/stream": board?.turns.length,
    "/hosts": board?.hosts.length,
    "/topology": board?.ports.length,
    "/gateway": board?.gateway?.zones?.filter((z) => z.status === "running").length,
    "/cluster": board?.system?.activeWorkers?.length ?? (board?.system?.isCluster ? board?.system?.workersCount : 1),
  };

  return (
    <aside className="rail" aria-label="主导航">
      <div className="rail-brand">
        <BrandMark />
        <div className="rail-wordmark">
          <strong>CogniStack</strong>
          <span>上下文装配控制台</span>
        </div>
      </div>

      <nav className="rail-nav">
        {NAV_GROUPS.map((group) => (
          <div className="rail-group" key={group.id}>
            <p className="rail-group-label micro">{group.label}</p>
            {NAV.filter((item) => item.group === group.id).map((item) => {
              const Icon = item.Icon;
              const active = isActive(item, pathname);
              const count = counts[item.to];
              const link = (
                <NavLink
                  to={item.to}
                  end={item.end}
                  className="rail-item"
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon aria-hidden />
                  <span className="rail-item-label truncate">{item.label}</span>
                  {typeof count === "number" ? <span className="rail-item-count">{count}</span> : null}
                </NavLink>
              );
              return collapsed ? (
                <Tooltip key={item.to} label={item.label}>
                  {link}
                </Tooltip>
              ) : (
                <div key={item.to}>{link}</div>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="rail-foot">
        <IconButton
          className="rail-collapse"
          label={collapsed ? "展开导航" : "收起导航"}
          onClick={() => setRail(collapsed ? "expanded" : "collapsed")}
        >
          {collapsed ? <PanelLeftOpen size={15} aria-hidden /> : <PanelLeftClose size={15} aria-hidden />}
        </IconButton>
      </div>
    </aside>
  );
}

function AppHeader() {
  const { pathname } = useLocation();
  const { paused, setPaused } = useTelemetry();
  const { scheme, density } = usePrefs();
  const item = activeNav(pathname);

  return (
    <header className="header">
      <div className="header-title">
        <h1 className="truncate">{item.label}</h1>
        <p className="desc truncate" title={item.desc}>
          {item.desc}
        </p>
      </div>

      {/* 连接状态只在底部状态栏出现一次 —— 顶栏是"操作区",不是"读数区" */}
      <div className="header-tools">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={paused}
          data-active={paused ? "true" : undefined}
          title={paused ? "继续接收实时数据 (快捷键: P)" : "冻结列表以便逐行查看 (快捷键: P)"}
          onClick={() => setPaused(!paused)}
        >
          {paused ? <CirclePlay size={14} aria-hidden /> : <CirclePause size={14} aria-hidden />}
          {paused ? "继续" : "暂停"}
        </button>

        <Segmented
          label="界面密度"
          value={density}
          onChange={setDensity}
          options={[
            { value: "comfortable", label: "舒适" },
            { value: "compact", label: "紧凑" },
          ]}
        />

        <IconButton label={scheme === "dark" ? "切换到浅色主题 (快捷键: T)" : "切换到深色主题 (快捷键: T)"} onClick={toggleScheme}>
          {scheme === "dark" ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}
        </IconButton>
      </div>
    </header>
  );
}

function StatusBar() {
  const { snap, viewSnap, status, authHint, liveRun } = useTelemetry();
  const now = useWallNow();
  const board = viewSnap ?? snap;
  const conn = connTone(status);
  // 全站唯一的连接读数：liveRun 在跑时改写成"装配中",否则报连接状态本身
  const connText = liveRun?.phase === "running" ? "装配中" : conn.label;

  const calls = board?.hosts.reduce((a, h) => a + h.calls, 0) ?? 0;
  const hits = board?.hosts.reduce((a, h) => a + h.cacheHits, 0) ?? 0;
  const degraded = board?.hosts.reduce((a, h) => a + h.degradedCalls, 0) ?? 0;
  const liveHosts = board?.hosts.filter((h) => now - h.lastSeen < LIVE_MS).length ?? 0;
  const totalHosts = board?.hosts.length ?? 0;
  const started = board?.hosts.length ? Math.min(...board.hosts.map((h) => h.firstSeen)) : 0;

  return (
    <footer className="statusbar" aria-label="状态栏">
      {/* 顶边那道掠光是"正在接收"的信号,而不是装饰:reduced-motion 下会真的停住 */}
      <span className="rail-dash sb-live" aria-hidden />

      <span className="sb-item" title={`遥测连接：${conn.label}`}>
        <Dot tone={conn.tone} />
        {connText}
      </span>

      {authHint ? (
        <span className="sb-item" data-tone="bad">
          {authHint}
        </span>
      ) : null}

      <span className="sb-sep" aria-hidden>
        |
      </span>

      <span className="sb-item">
        调用 <b>{n(calls)}</b>
      </span>
      <span className="sb-item">
        缓存 <b>{n(hits)}</b>
      </span>
      <span className="sb-item" data-tone={degraded > 0 ? "bad" : undefined}>
        降级 <b>{degraded}</b>
      </span>

      <span className="sb-item sb-opt">
        在线{" "}
        <b>
          {liveHosts}/{totalHosts}
        </b>
      </span>

      {started ? (
        <span className="sb-item sb-opt">
          运行 <b>{uptime(now - started)}</b>
        </span>
      ) : null}

      <span className="sb-spacer" />

      <span className="sb-item sb-opt">
        回合 <b>{n(board?.totalTurns ?? 0)}</b>
      </span>
      <span className="sb-item sb-opt">
        <Badge tone="neutral" variant="plain">
          v{board?.version ?? "—"}
        </Badge>
      </span>
    </footer>
  );
}

export function Shell() {
  const { rail, density } = usePrefs();
  const { paused, setPaused } = useTelemetry();
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const key = e.key.toLowerCase();
      if (key === "1") {
        navigate("/");
      } else if (key === "2") {
        navigate("/stream");
      } else if (key === "3") {
        navigate("/hosts");
      } else if (key === "4") {
        navigate("/topology");
      } else if (key === "5") {
        navigate("/playground");
      } else if (key === "6") {
        navigate("/settings");
      } else if (key === "t") {
        toggleScheme();
      } else if (key === "d") {
        setDensity(density === "comfortable" ? "compact" : "comfortable");
      } else if (key === "p") {
        setPaused(!paused);
      } else if (key === "[" || key === "]") {
        setRail(rail === "collapsed" ? "expanded" : "collapsed");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [density, navigate, paused, rail, setPaused]);

  return (
    <div className="app" data-rail={rail}>
      <Sidebar />
      <div className="stage">
        <AppHeader />
        <main className="main" aria-label="工作区">
          <Outlet />
        </main>
      </div>
      <StatusBar />
    </div>
  );
}