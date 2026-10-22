"use client";

import { useState, type ReactNode } from "react";

type FlashTone = "down" | "up" | "info";

function toneFor(prev: string, next: string): FlashTone {
  if (next === "DOWN" || next === "FAILING") return "down";
  if (next === "UP" && (prev === "DOWN" || prev === "UNKNOWN")) return "up";
  return "info";
}

/**
 * กะพริบพื้นหลังเมื่อสถานะเปลี่ยนระหว่าง auto-refresh (router.refresh เก็บ state ของ client component ไว้)
 * ใช้ชื่อ animation สลับ a/b เพื่อเล่นซ้ำได้โดยไม่ต้อง remount ลูก ๆ
 */
export function Flash({
  value,
  as = "div",
  className,
  children,
}: {
  value: string;
  as?: "div" | "tr" | "li";
  className?: string;
  children: ReactNode;
}) {
  const [prev, setPrev] = useState(value);
  const [flash, setFlash] = useState<{ tone: FlashTone; n: number } | null>(null);
  if (value !== prev) {
    setPrev(value);
    setFlash({ tone: toneFor(prev, value), n: (flash?.n ?? 0) + 1 });
  }
  const Tag = as;
  return (
    <Tag
      className={className}
      data-status={value}
      style={
        flash
          ? { animation: `flash-${flash.tone}-${flash.n % 2 ? "a" : "b"} 2.4s var(--ease-out)` }
          : undefined
      }
    >
      {children}
    </Tag>
  );
}
