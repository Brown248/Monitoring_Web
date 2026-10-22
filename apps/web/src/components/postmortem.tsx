import type { PostmortemContent } from "@app/db";
import { cx } from "./ui";

const CONF: Record<string, { label: string; cls: string }> = {
  high: { label: "มั่นใจสูง", cls: "bg-up-bg text-up" },
  medium: { label: "มั่นใจปานกลาง", cls: "bg-warn-bg text-warn" },
  low: { label: "ยังไม่ยืนยัน", cls: "bg-sidebar text-muted" },
};
const PRIO: Record<string, string> = {
  high: "bg-down-bg text-down",
  medium: "bg-warn-bg text-warn",
  low: "bg-sidebar text-muted",
};
const PRIO_LABEL: Record<string, string> = { high: "ด่วน", medium: "ปานกลาง", low: "ภายหลัง" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

/** แสดงรายงานสรุปเหตุ — ใช้ทั้งในหน้า Incident และหน้าพิมพ์ */
export function PostmortemView({
  content: c,
  meta,
  print,
}: {
  content: PostmortemContent;
  meta?: string;
  print?: boolean;
}) {
  const conf = CONF[c.rootCauseConfidence] ?? CONF.low!;
  return (
    <div className={cx("space-y-5", print ? "" : "px-4 py-4")}>
      <div>
        <h2 className={cx("font-semibold tracking-tight", print ? "text-2xl" : "text-base")}>{c.title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed">{c.summary}</p>
      </div>
      <Section title="ผลกระทบ">
        <p className="text-sm leading-relaxed">{c.impact}</p>
      </Section>
      <Section title="ลำดับเหตุการณ์">
        <ol className="relative space-y-2 border-l-2 border-line pl-4">
          {c.timeline.map((t, i) => (
            <li key={i} className="relative text-sm">
              <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-surface ring-2 ring-ink/60" />
              <span className="num mr-2 text-xs font-medium text-muted">{t.time}</span>
              {t.event}
            </li>
          ))}
        </ol>
      </Section>
      <Section title="สาเหตุ">
        <div className="rounded-lg bg-canvas px-3 py-2.5 ring-1 ring-line">
          <span
            className={cx("mb-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium", conf.cls)}
          >
            {conf.label}
          </span>
          <p className="text-sm leading-relaxed">{c.rootCause}</p>
          {c.contributingFactors.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              {c.contributingFactors.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      </Section>
      {c.whatWentWell.length > 0 && (
        <Section title="สิ่งที่ทำได้ดี">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {c.whatWentWell.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="สิ่งที่ต้องทำเพื่อป้องกัน">
        <ul className="space-y-1.5">
          {c.actionItems.map((a, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span
                className={cx(
                  "mt-px shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  PRIO[a.priority],
                )}
              >
                {PRIO_LABEL[a.priority] ?? a.priority}
              </span>
              {a.action}
            </li>
          ))}
        </ul>
      </Section>
      {meta && (
        <p className="border-t border-line pt-3 text-[11px] text-muted">
          ร่างโดย AI ({meta}) จากข้อมูลการตรวจของระบบ — สาเหตุเป็นสมมติฐาน ควรตรวจทานกับ log
          ของเซิร์ฟเวอร์ก่อนสรุป
        </p>
      )}
    </div>
  );
}
