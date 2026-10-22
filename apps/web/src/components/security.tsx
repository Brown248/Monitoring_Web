import { formatAgo } from "@app/core";
import type { SecurityFinding } from "@app/db";
import Link from "next/link";
import type { SecurityAlertRow } from "@/lib/data/security";
import { ActionButton } from "./client/controls";
import { Dot, cx, type Tone } from "./ui";

const GRADE_STYLE: Record<string, string> = {
  A: "from-emerald-400 to-emerald-600 text-white",
  B: "from-lime-400 to-green-600 text-white",
  C: "from-amber-300 to-amber-500 text-ink",
  D: "from-orange-400 to-orange-600 text-white",
  F: "from-red-500 to-red-700 text-white",
};

/** เกรดความปลอดภัย A–F แบบป้ายไล่สี */
export function GradeBadge({ grade, size = 36 }: { grade: string | null; size?: number }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br font-bold shadow-[var(--shadow-card)]",
        grade ? GRADE_STYLE[grade] : "bg-sidebar text-subtle ring-1 ring-line",
      )}
      style={{ width: size, height: size, fontSize: size * 0.48 }}
      title={grade ? `เกรดความปลอดภัย ${grade}` : "ยังไม่ได้สแกน"}
    >
      {grade ?? "–"}
    </span>
  );
}

const SEV: Record<SecurityFinding["severity"], { label: string; tone: Tone; cls: string }> = {
  high: { label: "สูง", tone: "down", cls: "bg-down-bg text-down" },
  medium: { label: "กลาง", tone: "warn", cls: "bg-warn-bg text-warn" },
  low: { label: "ต่ำ", tone: "info", cls: "bg-info-bg text-info" },
  info: { label: "ข้อแนะนำ", tone: "muted", cls: "bg-sidebar text-muted" },
};

export function SeverityChip({ severity }: { severity: SecurityFinding["severity"] | string }) {
  const s = SEV[severity as SecurityFinding["severity"]] ?? SEV.info;
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        s.cls,
      )}
    >
      {s.label}
    </span>
  );
}

/** รายการปัญหาพร้อมวิธีแก้ (กดเปิดดูวิธีแก้) */
export function FindingList({ findings }: { findings: SecurityFinding[] }) {
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-up">
        <Dot tone="up" /> ไม่พบปัญหาจากการสแกนแบบ passive
      </div>
    );
  }
  return (
    <ul className="rows-in divide-y divide-line">
      {findings.map((f) => (
        <li key={f.id}>
          <details className="group px-4 py-3">
            <summary className="flex cursor-pointer list-none items-start gap-3 text-sm">
              <SeverityChip severity={f.severity} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{f.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{f.detail}</span>
              </span>
              <span className="text-xs text-muted transition-transform group-open:rotate-90" aria-hidden>
                ›
              </span>
            </summary>
            <div className="mt-2 rounded-lg bg-brand-bg/60 px-3 py-2 text-xs text-ink-soft ring-1 ring-brand/15 sm:ml-[52px]">
              <span className="font-medium text-brand-deep">วิธีแก้: </span>
              {f.fix}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

const ALERT_ICON: Record<string, string> = {
  VISUAL_CHANGE: "M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6",
  DEFACE_KEYWORD:
    "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  LOOKALIKE_DOMAIN:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  SECURITY_FINDING: "M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z",
};

/** รายการแจ้งเตือนด้านความปลอดภัย + ปุ่มรับทราบ */
export function AlertList({ alerts, isAdmin }: { alerts: SecurityAlertRow[]; isAdmin: boolean }) {
  return (
    <ul className="rows-in divide-y divide-line">
      {alerts.map((a) => (
        <li key={a.id} className={cx("flex items-start gap-3 px-4 py-3", a.acknowledgedAt && "opacity-60")}>
          <span
            className={cx(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm",
              a.acknowledgedAt ? "bg-sidebar" : a.severity === "high" ? "bg-down-bg" : "bg-warn-bg",
            )}
            aria-hidden
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={a.acknowledgedAt ? "text-muted" : a.severity === "high" ? "text-down" : "text-warn"}
            >
              <path d={ALERT_ICON[a.type] ?? ALERT_ICON.SECURITY_FINDING} />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              <SeverityChip severity={a.severity} />
              <span className="min-w-0">{a.title}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {formatAgo(a.createdAt)}
              {a.websiteId && (
                <>
                  {" · "}
                  <Link href={`/websites/${a.websiteId}#security`} className="link">
                    {a.websiteName}
                  </Link>
                </>
              )}
              {a.acknowledgedAt
                ? ` · รับทราบโดย ${a.acknowledgedBy ?? "—"}`
                : a.notifyError
                  ? ` · ${a.notifyError}`
                  : a.notifiedAt
                    ? " · ส่งอีเมลแล้ว"
                    : ""}
            </div>
          </div>
          {isAdmin && !a.acknowledgedAt && (
            <ActionButton url={`/api/security/alerts/${a.id}`} successMessage="รับทราบแล้ว">
              รับทราบ
            </ActionButton>
          )}
        </li>
      ))}
    </ul>
  );
}
