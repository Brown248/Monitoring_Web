"use client";

import type { JourneyInput } from "@app/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { ActionButton, JobButton, Spinner } from "./controls";
import { api } from "./fetch";
import { JourneyEditor } from "./journey-editor";
import { toast } from "./toast";

/** การ์ดทดสอบใช้งานจริง: ดูผล ↔ แก้ขั้นตอน */
export function JourneyPanel({
  websiteId,
  url,
  initial,
  version,
  isAdmin,
  children,
}: {
  websiteId: number;
  url: string;
  initial: JourneyInput | null;
  /** updated_at ของการทดสอบ (ISO) — ส่งไปกันบันทึกทับของคนอื่น */
  version: string | null;
  isAdmin: boolean;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <JourneyEditor
        websiteId={websiteId}
        url={url}
        initial={initial}
        version={version}
        onClose={() => setEditing(false)}
      />
    );
  return (
    <div className="space-y-3">
      {children}
      {isAdmin && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <button
            type="button"
            className={initial ? "btn-secondary" : "btn-primary"}
            onClick={() => setEditing(true)}
          >
            {initial ? "แก้ขั้นตอน" : "ตั้งค่าการทดสอบ"}
          </button>
          {initial && (
            <>
              <JobButton type="JOURNEY_RUN" payload={{ websiteId }}>
                ทดสอบตอนนี้
              </JobButton>
              <ActionButton
                url={`/api/websites/${websiteId}/journey`}
                method="DELETE"
                variant="secondary"
                className="text-down"
                confirm="ลบการทดสอบใช้งานจริงของเว็บนี้? (ประวัติผลทดสอบยังอยู่)"
              >
                ลบ
              </ActionButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface Option {
  id: number;
  name: string;
}

/** เลือกระบบที่เว็บนี้พึ่งพา (ฐานข้อมูล, API, SSO ฯลฯ) */
export function DependencyPicker({
  websiteId,
  options,
  selected,
  isAdmin,
}: {
  websiteId: number;
  options: Option[];
  selected: number[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set(selected));
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options]);
  const shown = options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase()));

  async function save() {
    setBusy(true);
    try {
      const res = await api<{ message: string }>(
        `/api/websites/${websiteId}/dependencies`,
        "PUT",
        { dependsOn: [...picked] },
        { "x-base-version": [...selected].sort((a, b) => a - b).join(",") },
      );
      toast("success", res.message);
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast("error", "บันทึกไม่สำเร็จ", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing)
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.length === 0 ? (
          <span className="text-xs text-muted">ไม่ได้พึ่งพาระบบอื่น</span>
        ) : (
          selected.map((id) => (
            <Link
              key={id}
              href={`/websites/${id}`}
              className="rounded-full bg-sidebar px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ring-line transition-colors hover:bg-brand-bg hover:text-brand-deep"
            >
              {byId.get(id) ?? `#${id}`}
            </Link>
          ))
        )}
        {isAdmin && (
          <button
            type="button"
            className="btn-ghost px-2 py-0.5 text-xs"
            onClick={() => {
              setPicked(new Set(selected));
              setEditing(true);
            }}
          >
            แก้ไข
          </button>
        )}
      </div>
    );

  return (
    <div className="space-y-2">
      <input type="search" placeholder="ค้นหาเว็บไซต์…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1">
        {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-muted">ไม่พบเว็บไซต์</li>}
        {shown.map((o) => (
          <li key={o.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-canvas">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-brand)]"
                checked={picked.has(o.id)}
                onChange={(e) =>
                  setPicked((p) => {
                    const n = new Set(p);
                    if (e.target.checked) n.add(o.id);
                    else n.delete(o.id);
                    return n;
                  })
                }
              />
              {o.name}
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">เลือกแล้ว {picked.size} ระบบ</span>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => setEditing(false)} disabled={busy}>
            ยกเลิก
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy && <Spinner />}
            บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}
