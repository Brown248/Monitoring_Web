"use client";

import { formatDayMonth, formatHm } from "@app/core";
import { useRef, useState } from "react";

export interface ChartPoint {
  t: string; // ISO
  ms: number | null;
  failed: boolean;
  unknown: boolean;
}

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const W = 1000;
const H = 220;
const PAD_L = 46;
const PAD_B = 24;
const PAD_T = 12;
const PLOT_W = W - PAD_L;
const PLOT_H = H - PAD_B - PAD_T;

/** กราฟแท่ง response time — ชี้เพื่อดูรายละเอียด · เส้นประ = ค่าเฉลี่ย / p95 · แท่งแดง = ตรวจไม่สำเร็จ */
export function ResponseChart({
  points,
  tz,
  multiDay,
}: {
  points: ChartPoint[];
  tz: string;
  multiDay: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted">ยังไม่มีผลตรวจในช่วงนี้</div>
    );
  }

  const ok = points.filter((p) => !p.failed && p.ms !== null).map((p) => p.ms!);
  const sorted = [...ok].sort((a, b) => a - b);
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : null;
  // ตัด outlier ด้านบนเพื่อไม่ให้แท่งปกติแบนเกินไป
  const p98 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))]! : 100;
  const max = niceMax(Math.max(p98, p95 ?? 0, 100));
  const barW = PLOT_W / points.length;
  const gap = barW > 6 ? 2 : barW > 3 ? 1 : 0.4;
  const yOf = (v: number) => PAD_T + PLOT_H - (Math.min(v, max) / max) * PLOT_H;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const failedCount = points.filter((p) => p.failed).length;

  function onMove(e: React.PointerEvent) {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W - PAD_L;
    const i = Math.floor(x / barW);
    setHover(i >= 0 && i < points.length ? i : null);
  }

  const hp = hover !== null ? points[hover] : null;
  const hoverLeftPct = hover !== null ? ((PAD_L + (hover + 0.5) * barW) / W) * 100 : 0;
  const fmtTime = (iso: string) =>
    multiDay ? `${formatDayMonth(iso, tz)} ${formatHm(iso, tz)}` : formatHm(iso, tz);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-b from-emerald-400 to-emerald-500/60" />
          ตอบสำเร็จ
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-red-400/70" />
          ล้มเหลว {failedCount > 0 && <b className="num text-down">{failedCount}</b>}
        </span>
        {avg !== null && (
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dashed border-ink/50" />
            เฉลี่ย <b className="num text-ink">{avg.toLocaleString("en-US")} ms</b>
          </span>
        )}
        {p95 !== null && (
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dotted border-warn" />
            p95 <b className="num text-ink">{p95.toLocaleString("en-US")} ms</b>
          </span>
        )}
      </div>
      <div
        ref={ref}
        // pan-y: ปัดขึ้นลงบนกราฟแล้วหน้าเลื่อนได้ (touch-none ทำให้มือถือเลื่อนผ่านกราฟไม่ได้)
        className="relative touch-pan-y select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        // แตะบนจอสัมผัส: เบราว์เซอร์ส่ง pointerleave ทันทีหลังยกนิ้ว — ไม่ซ่อน ให้อ่านรายละเอียดได้
        onPointerLeave={(e) => e.pointerType !== "touch" && setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-60 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label="กราฟ response time"
        >
          <defs>
            <linearGradient id="rc-ok" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.5" />
            </linearGradient>
            <linearGradient id="rc-high" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.5" />
            </linearGradient>
            <linearGradient id="rc-fail" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0.3" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD_L}
                x2={W}
                y1={yOf(t)}
                y2={yOf(t)}
                stroke="var(--color-line)"
                strokeDasharray={t === 0 ? undefined : "4 4"}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {points.map((p, i) => {
            const x = PAD_L + i * barW + gap / 2;
            const w = Math.max(0.4, barW - gap);
            const dim = hover !== null && hover !== i ? 0.45 : 1;
            const style = {
              animationDelay: `${Math.round((i / points.length) * 500)}ms`,
              opacity: dim,
              transition: "opacity 0.15s",
            };
            if (p.failed)
              return (
                <rect
                  key={i}
                  x={x}
                  y={PAD_T}
                  width={w}
                  height={PLOT_H}
                  fill="url(#rc-fail)"
                  rx={1}
                  className="bar-grow"
                  style={style}
                />
              );
            if (p.ms === null)
              return (
                <rect
                  key={i}
                  x={x}
                  y={PAD_T + PLOT_H - 4}
                  width={w}
                  height={4}
                  fill="var(--color-line-strong)"
                  className="bar-grow"
                  style={style}
                />
              );
            const y = yOf(p.ms);
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={w}
                height={Math.max(2, PAD_T + PLOT_H - y)}
                fill={p.ms > max || (p95 !== null && p.ms > p95 * 1.5) ? "url(#rc-high)" : "url(#rc-ok)"}
                rx={1.5}
                className="bar-grow"
                style={style}
              />
            );
          })}
          {avg !== null && (
            <line
              x1={PAD_L}
              x2={W}
              y1={yOf(avg)}
              y2={yOf(avg)}
              stroke="var(--color-ink)"
              strokeOpacity={0.5}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {p95 !== null && (
            <line
              x1={PAD_L}
              x2={W}
              y1={yOf(p95)}
              y2={yOf(p95)}
              stroke="var(--color-warn)"
              strokeWidth={1.5}
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* ตัวเลข/เวลาเป็น HTML ไม่ใช่ <text> ใน SVG — SVG ถูกยืดตามความกว้าง (preserveAspectRatio="none")
            ตัวหนังสือในนั้นจะบี้/ยืดตามจอ (มือถืออ่านไม่ออก) */}
        {ticks.map((tk) => (
          <span
            key={`y${tk}`}
            className="pointer-events-none absolute -translate-y-full whitespace-nowrap font-mono text-[11px] leading-none text-muted"
            style={{
              top: `${(yOf(tk) / H) * 100}%`,
              left: `${(PAD_L / W) * 100}%`,
              paddingLeft: 4,
              paddingBottom: 2,
            }}
          >
            {tk === 0 ? "0 ms" : tk.toLocaleString("en-US")}
          </span>
        ))}
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <span
              key={`x${i}`}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap font-mono text-[11px] leading-none text-muted"
              style={{
                top: `${((H - 4) / H) * 100}%`,
                left: `${((PAD_L + i * barW + barW / 2) / W) * 100}%`,
              }}
            >
              {multiDay ? formatDayMonth(p.t, tz) : formatHm(p.t, tz)}
            </span>
          ) : null,
        )}

        {hp && (
          <>
            <div
              className="pointer-events-none absolute bottom-6 top-3 w-px bg-ink/30"
              style={{ left: `${hoverLeftPct}%` }}
            />
            <div
              className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-[var(--shadow-lift)] backdrop-blur animate-pop"
              style={{ left: `clamp(80px, ${hoverLeftPct}%, calc(100% - 80px))` }}
            >
              <div className="num text-muted">{fmtTime(hp.t)}</div>
              {hp.failed ? (
                <div className="mt-0.5 font-semibold text-down">● ตรวจไม่สำเร็จ</div>
              ) : hp.ms === null ? (
                <div className="mt-0.5 font-semibold text-unknown">● UNKNOWN</div>
              ) : (
                <div className="mt-0.5 flex items-baseline gap-1.5">
                  <span className="num text-base font-semibold">{hp.ms.toLocaleString("en-US")}</span>
                  <span className="text-muted">ms</span>
                  {avg !== null && avg > 0 && (
                    <span className={`num ml-auto ${hp.ms > avg ? "text-warn" : "text-up"}`}>
                      {hp.ms > avg ? "+" : ""}
                      {Math.round(((hp.ms - avg) / avg) * 100)}%
                    </span>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
