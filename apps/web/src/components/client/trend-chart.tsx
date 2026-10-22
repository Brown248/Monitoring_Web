"use client";

import { formatDayMonth, formatHm, formatMs } from "@app/core";
import { useEffect, useMemo, useRef, useState } from "react";

export interface TrendPoint {
  t: string;
  avg: number | null;
  p95: number | null;
  total: number;
  down: number;
  slow: number;
  downSites: string[];
}

const H = 240;
const PAD_L = 52;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 28;

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

type Pt = [number, number];

/** แยกจุดเป็นช่วงที่ต่อเนื่อง (ช่วงที่ไม่มีผลตรวจ = เว้นว่าง ไม่ลากเส้นข้าม) */
function segments(pts: Array<Pt | null>): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of pts) {
    if (p) cur.push(p);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** เส้นโค้งแบบ monotone (Fritsch–Carlson) ของช่วงต่อเนื่อง ≥ 2 จุด — โค้งนุ่มแต่ไม่พุ่งเกินค่าจริง */
function curve(s: Pt[]): string {
  const n = s.length;
  const d = s.slice(0, -1).map((p, i) => (s[i + 1]![1] - p[1]) / (s[i + 1]![0] - p[0]));
  const m = s.map((_, i) => (i === 0 ? d[0]! : i === n - 1 ? d[n - 2]! : (d[i - 1]! + d[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i]! / d[i]!;
      const b = m[i + 1]! / d[i]!;
      const h = a * a + b * b;
      if (h > 9) {
        const k = 3 / Math.sqrt(h);
        m[i] = k * a * d[i]!;
        m[i + 1] = k * b * d[i]!;
      }
    }
  }
  let path = `M${s[0]![0]} ${s[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = s[i]!;
    const [x1, y1] = s[i + 1]!;
    const dx = (x1 - x0) / 3;
    path += `C${x0 + dx} ${y0 + m[i]! * dx},${x1 - dx} ${y1 - m[i + 1]! * dx},${x1} ${y1}`;
  }
  return path;
}

/**
 * เวลาตอบสนองรวมทั้งระบบ: พื้นที่ = ค่าเฉลี่ย, เส้นประ = p95, แถบแดง = ช่วงที่มีเว็บตรวจไม่ผ่าน
 * วัดความกว้างจริงของกล่อง (ไม่ยืด SVG) ตัวอักษรจึงไม่เบี้ยว · ชี้/แตะเพื่อดูรายละเอียดแต่ละช่วง
 */
export function TrendChart({
  points,
  bucketMin,
  tz,
  slowMs,
}: {
  points: TrendPoint[];
  bucketMin: number;
  tz: string;
  slowMs: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const multiDay = bucketMin >= 120;
  const n = points.length;
  const plotW = Math.max(0, width - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const step = n > 1 ? plotW / (n - 1) : plotW;
  const xOf = (i: number) => PAD_L + (n > 1 ? i * step : plotW / 2);

  const { max, avgPath, areaPath, p95Path, dots } = useMemo(() => {
    // แกนตั้งอิงค่าเฉลี่ย — p95 ของเว็บที่ช้าประจำไม่ทำให้เส้นเฉลี่ยแบนติดพื้น (ส่วนที่เกินถูกตัดที่ขอบบน)
    const maxAvg = Math.max(0, ...points.map((p) => p.avg ?? 0));
    const mx = niceMax(Math.max(maxAvg * 1.6, 300));
    const y = (v: number) => PAD_T + plotH - (Math.min(v, mx) / mx) * plotH;
    const base = PAD_T + plotH;
    const avgSegs = segments(points.map((p, i) => (p.avg === null ? null : [xOf(i), y(p.avg)])));
    const p95Segs = segments(points.map((p, i) => (p.p95 === null ? null : [xOf(i), y(p.p95)])));
    const long = avgSegs.filter((s) => s.length >= 2);
    return {
      max: mx,
      avgPath: long.map(curve).join(""),
      // พื้นที่ใต้เส้น: ปิดรูปจากจุดแรก/จุดสุดท้ายของแต่ละช่วงลงพื้น
      areaPath: long.map((s) => `${curve(s)}L${s[s.length - 1]![0]} ${base}L${s[0]![0]} ${base}Z`).join(""),
      p95Path: p95Segs
        .filter((s) => s.length >= 2)
        .map(curve)
        .join(""),
      // ช่วงที่มีผลตรวจเพียงช่องเดียว (เช่น เพิ่งเปิดระบบ) → แสดงเป็นจุด ไม่งั้นมองไม่เห็น
      dots: avgSegs.filter((s) => s.length === 1).map((s) => s[0]!),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- xOf ขึ้นกับ width/n ที่อยู่ใน deps แล้ว
  }, [points, width, plotH]);

  const yOf = (v: number) => PAD_T + plotH - (Math.min(v, max) / max) * plotH;
  const hasData = points.some((p) => p.total > 0);
  const label = (iso: string) =>
    multiDay ? `${formatDayMonth(iso, tz)} ${formatHm(iso, tz)}` : formatHm(iso, tz);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));

  function pick(clientX: number) {
    const r = box.current?.getBoundingClientRect();
    if (!r || n === 0) return;
    const i = Math.round((clientX - r.left - PAD_L) / (step || 1));
    setHover(i >= 0 && i < n ? i : null);
  }

  const hp = hover !== null ? points[hover] : null;
  const end = hp ? new Date(new Date(hp.t).getTime() + bucketMin * 60_000).toISOString() : null;
  const tipLeft = hover !== null ? Math.min(Math.max(xOf(hover), 110), Math.max(110, width - 110)) : 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-gradient-to-b from-brand/60 to-brand/10 ring-1 ring-brand/40" />
          เฉลี่ย
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t-2 border-dashed border-warn" />
          p95 (ช้าสุด 5%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-down/25 ring-1 ring-down/40" />
          มีเว็บตรวจไม่ผ่าน
        </span>
        {slowMs < max && (
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t border-dotted border-muted" />
            เกณฑ์ช้า {formatMs(slowMs)}
          </span>
        )}
      </div>
      <div
        ref={box}
        className="relative h-[240px] touch-pan-y select-none"
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={(e) => e.pointerType !== "touch" && setHover(null)}
      >
        {width > 0 && !hasData && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            ยังไม่มีผลตรวจในช่วงนี้
          </div>
        )}
        {width > 0 && hasData && (
          <svg
            width={width}
            height={H}
            className="block overflow-visible"
            role="img"
            aria-label="กราฟเวลาตอบสนองรวม"
          >
            <defs>
              <linearGradient id="trend-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-brand)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--color-brand)" stopOpacity="0.02" />
              </linearGradient>
              {/* ตัดเส้นที่สูงเกินแกนพอดีขอบบน (ค่าจริงดูได้ใน tooltip) */}
              <clipPath id="trend-plot">
                <rect x={PAD_L} y={PAD_T - 2} width={Math.max(0, width - PAD_L - PAD_R)} height={plotH + 4} />
              </clipPath>
            </defs>

            {/* ช่วงที่มีเว็บตรวจไม่ผ่าน — เข้มตามสัดส่วน */}
            {points.map((p, i) =>
              p.down > 0 ? (
                <rect
                  key={`d${i}`}
                  x={xOf(i) - Math.max(step, 4) / 2}
                  y={PAD_T}
                  width={Math.max(step, 4)}
                  height={plotH}
                  fill="var(--color-down)"
                  opacity={0.07 + Math.min(0.2, (p.down / Math.max(1, p.total)) * 0.5)}
                />
              ) : null,
            )}

            {[0, max / 2, max].map((t) => (
              <g key={t}>
                <line
                  x1={PAD_L}
                  x2={width - PAD_R}
                  y1={yOf(t)}
                  y2={yOf(t)}
                  stroke="var(--color-line)"
                  strokeDasharray={t === 0 ? undefined : "3 5"}
                />
                <text x={PAD_L - 8} y={yOf(t) + 4} textAnchor="end" fontSize={11} className="num fill-muted">
                  {t === 0 ? "0" : t >= 1000 ? `${t / 1000}s` : `${t}ms`}
                </text>
              </g>
            ))}

            {slowMs < max && (
              <line
                x1={PAD_L}
                x2={width - PAD_R}
                y1={yOf(slowMs)}
                y2={yOf(slowMs)}
                stroke="var(--color-muted)"
                strokeOpacity={0.6}
                strokeDasharray="1 4"
              />
            )}

            <g clipPath="url(#trend-plot)">
              <path d={areaPath} fill="url(#trend-area)" className="trend-fade" />
              <path
                d={p95Path}
                fill="none"
                stroke="var(--color-warn)"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                strokeOpacity={0.85}
                className="trend-fade"
              />
              <path
                d={avgPath}
                fill="none"
                stroke="var(--color-brand)"
                strokeWidth={2.25}
                strokeLinejoin="round"
                strokeLinecap="round"
                pathLength={1}
                className="trend-draw"
              />
              {dots.map(([x, y]) => (
                <circle key={x} cx={x} cy={y} r={3.5} fill="var(--color-brand)" className="trend-fade" />
              ))}
            </g>

            {points.map((p, i) =>
              // ป้ายสุดท้าย "ตอนนี้" — ข้ามป้ายปกติที่อยู่ใกล้เกินไปไม่ให้ทับกัน
              (i % labelEvery === 0 && n - 1 - i >= labelEvery * 0.75) || i === n - 1 ? (
                <text
                  key={`x${i}`}
                  x={xOf(i)}
                  y={H - 8}
                  textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                  fontSize={11}
                  className="num fill-muted"
                >
                  {i === n - 1 ? "ตอนนี้" : label(p.t)}
                </text>
              ) : null,
            )}

            {hover !== null && hp && (
              <g>
                <line
                  x1={xOf(hover)}
                  x2={xOf(hover)}
                  y1={PAD_T}
                  y2={PAD_T + plotH}
                  stroke="var(--color-ink)"
                  strokeOpacity={0.25}
                />
                {hp.p95 !== null && (
                  <circle
                    cx={xOf(hover)}
                    cy={yOf(hp.p95)}
                    r={3.5}
                    fill="var(--color-surface)"
                    stroke="var(--color-warn)"
                    strokeWidth={2}
                  />
                )}
                {hp.avg !== null && (
                  <circle
                    cx={xOf(hover)}
                    cy={yOf(hp.avg)}
                    r={4.5}
                    fill="var(--color-surface)"
                    stroke="var(--color-brand)"
                    strokeWidth={2.5}
                  />
                )}
              </g>
            )}
          </svg>
        )}

        {hp && end && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-52 -translate-x-1/2 rounded-xl border border-line bg-surface/95 px-3 py-2.5 text-xs shadow-[var(--shadow-lift)] backdrop-blur"
            style={{ left: tipLeft }}
          >
            <div className="num mb-1.5 font-semibold text-ink">
              {label(hp.t)} – {formatHm(end, tz)}
            </div>
            {hp.total === 0 ? (
              <div className="text-muted">ไม่มีผลตรวจในช่วงนี้</div>
            ) : (
              <dl className="space-y-0.5">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">เฉลี่ย</dt>
                  <dd className="num font-semibold text-brand-deep">{formatMs(hp.avg)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">p95</dt>
                  <dd className="num text-warn">{formatMs(hp.p95)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">ผลตรวจ</dt>
                  <dd className="num">
                    {hp.total.toLocaleString("th-TH")} ครั้ง
                    {hp.slow > 0 && <span className="text-warn"> · ช้า {hp.slow}</span>}
                  </dd>
                </div>
                {hp.down > 0 && (
                  <div className="mt-1 rounded-md bg-down-bg px-2 py-1 text-down">
                    <span className="font-medium">ไม่ผ่าน {hp.down} ครั้ง:</span>{" "}
                    {hp.downSites.slice(0, 4).join(", ")}
                    {hp.downSites.length > 4 && ` +${hp.downSites.length - 4}`}
                  </div>
                )}
              </dl>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
