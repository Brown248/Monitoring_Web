"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api } from "./fetch";
import { SiteIcon } from "./site-icon";
import { toast } from "./toast";

interface Site {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  status: "UP" | "DOWN" | "UNKNOWN" | "PENDING";
}

interface Item {
  id: string;
  group: "หน้า" | "เว็บไซต์" | "คำสั่ง";
  label: string;
  hint?: string;
  site?: Site;
  icon?: string;
  run: () => void | Promise<void>;
}

export const OPEN_PALETTE_EVENT = "wm-open-palette";

const PAGES: Array<{ href: string; label: string; keywords: string; adminOnly?: boolean }> = [
  { href: "/", label: "ภาพรวม", keywords: "overview dashboard หน้าแรก" },
  { href: "/websites", label: "เว็บไซต์", keywords: "websites sites list" },
  { href: "/map", label: "แผนผังระบบ", keywords: "map dependency service graph พึ่งพา เชื่อมโยง แผนผัง" },
  { href: "/incidents", label: "Incident", keywords: "incidents down ล่ม" },
  { href: "/security", label: "ความปลอดภัย", keywords: "security ssl grade deface lookalike แฮก โดเมนปลอม" },
  { href: "/ask", label: "ถาม AI", keywords: "ai ask chat claude ถาม" },
  { href: "/checks", label: "ประวัติการตรวจ", keywords: "checks history log" },
  { href: "/system", label: "สถานะระบบ", keywords: "system worker health" },
  { href: "/settings", label: "ตั้งค่า", keywords: "settings smtp ai sheets" },
  { href: "/websites/new", label: "เพิ่มเว็บไซต์", keywords: "add new create", adminOnly: true },
];

const STATUS_DOT: Record<Site["status"], string> = {
  UP: "bg-brand",
  DOWN: "bg-down",
  UNKNOWN: "bg-unknown",
  PENDING: "bg-info",
};

function score(text: string, q: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s./:-]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
}

