import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { IconButton } from "./Button";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 抽屉 / 底部面板。
 * Esc 关闭、打开时把焦点送进去、关闭后还给触发元素 —— 不用组件库也得守住这三条,
 * 否则键盘用户会被困在遮罩后面。
 */
export function Drawer({
  open,
  onClose,
  title,
  side = "bottom",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  side?: "bottom" | "right" | "center";
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  /*
   * onClose 存进 ref，effect 只依赖 `open`。
   * 此前依赖数组是 `[open, onClose]`，而调用方几乎都传内联箭头函数（每次渲染都是新引用）——
   * 控制台每收到一次 SSE 快照 / 每秒心跳都会重渲染，于是这个 effect 反复清理并重跑，
   * 把用户刚移走的焦点一次次抢回抽屉里的第一个可聚焦元素。键盘用户因此没法操作抽屉内容。
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      // 焦点陷阱：aria-modal="true" 是承诺，Tab 不能逃到被遮罩的页面上
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !panel.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !panel.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }, 0);

    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        className="drawer"
        data-side={side}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={typeof title === "string" ? title : "详情"}
      >
        <header className="drawer-head">
          <h2>{title}</h2>
          <IconButton label="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </IconButton>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
}

/**
 * 模态居中弹框。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Drawer open={open} onClose={onClose} title={title} side="center">
      {children}
    </Drawer>
  );
}