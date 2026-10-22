import { formatDateTime, formatMs, formatRelativeDay, formatTime, JOURNEY_ACTION_LABEL } from "@app/core";
import type { JourneyStep } from "@app/db";
import Link from "next/link";
import type { DiagnosisRow, JourneyRunRow, SiteChangeRow } from "@/lib/data/insights";
import { cx, Pill, type Tone } from "./ui";

const STEP_TONE: Record<string, { tone: Tone; icon: string }> = {
  ok: { tone: "up", icon: "M20 6 9 17l-5-5" },
  warn: { tone: "warn", icon: "M12 8v5m0 3.5h.01" },
  fail: { tone: "down", icon: "M18 6 6 18M6 6l12 12" },
  skip: { tone: "muted", icon: "M5 12h14" },
};

const STEP_BG: Record<string, string> = {
  ok: "bg-up-bg text-up",
  warn: "bg-warn-bg text-warn",
  fail: "bg-down-bg text-down",
  skip: "bg-sidebar text-subtle",
};

const VERDICT_STYLE: Record<string, string> = {
  down: "border-down/25 bg-gradient-to-r from-down-bg to-surface",
  warn: "border-warn/25 bg-gradient-to-r from-warn-bg to-surface",
  ok: "border-up/25 bg-gradient-to-r from-up-bg to-surface",
};

