import { cx } from "@/ui";
import type { Tone } from "@/ui";

/**
 * 迷你走势。纯 polyline,不引图表库。
 * 少于两个点时不画线,只留一条基线 —— 单点连不成趋势,画个点会误导。
 */
export function Sparkline({
  values,
  width = 72,
  height = 20,
  tone = "brand",
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: Tone;
  className?: string;
}) {
  const base = (
    <line className="spark-base" x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} />
  );

  if (!values || values.length < 2) {
    return (
      <svg className={cx("spark", className)} width={width} height={height} aria-hidden>
        {base}
      </svg>
    );
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1, max - min);
  const step = width / (values.length - 1);
  const top = 2;
  const usable = Math.max(1, height - 4);

  const points = values
    .map((v, i) => `${(i * step).toFixed(2)},${(top + (1 - (v - min) / span) * usable).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      className={cx("spark", `tone-${tone}`, className)}
      width={width}
      height={height}
      aria-hidden
    >
      {base}
      <polyline className="spark-line" points={points} />
    </svg>
  );
}