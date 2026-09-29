import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * 数据表外壳：自带横向滚动与粘性表头。
 * 表格本身用原生 <table>,语义交给浏览器。
 */
export function DataTable({
  minWidth = 560,
  label,
  className,
  children,
}: {
  minWidth?: number;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("dt-scroll", className)}>
      <table className="dt" aria-label={label} style={{ minInlineSize: minWidth }}>
        {children}
      </table>
    </div>
  );
}