/** ค้นหาด่วน: Ctrl/⌘ + K — ไปหน้าต่าง ๆ, เปิดเว็บไซต์ หรือสั่งตรวจทันที (Admin) */
export function CommandPalette({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [sites, setSites] = useState<Site[] | null>(null);
  const loadedAt = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const show = useCallback(() => {
    setQ("");
    setActive(0);
    setOpen(true);
    // โหลดรายชื่อเว็บใหม่ถ้าเก่ากว่า 30 วินาที
    if (Date.now() - loadedAt.current > 30_000) {
      loadedAt.current = Date.now();
      api<{ sites: Site[] }>("/api/command/sites", "GET")
        .then((r) => setSites(r.sites))
        .catch(() => setSites([]));
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) setOpen(false);
        else show();
      }
    };
    const onOpen = () => show();
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, [open, show]);

  useEffect(() => {
    if (!open) return;
    // ปิดแล้วคืน focus ให้ปุ่ม/ช่องเดิม (ผู้ใช้คีย์บอร์ดไม่หลงตำแหน่ง)
    const before = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => before?.focus?.();
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const go = (href: string) => () => {
      setOpen(false);
      router.push(href);
    };
    const pages = PAGES.filter((p) => !p.adminOnly || isAdmin)
      .map((p) => ({ p, s: Math.max(score(p.label, query), score(p.keywords, query)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ p }): Item => ({
        id: `page:${p.href}`,
        group: "หน้า",
        label: p.label,
        hint: p.href,
        icon: p.href === "/websites/new" ? "plus" : "page",
        run: go(p.href),
      }));
    const matched = (sites ?? [])
      .map((s) => ({
        s,
        sc: Math.max(score(s.name, query), score(s.url.replace(/^https?:\/\//, ""), query)),
      }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, query ? 8 : 5)
      .map((x) => x.s);
    const siteItems = matched.map((s): Item => ({
      id: `site:${s.id}`,
      group: "เว็บไซต์",
      label: s.name,
      hint: s.url.replace(/^https?:\/\//, ""),
      site: s,
      run: go(`/websites/${s.id}`),
    }));
    const commands: Item[] =
      isAdmin && query
        ? matched
            .filter((s) => s.enabled)
            .slice(0, 3)
            .map((s) => ({
              id: `check:${s.id}`,
              group: "คำสั่ง",
              label: `ตรวจทันที: ${s.name}`,
              hint: "ส่งเข้าคิวให้ Worker",
              icon: "bolt",
              run: async () => {
                setOpen(false);
                try {
                  await api(`/api/websites/${s.id}/check-now`);
                  toast("success", "สั่งตรวจแล้ว", s.name);
                  setTimeout(() => router.refresh(), 6000);
                } catch (err) {
                  toast("error", "สั่งตรวจไม่สำเร็จ", err instanceof Error ? err.message : undefined);
                }
              },
            }))
        : [];
    return query ? [...siteItems, ...commands, ...pages] : [...pages, ...siteItems];
  }, [q, sites, isAdmin, router]);

  const safeActive = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${safeActive}"]`)?.scrollIntoView({ block: "nearest" });
  }, [safeActive]);

  if (!open) return null;

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((safeActive + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((safeActive - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void items[safeActive]?.run();
    }
  }

  let lastGroup = "";
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="ค้นหาด่วน"
      onKeyDown={(e) => {
        // Esc ปิดได้จากทุกจุดใน dialog · Tab ไม่หลุดออกไปหน้าข้างหลัง (focus trap — เลือกรายการด้วยลูกศร)
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
        } else if (e.key === "Tab") {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <button
        aria-label="ปิด"
        className="animate-fade-in absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
      />
      <div className="animate-pop relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_64px_-16px_rgb(23_21_26/0.35)]">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="shrink-0 text-subtle"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="ค้นหาเว็บไซต์ หน้า หรือคำสั่ง…"
            className="h-14 w-full rounded-none border-0 bg-transparent px-0 text-[15px] shadow-none outline-none placeholder:text-subtle focus-visible:outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[safeActive] ? `palette-${safeActive}` : undefined}
          />
          <kbd className="kbd shrink-0">Esc</kbd>
        </div>
        <ul id="palette-list" ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {sites === null && q && <li className="px-3 py-2 text-sm text-muted">กำลังโหลดรายชื่อเว็บ…</li>}
          {items.length === 0 && sites !== null && (
            <li className="px-3 py-8 text-center text-sm text-muted">ไม่พบ “{q}”</li>
          )}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const selected = i === safeActive;
            return (
              <li key={it.id} role="presentation">
                {header && (
                  <div className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-subtle">
                    {header}
                  </div>
                )}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  onMouseMove={() => selected || setActive(i)}
                  onClick={() => void it.run()}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-100 ${selected ? "bg-sidebar text-ink" : "text-ink/80"}`}
                >
                  {it.site ? (
                    <span className="relative">
                      <SiteIcon id={it.site.id} name={it.site.name} size={26} />
                      <span
                        className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${it.site.enabled ? STATUS_DOT[it.site.status] : "bg-line-strong"}`}
                      />
                    </span>
                  ) : (
                    <span className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-sidebar text-muted ring-1 ring-line">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        {it.icon === "plus" ? (
                          <path d="M12 5v14M5 12h14" />
                        ) : it.icon === "bolt" ? (
                          <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
                        ) : (
                          <path d="M9 18l6-6-6-6" />
                        )}
                      </svg>
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{it.label}</span>
                  </span>
                  {it.hint && (
                    <span className="max-w-[40%] truncate font-mono text-xs text-muted">{it.hint}</span>
                  )}
                  {selected && <kbd className="kbd">↵</kbd>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-4 border-t border-line bg-canvas/60 px-4 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> เลือก
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="kbd">↵</kbd> เปิด
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <kbd className="kbd">Ctrl</kbd>
            <kbd className="kbd">K</kbd> เปิด/ปิด
          </span>
        </div>
      </div>
    </div>
  );
}

/** ปุ่มเปิดค้นหาด่วน (sidebar / header มือถือ) */
export function PaletteButton({ compact }: { compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
      className={
        compact
          ? "btn-ghost px-2 py-1"
          : "flex w-full items-center gap-2 rounded-lg border border-line bg-surface/70 px-3 py-2 text-sm text-muted shadow-[var(--shadow-card)] transition-colors hover:border-line-strong hover:text-ink"
      }
      aria-label="ค้นหาด่วน (Ctrl+K)"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      {!compact && (
        <>
          <span className="flex-1 text-left">ค้นหา…</span>
          <kbd className="kbd">Ctrl K</kbd>
        </>
      )}
    </button>
  );
}
