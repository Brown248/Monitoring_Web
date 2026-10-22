"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * ย่อผืนผ้าใบขนาดคงที่ (เช่น แผนผัง 1680px) ให้พอดีความกว้างที่มี
 * จอแคบเกินไปจะไม่ย่อต่ำกว่า minScale แต่เลื่อนซ้าย-ขวาแทน (ตัวหนังสือยังอ่านได้) และบอกผู้ใช้ว่าเลื่อนได้
 */
export function FitCanvas({
  width,
  height,
  minScale = 0.5,
  children,
}: {
  width: number;
  height: number;
  minScale?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const s = Math.max(minScale, Math.min(1, el.clientWidth / width));
      setScale(s);
      setOverflow(width * s > el.clientWidth + 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, minScale]);
  const s = scale ?? 1;
  return (
    <div className="relative">
      <div
        ref={ref}
        className="overflow-x-auto overflow-y-hidden overscroll-x-contain"
        onScroll={(e) => {
          const t = e.currentTarget;
          setAtEnd(t.scrollLeft + t.clientWidth >= t.scrollWidth - 4);
        }}
      >
        <div
          style={{ width: width * s, height: height * s, visibility: scale === null ? "hidden" : undefined }}
        >
          <div style={{ width, height, transform: `scale(${s})`, transformOrigin: "0 0" }}>{children}</div>
        </div>
      </div>
      {overflow && !atEnd && (
        <>
          {/* ขอบจางด้านขวา + ป้ายบอกว่ายังมีส่วนที่เหลือ */}
          <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-surface to-transparent" />
          <div className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-ink/85 px-3 py-1 text-xs font-medium text-surface shadow-[var(--shadow-lift)]">
            เลื่อนเพื่อดูส่วนที่เหลือ →
          </div>
        </>
      )}
    </div>
  );
}
