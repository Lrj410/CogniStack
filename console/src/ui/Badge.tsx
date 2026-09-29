import type { ReactNode } from "react";
import { cx } from "./cx";
import type { Tone } from "./feedback";

export type BadgeProps = {
  tone?: Tone;
  variant?: "soft" | "solid" | "outline" | "plain";
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
};

export function Badge({
  tone = "neutral",
  variant = "soft",
  icon,
  title,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={cx(
        "badge",
        `badge--${variant}`,
        variant !== "plain" && `tone-${tone}`,
        className,
      )}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}

/** 状态圆点。仅色彩传达状态时必须同时给出文字，不要只留一个点。 */
export function Dot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className={cx("dot", `tone-${tone}`, pulse && "dot--pulse")} aria-hidden />;
}

/** 可点击的筛选芯片。 */
export function Chip({
  active = false,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="chip"
      data-active={active ? "true" : undefined}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}