import type { ReactNode } from "react";
import { cx } from "./cx";

export type Tone = "brand" | "ok" | "warn" | "bad" | "info" | "neutral";

/**
 * 载入指示。
 * 默认纯装饰（旁边的文案已说明状态）;传 label 时才对外播报。
 */
export function Spinner({ label }: { label?: string }) {
  return (
    <span
      className="spinner"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Empty({
  icon,
  title,
  text,
}: {
  icon?: ReactNode;
  title: string;
  text?: string;
}) {
  return (
    <div className="empty">
      {icon}
      <p className="empty-title">{title}</p>
      {text ? <p className="empty-text">{text}</p> : null}
    </div>
  );
}

export function Alert({
  tone = "warn",
  title,
  children,
  onDismiss,
  action,
}: {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  return (
    // bad 级告警走 assertive 播报：role="status" 是 polite，错误会迟到。
    <div className={cx("alert", `tone-${tone}`)} role={tone === "bad" ? "alert" : "status"}>
      <div className="alert-body">
        <p className="alert-title">{title}</p>
        {children ? <div className="alert-text">{children}</div> : null}
      </div>
      {action}
      {onDismiss ? (
        <button type="button" className="btn-icon btn-icon--sm" aria-label="关闭提示" title="关闭" onClick={onDismiss}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

export function Code({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="code" title={title}>
      {children}
    </code>
  );
}