import {
  formatAgo,
  formatDate,
  formatDuration,
  formatHm,
  formatMs,
  formatPercent,
  formatTime,
  shortUrl,
} from "@app/core";
import Link from "next/link";
import { AutoRefresh, RefreshButton } from "@/components/client/controls";
import {
  Card,
  Dot,
  Empty,
  PageHeader,
  Segments,
  Stat,
  StatGrid,
  withParams,
  type Tone,
} from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import {
  lastCheckAt,
  overallUptime24h,
  recentEvents,
  slowResponders,
  systemTrend,
  TREND_RANGES,
  type TrendRange,
} from "@/lib/data/dashboard";
import { StatusHero, UptimeRing } from "@/components/hero";
import { EventFeed } from "@/components/event-feed";
import { TrendChart } from "@/components/client/trend-chart";
import { Onboarding } from "@/components/onboarding";
import { openIncidents } from "@/lib/data/incidents";
import {
  aiHealth,
  backupHealth,
  canaryHealth,
  dbLatencyMs,
  loadSettings,
  outboxHealth,
  sheetsHealth,
  workerHealth,
  type Health,
} from "@/lib/data/system";
import { siteStatusList, websiteCounts } from "@/lib/data/websites";
import { recentHeartbeats } from "@/lib/data/heartbeats";
import { HeartbeatBars, HeartbeatLegend, HeartbeatSummary } from "@/components/heartbeat-bars";
import { openOutageGroups, securityAlertsList } from "@/lib/data/security";
import { openOperationalAlerts } from "@/lib/data/insights";
import { SiteStatusGrid } from "@/components/site-status-grid";
import { Flash } from "@/components/client/flash";
import { tz } from "@/lib/env";
import { SiteIcon } from "@/components/client/site-icon";
import { requestNow } from "@/lib/time";

export const dynamic = "force-dynamic";

const UPTIME_ROWS = 20;

