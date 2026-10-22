import {
  causeLabel,
  formatDayMonth,
  formatHm,
  formatMs,
  formatPercent,
  isSameDay,
  shortUrl,
} from "@app/core";
import Link from "next/link";
import type { WebsiteRow } from "@/lib/data/websites";
import { EnabledToggle } from "./client/controls";
import { Flash } from "./client/flash";
import { SiteIcon } from "./client/site-icon";
import { Sparkline } from "./hero";
import type { Heartbeats } from "@/lib/data/heartbeats";
import { HeartbeatBars } from "./heartbeat-bars";
import { StatusLabel, cx } from "./ui";

export function responseText(w: WebsiteRow): string {
  if (!w.enabled || w.lastResultStatus === null) return "—";
  if (w.lastResultStatus === "UP") return formatMs(w.lastResponseMs);
  return w.lastHttpStatus ? `HTTP ${w.lastHttpStatus}` : causeLabel(w.lastErrorCode, w.lastHttpStatus);
}

export function lastCheckedText(w: WebsiteRow, now: Date, zone: string): string {
  if (!w.lastCheckedAt) return "—";
  return isSameDay(w.lastCheckedAt, now, zone)
    ? formatHm(w.lastCheckedAt, zone)
    : formatDayMonth(w.lastCheckedAt, zone);
}

/** การ์ดเว็บไซต์ (มุมมองการ์ด + จอแคบ) — ทั้งการ์ดคลิกได้, สวิตช์/ปุ่มอยู่เหนือลิงก์ */
export function WebsiteCard({
  w,
  isAdmin,
  now,
  zone,
  beats,
}: {
  w: WebsiteRow;
  isAdmin: boolean;
  now: Date;
  zone: string;
  beats?: Heartbeats;
}) {
  const hasSpark = w.enabled && w.spark.filter((v) => v !== null).length >= 2;
  const uptimeCls =
    !w.enabled || w.uptime24h === null
      ? ""
      : w.uptime24h < 0.95
        ? "text-down"
        : w.uptime24h < 0.995
          ? "text-warn"
          : "text-up";
  const down = w.enabled && (w.status === "DOWN" || w.failing);
  return (
    <Flash
      value={w.enabled ? (w.failing ? "FAILING" : w.status) : "OFF"}
      className={cx(
        "card card-hover group relative flex flex-col overflow-hidden",
        down && "border-down/40",
        !w.enabled && "opacity-75",
      )}
    >
      {down && <span className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-down to-transparent" />}
      <div className="flex items-start gap-3 px-4 pt-4">
        <SiteIcon id={w.id} name={w.name} size={40} />
        <div className="min-w-0 flex-1">
          <Link
            href={`/websites/${w.id}`}
            className="block truncate font-semibold tracking-tight after:absolute after:inset-0 after:content-['']"
          >
            {w.name}
          </Link>
          <div className="truncate font-mono text-xs text-muted" title={w.url}>
            {shortUrl(w.url)}
          </div>
        </div>
        <StatusLabel status={w.status} degraded={w.lastDegraded} failing={w.failing} enabled={w.enabled} />
      </div>

      <div className="relative z-10 mt-4 px-4">
        <HeartbeatBars
          data={beats}
          tz={zone}
          height="h-7"
          muted={!w.enabled}
          emptyLabel={w.enabled ? undefined : "ปิดการตรวจอยู่"}
        />
      </div>

      {hasSpark && (
        <div className="mt-3 px-4">
          <Sparkline id={`spark-${w.id}`} fluid height={40} values={w.spark} />
        </div>
      )}

      <dl className="mt-3 grid grid-cols-3 gap-2 px-4 text-xs">
        <div>
          <dt className="text-muted">Response</dt>
          <dd className={cx("num mt-0.5 truncate text-sm font-semibold", down && "text-down")}>
            {responseText(w)}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Uptime 24 ชม.</dt>
          <dd className={cx("num mt-0.5 text-sm font-semibold", uptimeCls)}>
            {w.enabled ? formatPercent(w.uptime24h) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">ตรวจล่าสุด</dt>
          <dd className="num mt-0.5 text-sm font-semibold">{lastCheckedText(w, now, zone)}</dd>
        </div>
      </dl>

      <div className="relative z-10 mt-4 flex items-center justify-between gap-2 border-t border-line bg-canvas/50 px-4 py-2.5">
        <EnabledToggle websiteId={w.id} enabled={w.enabled} disabled={!isAdmin} />
        {isAdmin && (
          <Link href={`/websites/${w.id}/edit`} className="btn-ghost px-2 py-1 text-xs">
            แก้ไข
          </Link>
        )}
      </div>
    </Flash>
  );
}
