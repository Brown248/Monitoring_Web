import { errorLabel, formatDateTime, formatNumber, formatTime, isSameDay } from "@app/core";
import { checksFilterSchema } from "@app/db/queries";
import type { Metadata } from "next";
import { detailCell, httpCell, responseCell } from "@/components/check-cells";
import { JobButton, QuerySelect } from "@/components/client/controls";
import { Empty, PageHeader, Pagination, Segments, StatusLabel, withParams } from "@/components/ui";
import { clampPage, parsePage } from "@/lib/params";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { checkHistory, errorCodesInUse } from "@/lib/data/checks";
import { loadSettings } from "@/lib/data/system";
import { websiteOptions } from "@/lib/data/websites";
import { tz } from "@/lib/env";

export const metadata: Metadata = { title: "ประวัติการตรวจ" };
export const dynamic = "force-dynamic";

const PAGE_SIZES = [50, 100, 200];

export default async function ChecksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const zone = tz();
  const parsed = checksFilterSchema.safeParse({
    websiteId: sp.websiteId || undefined,
    result: sp.result || undefined,
    errorCode: sp.errorCode || undefined,
    range: sp.range || undefined,
  });
  const filter = parsed.success ? parsed.data : checksFilterSchema.parse({});
  const pageSize = PAGE_SIZES.includes(Number(sp.size)) ? Number(sp.size) : 50;
  const page = parsePage(sp.page);
  const [data, sites, codes, settings] = await Promise.all([
    checkHistory(filter, page, pageSize),
    websiteOptions(),
    errorCodesInUse(),
    loadSettings(),
  ]);
  const current = {
    websiteId: filter.websiteId?.toString(),
    result: filter.result,
    errorCode: filter.errorCode,
    range: filter.range === "24h" ? undefined : filter.range,
    size: pageSize === 50 ? undefined : String(pageSize),
  };
  const last = clampPage(page, data.total, pageSize);
  if (last !== null) redirect(withParams("/checks", current, { page: last > 1 ? last : undefined }));
  const exportQuery = new URLSearchParams(
    Object.entries({
      websiteId: current.websiteId,
      result: current.result,
      errorCode: current.errorCode,
      range: filter.range,
    }).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const now = new Date();
  const totalAll = data.counts.up + data.counts.down + data.counts.unknown;

  return (
    <>
      <PageHeader
        title="ประวัติการตรวจ"
        subtitle={`ผลตรวจทุกครั้งของทุกเว็บไซต์ · เก็บแบบละเอียด ${settings.retention.checksDays} วัน จากนั้นรวมเป็นสรุปรายวัน`}
        actions={
          <>
            <a href={`/api/checks/export?${exportQuery}`} className="btn-secondary">
              ส่งออก CSV
            </a>
            {user.role === "ADMIN" && (
              <JobButton type="SHEETS_EXPORT_CHECKS" payload={filter}>
                ส่งไป Google Sheets
              </JobButton>
            )}
          </>
        }
      />
      <div className="card mb-4 grid gap-3 p-4 md:grid-cols-[1.4fr_auto_1fr_1fr] [&>*]:min-w-0">
        <div>
          <div className="mb-1.5 text-sm">เว็บไซต์</div>
          <QuerySelect
            name="websiteId"
            value={current.websiteId ?? ""}
            options={[
              { value: "", label: "ทุกเว็บไซต์" },
              ...sites.map((s) => ({ value: String(s.id), label: s.name })),
            ]}
          />
        </div>
        <div>
          <div className="mb-1.5 text-sm">ผลตรวจ</div>
          <Segments
            items={[
              { label: "ทั้งหมด", v: undefined },
              { label: "UP", v: "UP" },
              { label: "DOWN", v: "DOWN" },
              { label: "UNKNOWN", v: "UNKNOWN" },
              { label: "DEGRADED", v: "DEGRADED" },
            ].map((s) => ({
              label: s.label,
              href: withParams("/checks", current, { result: s.v, page: undefined }),
              active: filter.result === s.v,
            }))}
          />
        </div>
        <div>
          <div className="mb-1.5 text-sm">ประเภท Error</div>
          <QuerySelect
            name="errorCode"
            value={filter.errorCode ?? ""}
            options={[
              { value: "", label: "ทุกประเภท" },
              ...codes.map((c) => ({ value: c, label: errorLabel(c) })),
            ]}
          />
        </div>
        <div>
          <div className="mb-1.5 text-sm">ช่วงเวลา</div>
          <QuerySelect
            name="range"
            value={filter.range}
            options={[
              { value: "1h", label: "1 ชั่วโมงล่าสุด" },
              { value: "6h", label: "6 ชั่วโมงล่าสุด" },
              { value: "24h", label: "24 ชั่วโมงล่าสุด" },
              { value: "7d", label: "7 วันล่าสุด" },
              { value: "30d", label: "30 วันล่าสุด" },
              { value: "90d", label: "90 วันล่าสุด" },
            ]}
          />
        </div>
      </div>

      <p className="mb-3 flex flex-wrap gap-x-4 text-xs text-muted">
        <span>
          พบ <b className="num text-ink">{formatNumber(data.total)}</b> ผลตรวจ
        </span>
        <span>UP {formatNumber(data.counts.up)}</span>
        <span>DOWN {formatNumber(data.counts.down)}</span>
        <span>UNKNOWN {formatNumber(data.counts.unknown)}</span>
        <span>DEGRADED {formatNumber(data.counts.degraded)}</span>
        {totalAll !== data.total && <span>(จากทั้งหมด {formatNumber(totalAll)})</span>}
      </p>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="th">เวลา</th>
                <th className="th">เว็บไซต์</th>
                <th className="th">ผล</th>
                <th className="th">HTTP</th>
                <th className="th">Response</th>
                <th className="th">Retry</th>
                <th className="th">Error</th>
              </tr>
            </thead>
            <tbody className="rows-in divide-y divide-line">
              {data.items.map((c) => (
                <tr key={c.id} className="row">
                  <td className="td num whitespace-nowrap">
                    {isSameDay(c.checkedAt, now, zone)
                      ? formatTime(c.checkedAt, zone)
                      : formatDateTime(c.checkedAt, zone)}
                  </td>
                  <td className="td font-medium">{c.websiteName}</td>
                  <td className="td">
                    <StatusLabel status={c.status} degraded={c.degraded} />
                  </td>
                  <td className="td num">{httpCell(c)}</td>
                  <td className="td num">{responseCell(c)}</td>
                  <td className="td num">{c.retries}</td>
                  <td className="td text-muted">{detailCell(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.items.length === 0 && <Empty>ไม่พบผลตรวจตามตัวกรอง</Empty>}
        <div className="flex items-center gap-2 border-t border-line bg-canvas/60 px-4 pt-3 text-xs text-muted">
          ต่อหน้า
          <div className="w-24">
            <QuerySelect
              name="size"
              value={String(pageSize)}
              options={PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
            />
          </div>
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          numbered={false}
          hrefFor={(p) => withParams("/checks", current, { page: p })}
        />
      </div>
    </>
  );
}
