import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * 轻量提示。展开态由 CSS 驱动（hover / focus-within）,
 * 提示文案与无障碍名同源,不额外引入 JS 定位。
 */
export function Tooltip({
  label,
  side = "right",
  children,
}: {
  label: string;
  side?: "right" | "top" | "bottom";
  children: ReactNode;
}) {
  return (
    <span className={cx("tip", `tip--${side}`)} data-tip={label}>
      {children}
    </span>
  );
}