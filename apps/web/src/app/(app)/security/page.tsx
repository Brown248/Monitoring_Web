import { formatAgo, formatDate, shortUrl } from "@app/core";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton, AutoRefresh, JobButton } from "@/components/client/controls";
import { SiteIcon } from "@/components/client/site-icon";
import { AlertList, GradeBadge } from "@/components/security";
import { Card, Dot, Empty, PageHeader, cx, type Tone } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import {
  lookalikeList,
  securityAlertsList,
  securityFeatureStates,
  securityOverview,
} from "@/lib/data/security";
import { loadSettings } from "@/lib/data/system";
import { tz } from "@/lib/env";
import { requestNow } from "@/lib/time";

export const metadata: Metadata = { title: "ความปลอดภัย" };
export const dynamic = "force-dynamic";

function FeatureCard({
  title,
  tone,
  status,
  detail,
  icon,
}: {
  title: string;
  tone: Tone;
  status: string;
  detail: string;
  icon: string;
}) {
  return (
    <div className="card card-hover flex gap-3 px-4 py-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sidebar text-ink-soft ring-1 ring-line">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d={icon} />
        </svg>
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs font-medium">
          <Dot tone={tone} />
          <span
            className={
              tone === "down"
                ? "text-down"
                : tone === "warn"
                  ? "text-warn"
                  : tone === "up"
                    ? "text-up"
                    : "text-muted"
            }
          >
            {status}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted">{detail}</div>
      </div>
    </div>
  );
}

