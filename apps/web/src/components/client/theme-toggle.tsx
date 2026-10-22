"use client";

import { useEffect, useSyncExternalStore } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "wm-theme";
const EVENT = "wm-theme-change";

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "dark" || t === "system" ? t : "light";
  } catch {
    return "light";
  }
}

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  // ปิด transition ชั่วครู่ระหว่างสลับ เพื่อไม่ให้ทุก element ค่อย ๆ เปลี่ยนสีไม่พร้อมกัน
  root.classList.add("theme-switching");
  root.classList.toggle("dark", dark);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

function subscribe(cb: () => void) {
  // สลับธีมในอีกแท็บ → แท็บนี้ต้องเปลี่ยนสีด้วย ไม่ใช่แค่ไอคอน
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    apply(read());
    cb();
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

// ค่าเริ่มต้น = สว่าง (ไม่ตามระบบ จนกว่าผู้ใช้จะเลือกเอง)
const ORDER: Theme[] = ["light", "dark", "system"];
const LABEL: Record<Theme, string> = { system: "ตามระบบ", light: "สว่าง", dark: "มืด" };

/** ปุ่มสลับธีม: สว่าง → มืด → ตามระบบ */
export function ThemeToggle({ compact }: { compact?: boolean }) {
  const theme = useSyncExternalStore(subscribe, read, () => "light" as Theme);

  // ตามระบบ: เปลี่ยนตามการตั้งค่า OS ทันที
  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
    try {
      if (next === "light") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* localStorage ถูกปิด — ใช้ได้แค่ในหน้านี้ */
    }
    apply(next);
    window.dispatchEvent(new Event(EVENT));
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="btn-ghost gap-2 px-2 py-1 text-xs"
      title={`ธีม: ${LABEL[theme]} (คลิกเพื่อสลับ)`}
      aria-label={`ธีม: ${LABEL[theme]}`}
    >
      <span className="relative h-4 w-4">
        {/* ไอคอนหมุน/จางสลับกันตามธีม */}
        <svg
          viewBox="0 0 24 24"
          className={`absolute inset-0 transition-all duration-300 ${theme === "light" ? "rotate-0 opacity-100" : "-rotate-90 opacity-0"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        <svg
          viewBox="0 0 24 24"
          className={`absolute inset-0 transition-all duration-300 ${theme === "dark" ? "rotate-0 opacity-100" : "rotate-90 opacity-0"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
        <svg
          viewBox="0 0 24 24"
          className={`absolute inset-0 transition-all duration-300 ${theme === "system" ? "scale-100 opacity-100" : "scale-50 opacity-0"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      </span>
      {!compact && LABEL[theme]}
    </button>
  );
}
