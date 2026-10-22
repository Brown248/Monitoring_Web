"use client";

import { useEffect, useState } from "react";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  leaving?: boolean;
}

const EVENT = "wm-toast";
let seq = 0;

/** แสดงข้อความแจ้งผลที่มุมขวาล่าง — เรียกจาก client component ใดก็ได้ */
export function toast(kind: ToastKind, title: string, detail?: string) {
  window.dispatchEvent(new CustomEvent<ToastItem>(EVENT, { detail: { id: ++seq, kind, title, detail } }));
}

const ICON: Record<ToastKind, { bg: string; path: string }> = {
  success: { bg: "bg-up-bg text-up", path: "M20 6 9 17l-5-5" },
  error: { bg: "bg-down-bg text-down", path: "M18 6 6 18M6 6l12 12" },
  info: { bg: "bg-info-bg text-info", path: "M12 16v-4M12 8h.01" },
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const dismiss = (id: number) => {
      setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      timers.add(setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 220));
    };
    const onToast = (e: Event) => {
      const item = (e as CustomEvent<ToastItem>).detail;
      setItems((list) => [...list.slice(-3), item]);
      timers.add(setTimeout(() => dismiss(item.id), item.kind === "error" ? 7000 : 4000));
    };
    window.addEventListener(EVENT, onToast);
    return () => {
      window.removeEventListener(EVENT, onToast);
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-[var(--shadow-lift)] backdrop-blur ${
            t.leaving ? "toast-out" : "toast-in"
          }`}
        >
          <span
            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ICON[t.kind].bg}`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {t.kind === "info" && <circle cx="12" cy="12" r="0" />}
              <path d={ICON[t.kind].path} />
            </svg>
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">{t.title}</div>
            {t.detail && <div className="mt-0.5 break-words text-xs text-muted">{t.detail}</div>}
          </div>
          <button
            type="button"
            aria-label="ปิด"
            onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}
            className="-mr-1 rounded-md p-1 text-subtle transition-colors hover:bg-ink/5 hover:text-ink"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
