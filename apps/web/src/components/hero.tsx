import { formatPercent } from "@app/core";
import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./ui";

/** วงแหวน Uptime — วาดเส้นตัวเองตอนแสดง */
export function UptimeRing({
  ratio,
  size = 132,
  tone,
}: {
  ratio: number | null;
  size?: number;
  tone: "up" | "down" | "warn" | "muted";
}) {
  const stroke = 11;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const value = ratio ?? 0;
  const color = {
    up: "var(--color-brand)",
    down: "var(--color-down)",
    warn: "var(--color-warn)",
    muted: "var(--color-subtle)",
  }[tone];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90 overflow-visible"
        style={{ filter: `drop-shadow(0 2px 8px color-mix(in oklab, ${color} 35%, transparent))` }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - value)}
          className="ring-draw"
          style={{ ["--ring-circ" as string]: `${circ}` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-[1.55rem] font-semibold leading-none tracking-tight">
          {ratio === null ? "—" : formatPercent(ratio)}
        </span>
        <span className="mt-1 text-[11px] text-muted">uptime 24 ชม.</span>
      </div>
    </div>
  );
}

/** กราฟเส้นเล็ก (sparkline) — เส้นวาดตัวเอง + พื้นที่ไล่เฉด · จุดสีแดง = ชั่วโมงที่มีผลตรวจล้มเหลว */
export function Sparkline({
  values,
  downs,
  width = 260,
  height = 64,
  id = "spark",
  fluid = false,
  emptyLabel = "รอข้อมูลอย่างน้อย 2 ชั่วโมง",
}: {
  values: Array<number | null>;
  downs?: number[];
  width?: number;
  height?: number;
  /** id ของ gradient — ต้องไม่ซ้ำเมื่อมีหลายกราฟในหน้าเดียว */
  id?: string;
  /** ยืดเต็มความกว้างกล่อง (ไม่มีจุดปลายเส้น เพราะจะถูกยืดเป็นวงรี) */
  fluid?: boolean;
  emptyLabel?: string;
}) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line text-xs text-muted"
        style={{ width: fluid ? "100%" : width, height }}
      >
        {emptyLabel}
      </div>
    );
  }
  const max = Math.max(...known) * 1.15;
  const min = Math.min(...known) * 0.85;
  const step = width / (values.length - 1);
  const pts = values
    .map((v, i) =>
      v === null ? null : ([i * step, height - 6 - ((v - min) / (max - min || 1)) * (height - 12)] as const),
    )
    .filter((p): p is readonly [number, number] => p !== null);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1]![0].toFixed(1)},${height} L${pts[0]![0].toFixed(1)},${height} Z`;
  const last = pts[pts.length - 1]!;
  return (
    <svg
      width={fluid ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fluid ? "none" : undefined}
      className="block overflow-visible"
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={area}
        fill={`url(#${id}-fill)`}
        className="animate-fade-up"
        style={{ animationDelay: "400ms" }}
      />
      <path
        d={line}
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        pathLength={1}
        vectorEffect="non-scaling-stroke"
        className="line-draw"
      />
      {!fluid &&
        downs?.map((d, i) =>
          d > 0 ? (
            <circle
              key={i}
              cx={i * step}
              cy={height - 3}
              r={2.5}
              fill="var(--color-down)"
              className="animate-pop"
              style={{ animationDelay: "700ms" }}
            />
          ) : null,
        )}
      {!fluid && <circle cx={last[0]} cy={last[1]} r={3.5} fill="var(--color-brand)" className="dot-ping" />}
    </svg>
  );
}

type HeroState = "ok" | "warn" | "down" | "idle";

const HERO: Record<
  HeroState,
  { border: string; bg: string; glow: string; dot: string; text: string; label: string }
> = {
  ok: {
    border: "border-brand/25",
    bg: "from-brand-bg via-surface to-surface",
    glow: "bg-brand/15",
    dot: "bg-brand",
    text: "text-brand-deep",
    label: "ปกติ",
  },
  warn: {
    border: "border-warn/30",
    bg: "from-warn-bg via-surface to-surface",
    glow: "bg-warn/15",
    dot: "bg-warn",
    text: "text-warn",
    label: "ผิดปกติ",
  },
  down: {
    border: "border-down/25",
    bg: "from-down-bg via-surface to-surface",
    glow: "bg-down/15",
    dot: "bg-down",
    text: "text-down",
    label: "มีปัญหา",
  },
  idle: {
    border: "border-line",
    bg: "from-sidebar via-surface to-surface",
    glow: "bg-info/10",
    dot: "bg-subtle",
    text: "text-muted",
    label: "รอข้อมูล",
  },
};

/** ส่วนหัวหน้าภาพรวม: สีพื้นตามสถานะรวมของระบบ */
export function StatusHero({
  state,
  title,
  subtitle,
  ring,
  side,
  action,
}: {
  state: HeroState;
  title: ReactNode;
  subtitle: ReactNode;
  ring: ReactNode;
  side?: ReactNode;
  action?: { href: string; label: string };
}) {
  const st = HERO[state];
  return (
    <section
      className={cx(
        "animate-fade-up relative mb-5 overflow-hidden rounded-2xl border px-5 py-5 shadow-[var(--shadow-card)] md:px-7",
        st.border,
      )}
    >
      {/* พื้นหลังไล่เฉดตามสถานะ */}
      <div aria-hidden className={cx("absolute inset-0 bg-gradient-to-br", st.bg)} />
      <div
        aria-hidden
        className={cx("animate-float absolute -right-16 -top-24 h-64 w-64 rounded-full blur-3xl", st.glow)}
      />
      <div className="relative flex flex-wrap items-center gap-6">
        {ring}
        <div className="min-w-60 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cx("inline-block h-2.5 w-2.5 rounded-full", st.dot, state !== "idle" && "dot-ping")}
            />
            <span className={cx("text-xs font-medium uppercase tracking-wider", st.text)}>{st.label}</span>
          </div>
          <h2 className="mt-1.5 text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
          <div className="mt-1 text-sm text-muted">{subtitle}</div>
          {action && (
            <Link href={action.href} className="btn-secondary mt-3">
              {action.label}
              <span aria-hidden>→</span>
            </Link>
          )}
        </div>
        {side && <div className="shrink-0 max-md:w-full">{side}</div>}
      </div>
    </section>
  );
}
