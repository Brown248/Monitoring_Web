import Link from "next/link";
import { cx } from "./ui";

interface Step {
  title: string;
  detail: string;
  done: boolean;
  href?: string;
  cta?: string;
  optional?: boolean;
}

/** ภาพประกอบหน้าเริ่มต้น: จอ monitor + เส้นชีพจรวาดตัวเอง */
function Illustration() {
  return (
    <svg viewBox="0 0 220 150" className="h-36 w-auto" aria-hidden>
      <defs>
        <linearGradient id="ob-screen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-surface)" />
          <stop offset="100%" stopColor="var(--color-sidebar)" />
        </linearGradient>
      </defs>
      <circle cx="110" cy="72" r="66" fill="var(--color-brand)" opacity="0.08" className="animate-float" />
      <rect
        x="30"
        y="22"
        width="160"
        height="96"
        rx="12"
        fill="url(#ob-screen)"
        stroke="var(--color-line-strong)"
        strokeWidth="2"
      />
      <rect x="92" y="118" width="36" height="12" fill="var(--color-line-strong)" />
      <rect x="70" y="128" width="80" height="6" rx="3" fill="var(--color-line-strong)" />
      <path
        d="M46 72h28l10-24 16 46 12-32 8 10h54"
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className="line-draw"
      />
      <circle cx="174" cy="72" r="5" fill="var(--color-brand)" className="dot-ping" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={46 + i * 22} y="96" width="16" height="6" rx="3" fill="var(--color-line-strong)" />
      ))}
    </svg>
  );
}

/** หน้าเริ่มต้นเมื่อยังไม่มีเว็บไซต์ — ทำทีละขั้น */
export function Onboarding({
  isAdmin,
  hasWebsite,
  smtpConfigured,
  workerOnline,
  aiReady,
}: {
  isAdmin: boolean;
  hasWebsite: boolean;
  smtpConfigured: boolean;
  workerOnline: boolean;
  aiReady: boolean;
}) {
  const steps: Step[] = [
    {
      title: "เปิด Worker ตัวตรวจเว็บ",
      detail: workerOnline
        ? "Worker ส่ง heartbeat อยู่ — พร้อมตรวจ"
        : "รัน pnpm dev:worker (หรือ docker compose up -d worker บน server)",
      done: workerOnline,
      href: "/system",
      cta: "ดูสถานะระบบ",
    },
    {
      title: "เพิ่มเว็บไซต์แรก",
      detail: "ใส่ URL แล้วกด “ทดสอบ URL” ระบบจะเริ่มตรวจทันทีหลังบันทึก",
      done: hasWebsite,
      href: isAdmin ? "/websites/new" : undefined,
      cta: "เพิ่มเว็บไซต์",
    },
    {
      title: "ตั้งค่าอีเมลแจ้งเตือน (SMTP)",
      detail: "กรอก host/ผู้ส่งในหน้าตั้งค่า แล้วกด “ส่งอีเมลทดสอบ” · รหัสผ่านอยู่ใน .env",
      done: smtpConfigured,
      href: "/settings#smtp",
      cta: "ตั้งค่า SMTP",
    },
    {
      title: "เปิด AI วิเคราะห์ Incident",
      detail: "เลือก provider และใส่ AI_API_KEY ใน .env",
      done: aiReady,
      href: "/settings#ai",
      cta: "ตั้งค่า AI",
      optional: true,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const nextIndex = steps.findIndex((s) => !s.done);

  return (
    <section className="card animate-fade-up mb-5 overflow-hidden">
      <div className="relative grid gap-6 p-6 md:grid-cols-[auto_1fr] md:p-8">
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-br from-brand-bg/70 via-transparent to-transparent"
        />
        <div className="relative flex justify-center md:block">
          <Illustration />
        </div>
        <div className="relative">
          <p className="text-xs font-medium uppercase tracking-wider text-brand-deep">เริ่มต้นใช้งาน</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">ยินดีต้อนรับสู่ SYNTECH Web Monitor</h2>
          <p className="mt-1 text-sm text-muted">
            ทำตามขั้นตอนด้านล่างเพื่อเริ่มเฝ้าดูเว็บไซต์ — เสร็จแล้ว {doneCount} จาก {steps.length} ขั้น
          </p>
          <div className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-line">
            <div
              className="strip-grow h-full rounded-full bg-gradient-to-r from-brand-deep to-brand"
              style={{ width: `${(doneCount / steps.length) * 100}%` }}
            />
          </div>
        </div>
      </div>
      <ol className="rows-in divide-y divide-line border-t border-line">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className={cx("flex items-center gap-4 px-6 py-4", i === nextIndex && "bg-brand-bg/40")}
          >
            <span
              className={cx(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                s.done
                  ? "bg-brand text-white"
                  : i === nextIndex
                    ? "bg-ink text-surface"
                    : "bg-sidebar text-muted ring-1 ring-line",
              )}
            >
              {s.done ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={cx(
                  "text-sm font-medium",
                  s.done && "text-muted line-through decoration-line-strong",
                )}
              >
                {s.title}
                {s.optional && (
                  <span className="ml-2 rounded-full bg-sidebar px-2 py-0.5 text-[11px] font-normal text-muted">
                    ไม่บังคับ
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted">{s.detail}</div>
            </div>
            {!s.done && s.href && (
              <Link href={s.href} className={i === nextIndex ? "btn-primary" : "btn-secondary"}>
                {s.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
