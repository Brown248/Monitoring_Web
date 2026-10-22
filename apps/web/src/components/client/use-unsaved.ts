"use client";

import { useEffect } from "react";

/**
 * เตือนก่อนปิดแท็บ/รีโหลด เมื่อมีการแก้ไขที่ยังไม่บันทึก
 * (ข้อจำกัด: การกดลิงก์ภายในเว็บไม่ผ่าน beforeunload — App Router ไม่มีวิธีหยุดการเปลี่ยนหน้า)
 */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // เบราว์เซอร์รุ่นเก่ายังต้องการค่านี้ถึงจะแสดงกล่องยืนยัน
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
