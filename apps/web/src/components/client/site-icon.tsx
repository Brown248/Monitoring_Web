"use client";

import { siteInitials, toneOf } from "@app/core";
import { useState, useSyncExternalStore } from "react";

/** ต้องมี ICON_TONES (10) สี — เขียนเต็มเพื่อให้ Tailwind เก็บ class ไว้ */
const TONES = [
  "from-emerald-400 to-teal-600",
  "from-sky-400 to-indigo-600",
  "from-amber-400 to-orange-600",
  "from-fuchsia-400 to-purple-600",
  "from-rose-400 to-red-600",
  "from-lime-400 to-green-600",
  "from-cyan-400 to-blue-600",
  "from-violet-400 to-indigo-700",
  "from-orange-400 to-rose-600",
  "from-teal-400 to-cyan-700",
];

// ---------- รายการเว็บที่มีโลโก้: โหลดครั้งเดียวต่อหน้า แล้วใช้ร่วมกันทุกไอคอน ----------
let icons: Record<string, string> | null = null;
let loading: Promise<void> | null = null;
let loadedAt = 0;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

function load() {
  if (loading && Date.now() - loadedAt < 60_000) return;
  loadedAt = Date.now();
  loading = fetch("/api/favicons")
    .then((r) => (r.ok ? r.json() : {}))
    .then((j: { icons?: Record<string, string> }) => {
      icons = j.icons ?? {};
      notify();
    })
    .catch(() => {
      icons = {};
      notify();
    });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  load();
  return () => listeners.delete(cb);
}

/**
 * ไอคอนเว็บ: โลโก้จริงของเว็บ (Worker ดึง apple-touch-icon / favicon / โลโก้ในหน้าเว็บมาเก็บไว้)
 * — หลายเว็บใช้โลโก้เดียวกันก็แสดงโลโก้จริงตามนั้น (มีชื่อเว็บกำกับข้าง ๆ อยู่แล้ว)
 * ไม่มีโลโก้ / โหลดไม่สำเร็จ → อักษรย่อ สีตามชื่อ (ชื่อเดิมได้สีเดิมเสมอ)
 * ขอรูปเฉพาะเว็บที่มีโลโก้จริง และแสดงรูปเมื่อโหลดสำเร็จเท่านั้น — ไม่มีไอคอนรูปเสีย/คำขอ 404
 */
export function SiteIcon({
  id,
  name,
  size = 28,
  className = "",
}: {
  id: number;
  name: string;
  size?: number;
  className?: string;
}) {
  const idx = useSyncExternalStore(
    subscribe,
    () => icons,
    () => null,
  );
  const version = idx?.[id];
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const hasImg = version !== undefined && failed !== version;
  const imgOk = hasImg && loaded === version;
  const initials = siteInitials(name);
  const tone = TONES[toneOf(name) % TONES.length];
  const fontSize = size * (initials.length >= 3 ? 0.32 : initials.length === 2 ? 0.38 : 0.46);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1 ring-line ${imgOk ? "bg-white" : ""} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {!imgOk && (
        <span
          className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${tone} font-semibold leading-none tracking-tight text-white`}
          style={{ fontSize }}
        >
          {initials}
        </span>
      )}
      {hasImg && (
        // eslint-disable-next-line @next/next/no-img-element -- ไฟล์จาก API ภายใน ไม่ต้องผ่าน image optimizer
        <img
          src={`/api/websites/${id}/favicon?v=${version}`}
          alt=""
          width={size}
          height={size}
          decoding="async"
          className={`absolute h-[78%] w-[78%] object-contain transition-opacity duration-200 ${imgOk ? "opacity-100" : "opacity-0"}`}
          onLoad={(e) => (e.currentTarget.naturalWidth > 0 ? setLoaded(version) : setFailed(version))}
          onError={() => setFailed(version)}
        />
      )}
    </span>
  );
}
