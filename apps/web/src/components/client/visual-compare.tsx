"use client";

import { useState } from "react";

type View = "compare" | "diff";

/**
 * เทียบภาพหน้าเว็บ: ลากแถบเพื่อดูต้นแบบ (ซ้าย) กับล่าสุด (ขวา) หรือดูภาพไฮไลต์ส่วนที่เปลี่ยน
 * ภาพมาจาก /api/websites/[id]/snapshot (PNG ที่ worker ถ่ายเอง)
 */
export function VisualCompare({
  websiteId,
  hasDiff,
  version,
}: {
  websiteId: number;
  hasDiff: boolean;
  /** เปลี่ยนเมื่อมีภาพใหม่ เพื่อไม่ให้ browser ใช้ภาพเก่าใน cache */
  version: string;
}) {
  const [view, setView] = useState<View>("compare");
  const [pos, setPos] = useState(50);
  const src = (kind: string) =>
    `/api/websites/${websiteId}/snapshot?kind=${kind}&v=${encodeURIComponent(version)}`;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex rounded-lg bg-sidebar p-0.5 text-xs ring-1 ring-line">
          {(
            [
              ["compare", "ต้นแบบ ↔ ล่าสุด"],
              ["diff", "ส่วนที่เปลี่ยน"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              disabled={v === "diff" && !hasDiff}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 font-medium transition-all disabled:opacity-40 ${view === v ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {view === "compare" && <span className="text-xs text-muted">ลากแถบกลางภาพเพื่อเทียบ</span>}
      </div>
      <div className="relative aspect-[1366/900] w-full select-none overflow-hidden rounded-lg bg-sidebar ring-1 ring-line">
        {view === "diff" ? (
          // eslint-disable-next-line @next/next/no-img-element -- ภาพจาก API ภายใน
          <img
            src={src("diff")}
            alt="ส่วนที่เปลี่ยนจากต้นแบบ (สีแดง)"
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- ภาพจาก API ภายใน */}
            <img
              src={src("latest")}
              alt="หน้าเว็บล่าสุด"
              className="absolute inset-0 h-full w-full object-cover object-top"
            />
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- ภาพจาก API ภายใน */}
              <img
                src={src("baseline")}
                alt="ภาพต้นแบบ"
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
            </div>
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-surface shadow-[0_0_0_1px_rgb(0_0_0/0.15)]"
              style={{ left: `${pos}%` }}
            >
              <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface text-xs text-ink shadow-[var(--shadow-lift)] ring-1 ring-line">
                ⇆
              </span>
            </div>
            <span className="absolute left-2 top-2 rounded-md bg-ink/75 px-2 py-0.5 text-[11px] text-surface">
              ต้นแบบ
            </span>
            <span className="absolute right-2 top-2 rounded-md bg-ink/75 px-2 py-0.5 text-[11px] text-surface">
              ล่าสุด
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={pos}
              onChange={(e) => setPos(Number(e.target.value))}
              aria-label="เลื่อนเพื่อเทียบภาพต้นแบบกับภาพล่าสุด"
              className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
            />
          </>
        )}
      </div>
    </div>
  );
}
