import Link from "next/link";
import type { ReactNode } from "react";
import { CountUp } from "./client/count-up";

export type Tone = "up" | "down" | "warn" | "unknown" | "info" | "ai" | "muted";

const TONE_TEXT: Record<Tone, string> = {
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
  unknown: "text-unknown",
  info: "text-info",
  ai: "text-ai",
  muted: "text-subtle",
};
const TONE_DOT: Record<Tone, string> = {
  up: "bg-up",
  down: "bg-down",
  warn: "bg-warn",
  unknown: "bg-unknown",
  info: "bg-info",
  ai: "bg-ai",
  muted: "bg-subtle",
};
const TONE_PILL: Record<Tone, string> = {
  up: "bg-up-bg text-up ring-up/15",
  down: "bg-down-bg text-down ring-down/20",
  warn: "bg-warn-bg text-warn ring-warn/20",
  unknown: "bg-sidebar text-unknown ring-black/5",
  info: "bg-info-bg text-info ring-info/15",
  ai: "bg-ai-bg text-ai ring-ai/15",
  muted: "bg-sidebar text-muted ring-black/5",
};

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** จุดสถานะ — pulse = มีวงกระเพื่อม (ใช้กับ DOWN / สถานะสด) */
export function Dot({ tone, className, pulse }: { tone: Tone; className?: string; pulse?: boolean }) {
  return (
    <span
      className={cx(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        TONE_DOT[tone],
        pulse && "dot-ping",
        className,
      )}
      aria-hidden
    />
  );
}

export function ToneText({
  tone,
  children,
  className,
  pulse,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span className={cx("inline-flex items-center gap-1.5", TONE_TEXT[tone], className)}>
      <Dot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

/** ป้ายสถานะแบบเม็ดยา */
export function Pill({
  tone,
  children,
  dot = true,
  pulse,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_PILL[tone],
        className,
      )}
    >
      {dot && <Dot tone={tone} pulse={pulse} className="h-1.5 w-1.5" />}
      {children}
    </span>
  );
}

export function statusTone(status: string | null | undefined, degraded = false): Tone {
  if (status === "UP") return degraded ? "warn" : "up";
  if (status === "DOWN") return "down";
  if (status === "UNKNOWN") return "unknown";
  return "muted";
}

export function StatusLabel({
  status,
  degraded,
  failing,
  enabled = true,
}: {
  status: string | null;
  degraded?: boolean;
  /** ล้มเหลวแต่ยังไม่ครบเกณฑ์ยืนยัน DOWN */
  failing?: boolean;
  enabled?: boolean;
}) {
  if (!enabled) return <Pill tone="muted">ปิดการตรวจ</Pill>;
  if (failing && status !== "DOWN")
    return (
      <Pill tone="warn" pulse>
        FAILING
      </Pill>
    );
  if (status === "PENDING")
    return (
      <Pill tone="info" pulse>
        PENDING
      </Pill>
    );
  const label = status === "UP" && degraded ? "DEGRADED" : (status ?? "—");
  return (
    <Pill tone={statusTone(status, degraded)} pulse={status === "DOWN"}>
      {label}
    </Pill>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx("card overflow-hidden", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0 text-sm">{action}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  // มือถือ 2×2 แทนเรียงทีละใบ — เห็นตัวเลขครบในจอเดียว
  return <div className={cx("stagger grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>;
}

const STAT_ACCENT: Partial<Record<Tone, string>> = {
  up: "from-up/70",
  down: "from-down/80",
  warn: "from-warn/70",
  unknown: "from-unknown/40",
};

export function Stat({
  label,
  value,
  sub,
  tone,
  dot,
  mono = true,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  dot?: Tone;
  mono?: boolean;
}) {
  const accent = dot ? STAT_ACCENT[dot] : undefined;
  return (
    <div className="card card-hover relative min-w-0 overflow-hidden px-3.5 py-3.5 sm:px-4 sm:py-4">
      {accent && (
        <span className={cx("absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r to-transparent", accent)} />
      )}
      <div className="flex items-center gap-1.5 text-[13px] text-muted sm:text-sm">
        {dot && <Dot tone={dot} pulse={dot === "down" && typeof value === "number" && value > 0} />}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cx(
          "mt-1.5 break-words text-[1.3rem] font-semibold leading-tight tracking-tight sm:text-[1.65rem]",
          mono && "num",
          tone && TONE_TEXT[tone],
        )}
      >
        {typeof value === "number" ? <CountUp value={value} /> : value}
      </div>
      {sub && <div className="mt-1 text-[11px] leading-snug text-muted sm:text-xs">{sub}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: Array<{ label: string; href?: string }>;
}) {
  return (
    <div className="mb-7">
      {breadcrumb && (
        <nav className="mb-2 flex items-center gap-1.5 text-xs text-muted">
          {breadcrumb.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-subtle">/</span>}
              {b.href ? (
                <Link href={b.href} className="transition-colors hover:text-ink">
                  {b.label}
                </Link>
              ) : (
                <span className="text-ink/70">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-[-0.02em] md:text-[1.85rem]">
            {title}
          </h1>
          {subtitle && <div className="mt-1.5 text-sm text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** ตัวเลือกแบบเม็ด (segmented control) */
export function Segments({ items }: { items: Array<{ label: ReactNode; href: string; active: boolean }> }) {
  return (
    <div className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-sidebar p-0.5 text-sm ring-1 ring-inset ring-line [scrollbar-width:none]">
      {items.map((it, i) => (
        <Link
          key={i}
          href={it.href}
          scroll={false}
          className={cx(
            "whitespace-nowrap rounded-md px-3 py-1.5 transition-all duration-200",
            it.active
              ? "bg-surface font-medium text-ink shadow-[0_1px_3px_rgb(23_21_26/0.12)]"
              : "text-muted hover:text-ink",
          )}
        >
          {it.label}
        </Link>
      ))}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
  numbered = true,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
  numbered?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const nums: number[] = [];
  if (numbered) for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(p);
  const btn = "btn-secondary min-w-9 px-3";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/50 px-4 py-3 text-xs text-muted">
      <span>
        แสดง {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")} จาก {total.toLocaleString("en-US")}
      </span>
      <div className="flex items-center gap-1.5">
        {page > 1 ? (
          <Link className={btn} href={hrefFor(page - 1)}>
            ก่อนหน้า
          </Link>
        ) : (
          <span className={cx(btn, "pointer-events-none opacity-40")}>ก่อนหน้า</span>
        )}
        {nums.map((p) =>
          p === page ? (
            <span key={p} className="btn-primary min-w-9 px-3">
              {p}
            </span>
          ) : (
            <Link key={p} href={hrefFor(p)} className={btn}>
              {p}
            </Link>
          ),
        )}
        {page < pages ? (
          <Link className={btn} href={hrefFor(page + 1)}>
            ถัดไป
          </Link>
        ) : (
          <span className={cx(btn, "pointer-events-none opacity-40")}>ถัดไป</span>
        )}
      </div>
    </div>
  );
}

export function Empty({ children, icon = "check" }: { children: ReactNode; icon?: "check" | "inbox" }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sidebar text-subtle">
        {icon === "check" ? (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
        )}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function KeyValue({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v], i) => (
        <div key={i} className="row flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** สร้าง URL ใหม่จาก searchParams เดิม + ค่าที่เปลี่ยน (ค่า undefined/"" = ลบ) */
export function withParams(
  path: string,
  current: Record<string, string | undefined>,
  patch: Record<string, string | number | undefined>,
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...patch })) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}
