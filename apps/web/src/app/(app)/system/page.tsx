import { formatAgo, formatBytes, formatDate, formatDuration, formatHm, formatTime } from "@app/core";
import { sql } from "@app/db";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionButton, AutoRefresh } from "@/components/client/controls";
import { Card, cx, Dot, Empty, PageHeader, type Tone } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  aiHealth,
  backupHealth,
  canaryHealth,
  dbLatencyMs,
  diskUsage,
  loadSettings,
  outboxHealth,
  sheetsHealth,
  workerHealth,
  type Health,
} from "@/lib/data/system";
import { getEnv, tz } from "@/lib/env";
import { requestNow } from "@/lib/time";

export const metadata: Metadata = { title: "สถานะระบบ" };
export const dynamic = "force-dynamic";

const HEALTH_TONE: Record<Health, Tone> = { ok: "up", warn: "warn", error: "down", off: "muted" };

function HealthCard({
  title,
  health,
  label,
  rows,
}: {
  title: string;
  health: Health;
  label: string;
  rows: Array<[string, ReactNode]>;
}) {
  const tone = HEALTH_TONE[health];
  return (
    <div className="card card-hover p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span
          className={cx(
            "inline-flex items-center gap-1.5 text-xs font-medium",
            tone === "up"
              ? "text-up"
              : tone === "down"
                ? "text-down"
                : tone === "warn"
                  ? "text-warn"
                  : "text-muted",
          )}
        >
          <Dot tone={tone} />
          {label}
        </span>
      </div>
      <dl className="space-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd className="num text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default async function SystemPage() {
  const user = await requireUser();
  const zone = tz();
  const db = getDb();
  const settings = await loadSettings();
  const [worker, latency, canary, outbox, ai, sheets, disk, extra, slots, queue, syncLogs, backup] =
    await Promise.all([
      workerHealth(),
      dbLatencyMs(),
      canaryHealth(),
      outboxHealth(settings),
      aiHealth(settings),
      sheetsHealth(settings),
      diskUsage(),
      db.execute<{ conns: string; max_conns: string; migrations: string; db_size: string }>(sql`
      SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::text AS conns,
             current_setting('max_connections') AS max_conns,
             (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS migrations,
             pg_database_size(current_database())::text AS db_size
    `),
      db.execute<{ slot: Date }>(
        sql`SELECT slot FROM heartbeat_slots WHERE slot >= now() - interval '24 hours' ORDER BY slot`,
      ),
      db.execute<{
        id: number;
        incident_id: number;
        event_type: string;
        recipient: string;
        status: string;
        attempts: number;
        last_error: string | null;
        next_attempt_at: Date;
      }>(sql`
      SELECT id, incident_id, event_type, recipient, status, attempts, last_error, next_attempt_at
      FROM notification_events WHERE status <> 'SENT' ORDER BY next_attempt_at LIMIT 50
    `),
      db.execute<{
        started_at: Date;
        entity_type: string;
        rows_synced: number;
        status: string;
        message: string | null;
      }>(sql`
      SELECT started_at, entity_type, rows_synced, status, message FROM integration_sync_logs
      WHERE integration = 'google_sheets' ORDER BY started_at DESC LIMIT 8
    `),
      backupHealth(),
    ]);
  const ex = extra.rows[0]!;
  const isAdmin = user.role === "ADMIN";

  // กราฟ heartbeat 24 ชม.: 288 ช่อง × 5 นาที
  const slotSet = new Set(slots.rows.map((s) => Math.floor(new Date(s.slot).getTime() / 300_000)));
  const nowMs = requestNow();
  const nowSlot = Math.floor(nowMs / 300_000);
  const firstSlot = slots.rows.length
    ? Math.floor(new Date(slots.rows[0]!.slot).getTime() / 300_000)
    : nowSlot;
  // "before" = ช่วงก่อน heartbeat แรกในหน้าต่าง 24 ชม. (ระบบยังไม่เริ่ม) — ไม่นับเป็นช่วงขาดหาย
  const grid: Array<"ok" | "gap" | "before"> = [];
  for (let i = 287; i >= 0; i--) {
    const s = nowSlot - i;
    grid.push(slotSet.has(s) ? "ok" : s < firstSlot ? "before" : "gap");
  }
  const gaps: Array<{ from: number; to: number }> = [];
  let gapStart: number | null = null;
  for (let s = Math.max(firstSlot, nowSlot - 287); s <= nowSlot - 1; s++) {
    if (!slotSet.has(s)) gapStart ??= s;
    else if (gapStart !== null) {
      gaps.push({ from: gapStart, to: s });
      gapStart = null;
    }
  }
  if (gapStart !== null && nowSlot - gapStart > 1) gaps.push({ from: gapStart, to: nowSlot });
  const gapMinutes = gaps.reduce((a, g) => a + (g.to - g.from) * 5, 0);

  const latestCanaryOk = canary.targets.filter((t) => t.ok).length;
  const b = backup.last;

  return (
    <>
      <AutoRefresh seconds={30} />
      <PageHeader title="สถานะระบบ" subtitle="สุขภาพของตัวระบบ Monitor เอง — แยกจากสถานะของเว็บไซต์ที่ตรวจ" />

      <div className="stagger mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <HealthCard
          title="Monitoring Worker"
          health={worker.health}
          label={worker.health === "ok" ? "ทำงาน" : worker.health === "off" ? "ยังไม่พบ" : "ขาดการติดต่อ"}
          rows={[
            ["heartbeat ล่าสุด", worker.lastSeenAt ? formatAgo(worker.lastSeenAt) : "—"],
            ["ตรวจ 5 นาทีล่าสุด", `${worker.checksLast5m} ครั้ง`],
            [
              "ทำงานต่อเนื่อง",
              worker.startedAt && worker.health === "ok"
                ? formatDuration(nowMs - worker.startedAt.getTime())
                : "—",
            ],
          ]}
        />
        <HealthCard
          title="Database"
          health="ok"
          label="เชื่อมต่อ"
          rows={[
            ["latency", `${latency} ms`],
            ["connections", `${ex.conns} / ${ex.max_conns}`],
            ["migration", `${ex.migrations} รายการ (ล่าสุด)`],
          ]}
        />
        <HealthCard
          title="Canary check"
          health={canary.health}
          label={
            canary.health === "ok"
              ? "ผ่าน"
              : canary.health === "off"
                ? "ยังไม่มีผล"
                : canary.health === "warn"
                  ? "ผ่านบางส่วน"
                  : "ล้มเหลว"
          }
          rows={[
            ...canary.targets.map((t, i): [string, ReactNode] => [
              `ปลายทาง ${i + 1}`,
              <span key={t.target} title={t.target}>
                {new URL(t.target).hostname} {t.ok ? "✓" : "✗"}
              </span>,
            ]),
            ["ล้มเหลวล่าสุด", canary.lastFailureAt ? formatTime(canary.lastFailureAt, zone) : "—"],
          ]}
        />
        <HealthCard
          title="อีเมล (SMTP)"
          health={outbox.health}
          label={
            !outbox.smtpConfigured
              ? "ยังไม่ตั้งค่า"
              : outbox.pending + outbox.failed + outbox.dead > 0
                ? "มีงานค้าง"
                : "ปกติ"
          }
          rows={[
            [
              "SMTP",
              outbox.smtpConfigured ? `${settings.smtp.host}:${settings.smtp.port}` : "ยังไม่ได้ตั้งค่า",
            ],
            ["Outbox ค้าง", `${outbox.pending + outbox.failed + outbox.dead} รายการ`],
            ["ส่งสำเร็จ 24 ชม.", `${outbox.sent24h} ฉบับ`],
          ]}
        />
        <HealthCard
          title="AI Analyzer"
          health={ai.health}
          label={ai.health === "ok" ? "พร้อม" : ai.health === "off" ? "ปิด" : "ตั้งค่าไม่ครบ"}
          rows={[
            ["provider", ai.provider === "none" ? "—" : `${ai.provider}${ai.model ? ` · ${ai.model}` : ""}`],
            [
              "เรียกใช้เดือนนี้",
              `${ai.callsThisMonth}${ai.monthlyLimit ? ` / ${ai.monthlyLimit}` : ""} ครั้ง`,
            ],
            ["ล้มเหลวล่าสุด", ai.lastFailureAt ? formatDate(ai.lastFailureAt, zone) : "—"],
          ]}
        />
        <HealthCard
          title="Backup ฐานข้อมูล"
          health={backup.health}
          label={
            backup.health === "ok"
              ? "ปกติ"
              : !b
                ? "ยังไม่เคย backup"
                : !b.ok
                  ? "ล้มเหลวล่าสุด"
                  : "เก่าเกินกำหนด"
          }
          rows={[
            [
              "สำเร็จล่าสุด",
              backup.lastOkAt
                ? `${formatDate(backup.lastOkAt, zone)} ${formatHm(backup.lastOkAt, zone)}`
                : "—",
            ],
            ["ขนาดไฟล์", b?.ok ? formatBytes(b.sizeBytes) : "—"],
          ]}
        />
        <HealthCard
          title="Google Sheets"
          health={sheets.health}
          label={
            !sheets.configured ? "ยังไม่ตั้งค่า" : sheets.lastStatus === "FAILED" ? "ล้มเหลวล่าสุด" : "ปกติ"
          }
          rows={[
            ["sync ล่าสุด", sheets.lastSyncAt ? formatHm(sheets.lastSyncAt, zone) : "—"],
            [
              "sync ถัดไป",
              sheets.nextSyncAt
                ? formatHm(sheets.nextSyncAt, zone)
                : settings.sheets.interval === "manual"
                  ? "กดเอง"
                  : "—",
            ],
            ["ค้างส่ง", `${sheets.pendingRows} แถว`],
          ]}
        />
      </div>

      <Card
        className="mb-5"
        title="Worker heartbeat · 24 ชั่วโมง"
        subtitle="ช่องละ 5 นาที · เทา = ไม่มี heartbeat (ระบบไม่ได้ตรวจเว็บในช่วงนั้น)"
        action={
          gaps.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-warn">
              <Dot tone="warn" />
              ขาดหาย {gaps.length} ช่วง · {gapMinutes} นาที
            </span>
          ) : (
            <span className="text-xs text-up">ไม่มีช่วงขาดหาย</span>
          )
        }
        bodyClassName="px-4 py-4"
      >
        <div className="flex h-8 gap-px">
          {grid.map((g, i) => (
            <span
              key={i}
              className={cx(
                "flex-1",
                g === "ok" ? "bg-up/75" : g === "gap" ? "bg-line-strong" : "bg-line/40",
              )}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted">
          <span>เมื่อวาน {formatHm(new Date(nowMs - 86_400_000), zone)}</span>
          <span>ตอนนี้</span>
        </div>
        {gaps.slice(-3).map((g) => (
          <div
            key={g.from}
            className="mt-3 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn"
          >
            <b className="num">
              {formatHm(new Date(g.from * 300_000), zone)} – {formatHm(new Date(g.to * 300_000), zone)}
            </b>{" "}
            ไม่มี heartbeat จาก Worker ({(g.to - g.from) * 5} นาที) — Worker หยุดหรือรีสตาร์ท · ตรวจ log ด้วย{" "}
            <code>docker compose logs worker</code>
          </div>
        ))}
      </Card>

      <Card
        className="mb-5"
        title="คิวอีเมล (Outbox)"
        subtitle="รายการที่ยังไม่สำเร็จ · retry อัตโนมัติแบบ backoff สูงสุด 12 ครั้ง (ราว 16 ชม.)"
        action={
          isAdmin &&
          outbox.failed + outbox.dead > 0 && (
            <ActionButton url="/api/outbox/retry-failed">ส่งใหม่ทั้งหมดที่ล้มเหลว</ActionButton>
          )
        }
      >
        {queue.rows.length === 0 ? (
          <Empty>ไม่มีอีเมลค้างส่ง</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">Incident</th>
                  <th className="th">ประเภท</th>
                  <th className="th">ผู้รับ</th>
                  <th className="th">สถานะ</th>
                  <th className="th">ครั้งที่</th>
                  <th className="th">Error ล่าสุด</th>
                  <th className="th">retry ถัดไป</th>
                  <th className="th">การจัดการ</th>
                </tr>
              </thead>
              <tbody className="rows-in divide-y divide-line">
                {queue.rows.map((n) => (
                  <tr key={n.id} className="row">
                    <td className="td">
                      <Link href={`/incidents/${n.incident_id}`} className="link num">
                        #{n.incident_id}
                      </Link>
                    </td>
                    <td className="td">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium ${n.event_type === "DOWN" ? "text-down" : "text-info"}`}
                      >
                        <Dot tone={n.event_type === "DOWN" ? "down" : "info"} />
                        {n.event_type}
                      </span>
                    </td>
                    <td className="td font-mono text-xs">{n.recipient}</td>
                    <td className="td">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs ${n.status === "PENDING" ? "text-muted" : "text-down"}`}
                      >
                        <Dot tone={n.status === "PENDING" ? "muted" : "down"} />
                        {n.status}
                      </span>
                    </td>
                    <td className="td num">{n.attempts}</td>
                    <td className="td max-w-64 truncate text-xs text-muted" title={n.last_error ?? ""}>
                      {n.last_error ?? "—"}
                    </td>
                    <td className="td num text-xs">
                      {n.status === "DEAD"
                        ? "เลิกส่งแล้ว"
                        : new Date(n.next_attempt_at) <= new Date()
                          ? "กำลังส่ง"
                          : formatTime(new Date(n.next_attempt_at), zone)}
                    </td>
                    <td className="td">
                      {isAdmin && <ActionButton url={`/api/outbox/${n.id}/retry`}>ส่งใหม่</ActionButton>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="stagger grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Google Sheets sync log">
          {syncLogs.rows.length === 0 ? (
            <Empty>
              {sheets.configured ? "ยังไม่เคย sync" : "ยังไม่ได้ตั้งค่า Google Sheets (ดูหน้าตั้งค่า)"}
            </Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">เวลา</th>
                  <th className="th">ข้อมูล</th>
                  <th className="th">จำนวนแถว</th>
                  <th className="th">สถานะ</th>
                  <th className="th">หมายเหตุ</th>
                </tr>
              </thead>
              <tbody className="rows-in divide-y divide-line">
                {syncLogs.rows.map((l, i) => (
                  <tr key={i} className="row">
                    <td className="td num">{formatTime(new Date(l.started_at), zone)}</td>
                    <td className="td">
                      {l.entity_type === "incidents"
                        ? "Incident"
                        : l.entity_type === "daily_uptime"
                          ? "Uptime รายวัน"
                          : "Check History"}
                    </td>
                    <td className="td num">{l.rows_synced}</td>
                    <td className="td">
                      <span
                        className={`inline-flex items-center gap-1.5 ${l.status === "SUCCESS" ? "text-up" : "text-down"}`}
                      >
                        <Dot tone={l.status === "SUCCESS" ? "up" : "down"} />
                        {l.status === "SUCCESS" ? "สำเร็จ" : "ล้มเหลว"}
                      </span>
                    </td>
                    <td className="td max-w-72 truncate text-xs text-muted" title={l.message ?? ""}>
                      {l.message ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Backup และพื้นที่" bodyClassName="px-4 py-3">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Backup ล่าสุด</dt>
              <dd className={`num ${b && !b.ok ? "text-down" : ""}`}>
                {b ? `${formatDate(b.at, zone)} ${formatHm(b.at, zone)} ${b.ok ? "✓" : "✗"}` : "ยังไม่มี"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">ปลายทาง</dt>
              <dd className="num text-right text-xs">
                {b?.destination ?? getEnv().BACKUP_DESTINATION ?? "—"}
              </dd>
            </div>
            {b?.ok && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted">ขนาดไฟล์ backup</dt>
                <dd className="num">{formatBytes(b.sizeBytes)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-muted">ขนาดฐานข้อมูล</dt>
              <dd className="num">{formatBytes(Number(ex.db_size))}</dd>
            </div>
            {disk && (
              <div className="pt-1">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">ดิสก์</dt>
                  <dd className="num">
                    {Math.round((disk.usedBytes / disk.totalBytes) * 100)}% ของ {formatBytes(disk.totalBytes)}
                  </dd>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                  <div
                    className={cx(
                      "h-full rounded-full",
                      disk.usedBytes / disk.totalBytes > 0.85
                        ? "bg-down"
                        : "bg-gradient-to-r from-brand-deep to-brand",
                    )}
                    style={{ width: `${Math.round((disk.usedBytes / disk.totalBytes) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </dl>
          {backup.health !== "ok" && (
            <p
              className={cx(
                "mt-3 rounded-md border px-3 py-2 text-xs",
                backup.health === "error"
                  ? "border-down/30 bg-down-bg text-down"
                  : "border-warn/30 bg-warn-bg text-warn",
              )}
            >
              {backup.detail}
              {b && (
                <>
                  {" "}
                  · ดูรายละเอียดใน <code>backups/backup.log</code>
                </>
              )}
            </p>
          )}
        </Card>
      </div>
      <p className="mt-4 text-xs text-muted">
        Canary: {latestCanaryOk}/{canary.targets.length} ปลายทางตอบได้ในรอบล่าสุด
      </p>
    </>
  );
}
