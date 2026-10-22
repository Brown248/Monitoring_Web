"use client";

import { useEffect, useRef, useState } from "react";

export const SESSION_EXPIRED_EVENT = "wm:session-expired";
export const SESSION_OK_EVENT = "wm:session-ok";

/**
 * session หมดอายุระหว่างใช้งาน — แทนที่จะพาไปหน้า login ทันที (ข้อมูลในฟอร์มหาย)
 * แสดงแถบให้เข้าสู่ระบบในแท็บใหม่ แล้วกลับมากดบันทึกซ้ำได้ ข้อมูลที่กรอกยังอยู่ครบ
 */
export function SessionBanner() {
  const [expired, setExpired] = useState(false);
  // กดปิดแล้ว: การตรวจเบื้องหลังทุก ๆ นาทีไม่เปิดแถบซ้ำ — เปิดอีกเฉพาะตอนผู้ใช้กดบันทึกแล้วไม่ผ่าน
  const dismissed = useRef(false);
  useEffect(() => {
    const on = (e: Event) => {
      if (dismissed.current && e instanceof CustomEvent && e.detail === "poll") return;
      setExpired(true);
    };
    const off = () => {
      dismissed.current = false;
      setExpired(false);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, on);
    window.addEventListener(SESSION_OK_EVENT, off);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, on);
      window.removeEventListener(SESSION_OK_EVENT, off);
    };
  }, []);
  if (!expired) return null;
  return (
    <div
      role="alert"
      className="animate-pop fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-xl flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-surface px-4 py-3 text-sm shadow-[var(--shadow-lift)]"
    >
      <span className="min-w-0 flex-1">
        <b>หมดเวลาเข้าสู่ระบบ</b> — ข้อมูลที่กรอกไว้ยังอยู่ เข้าสู่ระบบใหม่ในแท็บใหม่
        แล้วกลับมากดบันทึกอีกครั้ง
      </span>
      <a href="/login" target="_blank" rel="noopener" className="btn-primary">
        เข้าสู่ระบบ (แท็บใหม่)
      </a>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          dismissed.current = true;
          setExpired(false);
        }}
      >
        ปิด
      </button>
    </div>
  );
}
