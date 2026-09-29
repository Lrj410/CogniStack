/**
 * Telemetry transport — rebuilt.
 *
 * Contract:
 * - One EventSource at a time; on drop, remint stream-ticket and reopen (tickets are one-shot).
 * - Progress is reduced into a LiveRun (accumulated stages), never a single slot.
 * - Pause freezes the turn snapshot for inspection; LiveRun ALWAYS updates.
 * - Snapshot hitchhikes `progress` so reconnect mid-run resumes the board.
 * - Conn: OPEN = live; error → reconnecting; auth 401 → down until key changes.
 * - Sep. tick: useWallNow() subscribes independently so the 1s heartbeat does not
 *   rebuild the main context value (tables / charts stay put).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TelemetrySnapshot, TurnRecord } from "../lib/types";
import { apiHeaders, apiUrl, streamUrl } from "../lib/apiKey";
import { STAGE_META } from "../lib/i18n";

export type PipelineProgress = {
  runId: string;
  hostId: string;
  hostName?: string;
  mode: string;
  stage: string;
  phase: "start" | "end";
  ms?: number;
  at: number;
};

export type StageMark = {
  state: "idle" | "running" | "done";
  ms?: number;
};

export type LiveRun = {
  runId: string;
  hostId: string;
  hostName?: string;
  mode: string;
  phase: "idle" | "running" | "done";
  stages: Record<string, StageMark>;
  banner: string;
  updatedAt: number;
};

export type ConnStatus = "boot" | "live" | "reconnecting" | "down";

type TelemetryCtx = {
  snap: TelemetrySnapshot | null;
  /** Frozen copy while paused; equals snap when not paused. */
  viewSnap: TelemetrySnapshot | null;
  conn: ConnStatus;
  status: "boot" | "live" | "down" | "paused" | "reconnecting";
  paused: boolean;
  setPaused: (v: boolean) => void;
  refresh: () => void;
  reset: () => Promise<void>;
  /** Accumulated live pipeline — owns the Shell board. */
  liveRun: LiveRun | null;
  latestTurn: TurnRecord | null;
  authHint: string | null;
};

const Ctx = createContext<TelemetryCtx | null>(null);

/* ------------------------------------------------------------------ *
 * 独立于主 context 的墙钟心跳：只有调用 useWallNow() 的组件每秒重渲染，
 * 避免带动回合表格 / 图表一起刷新。
 * ------------------------------------------------------------------ */
let wallNow = Date.now();
const wallListeners = new Set<() => void>();
let wallTimer: ReturnType<typeof setInterval> | null = null;

function subscribeWall(cb: () => void) {
  wallListeners.add(cb);
  if (wallListeners.size === 1) {
    wallNow = Date.now();
    wallTimer = setInterval(() => {
      wallNow = Date.now();
      for (const l of wallListeners) l();
    }, 1000);
  }
  return () => {
    wallListeners.delete(cb);
    if (!wallListeners.size && wallTimer) {
      clearInterval(wallTimer);
      wallTimer = null;
    }
  };
}

function getWallNow() {
  return wallNow;
}

/** Client wall clock — ticks ~1s so age/uptime stay honest. */
export function useWallNow(): number {
  return useSyncExternalStore(subscribeWall, getWallNow, getWallNow);
}

function labelOf(stage: string) {
  return STAGE_META.find((s) => s.key === stage)?.label ?? stage;
}

