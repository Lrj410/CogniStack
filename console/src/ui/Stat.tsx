import type { ReactNode } from "react";
import { cx } from "./cx";
import type { Tone } from "./feedback";

export function Stat({
  label,
  value,
  unit,
  tone = "neutral",
  icon,
  foot,
  footRight,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: Tone;
  icon?: ReactNode;
  foot?: ReactNode;
  footRight?: ReactNode;
}) {
  return (
    <div className="stat">
      <p className="stat-label">
        {icon}
        {label}
      </p>
      <p className="stat-value" data-tone={tone === "neutral" ? undefined : tone}>
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </p>
      {foot || footRight ? (
        <p className="stat-foot">
          <span className="truncate" title={typeof foot === "string" ? foot : undefined}>{foot}</span>
          {footRight ? <span className="num">{footRight}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

export function Toolbar({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("toolbar", className)}>{children}</div>;
}