import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Spinner } from "./feedback";

type Variant = "solid" | "outline" | "ghost" | "danger" | "quiet-danger";
type Size = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  /** 前置图标（应为装饰性，需自带 aria-hidden） */
  icon?: ReactNode;
  /** 后置图标 */
  trailing?: ReactNode;
  loading?: boolean;
  block?: boolean;
  active?: boolean;
};

export function Button({
  variant = "outline",
  size = "md",
  icon,
  trailing,
  loading = false,
  block = false,
  active,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      className={cx(
        "btn",
        `btn--${variant}`,
        size !== "md" && `btn--${size}`,
        block && "btn--block",
        className,
      )}
      data-loading={loading ? "true" : undefined}
      data-active={active ? "true" : undefined}
      disabled={disabled || loading}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {trailing}
    </button>
  );
}

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** 无障碍名称（图标按钮必须有无障碍名，不能只有一个图形） */
  label: string;
  size?: "sm" | "md";
  active?: boolean;
};

export function IconButton({
  label,
  size = "md",
  active,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      title={label}
      className={cx("btn-icon", size === "sm" && "btn-icon--sm", className)}
      data-active={active ? "true" : undefined}
    >
      {children}
    </button>
  );
}
