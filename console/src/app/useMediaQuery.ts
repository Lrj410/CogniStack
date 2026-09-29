import { useSyncExternalStore } from "react";

/**
 * 订阅一个媒体查询。
 * 用 useSyncExternalStore 而不是 useState+useEffect：后者会在首帧先给出错误值,
 * 于是窄屏上会闪一下桌面版布局。
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}