"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { api, ApiError } from "./fetch";
import { SESSION_EXPIRED_EVENT, SESSION_OK_EVENT } from "./session-banner";
import { Switch } from "./switch";
import { toast } from "./toast";

/** router.refresh() ทุก N วินาที (หยุดเมื่อแท็บไม่ได้เปิดอยู่) */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // กำลังแก้ไขอยู่ (เช่น JourneyEditor) → ไม่รีเฟรช
      if (document.querySelector("[data-editing]")) return;
      // ตรวจ session ก่อน — หมดอายุแล้ว router.refresh() จะพาไปหน้า login ทันที (ข้อมูลที่กรอกหาย)
      void fetch("/api/auth/session", { cache: "no-store" })
        .then((r) => {
          // detail "poll" = ตรวจเองเบื้องหลัง — ผู้ใช้กดปิดแถบแล้วจะไม่เด้งกลับมาทุกรอบ
          if (r.status === 401)
            window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: "poll" }));
          else if (r.ok) {
            window.dispatchEvent(new Event(SESSION_OK_EVENT)); // login ใหม่ในแท็บอื่นแล้ว → ซ่อนแถบ
            router.refresh();
          }
        })
        .catch(() => undefined); // เครือข่ายหลุดชั่วคราว — รอบหน้าลองใหม่
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button className="btn-secondary" disabled={pending} onClick={() => start(() => router.refresh())}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={pending ? "animate-spin" : "transition-transform duration-500 group-hover:rotate-180"}
        aria-hidden
      >
        <path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      {pending ? "กำลังรีเฟรช…" : "รีเฟรช"}
    </button>
  );
}

