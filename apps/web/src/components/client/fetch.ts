import { SESSION_EXPIRED_EVENT, SESSION_OK_EVENT } from "./session-banner";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export async function api<T = Record<string, unknown>>(
  url: string,
  method = "POST",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
  // session หมดอายุ → ไม่ย้ายหน้า (ข้อมูลที่กรอกจะหาย) แสดงแถบให้ login ในแท็บใหม่แล้วกดซ้ำแทน
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(
      "หมดเวลาเข้าสู่ระบบ — เข้าสู่ระบบใหม่ (แท็บใหม่) แล้วกดอีกครั้ง ข้อมูลที่กรอกยังอยู่",
      401,
    );
  }
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data.fields);
  window.dispatchEvent(new Event(SESSION_OK_EVENT));
  return data as T;
}
