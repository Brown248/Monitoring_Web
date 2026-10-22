import { dayKey, formatDateTime, formatDuration, formatHm, isSameDay } from "@app/core";
import type { Metadata } from "next";
import Link from "next/link";
import { JobButton, QueryDate, QuerySelect } from "@/components/client/controls";
import { Dot, Empty, PageHeader, Pagination, Segments, Stat, StatGrid, withParams } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { incidentStats, listIncidents, type EmailSummary } from "@/lib/data/incidents";
import { websiteOptions } from "@/lib/data/websites";
import { SiteIcon } from "@/components/client/site-icon";
import { tz } from "@/lib/env";
import { clampPage, parseDateParam, parseId, parsePage } from "@/lib/params";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Incident" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

function emailText(list: EmailSummary[]): string {
  if (list.length === 0) return "—";
  return list
    .map((e) => {
      let s = `${e.type} ${e.sent}/${e.total}`;
      if (e.dead > 0) s += " · ล้มเหลว";
      else if (e.failed > 0) s += " · รอ retry";
      return s;
    })
    .join(" · ");
}

function aiText(status: string | null, error: string | null): string {
  switch (status) {
    case null:
      return "—";
    case "PENDING":
    case "RUNNING":
      return "กำลังวิเคราะห์";
    case "DONE":
      return "เสร็จแล้ว";
    case "SKIPPED":
      return "ข้าม (ปิดอัตโนมัติ)";
    case "FAILED":
      return `ล้มเหลว${error ? ` (${error.length > 40 ? error.slice(0, 40) + "…" : error})` : ""}`;
    default:
      return status;
  }
}

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const zone = tz();
  const status = sp.status === "open" || sp.status === "closed" ? sp.status : "all";
  const websiteId = parseId(sp.websiteId);
  const now = new Date();
  // ค่าเริ่มต้น 7 วันล่าสุด; ถ้าล้างตัวกรอง (from=all) = ไม่จำกัดวันที่
  const from =
    sp.from === "all"
      ? undefined
      : parseDateParam(sp.from)
        ? sp.from
        : dayKey(new Date(now.getTime() - 7 * 86_400_000), zone);
  const to = sp.from === "all" ? undefined : (parseDateParam(sp.to) ?? dayKey(now, zone));
  const page = parsePage(sp.page);
  const [stats, list, sites] = await Promise.all([
    incidentStats(),
    listIncidents({ status, websiteId, from, to, page, pageSize: PAGE_SIZE }, zone),
    websiteOptions(),
  ]);
  const current = {
    status: status === "all" ? undefined : status,
    websiteId: websiteId?.toString(),
    from: sp.from === "all" ? "all" : parseDateParam(sp.from),
    to: parseDateParam(sp.to),
  };
  const last = clampPage(page, list.total, PAGE_SIZE);
  if (last !== null) redirect(withParams("/incidents", current, { page: last > 1 ? last : undefined }));

  return (
    <>
      <PageHeader
        title="Incident"
        subtitle="ช่วงเวลาที่ระบบยืนยันว่าเว็บไซต์มีปัญหา · 1 Incident ส่ง DOWN และ Recovery อย่างละครั้ง"
        actions={user.role === "ADMIN" && <JobButton type="SHEETS_SYNC">ส่งออกไป Google Sheets</JobButton>}
      />
      <StatGrid className="mb-5">
        <Stat label="เปิดอยู่" value={stats.open} tone={stats.open > 0 ? "down" : undefined} />
        <Stat label="7 วันล่าสุด" value={stats.last7} />
        <Stat
          label="เวลาฟื้นตัวเฉลี่ย"
          value={stats.avgRecoveryMin === null ? "—" : formatDuration(stats.avgRecoveryMin * 60_000)}
        />
        <Stat
          label="ล่มบ่อยสุด (30 วัน)"
          mono={false}
          value={
            <span className="text-lg">
              {stats.top ? `${stats.top.name} · ${stats.top.count} ครั้ง` : "—"}
            </span>
          }
        />
      </StatGrid>

      <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div>
          <div className="mb-1.5 text-sm">สถานะ</div>
          <Segments
            items={[
              { label: "ทั้งหมด", v: undefined },
              { label: "เปิดอยู่", v: "open" },
              { label: "ปิดแล้ว", v: "closed" },
            ].map((s) => ({
              label: s.label,
              href: withParams("/incidents", current, { status: s.v, page: undefined }),
              active: (s.v ?? "all") === status,
            }))}
          />
        </div>
        <div className="min-w-56 flex-1">
          <div className="mb-1.5 text-sm">เว็บไซต์</div>
          <QuerySelect
            name="websiteId"
            value={websiteId?.toString() ?? ""}
            options={[
              { value: "", label: "ทุกเว็บไซต์" },
              ...sites.map((s) => ({ value: String(s.id), label: s.name })),
            ]}
          />
        </div>
        <div>
          <div className="mb-1.5 text-sm">ตั้งแต่</div>
          <QueryDate name="from" value={from ?? ""} />
        </div>
        <div>
          <div className="mb-1.5 text-sm">ถึง</div>
          <QueryDate name="to" value={to ?? ""} />
        </div>
        <Link href="/incidents?from=all" className="btn-secondary">
          ล้างตัวกรอง
        </Link>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="th">#</th>
                <th className="th">เว็บไซต์</th>
                <th className="th">สถานะ</th>
                <th className="th">เริ่ม</th>
                <th className="th">ฟื้นตัว</th>
                <th className="th">ระยะเวลา</th>
                <th className="th">สาเหตุจากผลตรวจ</th>
                <th className="th">อีเมล</th>
                <th className="th">AI</th>
              </tr>
            </thead>
            <tbody className="rows-in divide-y divide-line">
              {list.items.map((i) => (
                <tr key={i.id} className="row">
                  <td className="td">
                    <Link href={`/incidents/${i.id}`} className="link num">
                      #{i.id}
                    </Link>
                  </td>
                  <td className="td font-medium">
                    <span className="flex items-center gap-2.5">
                      <SiteIcon id={i.websiteId} name={i.websiteName} size={24} />
                      {i.websiteName}
                    </span>
                  </td>
                  <td className="td">
                    <span
                      className={`inline-flex items-center gap-1.5 ${i.recoveredAt ? "text-up" : "text-down"}`}
                    >
                      <Dot tone={i.recoveredAt ? "up" : "down"} />
                      {i.recoveredAt ? "ปิดแล้ว" : "เปิดอยู่"}
                    </span>
                  </td>
                  <td className="td num whitespace-nowrap">{formatDateTime(i.startedAt, zone)}</td>
                  <td className="td num whitespace-nowrap text-muted">
                    {i.recoveredAt
                      ? isSameDay(i.recoveredAt, i.startedAt, zone)
                        ? formatHm(i.recoveredAt, zone)
                        : formatDateTime(i.recoveredAt, zone)
                      : "—"}
                  </td>
                  <td className="td num whitespace-nowrap font-semibold">
                    {formatDuration((i.recoveredAt ?? now).getTime() - i.startedAt.getTime())}
                  </td>
                  <td className="td text-muted">{i.cause}</td>
                  <td className="td whitespace-nowrap">{emailText(i.emails)}</td>
                  <td className="td text-muted">{aiText(i.aiStatus, i.aiError)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.items.length === 0 && <Empty>ไม่พบ Incident ในช่วงที่เลือก</Empty>}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={list.total}
          numbered={false}
          hrefFor={(p) => withParams("/incidents", current, { page: p })}
        />
      </div>
    </>
  );
}