/** ผลวินิจฉัย: สรุป (ใครต้องแก้อะไร) + ไล่ตรวจทีละชั้น */
export function DiagnosisView({ d, tz, compact }: { d: DiagnosisRow; tz: string; compact?: boolean }) {
  const v = d.verdict;
  return (
    <div className="space-y-4">
      <div className={cx("rounded-xl border px-4 py-3", VERDICT_STYLE[v.severity] ?? VERDICT_STYLE.warn)}>
        <div
          className={cx(
            "text-sm font-semibold",
            v.severity === "down" ? "text-down" : v.severity === "ok" ? "text-up" : "text-warn",
          )}
        >
          {v.title}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">{v.explanation}</p>
        {v.actions.length > 0 && (
          <div className="mt-2.5">
            <div className="text-xs font-semibold text-ink">ควรทำ</div>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-ink-soft">
              {v.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ol>
          </div>
        )}
        {v.healthy.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {v.healthy.map((h) => (
              <Pill key={h} tone="up">
                {h} ปกติ
              </Pill>
            ))}
          </div>
        )}
      </div>
      {!compact && d.steps.length > 0 && (
        <ol className="relative space-y-0">
          {d.steps.map((s, i) => {
            const st = STEP_TONE[s.status] ?? STEP_TONE.skip!;
            return (
              <li key={s.key} className="relative flex gap-3 pb-3 last:pb-0">
                {i < d.steps.length - 1 && (
                  <span
                    className="absolute left-[13px] top-7 h-[calc(100%-1.5rem)] w-px bg-line"
                    aria-hidden
                  />
                )}
                <span
                  className={cx(
                    "relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    STEP_BG[s.status],
                  )}
                  aria-hidden
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d={st.icon} />
                  </svg>
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    <span className="font-medium">{s.label}</span>
                    {s.ms !== null && <span className="num text-xs text-muted">{formatMs(s.ms)}</span>}
                  </div>
                  <div className="break-words text-xs text-muted">{s.detail}</div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="text-[11px] text-subtle">
        {d.trigger === "auto" ? "วินิจฉัยอัตโนมัติตอนเกิดเหตุ" : "สั่งวินิจฉัยจากหน้าเว็บ"} ·{" "}
        {formatDateTime(d.createdAt, tz)}
        {d.durationMs !== null && ` · ใช้เวลา ${(d.durationMs / 1000).toFixed(1)} วินาที`}
      </div>
    </div>
  );
}

const SEVERITY: Record<SiteChangeRow["severity"], { tone: Tone; label: string }> = {
  high: { tone: "down", label: "สำคัญมาก" },
  medium: { tone: "warn", label: "ควรตรวจ" },
  low: { tone: "muted", label: "เล็กน้อย" },
  info: { tone: "info", label: "ปกติ" },
};

/** ไทม์ไลน์การเปลี่ยนแปลงของเว็บ */
export function ChangeTimeline({ changes, tz }: { changes: SiteChangeRow[]; tz: string }) {
  return (
    <ul className="rows-in divide-y divide-line">
      {changes.map((c) => {
        const sev = SEVERITY[c.severity] ?? SEVERITY.low;
        return (
          <li key={c.id} className="px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{c.label}</span>
              <span className="flex items-center gap-2">
                <Pill tone={sev.tone} dot={false}>
                  {sev.label}
                </Pill>
                <span className="num text-xs text-muted" title={formatDateTime(c.at, tz)}>
                  {formatRelativeDay(c.at, tz)}
                </span>
              </span>
            </div>
            <div className="mt-1 grid gap-1 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-2">
              <span className="text-subtle">เดิม</span>
              <span className="break-all font-mono text-muted line-through decoration-subtle/50">
                {c.oldValue ?? "—"}
              </span>
              <span className="text-subtle">ใหม่</span>
              <span className="break-all font-mono text-ink">{c.newValue ?? "—"}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function describeStep(s: JourneyStep): string {
  const v = s.value?.startsWith("secret:") ? `🔒 ${s.value.slice(7)}` : s.value;
  switch (s.action) {
    case "goto":
      return `${JOURNEY_ACTION_LABEL.goto} ${v}`;
    case "fill":
      return `${JOURNEY_ACTION_LABEL.fill} ${s.selector} ← ${v}`;
    case "click":
    case "waitFor":
      return `${JOURNEY_ACTION_LABEL[s.action]} ${s.selector}`;
    default:
      return `${JOURNEY_ACTION_LABEL[s.action]} "${v}"`;
  }
}

/** ผลทดสอบใช้งานจริงย้อนหลัง (แถบสี + รายละเอียดครั้งล่าสุดที่ไม่ผ่าน) */
export function JourneyRuns({
  websiteId,
  runs,
  steps,
  tz,
  canViewScreenshot = false,
}: {
  websiteId: number;
  runs: JourneyRunRow[];
  steps: JourneyStep[];
  tz: string;
  /** ภาพหน้าจอดูได้เฉพาะ Admin */
  canViewScreenshot?: boolean;
}) {
  const last = runs[0];
  const lastFail = runs.find((r) => !r.ok);
  return (
    <div className="space-y-3">
      <div className="flex h-7 items-end gap-[3px]" aria-label="ผลทดสอบย้อนหลัง">
        {[...runs].reverse().map((r) => (
          <span
            key={r.id}
            title={`${formatDateTime(r.startedAt, tz)} · ${r.ok ? "ผ่าน" : "ไม่ผ่าน"} · ${(r.durationMs / 1000).toFixed(1)} วินาที`}
            className={cx("h-full w-2 rounded-sm", r.ok ? "bg-up" : "bg-down")}
          />
        ))}
      </div>
      {last && (
        <div className="text-xs text-muted">
          ล่าสุด {formatTime(last.startedAt, tz)} · {last.ok ? "ผ่านทุกขั้นตอน" : "ไม่ผ่าน"} ·{" "}
          {(last.durationMs / 1000).toFixed(1)} วินาที
        </div>
      )}
      {last?.ok && last.stepMs.length > 0 && (
        <ol className="space-y-1 text-xs">
          {steps.map((s, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="truncate text-muted">
                {i + 1}. {describeStep(s)}
              </span>
              <span className="num shrink-0">
                {last.stepMs[i] !== undefined ? formatMs(last.stepMs[i]!) : "—"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {lastFail && (
        <div
          className={cx(
            "rounded-lg px-3 py-2 text-xs",
            last && !last.ok ? "bg-down-bg text-down" : "bg-sidebar text-muted",
          )}
        >
          <div className="font-medium">
            {last && !last.ok ? "ไม่ผ่าน" : "ไม่ผ่านครั้งล่าสุด"} · {formatDateTime(lastFail.startedAt, tz)}
          </div>
          <div className="mt-0.5 break-words">{lastFail.error}</div>
          {lastFail.hasScreenshot && canViewScreenshot && (
            <Link
              className="link mt-1 inline-block"
              href={`/api/websites/${websiteId}/journey/screenshot?run=${lastFail.id}`}
              target="_blank"
            >
              ดูภาพหน้าจอตอนที่ไม่ผ่าน ↗
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
