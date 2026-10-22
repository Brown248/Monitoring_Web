"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, type ReactNode } from "react";

export type NavIcon =
  "overview" | "websites" | "map" | "incidents" | "security" | "ask" | "checks" | "system" | "settings";

const ICONS: Record<NavIcon, ReactNode> = {
  overview: <path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z" />,
  websites: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  map: (
    <>
      <rect x="2.5" y="3" width="7" height="5" rx="1.5" />
      <rect x="14.5" y="9.5" width="7" height="5" rx="1.5" />
      <rect x="2.5" y="16" width="7" height="5" rx="1.5" />
      <path d="M9.5 5.5h2.5a2 2 0 0 1 2 2V10M9.5 18.5h2.5a2 2 0 0 0 2-2V14" />
    </>
  ),
  incidents: (
    <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  ),
  security: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  ask: (
    <>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  checks: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  system: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4M7 10h2l1.5-3 3 6 1.5-3h2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
};

function Icon({ name }: { name: NavIcon }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

/** แสดง spinner เล็ก ๆ ระหว่างกำลังโหลดหน้าที่กด */
function PendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`h-3.5 w-3.5 rounded-full border-2 border-ink/20 border-t-ink transition-opacity duration-150 ${pending ? "animate-spin opacity-100" : "opacity-0"}`}
    />
  );
}

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  badge?: number;
}

export function NavLinks({ items, compact }: { items: NavItem[]; compact?: boolean }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const activeHref = items.find((it) =>
    it.href === "/" ? pathname === "/" : pathname === it.href || pathname.startsWith(it.href + "/"),
  )?.href;

  // เลื่อน "pill" ไปที่เมนูที่เลือก (แก้ style ตรง ๆ ไม่ใช้ state เพื่อไม่ re-render)
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    const place = () => {
      const el = activeHref ? nav.querySelector<HTMLElement>(`[data-href="${activeHref}"]`) : null;
      if (!el) {
        pill.style.opacity = "0";
        return;
      }
      if (!placed.current) pill.style.transition = "none";
      pill.style.opacity = "1";
      pill.style.width = `${el.offsetWidth}px`;
      pill.style.height = `${el.offsetHeight}px`;
      pill.style.transform = `translate(${el.offsetLeft}px, ${el.offsetTop}px)`;
      if (!placed.current) {
        void pill.offsetWidth;
        pill.style.transition = "";
        placed.current = true;
      }
    };
    place();
    if (compact && activeHref) {
      const el = nav.querySelector<HTMLElement>(`[data-href="${activeHref}"]`);
      if (el) nav.scrollTo({ left: el.offsetLeft - 16, behavior: "smooth" });
    }
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [activeHref, compact]);

  return (
    <nav
      ref={navRef}
      className={`relative ${compact ? "flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "flex flex-col gap-1"}`}
    >
      <span
        ref={pillRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 rounded-lg bg-surface opacity-0 shadow-[0_1px_3px_rgb(23_21_26/0.08),0_0_0_1px_rgb(23_21_26/0.04)] transition-[transform,width,height,opacity] duration-300 ease-[var(--ease-out)]"
      >
        {!compact && (
          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand" />
        )}
      </span>
      {items.map((it) => {
        const active = it.href === activeHref;
        return (
          <Link
            key={it.href}
            href={it.href}
            data-href={it.href}
            aria-current={active ? "page" : undefined}
            className={`group relative flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors duration-200 ${
              active ? "font-medium text-ink" : "text-ink/65 hover:bg-surface/50 hover:text-ink"
            }`}
          >
            <span
              className={`transition-colors ${active ? "text-brand-deep" : "text-subtle group-hover:text-ink/70"}`}
            >
              <Icon name={it.icon} />
            </span>
            <span className="flex-1">{it.label}</span>
            {it.badge ? (
              <span className="rounded-full bg-down px-1.5 py-px text-[11px] font-semibold text-white shadow-sm">
                {it.badge}
              </span>
            ) : (
              <PendingHint />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
