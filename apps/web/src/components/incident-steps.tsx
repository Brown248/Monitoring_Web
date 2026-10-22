import { formatDuration, formatTime } from "@app/core";
import type { ReactNode } from "react";
import { cx } from "./ui";

export type StepState = "done" | "active" | "warn" | "skipped" | "waiting";

export interface IncidentStep {
  key: string;
  title: string;
  at: Date | null;
  state: StepState;
  detail: string;
}

const ICONS: Record<string, ReactNode> = {
  start: (
    <path d="M12 8v5m0 3.5h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  ),
  confirm: <path d="M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />,
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  ai: (
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
  ),
  recover: <path d="M20 6 9 17l-5-5" />,
  waiting: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
};

const DOT: Record<StepState, string> = {
  done: "bg-ink text-surface",
  active: "bg-down text-white",
  warn: "bg-warn text-white",
  skipped: "bg-sidebar text-subtle ring-1 ring-line",
  waiting: "bg-surface text-subtle ring-1 ring-line-strong",
};

/**
 * ลำดับเหตุการณ์ของ Incident แบบ stepper: เริ่มล้มเหลว → ยืนยัน → แจ้งอีเมล → AI → กลับมาใช้งาน
 * แนวนอนบนจอกว้าง / แนวตั้งบนมือถือ — เส้นเชื่อมเติมสีตามขั้นที่ผ่านแล้ว
 */
export function IncidentSteps({
  steps,
  startedAt,
  zone,
}: {
  steps: IncidentStep[];
  startedAt: Date;
  zone: string;
}) {
  const lastDone = steps.reduce((acc, s, i) => (s.state === "done" || s.state === "warn" ? i : acc), 0);
  return (
    <ol className="relative grid gap-0 md:grid-cols-5">
      {steps.map((s, i) => {
        const reached = i <= lastDone;
        const recovered = s.key === "recover" && s.state === "done";
        return (
          <li
            key={s.key}
            className="relative flex gap-3 pb-6 last:pb-0 md:flex-col md:items-center md:gap-0 md:pb-0 md:text-center"
            style={{ animation: `fade-up 0.5s var(--ease-out) ${i * 90}ms both` }}
          >
            {/* เส้นเชื่อม: แนวตั้ง (มือถือ) / แนวนอน (md+) */}
            {i < steps.length - 1 && (
              <>
                <span
                  className={cx(
                    "absolute left-[17px] top-9 h-[calc(100%-2.25rem)] w-0.5 md:hidden",
                    i < lastDone ? "bg-ink/70" : "bg-line",
                  )}
                />
                <span className="absolute left-[calc(50%+22px)] top-[17px] hidden h-0.5 w-[calc(100%-44px)] overflow-hidden rounded-full bg-line md:block">
                  {i < lastDone && (
                    <span
                      className="block h-full origin-left bg-ink/70"
                      style={{ animation: `grow-x 0.5s var(--ease-out) ${i * 90 + 200}ms both` }}
                    />
                  )}
                </span>
              </>
            )}
            <span
              className={cx(
                "relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                recovered ? "bg-brand text-white" : DOT[s.state],
              )}
            >
              {s.state === "active" && (
                <span aria-hidden className="dot-ping absolute inset-0 -z-10 rounded-full bg-down" />
              )}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                {s.key === "recover" && s.state !== "done" ? ICONS.waiting : ICONS[s.key]}
              </svg>
            </span>
            <div className="min-w-0 md:mt-2.5 md:px-2">
              <div className={cx("text-sm font-semibold", !reached && s.state !== "active" && "text-muted")}>
                {s.title}
              </div>
              <div className="num mt-0.5 text-xs text-muted">
                {s.at ? (
                  <>
                    {formatTime(s.at, zone)}
                    {i > 0 && s.at.getTime() - startedAt.getTime() >= 60_000 && (
                      <span className="text-subtle">
                        {" "}
                        · +{formatDuration(s.at.getTime() - startedAt.getTime())}
                      </span>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </div>
              <div
                className={cx(
                  "mt-1 text-xs",
                  s.state === "active"
                    ? "font-medium text-down"
                    : s.state === "warn"
                      ? "text-warn"
                      : "text-muted",
                )}
              >
                {s.detail}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
