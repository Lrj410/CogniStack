import { useId, useMemo, useRef, useState } from "react";
import { cx } from "@/ui";
import type { Tone } from "@/ui";

export type ChartPoint = { x: number; y: number };

const VIEW_W = 100;
const VIEW_H = 100;
const PAD_Y = 7;

/**
 * 面积图。
 *
 * 用 viewBox + preserveAspectRatio="none" 让路径横向自适应,配合
 * vector-effect="non-scaling-stroke" 保持 1.5px 线宽不随拉伸变形;
 * 轴标全部留在 HTML 层,免得被非等比缩放拉歪。
 *
 * 键盘可达：聚焦后 ←/→ 移动游标,Home/End 跳到端点。
 */
export function AreaChart({
  data,
  height = 168,
  tone = "brand",
  formatY,
  formatX,
  label,
  unit,
}: {
  data: ChartPoint[];
  height?: number;
  tone?: Tone;
  formatY: (v: number) => string;
  formatX: (x: number) => string;
  label: string;
  unit?: string;
}) {
  /*
   * 每个实例一个稳定且唯一的渐变 id。
   * 曾用 `Math.random()`：既是渲染期非纯调用（React Compiler 因此跳过优化），
   * 又不是稳定值。改用 useId 后，同一次挂载内 id 恒定，且不同图表互不串用。
   * 过滤非字母数字字符 —— useId 的返回值带 `:` 等字符，放进 `url(#…)` 不安全。
   */
  const gradId = `cs-area-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const model = useMemo(() => {
    if (data.length < 2) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const p of data) {
      if (p.y < min) min = p.y;
      if (p.y > max) max = p.y;
    }
    const spread = max - min;
    const lo = spread > 0 ? Math.max(0, min - spread * 0.18) : Math.max(0, min * 0.9);
    const hi = spread > 0 ? max + spread * 0.18 : max * 1.1 + 1;

    const inner = VIEW_H - PAD_Y * 2;
    const px = (i: number) => (i / (data.length - 1)) * VIEW_W;
    const py = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * inner;

    const line = data.map((p, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(2)},${py(p.y).toFixed(2)}`).join(" ");
    const area = `${line} L${VIEW_W},${VIEW_H - PAD_Y} L0,${VIEW_H - PAD_Y} Z`;

    const ticks = [0, 1, 2, 3].map((k) => {
      const value = hi - (k / 3) * (hi - lo);
      return { value, y: PAD_Y + (k / 3) * inner };
    });

    return { line, area, ticks, lo, hi, min, max, last: data[data.length - 1]!.y };
  }, [data]);

  if (!model) return null;

  const point = active != null ? data[active] : null;
  const cursorPct =
    active != null && data.length > 1 ? (active / (data.length - 1)) * 100 : 0;
  const cursorY =
    point != null ? PAD_Y + (1 - (point.y - model.lo) / (model.hi - model.lo)) * (VIEW_H - PAD_Y * 2) : 0;

  function pick(clientX: number) {
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    const idx = Math.round(ratio * (data.length - 1));
    setActive(Math.max(0, Math.min(data.length - 1, idx)));
  }

  function move(delta: number) {
    setActive((prev) => {
      const base = prev ?? data.length - 1;
      return Math.max(0, Math.min(data.length - 1, base + delta));
    });
  }

  const summary = `${label}：最近 ${formatY(model.last)}${unit ?? ""}，最低 ${formatY(model.min)}，最高 ${formatY(model.max)}，共 ${data.length} 个采样点`;

  return (
    <div className={cx("chart", `tone-${tone}`)}>
      <div className="chart-plot" style={{ height }}>
        <div className="chart-axis" aria-hidden>
          {model.ticks.map((t) => (
            <span key={t.y} style={{ insetBlockStart: `${(t.y / VIEW_H) * 100}%` }}>
              {formatY(t.value)}
            </span>
          ))}
        </div>

        <div
          className="chart-stage"
          ref={plotRef}
          tabIndex={0}
          role="img"
          aria-label={summary}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "Home") {
              e.preventDefault();
              setActive(0);
            } else if (e.key === "End") {
              e.preventDefault();
              setActive(data.length - 1);
            } else if (e.key === "Escape") {
              setActive(null);
            }
          }}
        >
          <svg
            className="chart-svg"
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            height={height}
            aria-hidden
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                {/* 颜色走 CSS 类：`stop-color` / `stop-opacity` 是 CSS 属性，
                    写在类里可靠地跟随主题与 tone；写成表现属性则不吃 var()。 */}
                <stop className="chart-area-stop-a" offset="0%" />
                <stop className="chart-area-stop-b" offset="100%" />
              </linearGradient>
            </defs>

            {model.ticks.map((t) => (
              <line
                key={t.y}
                className="chart-grid"
                x1={0}
                y1={t.y}
                x2={VIEW_W}
                y2={t.y}
              />
            ))}

            <path d={model.area} fill={`url(#${gradId})`} />
            <path className="chart-line" d={model.line} />

            {active != null ? (
              <line className="chart-cursor" x1={cursorPct} y1={PAD_Y - 3} x2={cursorPct} y2={VIEW_H - PAD_Y + 3} />
            ) : null}
          </svg>

          {active != null ? (
            <span
              className="chart-dot"
              style={{
                insetInlineStart: `${cursorPct}%`,
                insetBlockStart: `${(cursorY / VIEW_H) * 100}%`,
              }}
              aria-hidden
            />
          ) : null}

          {point ? (
            <div
              className="chart-tip"
              style={{
                insetInlineStart: `${Math.max(10, Math.min(90, cursorPct))}%`,
                insetBlockStart: `${(cursorY / VIEW_H) * 100}%`,
              }}
            >
              <span className="k">{formatX(point.x)}</span>
              <b>
                {formatY(point.y)}
                {unit ?? ""}
              </b>
            </div>
          ) : null}
        </div>
      </div>

      <p className="chart-foot">
        <span>
          最近 <b>{formatY(model.last)}{unit ?? ""}</b>
        </span>
        <span>
          最低 <b>{formatY(model.min)}</b>
        </span>
        <span>
          最高 <b>{formatY(model.max)}</b>
        </span>
        <span className="sb-spacer" />
        <span>{data.length} 点</span>
      </p>
    </div>
  );
}