"use client";

import { useEffect, useRef, useState } from "react";

/**
 * tooltip ตัวเดียวทั้งหน้า สำหรับ element ที่มี data-tip (บรรทัดแรกตัวหนา บรรทัดถัดไปตัวเล็ก)
 * แทนการฝัง tooltip ไว้ในทุกแท่งของแถบผลตรวจ — HTML เล็กลงมากเมื่อมีเว็บเยอะ
 */
export function TipLayer() {
  const [tip, setTip] = useState<{ lines: string[]; x: number; y: number; below: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const target = useRef<Element | null>(null);

  useEffect(() => {
    const place = (el: Element) => {
      const r = el.getBoundingClientRect();
      const below = r.top < 64; // ใกล้ขอบบน → แสดงใต้แท่งแทน
      setTip({
        lines: (el.getAttribute("data-tip") ?? "").split("\n"),
        x: r.left + r.width / 2,
        y: below ? r.bottom + 8 : r.top - 8,
        below,
      });
    };
    const show = (e: PointerEvent | FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]");
      if (!el || el === target.current) return;
      target.current = el;
      place(el);
    };
    const hide = (e: PointerEvent | FocusEvent) => {
      // แตะบนจอสัมผัส: pointerout มาทันทีหลังยกนิ้ว → ถ้าซ่อนตรงนี้ tooltip จะเห็นแค่ตอนนิ้วแตะค้าง
      // (ซ่อนเมื่อแตะที่อื่นแทน — ดู tapAway)
      if ("pointerType" in e && e.pointerType === "touch") return;
      const to = (e as PointerEvent).relatedTarget as Element | null;
      if (to && target.current && target.current.contains(to)) return;
      target.current = null;
      setTip(null);
    };
    // เลื่อนจอระหว่างชี้อยู่ → tooltip ตามแท่งไป (แท่งหลุดจากจอ/ถูกลบ → ซ่อน)
    const follow = () => {
      const el = target.current;
      if (!el) return;
      if (!el.isConnected) {
        target.current = null;
        setTip(null);
      } else place(el);
    };
    const tapAway = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if ((e.target as Element | null)?.closest?.("[data-tip]")) return;
      target.current = null;
      setTip(null);
    };
    document.addEventListener("pointerdown", tapAway);
    document.addEventListener("pointerover", show);
    document.addEventListener("pointerout", hide);
    document.addEventListener("focusin", show);
    document.addEventListener("focusout", hide);
    window.addEventListener("scroll", follow, true);
    return () => {
      document.removeEventListener("pointerdown", tapAway);
      document.removeEventListener("pointerover", show);
      document.removeEventListener("pointerout", hide);
      document.removeEventListener("focusin", show);
      document.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", follow, true);
    };
  }, []);

  // ไม่ให้ล้นขอบจอซ้าย/ขวา
  useEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const left = Math.min(Math.max(8, tip.x - w / 2), window.innerWidth - w - 8);
    el.style.left = `${left}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[70] w-max max-w-56 rounded-lg bg-ink px-2.5 py-1.5 text-xs text-surface shadow-[var(--shadow-lift)]"
      style={{
        left: tip.x,
        top: tip.y,
        transform: tip.below ? undefined : "translateY(-100%)",
      }}
    >
      <span className="block font-medium">{tip.lines[0]}</span>
      {tip.lines.slice(1).map((l, i) => (
        <span key={i} className="block font-mono opacity-80">
          {l}
        </span>
      ))}
    </div>
  );
}
