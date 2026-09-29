import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

export function Panel({
  raised = false,
  flush = false,
  className,
  style,
  children,
}: {
  raised?: boolean;
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <section
      className={cx("panel", raised && "panel--raised", flush && "panel--flush", className)}
      style={style}
    >
      {children}
    </section>
  );
}

export function PanelHead({
  title,
  sub,
  icon,
  right,
}: {
  title: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="panel-head">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", minWidth: 0 }}>
        {icon}
        <h2 className="truncate">{title}</h2>
        {sub ? (
          <span className="sub truncate" title={typeof sub === "string" ? sub : undefined}>
            {sub}
          </span>
        ) : null}
      </div>
      {right ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flex: "0 0 auto" }}>
          {right}
        </div>
      ) : null}
    </header>
  );
}

export function PanelBody({
  flush = false,
  scroll = false,
  className,
  style,
  children,
}: {
  flush?: boolean;
  scroll?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={cx("panel-body", flush && "panel-body--flush", scroll && "panel-body--scroll", className)}
      style={style}
    >
      {children}
    </div>
  );
}

/** 竖排堆栈：统一 gap,避免各页各写 margin。 */
export function Stack({
  gap = "var(--stack-gap)",
  className,
  style,
  children,
}: {
  gap?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(className)}
      style={{ display: "flex", flexDirection: "column", gap, minWidth: 0, ...style }}
    >
      {children}
    </div>
  );
}

/** 横排：默认垂直居中、可换行。 */
export function Row({
  gap = "var(--sp-4)",
  wrap = true,
  align = "center",
  justify,
  className,
  style,
  children,
}: {
  gap?: string;
  wrap?: boolean;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(className)}
      style={{
        display: "flex",
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? "wrap" : "nowrap",
        gap,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}