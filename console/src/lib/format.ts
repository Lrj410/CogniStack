export function n(v: number): string {
  const x = Number(v) || 0;
  if (Math.abs(x) >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (Math.abs(x) >= 1e4) return `${(x / 1e3).toFixed(1)}k`;
  return String(Math.round(x));
}

export function dur(v: number): string {
  const x = Number(v) || 0;
  if (x < 1) return `${(x * 1000).toFixed(0)}µs`;
  if (x < 1000) return `${x.toFixed(1)}ms`;
  return `${(x / 1000).toFixed(2)}s`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function uptime(ms: number): string {
  const s = Math.floor((Number(ms) || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${r}s`;
  return `${r}s`;
}

export function hitRate(counter?: { hits?: number; misses?: number }): number | null {
  if (!counter) return null;
  const hits = counter.hits ?? 0;
  const misses = counter.misses ?? 0;
  const tot = hits + misses;
  return tot ? hits / tot : null;
}

export const LIVE_MS = 5000;
export const IDLE_MS = 60000;

export function hostAge(lastSeen: number, now: number): "live" | "idle" | "off" {
  const d = now - lastSeen;
  if (d < LIVE_MS) return "live";
  if (d < IDLE_MS) return "idle";
  return "off";
}
