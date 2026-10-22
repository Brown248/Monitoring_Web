import { dayKey, formatDate, formatHm } from "@app/core";
import Link from "next/link";
import type { ReactNode } from "react";
import type { EventRow } from "@/lib/data/dashboard";
import { cx, type Tone } from "./ui";

type Category =
  "outage" | "warn" | "recovered" | "notify" | "ai" | "security" | "journey" | "config" | "system";

const CATEGORY_OF: Record<string, Category> = {
  INCIDENT_OPENED: "outage",
  STILL_FAILING: "outage",
  ROOT_CAUSE_CLEARED: "outage",
  DOWN: "outage",
  FIRST_FAILURE: "warn",
  UNKNOWN: "warn",
  SLOW: "warn",
  ANOMALY: "warn",
  CANARY_FAILED: "warn",
  INCIDENT_CLOSED: "recovered",
  ANOMALY_RESOLVED: "recovered",
  JOURNEY_RECOVERED: "recovered",
  CANARY_RECOVERED: "recovered",
  OUTBOX_CREATED: "notify",
  EMAIL_SENT: "notify",
  EMAIL_RETRY: "notify",
  EMAIL_FAILED: "notify",
  NO_RECIPIENTS: "notify",
  ALERT_SUPPRESSED: "notify",
  AI_REQUESTED: "ai",
  AI_DONE: "ai",
  AI_FAILED: "ai",
  POSTMORTEM_DONE: "ai",
  SECURITY_FINDING: "security",
  VISUAL_CHANGE: "security",
  DEFACE_KEYWORD: "security",
  LOOKALIKE_DOMAIN: "security",
  SITE_CHANGED: "security",
  SITE_CHANGE: "security",
  VISUAL_BASELINE: "security",
  JOURNEY_FAILED: "journey",
  RETENTION: "system",
  SHEETS_SYNC: "system",
  SHEETS_EXPORT: "system",
  SHEETS_FAILED: "system",
  JOB_FAILED: "system",
};

const CATEGORY: Record<Category, { tone: Tone; icon: ReactNode }> = {
  outage: {
    tone: "down",
    icon: (
      <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    ),
  },
  warn: { tone: "warn", icon: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" /> },
  recovered: {
    tone: "up",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 5-5" />
      </>
    ),
  },
  notify: {
    tone: "info",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>
    ),
  },
  ai: {
    tone: "ai",
    icon: (
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    ),
  },
  security: {
    tone: "warn",
    icon: <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z" />,
  },
  journey: {
    tone: "down",
    icon: (
      <>
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" />
      </>
    ),
  },
  config: {
    tone: "muted",
    icon: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6" />,
  },
  system: {
    tone: "muted",
    icon: (
      <>
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>
    ),
  },
};

const TONE_CHIP: Record<Tone, string> = {
  down: "bg-down-bg text-down",
  warn: "bg-warn-bg text-warn",
  up: "bg-up-bg text-up",
  info: "bg-info-bg text-info",
  ai: "bg-ai-bg text-ai",
  muted: "bg-sidebar text-muted",
  unknown: "bg-sidebar text-unknown",
};
const LEVEL_TONE: Record<string, Tone> = { ERROR: "down", WARN: "warn", SUCCESS: "up" };

function dayLabel(d: Date, tz: string, now: Date): string {
  const k = dayKey(d, tz);
  if (k === dayKey(now, tz)) return "วันนี้";
  if (k === dayKey(new Date(now.getTime() - 86_400_000), tz)) return "เมื่อวาน";
  return formatDate(d, tz);
}

/** เหตุการณ์ล่าสุด: ไอคอนตามประเภท · สีตามความรุนแรง · แบ่งกลุ่มตามวัน */
export function EventFeed({ events, tz, now }: { events: EventRow[]; tz: string; now: Date }) {
  const groups: Array<{ label: string; items: EventRow[] }> = [];
  for (const e of events) {
    const label = dayLabel(e.at, tz, now);
    const g = groups[groups.length - 1];
    if (g?.label === label) g.items.push(e);
    else groups.push({ label, items: [e] });
  }
  return (
    <div>
      {groups.map((g) => (
        <section key={g.label}>
          <h3 className="sticky top-0 z-[1] border-b border-line bg-canvas/80 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted backdrop-blur">
            {g.label}
          </h3>
          <ul className="rows-in divide-y divide-line">
            {g.items.map((e) => {
              const cat = CATEGORY[CATEGORY_OF[e.type] ?? "config"];
              const tone = LEVEL_TONE[e.level] ?? cat.tone;
              const href = e.incidentId
                ? `/incidents/${e.incidentId}`
                : e.websiteId
                  ? `/websites/${e.websiteId}`
                  : null;
              const body = (
                <>
                  <span
                    className={cx(
                      "mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                      TONE_CHIP[tone],
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
                    >
                      {cat.icon}
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1 leading-snug">{e.message}</span>
                  <span className="num shrink-0 pt-0.5 text-xs text-muted">{formatHm(e.at, tz)}</span>
                </>
              );
              return (
                <li key={e.id}>
                  {href ? (
                    <Link
                      href={href}
                      className="flex items-start gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-canvas/70"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-start gap-3 px-4 py-2.5 text-sm">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
