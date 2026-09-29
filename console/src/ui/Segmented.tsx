import type { ReactNode } from "react";
import { useRef } from "react";
import { cx } from "./cx";

/**
 * 分段控件。用于 2–4 个互斥视图的切换。
 *
 * 语义是**互斥单选**，所以走 radiogroup/radio（而不是一组各自独立的
 * aria-pressed 开关）—— 读屏器因此能播报「N 选 1、当前选中哪项」，
 * 并支持方向键在组内移动（roving tabindex，整组只占一个 Tab 停留点）。
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function move(from: number, delta: number) {
    if (options.length === 0) return;
    const next = (from + delta + options.length) % options.length;
    const item = options[next]!;
    onChange(item.value);
    // 焦点跟着选中项走（roving tabindex 的标准行为）
    ref.current?.querySelectorAll<HTMLButtonElement>(".seg-btn")[next]?.focus();
  }

  return (
    <div className={cx("seg", className)} role="radiogroup" aria-label={label} ref={ref}>
      {options.map((o, i) => {
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="seg-btn"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0, 0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(options.length - 1, 0);
              }
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}