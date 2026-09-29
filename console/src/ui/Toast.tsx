import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "./cx";
import type { Tone } from "./feedback";

type ToastItem = { id: number; message: string; tone: Tone };

const Ctx = createContext<((message: string, tone?: Tone) => void) | null>(null);

const LIFETIME_MS = 2400;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  // 每个 toast 的自动关闭定时器都登记在册，卸载时统一清掉
  const timers = useRef(new Set<number>());

  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
      timers.current.clear();
    },
    [],
  );

  const push = useCallback((message: string, tone: Tone = "brand") => {
    seq.current += 1;
    const id = seq.current;
    setItems((prev) => [...prev, { id, message, tone }]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, LIFETIME_MS);
    timers.current.add(timer);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-host" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={cx("toast", `tone-${t.tone}`)}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast 必须在 ToastProvider 内使用");
  return v;
}