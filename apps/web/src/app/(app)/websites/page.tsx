import { formatInterval, formatNumber, formatPercent } from "@app/core";
import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh, EnabledToggle, SearchBox } from "@/components/client/controls";
import { Flash } from "@/components/client/flash";
import { WebsiteCard, lastCheckedText, responseText } from "@/components/website-card";
import { HeartbeatBars } from "@/components/heartbeat-bars";
import { recentHeartbeats } from "@/lib/data/heartbeats";
import { Empty, PageHeader, Pagination, Segments, StatusLabel, cx, withParams } from "@/components/ui";
import { clampPage, parsePage } from "@/lib/params";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { loadSettings } from "@/lib/data/system";
import { listWebsites, websiteCounts, type StatusFilter } from "@/lib/data/websites";
import { SiteIcon } from "@/components/client/site-icon";
import { tz } from "@/lib/env";

export const metadata: Metadata = { title: "เว็บไซต์" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const STATUS_VALUES: StatusFilter[] = ["all", "UP", "DOWN", "UNKNOWN", "PENDING", "disabled"];

export default async function WebsitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const zone = tz();
  const status = (STATUS_VALUES.includes(sp.status as StatusFilter) ? sp.status : "all") as StatusFilter;
  const page = parsePage(sp.page);
  const q = (sp.q ?? "").slice(0, 100);
  const view: "table" | "cards" = sp.view === "cards" ? "cards" : "table";
  const [counts, list, settings] = await Promise.all([
    websiteCounts(),
    listWebsites({ q, status, page, pageSize: PAGE_SIZE }),
    loadSettings(),
  ]);
  const current = {
    q: q || undefined,
    status: status === "all" ? undefined : status,
    view: view === "cards" ? "cards" : undefined,
  };
  // เลยหน้าสุดท้าย (เช่น เว็บกลับมา UP ระหว่างดูหน้า 2 ของตัวกรอง DOWN) → ไปหน้าสุดท้ายที่มีข้อมูล
  const last = clampPage(page, list.total, PAGE_SIZE);
  if (last !== null) redirect(withParams("/websites", current, { page: last > 1 ? last : undefined }));
  const beats = await recentHeartbeats(
    list.items.map((w) => w.id),
    settings.check_defaults.slowThresholdMs,
    30,
  );
  const isAdmin = user.role === "ADMIN";
  const now = new Date();

  return (
    <>
      <AutoRefresh seconds={30} />
      <PageHeader
        title="เว็บไซต์"
        subtitle={`${counts.total} รายการ · ตรวจทุก ${formatInterval(settings.check_defaults.checkIntervalSeconds)}เป็นค่าเริ่มต้น`}
        actions={
          isAdmin && (
            <Link href="/websites/new" className="btn-primary">
              + เพิ่มเว็บไซต์
            </Link>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-64 flex-1">
          <SearchBox value={q} placeholder="ค้นหาชื่อหรือ URL" />
        </div>
        <Segments
          items={[
            { label: `ทั้งหมด ${counts.total}`, value: "all" },
            { label: `UP ${counts.up}`, value: "UP" },
            { label: `DOWN ${counts.down}`, value: "DOWN" },
            { label: `UNKNOWN ${counts.unknown}`, value: "UNKNOWN" },
            // แสดงเฉพาะเมื่อมีเว็บที่รอตรวจครั้งแรก (หรือกำลังกรองอยู่)
            ...(counts.pending > 0 || status === "PENDING"
              ? [{ label: `รอตรวจ ${counts.pending}`, value: "PENDING" }]
              : []),
            { label: `ปิดการตรวจ ${counts.disabled}`, value: "disabled" },
          ].map((s) => ({
            label: s.label,
            href: withParams("/websites", current, {
              status: s.value === "all" ? undefined : s.value,
              page: undefined,
            }),
            active: status === s.value,
          }))}
        />
        <ViewToggle
          view={view}
          tableHref={withParams("/websites", current, { view: undefined })}
          cardsHref={withParams("/websites", current, { view: "cards" })}
        />
      </div>

      {list.items.length > 0 && (
        <div
          className={cx(
            "stagger mb-4 grid gap-4 sm:grid-cols-2 2xl:grid-cols-3",
            view === "table" && "lg:hidden",
            view === "cards" && "lg:grid-cols-2 xl:grid-cols-3",
          )}
        >
          {list.items.map((w) => (
            <WebsiteCard key={w.id} w={w} isAdmin={isAdmin} now={now} zone={zone} beats={beats.get(w.id)} />
          ))}
        </div>
      )}

      {list.items.length > 0 && (
        <div className={cx("card mb-4 overflow-hidden [&>div]:border-t-0", view === "table" && "lg:hidden")}>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={list.total}
            hrefFor={(p) => withParams("/websites", current, { page: p })}
          />
        </div>
      )}

      <div
        className={cx(
          "card overflow-hidden",
          list.items.length > 0 && (view === "cards" ? "hidden" : "max-lg:hidden"),
        )}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="th">เว็บไซต์</th>
                <th className="th">สถานะ</th>
                <th className="th">Response ล่าสุด</th>
                <th className="th max-xl:hidden">ล่าสุด 30 ครั้ง</th>
                <th className="th">Uptime</th>
                <th className="th max-2xl:hidden">ตรวจล่าสุด</th>
                <th className="th max-2xl:hidden">รอบตรวจ</th>
                <th className="th">เปิดการตรวจ</th>
                <th className="th text-right">การจัดการ</th>
              </tr>
            </thead>
            <tbody className="rows-in divide-y divide-line">
              {list.items.map((w) => {
                return (
                  <Flash
                    as="tr"
                    key={w.id}
                    value={w.enabled ? (w.failing ? "FAILING" : w.status) : "OFF"}
                    className="row"
                  >
                    <td className="td">
                      <div className="flex items-center gap-3">
                        <SiteIcon id={w.id} name={w.name} size={32} />
                        <div className="min-w-0">
                          <Link href={`/websites/${w.id}`} className="font-medium hover:underline">
                            {w.name}
                          </Link>
                          <div className="max-w-52 truncate font-mono text-xs text-muted" title={w.url}>
                            {w.url}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="td">
                      <StatusLabel
                        status={w.status}
                        degraded={w.lastDegraded}
                        failing={w.failing}
                        enabled={w.enabled}
                      />
                    </td>
                    <td
                      className={cx(
                        "td num whitespace-nowrap",
                        w.enabled && w.status === "DOWN" && "text-down",
                      )}
                    >
                      {responseText(w)}
                    </td>
                    <td className="td max-xl:hidden">
                      <div className="w-[150px]">
                        <HeartbeatBars
                          data={beats.get(w.id)}
                          muted={!w.enabled}
                          emptyLabel={w.enabled ? undefined : "ปิดการตรวจอยู่"}
                          tz={zone}
                          height="h-6"
                        />
                      </div>
                    </td>
                    <td className="td num">{w.enabled ? formatPercent(w.uptime24h) : "—"}</td>
                    <td className="td whitespace-nowrap text-muted max-2xl:hidden">
                      {lastCheckedText(w, now, zone)}
                    </td>
                    <td className="td whitespace-nowrap text-muted max-2xl:hidden">
                      {formatInterval(w.checkIntervalSeconds)}
                    </td>
                    <td className="td">
                      <EnabledToggle websiteId={w.id} enabled={w.enabled} disabled={!isAdmin} />
                    </td>
                    <td className="td text-right">
                      {isAdmin ? (
                        <Link href={`/websites/${w.id}/edit`} className="btn-secondary">
                          แก้ไข
                        </Link>
                      ) : (
                        <Link href={`/websites/${w.id}`} className="btn-secondary">
                          ดู
                        </Link>
                      )}
                    </td>
                  </Flash>
                );
              })}
            </tbody>
          </table>
        </div>
        {list.items.length === 0 &&
          (counts.total === 0 ? (
            <div className="animate-fade-up flex flex-col items-center px-4 py-14 text-center">
              <span className="relative flex h-16 w-16 items-center justify-center">
                <span className="animate-float absolute inset-0 rounded-2xl bg-brand/15 blur-md" />
                <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand-deep text-white shadow-[var(--shadow-lift)]">
                  <svg
                    width="26"
                    height="26"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                  </svg>
                </span>
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight">ยังไม่มีเว็บไซต์ที่เฝ้าดู</h3>
              <p className="mt-1 max-w-sm text-sm text-muted">
                เพิ่ม URL แล้วระบบจะตรวจตามรอบที่ตั้งไว้ ส่งอีเมลเมื่อเว็บล่มและเมื่อกลับมาใช้งานได้
              </p>
              {isAdmin ? (
                <Link className="btn-primary mt-5" href="/websites/new">
                  + เพิ่มเว็บไซต์แรก
                </Link>
              ) : (
                <p className="mt-4 text-xs text-muted">รอผู้ดูแลระบบเพิ่มเว็บไซต์</p>
              )}
            </div>
          ) : (
            <Empty>{`ไม่พบเว็บไซต์ที่ตรงกับตัวกรอง (${formatNumber(counts.total)} รายการทั้งหมด)`}</Empty>
          ))}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={list.total}
          hrefFor={(p) => withParams("/websites", current, { page: p })}
        />
      </div>
      <p className="mt-3 text-xs text-muted">
        ปิดการตรวจ = Worker ข้ามเว็บนี้ แต่ยังเก็บประวัติไว้ · ต้องการลบให้ใช้ Archive ในหน้าแก้ไข
      </p>
    </>
  );
}

function ViewToggle({
  view,
  tableHref,
  cardsHref,
}: {
  view: "table" | "cards";
  tableHref: string;
  cardsHref: string;
}) {
  const item = (active: boolean) =>
    cx(
      "flex h-8 w-9 items-center justify-center rounded-md transition-all duration-200",
      active ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink",
    );
  return (
    <div
      className="flex rounded-lg bg-sidebar p-0.5 ring-1 ring-line max-lg:hidden"
      role="group"
      aria-label="มุมมอง"
    >
      <Link
        href={tableHref}
        className={item(view === "table")}
        aria-label="มุมมองตาราง"
        title="ตาราง"
        scroll={false}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </Link>
      <Link
        href={cardsHref}
        className={item(view === "cards")}
        aria-label="มุมมองการ์ด"
        title="การ์ด"
        scroll={false}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
        </svg>
      </Link>
    </div>
  );
}
