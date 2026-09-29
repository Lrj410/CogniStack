const STORAGE_KEY = "cs-api-key";

/** 兼容旧版本：localStorage 明文 Key 一次性迁移到 sessionStorage 并清除。 */
let migrated = false;
function migrateLegacyKey() {
  if (migrated) return;
  migrated = true;
  try {
    const legacy = localStorage.getItem(STORAGE_KEY)?.trim();
    if (legacy) {
      if (!sessionStorage.getItem(STORAGE_KEY)) sessionStorage.setItem(STORAGE_KEY, legacy);
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function getApiKey(): string {
  migrateLegacyKey();
  try {
    return sessionStorage.getItem(STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function setApiKey(key: string) {
  try {
    const v = key.trim();
    if (v) sessionStorage.setItem(STORAGE_KEY, v);
    else sessionStorage.removeItem(STORAGE_KEY);
    // 顺带清掉旧版可能残留的 localStorage 明文 Key。
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("cs-api-key"));
}

export function apiHeaders(extra?: HeadersInit): HeadersInit {
  const key = getApiKey();
  const h: Record<string, string> = {
    ...(extra as Record<string, string> | undefined),
  };
  if (key) h["authorization"] = `Bearer ${key}`;
  return h;
}

/**
 * Path helper for fetch — never appends ?key= (use Authorization header).
 * For EventSource use `streamUrl()` which mints a short-lived ticket.
 */
export function apiUrl(path: string): string {
  return path;
}

/** 取一次性 SSE ticket；失败重试一次，仍失败则降级为裸路径（绝不把 Key 拼进 URL）。 */
async function mintTicket(): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch("/api/stream-ticket", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }),
      });
      if (r.status === 401) throw new Error("401");
      if (r.ok) {
        const j = (await r.json()) as { ticket?: string | null };
        return j.ticket ?? null;
      }
    } catch (e) {
      if (String(e).includes("401")) throw e;
    }
  }
  return null;
}

export async function streamUrl(path = "/api/stream"): Promise<string> {
  const key = getApiKey();
  if (!key) return path;
  const ticket = await mintTicket();
  if (ticket) {
    const join = path.includes("?") ? "&" : "?";
    return `${path}${join}ticket=${encodeURIComponent(ticket)}`;
  }
  // 取不到 ticket：服务器可能未启用鉴权（裸路径可用），或未提供 ticket 端点。
  // 绝不退回到 ?key=，避免把密钥泄露到 URL / 日志 / Referer。
  return path;
}
