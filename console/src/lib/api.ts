/**
 * 统一 HTTP 请求层。
 *
 * SSE 主通道仍走 useTelemetry + EventSource；这里只管离散 REST
 * （snapshot / reset / prepare / stream-ticket），统一：
 *   - Authorization（apiHeaders）
 *   - 401 / 非 2xx → ApiError
 *   - 可选 AbortSignal
 */
import { apiHeaders, apiUrl } from "./apiKey";

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? (body.trim() || `HTTP ${status}`));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  get unauthorized() {
    return this.status === 401;
  }
}

export type ApiInit = Omit<RequestInit, "headers" | "body"> & {
  headers?: HeadersInit;
  /** JSON 对象会自动 stringify；字符串原样发送 */
  body?: unknown;
  /** 默认 true：自动设 application/json（有 body 时） */
  json?: boolean;
  /**
   * 未显式传 `signal` 时的兜底超时（毫秒，默认 30s）。
   * 传 `0` 或负数关闭；调用方自带 `signal` 时本项不生效（如压测那种长请求）。
   */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

async function request(path: string, init: ApiInit = {}): Promise<Response> {
  const { body, json = true, timeoutMs = DEFAULT_TIMEOUT_MS, headers: extra, ...rest } = init;
  const headers = new Headers(apiHeaders(extra));

  let payload: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === "string" || body instanceof FormData || body instanceof Blob) {
      payload = body as BodyInit;
    } else if (json) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    } else {
      payload = body as BodyInit;
    }
  }

  // 调用方自带的 signal 优先；否则给一个兜底超时，避免请求永久挂起。
  const signal = rest.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  return fetch(apiUrl(path), { ...rest, headers, body: payload, ...(signal ? { signal } : {}) });
}

/** 原始 Response；非 ok 抛 ApiError（body 已读成 text） */
export async function apiFetch(path: string, init?: ApiInit): Promise<Response> {
  const res = await request(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text);
  }
  return res;
}

export async function apiText(path: string, init?: ApiInit): Promise<{ status: number; text: string }> {
  const res = await request(path, init);
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text);
  return { status: res.status, text };
}
