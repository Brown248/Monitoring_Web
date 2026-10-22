import { causeLabel, formatMs, formatPercent, formatTime } from "@app/core";
import type { BeatStatus, Heartbeats } from "@/lib/data/heartbeats";
import { cx } from "./ui";

const BAR: Record<BeatStatus, string> = {
  up: "bg-brand",
  slow: "bg-amber-400",
  down: "bg-down",
  unknown: "bg-unknown/40",
};
const LABEL: Record<BeatStatus, string> = {
  up: "ปกติ",
  slow: "ช้า",
  down: "ล่ม",
  unknown: "สรุปไม่ได้",
};

export function HeartbeatLegend({ slowMs }: { slowMs: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {(["up", "slow", "down"] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className={cx("h-2.5 w-1.5 rounded-sm", BAR[s])} />
          {s === "slow" ? `ช้า > ${formatMs(slowMs)}` : LABEL[s]}
        </span>
      ))}
    </span>
  );
}

/** สีตัวเลข % ของแถบเรียลไทม์ */
export function heartbeatTone(h: Heartbeats | undefined): string {
  if (!h || h.uptime === null) return "text-muted";
  if (h.beats.at(-1)?.status === "down" || h.uptime < 0.95) return "text-down";
  if (h.uptime < 0.995 || h.slowRatio >= 0.5) return "text-warn";
  return "text-up";
}

/**
 * แถบเรียลไทม์: 1 เส้น = ผลตรวจ 1 ครั้ง (ล่าสุดอยู่ขวาสุด)
 * ผลตรวจน้อยกว่าจำนวนช่อง → เส้นกว้างขึ้นให้เต็มแถบ · ผลตรวจใหม่จะงอกขึ้นทางขวาเมื่อหน้ารีเฟรช
 * แต่ละเส้นเป็น element เดียว ข้อความ tooltip อยู่ใน data-tip แสดงด้วย <TipLayer> ตัวเดียวทั้งหน้า
 * (เดิม tooltip ฝังทุกเส้น → หน้าเว็บไซต์ 11 เว็บ HTML ใหญ่ 1.2 MB และจะโตตามจำนวนเว็บ)
 */
export function HeartbeatBars({
  data,
  tz,
  height = "h-7",
  muted = false,
  emptyLabel = "รอผลตรวจครั้งแรก",
}: {
  data: Heartbeats | undefined;
  tz: string;
  height?: string;
  /** เว็บที่ปิดการตรวจ — ยังเห็นประวัติแต่จางลง */
  muted?: boolean;
  emptyLabel?: string;
}) {
  const beats = data?.beats ?? [];
  if (beats.length === 0) {
    return (
      <div
        className={cx(
          "flex items-center justify-center rounded-md border border-dashed border-line text-xs text-muted",
          height,
        )}
      >
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className={cx("flex items-stretch gap-[2px]", height, muted && "opacity-40 grayscale-[60%]")}>
      {beats.map((b) => {
        const title = `${formatTime(b.at, tz)} · ${LABEL[b.status]}`;
        const detail =
          b.status === "down" || b.status === "unknown"
            ? b.http
              ? `HTTP ${b.http}`
              : causeLabel(b.error, b.http)
            : `${b.http ?? ""} · ${formatMs(b.ms)}`;
        return (
          <span
            key={b.id}
            className={cx("beat", BAR[b.status])}
            data-tip={`${title}\n${detail}`}
            aria-label={`${title} ${detail}`}
          />
        );
      })}
    </div>
  );
}

/** ตัวเลขด้านขวาของแถว: uptime ของผลตรวจในแถบ + % ที่ช้า */
export function HeartbeatSummary({ data }: { data: Heartbeats | undefined }) {
  if (!data || data.uptime === null) return <span className="text-sm text-muted">—</span>;
  return (
    <span className="flex flex-col items-end leading-tight">
      <span className={cx("num text-sm font-semibold", heartbeatTone(data))}>
        {formatPercent(data.uptime)}
      </span>
      {data.slowRatio > 0 ? (
        <span className="num text-[11px] font-medium text-warn">ช้า {Math.round(data.slowRatio * 100)}%</span>
      ) : (
        <span className="num text-[11px] text-muted">{formatMs(data.avgMs)}</span>
      )}
    </span>
  );
}