export default async function SecurityPage() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const zone = tz();
  const nowMs = requestNow();
  const [sites, alerts, domains, states, settings] = await Promise.all([
    securityOverview(),
    securityAlertsList({ limit: 30 }),
    lookalikeList(100),
    securityFeatureStates(),
    loadSettings(),
  ]);
  const sec = settings.security;
  const openAlerts = alerts.filter((a) => !a.acknowledgedAt);
  const newDomains = domains.filter((d) => d.status === "NEW");
  const scanned = sites.filter((s) => s.grade);
  const avgScore = scanned.length
    ? Math.round(scanned.reduce((n, s) => n + (s.score ?? 0), 0) / scanned.length)
    : null;

  return (
    <>
      <AutoRefresh seconds={60} />
      <PageHeader
        title="ความปลอดภัย"
        subtitle="ตรวจหน้าเว็บถูกแก้ไข · โดเมนเลียนแบบ · คะแนนความปลอดภัยแบบ passive (ไม่ใช่การเจาะระบบ)"
        actions={
          isAdmin && (
            <>
              <Link href="/settings#security" className="btn-secondary">
                ตั้งค่า
              </Link>
              <JobButton type="LOOKALIKE_SCAN" disabled={!sec.ctEnabled || sec.brandKeywords.length === 0}>
                ค้นโดเมนเลียนแบบตอนนี้
              </JobButton>
            </>
          )
        }
      />

      <div className="stagger mb-5 grid gap-4 md:grid-cols-3">
        <FeatureCard
          title="ตรวจหน้าเว็บถูกแก้ไข"
          icon="M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6"
          tone={
            !sec.visualEnabled
              ? "muted"
              : states.visual?.available === false
                ? "down"
                : states.visual
                  ? "up"
                  : "warn"
          }
          status={
            !sec.visualEnabled
              ? "ปิดอยู่"
              : states.visual?.available === false
                ? states.visual.error
                  ? `เปิด browser บนเครื่อง Worker ไม่ได้: ${states.visual.error}`
                  : "ไม่พบ browser บนเครื่อง Worker"
                : states.visual
                  ? "ทำงานอยู่"
                  : "รอ Worker รอบแรก"
          }
          detail={`ถ่ายภาพทุก ${sec.visualIntervalMinutes >= 60 ? `${sec.visualIntervalMinutes / 60} ชม.` : `${sec.visualIntervalMinutes} นาที`} · เตือนเมื่อเปลี่ยน ≥ ${sec.visualThresholdPct}% หรือพบคำต้องสงสัย ${sec.defaceKeywords.length} คำ`}
        />
        <FeatureCard
          title="เฝ้าโดเมนเลียนแบบ"
          icon="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"
          tone={
            !sec.ctEnabled || sec.brandKeywords.length === 0
              ? "muted"
              : states.lookalike?.status === "failed"
                ? "down"
                : newDomains.length > 0
                  ? "warn"
                  : "up"
          }
          status={
            !sec.ctEnabled
              ? "ปิดอยู่"
              : sec.brandKeywords.length === 0
                ? "ยังไม่ได้ตั้งชื่อแบรนด์"
                : states.lookalike?.status === "failed"
                  ? "ค้นไม่สำเร็จ — crt.sh ไม่ตอบ จะลองใหม่รอบถัดไป"
                  : newDomains.length > 0
                    ? `พบ ${newDomains.length} โดเมนที่ต้องตรวจสอบ`
                    : "ไม่พบโดเมนใหม่"
          }
          detail={
            sec.brandKeywords.length
              ? `คำค้น: ${sec.brandKeywords.join(", ")} · ${states.lookalike?.lastRunAt ? `ค้นล่าสุด ${formatAgo(new Date(states.lookalike.lastRunAt))}` : "ยังไม่เคยค้น"}`
              : "ตั้งชื่อแบรนด์และโดเมนของบริษัทในหน้าตั้งค่า"
          }
        />
        <FeatureCard
          title="คะแนนความปลอดภัย"
          icon="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6zM9 12l2 2 4-4"
          tone={
            !sec.scanEnabled
              ? "muted"
              : avgScore === null
                ? "warn"
                : avgScore >= 80
                  ? "up"
                  : avgScore >= 60
                    ? "warn"
                    : "down"
          }
          status={
            !sec.scanEnabled ? "ปิดอยู่" : avgScore === null ? "รอสแกนรอบแรก" : `คะแนนเฉลี่ย ${avgScore}/100`
          }
          detail={`สแกน header, SSL และไฟล์ที่ไม่ควรหลุด วันละครั้ง · สแกนแล้ว ${scanned.length}/${sites.length} เว็บ`}
        />
      </div>

      {openAlerts.length > 0 && (
        <Card
          className="mb-5 border-down/30"
          title={
            <span className="flex items-center gap-2">
              <Dot tone="down" pulse /> แจ้งเตือนที่ยังไม่รับทราบ ({openAlerts.length})
            </span>
          }
        >
          <AlertList alerts={openAlerts} isAdmin={isAdmin} />
        </Card>
      )}

      <Card
        className="mb-5"
        title="รายเว็บไซต์"
        subtitle="เรียงจากเกรดต่ำสุด · กดชื่อเว็บเพื่อดูรายละเอียดและวิธีแก้"
      >
        {sites.length === 0 ? (
          <Empty>ยังไม่มีเว็บไซต์</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">เว็บไซต์</th>
                  <th className="th">เกรด</th>
                  <th className="th">ปัญหา</th>
                  <th className="th max-lg:hidden">SSL หมดอายุ</th>
                  <th className="th">หน้าเว็บ</th>
                </tr>
              </thead>
              <tbody className="rows-in divide-y divide-line">
                {sites.map((s) => {
                  const sslDays = s.tlsValidTo
                    ? Math.floor((s.tlsValidTo.getTime() - nowMs) / 86_400_000)
                    : null;
                  return (
                    <tr key={s.id} className="row">
                      <td className="td">
                        <div className="flex items-center gap-3">
                          <SiteIcon id={s.id} name={s.name} size={30} />
                          <div className="min-w-0">
                            <Link href={`/websites/${s.id}#security`} className="font-medium hover:underline">
                              {s.name}
                            </Link>
                            <div className="truncate font-mono text-xs text-muted">{shortUrl(s.url)}</div>
                          </div>
                          {s.openAlerts > 0 && (
                            <span className="rounded-full bg-down px-1.5 py-px text-[11px] font-semibold text-white">
                              {s.openAlerts}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <GradeBadge grade={s.grade} size={30} />
                          <span className="num text-xs text-muted">
                            {s.score !== null ? `${s.score}/100` : s.scanError ? "สแกนไม่ได้" : "รอสแกน"}
                          </span>
                        </div>
                      </td>
                      <td className="td">
                        {s.grade ? (
                          <span className="flex flex-wrap gap-1.5 text-xs">
                            {s.high > 0 && (
                              <span className="rounded-full bg-down-bg px-2 py-0.5 font-medium text-down">
                                สูง {s.high}
                              </span>
                            )}
                            {s.medium > 0 && (
                              <span className="rounded-full bg-warn-bg px-2 py-0.5 font-medium text-warn">
                                กลาง {s.medium}
                              </span>
                            )}
                            {s.low > 0 && (
                              <span className="rounded-full bg-info-bg px-2 py-0.5 font-medium text-info">
                                ต่ำ {s.low}
                              </span>
                            )}
                            {s.high + s.medium + s.low === 0 && <span className="text-up">ไม่พบปัญหา</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">
                            {s.scanError ? s.scanError.slice(0, 60) : "—"}
                          </span>
                        )}
                      </td>
                      <td className="td max-lg:hidden">
                        {sslDays === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span
                            className={cx(
                              "num text-xs",
                              sslDays < 14
                                ? "font-semibold text-down"
                                : sslDays < 30
                                  ? "text-warn"
                                  : "text-muted",
                            )}
                          >
                            {formatDate(s.tlsValidTo!, zone)} · {sslDays < 0 ? "หมดแล้ว" : `${sslDays} วัน`}
                          </span>
                        )}
                      </td>
                      <td className="td text-xs">
                        {!sec.visualEnabled ? (
                          <span className="text-muted">ปิดอยู่</span>
                        ) : s.visualError ? (
                          <span className="text-warn" title={s.visualError}>
                            ถ่ายภาพไม่สำเร็จ
                          </span>
                        ) : s.visualKeywords.length > 0 ? (
                          <span className="font-medium text-down">
                            พบคำ: {s.visualKeywords.slice(0, 2).join(", ")}
                          </span>
                        ) : s.visualDiffPct === null ? (
                          <span className="text-muted">รอถ่ายภาพ</span>
                        ) : (
                          <span
                            className={cx(
                              "num",
                              s.visualDiffPct >= sec.visualThresholdPct
                                ? "font-semibold text-down"
                                : "text-up",
                            )}
                          >
                            {s.visualDiffPct === 0 && !s.visualAt ? "ต้นแบบ" : `ต่าง ${s.visualDiffPct}%`}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="stagger grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card
          title="โดเมนเลียนแบบ"
          subtitle="จาก Certificate Transparency log — โดเมนที่มีชื่อแบรนด์หรือสะกดคล้าย ซึ่งออกใบรับรอง SSL แล้ว"
        >
          {domains.length === 0 ? (
            <Empty>
              {sec.brandKeywords.length === 0 ? (
                <>
                  ยังไม่ได้ตั้งชื่อแบรนด์ —{" "}
                  <Link href="/settings#security" className="link">
                    ตั้งค่า
                  </Link>
                </>
              ) : (
                "ยังไม่พบโดเมนที่น่าสงสัย"
              )}
            </Empty>
          ) : (
            <ul className="rows-in divide-y divide-line">
              {domains.map((d) => (
                <li
                  key={d.domain}
                  className={cx(
                    "flex flex-wrap items-center gap-3 px-4 py-2.5",
                    d.status !== "NEW" && "opacity-55",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium">{d.domain}</span>
                      <span
                        className={cx(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          d.similarity === "typo" ? "bg-down-bg text-down" : "bg-warn-bg text-warn",
                        )}
                      >
                        {d.similarity === "typo" ? "สะกดคล้าย" : "มีชื่อแบรนด์"}
                      </span>
                      {d.status === "REPORTED" && <span className="text-[11px] text-info">รายงานแล้ว</span>}
                      {d.status === "IGNORED" && (
                        <span className="text-[11px] text-muted">ไม่เกี่ยวข้อง</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      คล้าย “{d.matchedKeyword}” · ใบรับรอง{" "}
                      {d.notBefore ? formatDate(d.notBefore, zone) : "—"}
                      {d.issuer ? ` · ${d.issuer}` : ""}
                    </div>
                  </div>
                  {isAdmin && d.status === "NEW" && (
                    <div className="flex gap-1.5">
                      <ActionButton
                        url="/api/security/lookalikes"
                        body={{ domain: d.domain, status: "REPORTED" }}
                      >
                        รายงานแล้ว
                      </ActionButton>
                      <ActionButton
                        url="/api/security/lookalikes"
                        body={{ domain: d.domain, status: "IGNORED" }}
                      >
                        ไม่เกี่ยวข้อง
                      </ActionButton>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-line bg-canvas/60 px-4 py-2.5 text-xs text-muted">
            พบโดเมนปลอม: แจ้งผู้ให้บริการจดโดเมน/โฮสติ้ง, แจ้งเตือนพนักงานและลูกค้า และรายงานที่ Google Safe
            Browsing
          </p>
        </Card>

        <Card title="ประวัติการแจ้งเตือน" subtitle="30 รายการล่าสุด">
          {alerts.length === 0 ? (
            <Empty>ยังไม่มีการแจ้งเตือนด้านความปลอดภัย</Empty>
          ) : (
            <AlertList alerts={alerts} isAdmin={isAdmin} />
          )}
        </Card>
      </div>
    </>
  );
}
