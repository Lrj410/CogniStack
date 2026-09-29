import { useMemo } from "react";
import { STAGE_META } from "@/lib/i18n";
import { dur } from "@/lib/format";
import type { LiveRun, StageMark } from "@/hooks/useTelemetry";
import type { TurnRecord } from "@/lib/types";

type CellState = StageMark["state"];

type Cell = {
  key: string;
  label: string;
  color: string;
  state: CellState;
  ms: number;
};

/**
 * 装配阶段导轨。
 *
 * 有实时事件时以实时为准（正在跑的阶段标 running）,没有就回落到最近一回合的
 * timings —— 否则页面在两次请求之间会整片熄火,看不出「上一次跑了什么」。
 */
export function StageRail({
  liveRun,
  lastTurn,
}: {
  liveRun: LiveRun | null;
  lastTurn: TurnRecord | null;
}) {
  const live = liveRun?.phase === "running";

  const cells = useMemo<Cell[]>(() => {
    return STAGE_META.map((meta) => {
      const fromLive = liveRun?.stages[meta.key];
      const turnMs = Number(lastTurn?.timings?.[meta.key]) || 0;

      if (live) {
        const state = fromLive?.state ?? "idle";
        return {
          key: meta.key,
          label: meta.label,
          color: meta.color,
          state,
          ms: fromLive?.ms ?? (state === "done" ? turnMs : 0),
        };
      }
      // justDone 或常态：以最近一轮真实产出的 timings 为准展示已完成的各阶段耗时
      return {
        key: meta.key,
        label: meta.label,
        color: meta.color,
        state: (turnMs > 0 || lastTurn) ? "done" : "idle",
        ms: turnMs,
      };
    });
  }, [liveRun, lastTurn, live]);

  const total = cells.reduce((a, c) => a + (c.ms || 0), 0);

  return (
    <section className="stage-rail" aria-label="装配流水线">
      {cells.map((c) => {
        let width = 0;
        if (c.state === "running") {
          width = 100;
        } else if (c.state === "done") {
          width = total > 0 ? Math.max(12, Math.min(100, (c.ms / total) * 100)) : 15;
        }
        return (
          <div className="stage-cell" key={c.key} data-state={c.state}>
            <div className="stage-cell-head">
              <span className="stage-cell-name truncate" title={c.label}>
                {c.label}
              </span>
              <span className="stage-cell-ms">
                {c.state === "running" ? "运行中" : c.ms > 0 ? dur(c.ms) : c.state === "done" ? "<1µs" : "—"}
              </span>
            </div>
            <div className="stage-cell-track">
              <div
                className="stage-cell-fill"
                style={{
                  ["--fill" as string]: (width / 100).toFixed(4),
                  ["--stage-color" as string]: c.color,
                }}
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}