const HEALTH_TONE: Record<Health, Tone> = { ok: "up", warn: "warn", error: "down", off: "muted" };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const zone = tz();
  const sp = await searchParams;
  const range: TrendRange = sp.trend === "7d" ? "7d" : "24h";
  const allEvents = sp.events === "all";
  const user = await getCurrentUser();
  const settings = await loadSettings();
  const slowMs = settings.check_defaults.slowThresholdMs;
  const [
    counts,
    uptime,
    last,
    open,
    slow,
    events,
    worker,
    latency,
    canary,
    outbox,
    ai,
    sheets,
    backup,
    trend,
    sites,
    groups,
    secAlerts,
    opAlerts,
  ] = await Promise.all([
    websiteCounts(),
    overallUptime24h(),
    lastCheckAt(),
    openIncidents(),
    slowResponders(),
    recentEvents({ limit: 12, importantOnly: !allEvents }),
    workerHealth(),
    dbLatencyMs(),
    canaryHealth(),
    outboxHealth(settings),
    aiHealth(settings),
    sheetsHealth(settings),
    backupHealth(),
    systemTrend(range, slowMs),
    siteStatusList(),
    openOutageGroups(),
    securityAlertsList({ open: true, limit: 3 }),
    openOperationalAlerts(),
  ]);
  const watched = sites.filter((s) => s.enabled);
  const beats = await recentHeartbeats(
    watched.slice(0, UPTIME_ROWS).map((s) => s.id),
    slowMs,
  );
  // ไม่ได้เปิดตรวจเว็บใดเลย = ไม่มีอะไรให้บอกว่า "ปกติ" (ไม่ใช่วงเขียวจากผลตรวจเก่า)
  const heroState: "ok" | "warn" | "down" | "idle" =
    counts.enabled === 0
      ? "idle"
      : open.length > 0 || counts.down > 0
        ? "down"
        : counts.failing > 0
          ? "warn"
          : uptime === null
            ? "idle"
            : "ok";
  const latestAvg = [...trend.buckets].reverse().find((b) => b.avg !== null)?.avg ?? null;
  const trendOk = trend.buckets.filter((b) => b.avg !== null);
  const trendChecks = trend.buckets.reduce((s, b) => s + b.total, 0);
  const trendDown = trend.buckets.reduce((s, b) => s + b.down, 0);
  const trendAvg = trendOk.length
    ? Math.round(
        trend.buckets.reduce((s, b) => s + (b.avg ?? 0) * (b.total - b.down), 0) /
          Math.max(
            1,
            trend.buckets.reduce((s, b) => s + (b.avg === null ? 0 : b.total - b.down), 0),
          ),
      )
    : null;
  const recovery = settings.check_defaults.confirmRecoveryCount;
  const nowMs = requestNow();

  const systemRows: Array<{ label: string; health: Health; detail: string }> = [
    {
      label: "Monitoring Worker",
      health: worker.health,
      detail: worker.lastSeenAt ? `heartbeat ${formatAgo(worker.lastSeenAt)}` : "ยังไม่พบ heartbeat",
    },
    { label: "Database", health: "ok", detail: `ตอบสนอง ${latency} ms` },
    {
      label: "Canary check",
      health: canary.health,
      detail: canary.targets.length
        ? `ผ่าน ${canary.targets.filter((t) => t.ok).length}/${canary.targets.length} ปลายทาง`
        : "ยังไม่มีผล",
    },
    {
      label: "คิวอีเมล (Outbox)",
      health: outbox.health,
      detail: !outbox.smtpConfigured
        ? "ยังไม่ได้ตั้งค่า SMTP"
        : outbox.pending + outbox.failed + outbox.dead > 0
          ? `ค้าง ${outbox.pending + outbox.failed + outbox.dead} รายการ${outbox.nextRetryAt ? ` · retry ${formatHm(outbox.nextRetryAt, zone)}` : ""}`
          : "ไม่มีงานค้าง",
    },
    {
      label: "AI Analyzer",
      health: ai.health,
      detail:
        ai.health === "off"
          ? "ปิดใช้งาน"
          : ai.health === "ok"
            ? "พร้อมใช้งาน"
            : !ai.keySet
              ? "ไม่พบ AI_API_KEY"
              : "ตั้งค่าไม่ครบ / ครบโควตา",
    },
    {
      label: "Backup ฐานข้อมูล",
      health: backup.health,
      detail: !backup.last
        ? "ยังไม่เคย backup"
        : !backup.last.ok
          ? "ครั้งล่าสุดล้มเหลว"
          : `${backup.stale ? "เก่าเกินกำหนด · " : ""}ล่าสุด ${formatDate(backup.last.at, zone)} ${formatHm(backup.last.at, zone)}`,
    },
    {
      label: "Google Sheets",
      health: sheets.health,
      detail: !sheets.configured
        ? "ยังไม่ได้ตั้งค่า"
        : sheets.lastSyncAt
          ? `Sync ล่าสุด ${formatHm(sheets.lastSyncAt, zone)}`
          : "ยังไม่เคย sync",
    },
  ];

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title="ภาพรวม"
        subtitle={`ตรวจล่าสุด ${last ? formatTime(last, zone) : "—"} · รีเฟรชอัตโนมัติทุก 15 วินาที`}
        actions={
          <>
            <RefreshButton />
            {user?.role === "ADMIN" && (
              <Link href="/websites/new" className="btn-primary">
                + เพิ่มเว็บไซต์
              </Link>
            )}
          </>
        }
      />

      {counts.total === 0 ? (
        <Onboarding
          isAdmin={user?.role === "ADMIN"}
          hasWebsite={false}
          smtpConfigured={outbox.smtpConfigured}
          workerOnline={worker.health === "ok"}
          aiReady={ai.health === "ok"}
        />
      ) : (
        <StatusHero
          state={heroState}
          title={
            heroState === "down"
              ? `มี ${Math.max(open.length, counts.down)} เว็บไซต์ล่มอยู่ตอนนี้`
              : heroState === "warn"
                ? `มี ${counts.failing} เว็บไซต์กำลังล้มเหลว`
                : heroState === "idle"
                  ? counts.enabled === 0
                    ? "ยังไม่ได้เปิดตรวจเว็บไซต์ใด"
                    : "กำลังรอผลตรวจครั้งแรก"
                  : "ทุกเว็บไซต์ทำงานปกติ"
          }
          subtitle={
            <>
              {heroState === "warn" && "รอยืนยันในรอบตรวจถัดไปก่อนเปิด Incident · "}
              เฝ้าดู {counts.enabled} เว็บไซต์ · ตรวจล่าสุด {last ? formatTime(last, zone) : "—"}
              {worker.health !== "ok" && <span className="ml-1 text-down">· Worker ไม่ได้ทำงาน</span>}
            </>
          }
          ring={
            <UptimeRing
              ratio={uptime}
              tone={
                heroState === "down"
                  ? "down"
                  : heroState === "warn"
                    ? "warn"
                    : heroState === "idle"
                      ? "muted"
                      : "up"
              }
            />
          }
          side={
            <div className="w-full rounded-xl border border-line bg-surface/75 px-4 py-3.5 backdrop-blur md:w-[340px]">
              <div className="mb-3 text-xs font-medium text-muted">สถานะรายเว็บ · {watched.length} เว็บ</div>
              <SiteStatusGrid sites={watched} />
              {latestAvg !== null && (
                <a
                  href="#trend"
                  className="mt-4 flex items-baseline justify-between gap-4 border-t border-line pt-3 text-xs text-muted transition-colors hover:text-ink"
                >
                  <span>Response เฉลี่ยทั้งระบบ (ล่าสุด)</span>
                  <span className="num text-sm font-semibold text-ink">{formatMs(latestAvg)} ↓</span>
                </a>
              )}
            </div>
          }
          action={
            open.length > 0 ? { href: "/incidents?status=open", label: "ดู Incident ที่เปิดอยู่" } : undefined
          }
        />
      )}

      {groups.map((g) => (
        <section
          key={g.kind + g.shared}
          className="animate-fade-up mb-5 flex flex-wrap items-start gap-3 rounded-xl border border-info/25 bg-info-bg/70 px-4 py-3.5"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info text-white">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="6" cy="6" r="2.5" />
              <circle cx="18" cy="6" r="2.5" />
              <circle cx="12" cy="18" r="2.5" />
              <path d="M7.8 7.8 10.6 16M16.2 7.8 13.4 16M8.5 6h7" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-info">ต้นเหตุร่วม: {g.title}</div>
            <div className="mt-0.5 text-xs text-ink-soft">{g.hint}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {g.members.map((m) => (
                <Link
                  key={m.incidentId}
                  href={`/incidents/${m.incidentId}`}
                  className="rounded-full bg-surface px-2.5 py-1 text-xs ring-1 ring-line transition-colors hover:ring-info/50"
                >
                  {m.name}
                </Link>
              ))}
            </div>
          </div>
        </section>
      ))}

      {opAlerts.length > 0 && (
        <section className="animate-fade-up mb-5 rounded-xl border border-warn/25 bg-warn-bg/70 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warn text-white">
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-warn">เตือนล่วงหน้า — ยังไม่ล่ม แต่ผิดปกติ</div>
              <div className="text-xs text-ink-soft">ระบบจะปิดการแจ้งเตือนเองเมื่อกลับมาปกติ</div>
            </div>
          </div>
          <ul className="mt-2 space-y-1 pl-12">
            {opAlerts.slice(0, 5).map((a) => (
              <li key={a.id} className="text-sm">
                <Link
                  href={a.websiteId ? `/websites/${a.websiteId}` : "/websites"}
                  className="hover:underline"
                >
                  <span className="font-medium">{a.title}</span>
                  {a.detail && <span className="text-xs text-muted"> — {a.detail}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {secAlerts.length > 0 && (
        <Link
          href="/security"
          className="animate-fade-up mb-5 flex items-center gap-3 rounded-xl border border-down/25 bg-down-bg/70 px-4 py-3 transition-colors hover:bg-down-bg"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-down text-white">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6zM12 9v4m0 3h.01" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-down">แจ้งเตือนด้านความปลอดภัยที่ยังไม่รับทราบ</div>
            <div className="truncate text-xs text-ink-soft">{secAlerts.map((a) => a.title).join(" · ")}</div>
          </div>
          <span className="text-sm text-down" aria-hidden>
            →
          </span>
        </Link>
      )}

      <StatGrid className="mb-5">
        <Stat
          label="เว็บไซต์ทั้งหมด"
          value={counts.total}
          sub={`เปิดการตรวจ ${counts.enabled} · ปิด ${counts.disabled}`}
        />
        <Stat
          label="UP"
          dot="up"
          value={Math.max(0, counts.up - counts.failing)}
          tone="up"
          sub={`uptime รวม 24 ชม. ${formatPercent(uptime)}`}
        />
        <Stat
          label="DOWN"
          dot="down"
          value={counts.down}
          tone={counts.down > 0 ? "down" : undefined}
          sub={
            counts.failing > 0
              ? `Incident เปิดอยู่ ${open.length} · กำลังล้มเหลว ${counts.failing} เว็บ`
              : `Incident เปิดอยู่ ${open.length} รายการ`
          }
        />
        <Stat
          label="UNKNOWN"
          dot="unknown"
          value={counts.unknown}
          sub={
            counts.pending > 0
              ? `ผลตรวจยังสรุปไม่ได้ · รอตรวจครั้งแรก ${counts.pending} เว็บ`
              : "ผลตรวจยังสรุปไม่ได้"
          }
        />
      </StatGrid>

      {watched.length > 0 && (
        <Card
          className="mb-5 overflow-visible!"
          title={
            <span className="flex items-center gap-2">
              <span className="dot-ping inline-block h-2 w-2 rounded-full bg-brand" />
              สถานะแบบเรียลไทม์
            </span>
          }
          subtitle="1 เส้น = ผลตรวจ 1 ครั้ง (ล่าสุด 90 ครั้ง) · อัปเดตอัตโนมัติทุก 15 วินาที"
          action={<HeartbeatLegend slowMs={slowMs} />}
        >
          <ul className="rows-in divide-y divide-line">
            {watched.slice(0, UPTIME_ROWS).map((s) => (
              <li key={s.id}>
                <Flash
                  value={s.failing ? "FAILING" : s.status}
                  className="grid items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[200px_minmax(0,1fr)_84px]"
                >
                  <Link href={`/websites/${s.id}`} className="flex min-w-0 items-center gap-2.5">
                    <SiteIcon id={s.id} name={s.name} size={26} />
                    <span className="truncate text-sm font-medium hover:underline">{s.name}</span>
                  </Link>
                  <HeartbeatBars data={beats.get(s.id)} tz={zone} />
                  <div className="text-right">
                    <HeartbeatSummary data={beats.get(s.id)} />
                  </div>
                </Flash>
              </li>
            ))}
          </ul>
          <div className="flex justify-between rounded-b-[inherit] border-t border-line bg-canvas/60 px-4 py-2 text-[11px] text-muted sm:pl-[232px] sm:pr-[116px]">
            <span>เก่ากว่า</span>
            <span>ล่าสุด</span>
          </div>
          {watched.length > UPTIME_ROWS && (
            <Link
              href="/websites"
              className="block border-t border-line px-4 py-2 text-center text-xs text-muted hover:text-ink"
            >
              ดูอีก {watched.length - UPTIME_ROWS} เว็บ →
            </Link>
          )}
        </Card>
      )}

      {watched.length > 0 && (
        <section id="trend" className="mb-5 scroll-mt-6">
          <Card
            title="เวลาตอบสนองรวมทั้งระบบ"
            subtitle={
              trendChecks > 0
                ? `${TREND_RANGES[range].label} · ช่วงละ ${trend.bucketMin >= 60 ? `${trend.bucketMin / 60} ชม.` : `${trend.bucketMin} นาที`} · เฉลี่ย ${formatMs(trendAvg)} · ตรวจ ${trendChecks.toLocaleString("th-TH")} ครั้ง${trendDown > 0 ? ` · ไม่ผ่าน ${trendDown.toLocaleString("th-TH")} ครั้ง` : " · ผ่านทั้งหมด"}`
                : `${TREND_RANGES[range].label} · ยังไม่มีผลตรวจ`
            }
            action={
              <Segments
                items={(Object.keys(TREND_RANGES) as TrendRange[]).map((r) => ({
                  label: TREND_RANGES[r].label,
                  href: withParams("/", sp, { trend: r === "24h" ? undefined : r }),
                  active: range === r,
                }))}
              />
            }
            bodyClassName="px-4 pb-3 pt-4"
          >
            <TrendChart points={trend.buckets} bucketMin={trend.bucketMin} tz={zone} slowMs={slowMs} />
          </Card>
        </section>
      )}

      {/* 2 คอลัมน์แยกกัน (ไม่ใช่ grid แถวต่อแถว) — การ์ดสั้นไม่ทิ้งช่องว่างใต้ตัวเอง */}
      <div className="stagger grid items-start gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-5">
          <Card
            title="Incident ที่เปิดอยู่"
            action={
              <Link href="/incidents" className="link">
                ดูทั้งหมด
              </Link>
            }
          >
            {open.length === 0 ? (
              <Empty>ไม่มี Incident ที่เปิดอยู่ — ทุกเว็บทำงานปกติ</Empty>
            ) : (
              <ul className="rows-in divide-y divide-line">
                {open.map((i) => (
                  <li key={i.id}>
                    <Link
                      href={`/incidents/${i.id}`}
                      className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-canvas/70"
                    >
                      <div className="flex min-w-0 gap-3">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-down">
                          <Dot tone="down" /> DOWN
                        </span>
                        <SiteIcon id={i.websiteId} name={i.name} size={32} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{i.name}</div>
                          <div className="truncate font-mono text-xs text-muted">{i.url}</div>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold text-down">
                          ล่ม {formatDuration(nowMs - i.startedAt.getTime())}
                        </div>
                        <div className="text-xs text-muted">
                          {i.cause}
                          {i.retries ? ` หลัง retry ${i.retries} ครั้ง` : ""}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-line bg-canvas/60 px-4 py-2.5 text-xs text-muted">
              อีเมลแจ้ง DOWN ถูกส่งครั้งเดียวต่อ Incident · จะส่ง Recovery
              เมื่อสำเร็จติดกันตามเกณฑ์ของแต่ละเว็บ (ค่าเริ่มต้น {recovery} รอบ)
            </p>
          </Card>
          <Card title="ตอบสนองช้ากว่าปกติ" subtitle="เทียบกับค่าเฉลี่ย 24 ชม. ของแต่ละเว็บ">
            {slow.length === 0 ? (
              <Empty>ไม่มีเว็บที่ตอบช้ากว่าปกติ</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-line">
                    <tr>
                      <th className="th">เว็บไซต์</th>
                      <th className="th">ล่าสุด</th>
                      <th className="th">เฉลี่ย 24 ชม.</th>
                      <th className="th">ต่างจากปกติ</th>
                    </tr>
                  </thead>
                  <tbody className="rows-in divide-y divide-line">
                    {slow.map((s) => (
                      <tr key={s.id} className="row">
                        <td className="td">
                          <div className="flex items-center gap-3">
                            <SiteIcon id={s.id} name={s.name} />
                            <div className="min-w-0">
                              <Link href={`/websites/${s.id}`} className="font-medium hover:underline">
                                {s.name}
                              </Link>
                              <div className="font-mono text-xs text-muted">{shortUrl(s.url)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="td num font-semibold text-warn">{formatMs(s.latest)}</td>
                        <td className="td num text-muted">{formatMs(s.avg)}</td>
                        <td className="td num text-warn">
                          <span className="inline-flex items-center gap-1.5">
                            <Dot tone="warn" />+{Math.round(s.diff * 100)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card
            title="สถานะระบบ"
            action={
              <Link href="/system" className="link">
                รายละเอียด
              </Link>
            }
          >
            <ul className="rows-in divide-y divide-line">
              {systemRows.map((r) => (
                <li key={r.label} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="flex items-center gap-2.5 font-medium">
                    <Dot tone={HEALTH_TONE[r.health]} />
                    {r.label}
                  </span>
                  <span className="text-right text-muted">{r.detail}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card
          title="เหตุการณ์ล่าสุด"
          subtitle={
            allEvents
              ? "ทุกเหตุการณ์ รวมงานระบบและการตั้งค่า"
              : "เฉพาะเรื่องที่ควรรู้ — ซ่อนงานระบบและการตั้งค่า"
          }
          action={
            <Segments
              items={[
                { label: "สำคัญ", href: withParams("/", sp, { events: undefined }), active: !allEvents },
                { label: "ทั้งหมด", href: withParams("/", sp, { events: "all" }), active: allEvents },
              ]}
            />
          }
        >
          {events.length === 0 ? (
            <Empty>{allEvents ? "ยังไม่มีเหตุการณ์" : "ไม่มีเหตุการณ์สำคัญ — ทุกอย่างปกติ"}</Empty>
          ) : (
            <EventFeed events={events} tz={zone} now={new Date(nowMs)} />
          )}
        </Card>
      </div>
    </>
  );
}