/** Pure reducer: progress events → LiveRun. */
export function reduceLiveRun(prev: LiveRun | null, ev: PipelineProgress): LiveRun {
  if (ev.stage === "_run" && ev.phase === "start") {
    return {
      runId: ev.runId,
      hostId: ev.hostId,
      hostName: ev.hostName,
      mode: ev.mode,
      phase: "running",
      stages: {},
      banner: "收到请求，开始装配…",
      updatedAt: ev.at,
    };
  }

  const base: LiveRun =
    prev && prev.runId === ev.runId
      ? prev
      : {
          runId: ev.runId,
          hostId: ev.hostId,
          hostName: ev.hostName,
          mode: ev.mode,
          phase: "running",
          stages: {},
          banner: prev?.banner ?? "装配中…",
          updatedAt: ev.at,
        };

  if (ev.stage === "_run" && ev.phase === "end") {
    return {
      ...base,
      hostName: ev.hostName ?? base.hostName,
      mode: ev.mode || base.mode,
      phase: "done",
      banner: "本回合装配完成",
      updatedAt: ev.at,
    };
  }

  const stages = { ...base.stages };
  if (ev.phase === "start") {
    stages[ev.stage] = { state: "running", ms: stages[ev.stage]?.ms };
    return {
      ...base,
      hostName: ev.hostName ?? base.hostName,
      phase: "running",
      stages,
      banner: `正在：${labelOf(ev.stage)}`,
      updatedAt: ev.at,
    };
  }

  stages[ev.stage] = {
    state: "done",
    ms: ev.ms ?? stages[ev.stage]?.ms,
  };
  return {
    ...base,
    hostName: ev.hostName ?? base.hostName,
    phase: "running",
    stages,
    banner: `完成：${labelOf(ev.stage)}`,
    updatedAt: ev.at,
  };
}

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<TelemetrySnapshot | null>(null);
  const [frozenSnap, setFrozenSnap] = useState<TelemetrySnapshot | null>(null);
  const [paused, setPausedState] = useState(false);
  const [conn, setConn] = useState<ConnStatus>("boot");
  const [liveRun, setLiveRun] = useState<LiveRun | null>(null);
  const [authHint, setAuthHint] = useState<string | null>(null);
  const [keyTick, setKeyTick] = useState(0);

  const pausedRef = useRef(paused);
  const esRef = useRef<EventSource | null>(null);
  const lastProgAt = useRef(0);
  const authBlockedRef = useRef(false);
  const mountedRef = useRef(true);

  // 渲染期写 ref 是反模式（并发渲染下可能写入未提交的那次渲染），改为提交后同步
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyProgress = useCallback((ev: PipelineProgress) => {
    if (!ev || typeof ev.at !== "number") return;
    if (ev.at < lastProgAt.current && ev.stage !== "_run") return;
    lastProgAt.current = Math.max(lastProgAt.current, ev.at);
    setLiveRun((prev) => reduceLiveRun(prev, ev));
  }, []);

  const ingestSnap = useCallback(
    (s: TelemetrySnapshot) => {
      setSnap(s);
      setConn("live");
      setAuthHint(null);
      authBlockedRef.current = false;
      if (!pausedRef.current) setFrozenSnap(null);
      if (s.progress) applyProgress(s.progress as PipelineProgress);
    },
    [applyProgress],
  );

  const setPaused = useCallback(
    (v: boolean) => {
      setPausedState(v);
      if (v) setFrozenSnap(snap);
      else setFrozenSnap(null);
    },
    [snap],
  );

  const blockAuth = useCallback((hint: string) => {
    authBlockedRef.current = true;
    const es = esRef.current;
    if (es) {
      es.close();
      esRef.current = null;
    }
    if (!mountedRef.current) return;
    setAuthHint(hint);
    setConn("down");
  }, []);

  const refresh = useCallback(() => {
    fetch(apiUrl("/api/snapshot"), { headers: apiHeaders() })
      .then(async (r) => {
        if (r.status === 401) {
          blockAuth("需要 API Key — 请到「设置」填写");
          throw new Error("401");
        }
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((s: TelemetrySnapshot) => {
        if (mountedRef.current) ingestSnap(s);
      })
      .catch(() => {
        if (mountedRef.current && !authBlockedRef.current) {
          setConn((c) => (c === "live" ? "reconnecting" : "down"));
        }
      });
  }, [ingestSnap, blockAuth]);

  const reset = useCallback(async () => {
    try {
      // 必须带 application/json：服务端把"无 Content-Type 的 POST"视为跨站
      // 简单请求而拒绝（CSRF 防护）。
      const r = await fetch(apiUrl("/api/reset"), {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }),
        body: "{}",
      });
      if (!mountedRef.current) return;
      if (r.status === 401) {
        blockAuth("需要 API Key — 请到「设置」填写");
        return;
      }
      if (!r.ok) {
        setAuthHint(`清空失败（HTTP ${r.status}）`);
        return;
      }
      lastProgAt.current = 0;
      setLiveRun(null);
      setSnap(null);
      setFrozenSnap(null);
      refresh();
    } catch {
      if (mountedRef.current) setAuthHint("清空失败 — 网络错误");
    }
  }, [refresh, blockAuth]);

  useEffect(() => {
    const onKey = () => {
      authBlockedRef.current = false;
      setKeyTick((n) => n + 1);
    };
    window.addEventListener("cs-api-key", onKey);
    return () => window.removeEventListener("cs-api-key", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    authBlockedRef.current = false;
    refresh();

    const detach = (es: EventSource) => {
      es.onopen = null;
      es.onerror = null;
      es.onmessage = null;
      es.close();
    };

    const scheduleReopen = (ms = 1500) => {
      if (cancelled || authBlockedRef.current) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        void openStream();
      }, ms);
    };

    async function openStream() {
      if (cancelled || authBlockedRef.current) return;
      if (esRef.current) {
        detach(esRef.current);
        esRef.current = null;
      }
      setConn((c) => (c === "boot" ? c : "reconnecting"));

      let url: string;
      try {
        url = await streamUrl("/api/stream");
      } catch {
        scheduleReopen(2000);
        return;
      }
      if (cancelled || authBlockedRef.current) return;

      const es = new EventSource(url);
      esRef.current = es;

      const onSnap = (ev: MessageEvent) => {
        try {
          ingestSnap(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      };
      const onProg = (ev: MessageEvent) => {
        try {
          applyProgress(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      };

      es.addEventListener("snapshot", onSnap);
      es.addEventListener("progress", onProg);
      es.onmessage = onSnap;

      es.onopen = () => {
        if (authBlockedRef.current) {
          detach(es);
          return;
        }
        setConn("live");
        setAuthHint(null);
      };

      es.onerror = () => {
        es.removeEventListener("snapshot", onSnap);
        es.removeEventListener("progress", onProg);
        detach(es);
        if (esRef.current === es) esRef.current = null;
        if (cancelled || authBlockedRef.current) return;

        setConn("reconnecting");
        fetch(apiUrl("/api/snapshot"), { headers: apiHeaders() })
          .then((r) => {
            if (cancelled || !mountedRef.current) return;
            if (r.status === 401) {
              blockAuth("需要 API Key — 请到「设置」填写");
              return;
            }
            // Remint ticket + reopen (one-shot tickets cannot be reused).
            scheduleReopen(1200);
          })
          .catch(() => {
            if (!cancelled && mountedRef.current) scheduleReopen(2500);
          });
      };
    }

    void openStream();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (esRef.current) {
        detach(esRef.current);
        esRef.current = null;
      }
    };
  }, [ingestSnap, applyProgress, refresh, keyTick, blockAuth]);

  const viewSnap = paused ? (frozenSnap ?? snap) : snap;
  const latestTurn = viewSnap?.turns[0] ?? null;

  const status: TelemetryCtx["status"] = paused
    ? "paused"
    : conn === "boot"
      ? "boot"
      : conn;

  const value = useMemo(
    () => ({
      snap,
      viewSnap,
      conn,
      status,
      paused,
      setPaused,
      refresh,
      reset,
      liveRun,
      latestTurn,
      authHint,
    }),
    [
      snap,
      viewSnap,
      conn,
      status,
      paused,
      setPaused,
      refresh,
      reset,
      liveRun,
      latestTurn,
      authHint,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTelemetry() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTelemetry outside provider");
  return v;
}

