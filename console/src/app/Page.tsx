import type { ReactNode } from "react";
import { Spinner } from "@/ui";

/** 常规页：整页滚动,面板之间带节奏留白。 */
export function PageScroll({ children }: { children: ReactNode }) {
  return <div className="page page-scroll page-enter">{children}</div>;
}

/** 工作台式页：内容自行铺满,不留外框留白（回合 / 调试）。 */
export function PageFlush({ children }: { children: ReactNode }) {
  return <div className="page page-flush page-enter">{children}</div>;
}

/** 未连接 / 载入中的占位。把「为什么空」说清楚,而不是只转一个圈。 */
export function Blocked({
  title,
  text,
  action,
  busy = false,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="blocked">
      {busy ? <Spinner /> : null}
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
      {action}
    </div>
  );
}