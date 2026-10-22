"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * ตัวเลขนับไปหาค่าใหม่ — ครั้งแรกนับจาก 0, เมื่อค่าเปลี่ยน (auto-refresh) นับจากค่าเดิม
 * server render ค่าจริงไว้ก่อน (ไม่มี JS ก็เห็นค่าถูกต้อง)
 */
export function CountUp({ value, durationMs = 700 }: { value: number; durationMs?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  // useLayoutEffect: ตั้งตัวเลขเริ่มต้นก่อนวาดจอ (ไม่เห็นค่าใหม่แวบก่อนเริ่มนับ)
  useLayoutEffect(() => {
    const el = ref.current;
    const from = prev.current;
    prev.current = value;
    if (
      !el ||
      from === value ||
      document.visibilityState !== "visible" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const fmt = new Intl.NumberFormat("en-US");
    const final = fmt.format(value);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / durationMs));
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt.format(Math.round(from + (value - from) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // กันค้างกลางทาง ถ้า browser หยุด animation frame (เช่น สลับแท็บระหว่างนับ)
    const settle = setTimeout(() => {
      cancelAnimationFrame(frame);
      el.textContent = final;
    }, durationMs + 150);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      el.textContent = final;
    };
  }, [value, durationMs]);
  // ข้อความในสแปนถูกแก้ตรง ๆ ระหว่างนับ — ถ้าให้ React จัดการ text node เอง React จะอัปเดต
  // node เก่าที่ถูกแทนไปแล้ว ตัวเลขค้างค่าเดิม จึงให้ React ตั้งผ่าน innerHTML ทั้งก้อนแทน
  return <span ref={ref} dangerouslySetInnerHTML={{ __html: value.toLocaleString("en-US") }} />;
}