/** ปุ่มที่ POST ไป API แล้วรีเฟรชหน้า — ใช้กับ ตรวจตอนนี้, Archive, ส่งใหม่, วิเคราะห์ใหม่ ฯลฯ */
export function ActionButton({
  url,
  body,
  method = "POST",
  children,
  confirm,
  variant = "secondary",
  successMessage,
  redirectTo,
  refreshAfterMs = 0,
  disabled,
  className,
}: {
  url: string;
  body?: unknown;
  method?: string;
  children: ReactNode;
  confirm?: string;
  variant?: "primary" | "secondary" | "danger";
  successMessage?: string;
  redirectTo?: string;
  refreshAfterMs?: number;
  disabled?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try {
      const res = await api<{ message?: string }>(url, method, body);
      toast("success", res.message ?? successMessage ?? "สำเร็จ");
      if (redirectTo) router.push(redirectTo);
      router.refresh();
      if (refreshAfterMs > 0) timer.current = setTimeout(() => router.refresh(), refreshAfterMs);
    } catch (err) {
      toast("error", "ทำรายการไม่สำเร็จ", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className={`btn-${variant} ${className ?? ""}`} disabled={busy || disabled} onClick={run}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70 ${className ?? ""}`}
    />
  );
}

/** สวิตช์เปิด/ปิดการตรวจ */
export function EnabledToggle({
  websiteId,
  enabled,
  disabled,
}: {
  websiteId: number;
  enabled: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  // ค่าที่แสดงระหว่างรอผล (optimistic) — คงไว้จนค่าจาก server เปลี่ยนตาม
  // (ล้างทันทีหลังได้คำตอบ = สวิตช์เด้งกลับค่าเดิมชั่วครู่ระหว่างรอหน้ารีเฟรช)
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [seen, setSeen] = useState(enabled);
  if (seen !== enabled) {
    setSeen(enabled);
    setOptimistic(null);
  }
  const on = optimistic ?? enabled;
  async function toggle() {
    const next = !on;
    setOptimistic(next);
    setBusy(true);
    try {
      await api(`/api/websites/${websiteId}/enabled`, "POST", { enabled: next });
      startRefresh(() => router.refresh());
    } catch (err) {
      setOptimistic(null);
      toast("error", "เปลี่ยนสถานะการตรวจไม่สำเร็จ", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Switch
      on={on}
      onToggle={toggle}
      disabled={busy || refreshing || disabled}
      label={on ? "ปิดการตรวจ" : "เปิดการตรวจ"}
    />
  );
}

/** select ที่เปลี่ยนค่าใน URL ทันที (ใช้เป็นตัวกรอง) */
export function QuerySelect({
  name,
  value,
  options,
  resetPage = true,
  className,
}: {
  name: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  resetPage?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <select
      className={className}
      value={value}
      onChange={(e) => {
        const p = new URLSearchParams(params.toString());
        if (e.target.value) p.set(name, e.target.value);
        else p.delete(name);
        if (resetPage) p.delete("page");
        router.push(`${pathname}?${p.toString()}`);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function QueryDate({ name, value }: { name: string; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => {
        const p = new URLSearchParams(params.toString());
        if (e.target.value) p.set(name, e.target.value);
        else p.delete(name);
        p.delete("page");
        router.push(`${pathname}?${p.toString()}`);
      }}
    />
  );
}

/** ช่องค้นหา — ส่งค่าเข้า URL หลังหยุดพิมพ์ */
export function SearchBox({
  name = "q",
  value,
  placeholder,
}: {
  name?: string;
  value: string;
  placeholder: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(value);
  // ผู้ใช้พิมพ์เองหรือยัง — URL เปลี่ยนจากที่อื่น (กดเมนู/ย้อนกลับ) ต้องไม่ถูกเขียนทับด้วยคำค้นเก่า
  const [dirty, setDirty] = useState(false);
  const [prevValue, setPrevValue] = useState(value);
  // คำค้นที่เราเพิ่ง push ไป — หน้าโหลดเสร็จด้วยค่านี้ ขณะที่ผู้ใช้พิมพ์ต่อไปแล้ว ต้องไม่ลบตัวอักษรที่พิมพ์เพิ่ม
  const [pushed, setPushed] = useState<string | null>(null);
  if (value !== prevValue) {
    setPrevValue(value);
    const ownNavigation = pushed !== null && value === pushed;
    setPushed(null);
    // หน้าโหลดเสร็จด้วยคำค้นที่เราส่งไปเอง: ช่องยังมีข้อความเดิม (อาจมีช่องว่างท้ายที่กำลังพิมพ์คำต่อไป) → ไม่เขียนทับ
    if (!(ownNavigation && (dirty || text.trim() === value))) {
      setText(value);
      setDirty(false);
    }
  }
  useEffect(() => {
    if (!dirty || text.trim() === value) return;
    const id = setTimeout(() => {
      const p = new URLSearchParams(params.toString());
      if (text.trim()) p.set(name, text.trim());
      else p.delete(name);
      p.delete("page");
      setDirty(false);
      setPushed(text.trim());
      router.push(`${pathname}?${p.toString()}`);
    }, 350);
    return () => clearTimeout(id);
  }, [dirty, text, value, name, params, pathname, router]);
  return (
    <input
      type="search"
      value={text}
      placeholder={placeholder}
      // เท่ากับที่ server ตัด (100) — ยาวกว่านี้ค่าใน URL จะไม่ตรงกับช่องค้นหา แล้วกดซ้ำไม่จบ
      maxLength={100}
      onChange={(e) => {
        setText(e.target.value);
        setDirty(true);
      }}
      className="max-w-md"
    />
  );
}

/** ปุ่มสร้างงานให้ worker (เช่น Sync Google Sheets) แล้วรอผล */
export function JobButton({
  type,
  payload,
  children,
  disabled,
}: {
  type: string;
  payload?: unknown;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  // ออกจากหน้านี้แล้ว → หยุดถามผล (ไม่ให้ toast ของหน้าเก่าเด้งขึ้นมาในหน้าอื่น)
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run() {
    setBusy(true);
    let id: number;
    try {
      ({ id } = await api<{ id: number }>("/api/jobs", "POST", { type, payload }));
    } catch (err) {
      setBusy(false);
      return toast("error", "ส่งงานไม่สำเร็จ", err instanceof Error ? err.message : String(err));
    }
    toast("info", "ส่งงานให้ Worker แล้ว", "กำลังรอผล…");
    // งานบางอย่าง (ถ่ายภาพ/Journey/sync Sheets) ใช้เวลาหลายนาที — รอได้ถึง 10 นาที
    const started = Date.now();
    let failures = 0;
    let warnedPending = false;
    try {
      while (alive.current && Date.now() - started < 10 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive.current) return;
        let job: { status: string; result: string | null };
        try {
          job = await api<{ status: string; result: string | null }>(`/api/jobs/${id}`, "GET");
          failures = 0;
        } catch (err) {
          // เน็ตสะดุดครั้งเดียวไม่ใช่งานล้มเหลว — ลองถามใหม่ เว้นแต่ session หมด/ไม่พบงาน
          if (err instanceof ApiError && (err.status === 401 || err.status === 404)) throw err;
          if (++failures >= 5) throw err;
          continue;
        }
        if (job.status === "DONE") {
          router.refresh();
          return toast("success", "เสร็จแล้ว", job.result ?? undefined);
        }
        if (job.status === "FAILED") return toast("error", "งานล้มเหลว", job.result ?? undefined);
        if (job.status === "PENDING" && !warnedPending && Date.now() - started > 60_000) {
          warnedPending = true;
          toast("info", "Worker ยังไม่รับงาน", "งานรอคิวอยู่ — ตรวจว่า Worker ทำงานอยู่ที่หน้าสถานะระบบ");
        }
      }
      if (alive.current) toast("error", "ยังไม่เสร็จ", "งานยังทำต่อใน Worker — ดูผลในหน้าสถานะระบบภายหลัง");
    } catch (err) {
      if (alive.current)
        toast("error", "ติดตามผลงานไม่ได้", err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <button className="btn-secondary" disabled={busy || disabled} onClick={run}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn-ghost px-2 py-1 text-xs"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        router.replace("/login");
        router.refresh();
      }}
    >
      ออกจากระบบ
    </button>
  );
}
