import { formatDateTime, formatDuration } from "@app/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Logo } from "@/components/app-shell";
import { PrintButton } from "@/components/client/print-button";
import { PostmortemView } from "@/components/postmortem";
import { requireUser } from "@/lib/auth";
import { incidentDetail } from "@/lib/data/incidents";
import { postmortemFor } from "@/lib/data/security";
import { tz } from "@/lib/env";
import { parseId as parseIdParam } from "@/lib/params";

export const metadata: Metadata = { title: "รายงานสรุปเหตุ" };
export const dynamic = "force-dynamic";

/** หน้าพิมพ์รายงานสรุปเหตุ (ไม่มี sidebar) — กดพิมพ์แล้วเลือก "บันทึกเป็น PDF" ได้ */
export default async function PostmortemReport({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  // id นอกช่วง int4 / ไม่ใช่จำนวนเต็ม → 404 (ไม่ใช่ error 500 จากฐานข้อมูล)
  const id = parseIdParam((await params).id);
  if (id === undefined) notFound();
  const [inc, pm] = await Promise.all([incidentDetail(id), postmortemFor(id)]);
  if (!inc || !pm?.content) notFound();
  const zone = tz();
  const end = inc.recoveredAt ?? new Date();
  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto max-w-3xl px-6 py-10 print:px-0 print:py-0">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <span className="text-sm text-muted">ตัวอย่างก่อนพิมพ์</span>
          <PrintButton />
        </div>
        <article className="rounded-2xl border border-line bg-surface px-10 py-9 shadow-[var(--shadow-card)] print:border-0 print:px-0 print:shadow-none">
          <header className="mb-6 flex items-start justify-between gap-4 border-b border-line pb-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted">
                Postmortem · Incident #{inc.id}
              </p>
              <h1 className="mt-1 text-xl font-semibold">{inc.websiteName}</h1>
              <p className="mt-1 font-mono text-xs text-muted">{inc.url}</p>
            </div>
            <Logo size={36} />
          </header>
          <dl className="mb-6 grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-muted">เริ่ม</dt>
              <dd className="num font-medium">{formatDateTime(inc.startedAt, zone)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">กลับมาใช้งาน</dt>
              <dd className="num font-medium">
                {inc.recoveredAt ? formatDateTime(inc.recoveredAt, zone) : "ยังไม่กลับมา"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">ระยะเวลา</dt>
              <dd className="num font-medium">{formatDuration(end.getTime() - inc.startedAt.getTime())}</dd>
            </div>
          </dl>
          <PostmortemView content={pm.content} meta={`${pm.provider} · ${pm.model}`} print />
        </article>
      </div>
    </div>
  );
}
