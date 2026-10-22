import { formatDateTime, formatDuration, formatMs, formatTime } from "@app/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, AutoRefresh, JobButton } from "@/components/client/controls";
import { Card, Dot, Empty, KeyValue, PageHeader, Stat, StatGrid, type Tone } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { incidentDetail } from "@/lib/data/incidents";
import { tz } from "@/lib/env";
import { PostmortemView } from "@/components/postmortem";
import { outageGroupFor, postmortemFor } from "@/lib/data/security";
import { IncidentSteps, type IncidentStep } from "@/components/incident-steps";
import { ChangeTimeline, DiagnosisView } from "@/components/insights";
import { changesBefore, incidentDiagnoses } from "@/lib/data/insights";
import { parseId as parseIdParam } from "@/lib/params";

export const metadata: Metadata = { title: "Incident" };
export const dynamic = "force-dynamic";

const LEVEL_TONE: Record<string, Tone> = { ERROR: "down", WARN: "warn", SUCCESS: "up", INFO: "muted" };
const TYPE_TONE: Record<string, Tone> = {
  AI_DONE: "ai",
  AI_FAILED: "down",
  OUTBOX_CREATED: "muted",
  EMAIL_SENT: "up",
};
const EMAIL_STATUS: Record<string, { label: string; tone: Tone }> = {
  SENT: { label: "SENT", tone: "up" },
  PENDING: { label: "PENDING", tone: "muted" },
  FAILED: { label: "FAILED", tone: "down" },
  DEAD: { label: "ล้มเหลว (เลิกส่ง)", tone: "down" },
};

function List({ title, items, badge }: { title: string; items: string[]; badge?: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
        {title}
        {badge && (
          <span className="inline-flex items-center gap-1 text-xs font-normal text-warn">
            <Dot tone="warn" />
            {badge}
          </span>
        )}
      </h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  // id นอกช่วง int4 / ไม่ใช่จำนวนเต็ม → 404 (ไม่ใช่ error 500 จากฐานข้อมูล)
  const id = parseIdParam((await params).id);
  if (id === undefined) notFound();
  const zone = tz();
  const inc = await incidentDetail(id);
  if (!inc) notFound();
  const [group, pm, diagnoses, changes] = await Promise.all([
    outageGroupFor(inc.id, inc.startedAt),
    postmortemFor(inc.id),
    incidentDiagnoses(inc.id),
    changesBefore(inc.websiteId, inc.startedAt),
  ]);
  const diagnosis = diagnoses[0] ?? null;
  const pmBusy = pm?.status === "PENDING" || pm?.status === "RUNNING";
  const isAdmin = user.role === "ADMIN";
  const now = new Date();
  const open = !inc.recoveredAt;
  const durationMs = (inc.recoveredAt ?? now).getTime() - inc.startedAt.getTime();
  const aiBusy = inc.ai?.status === "PENDING" || inc.ai?.status === "RUNNING";

  // timeline: เพิ่มบรรทัด "ยังล้มเหลว (รอบที่ N)" ของรอบล่าสุดเมื่อ incident ยังเปิดอยู่
  const timeline = [...inc.timeline];
  if (open && inc.lastCheck && inc.lastCheck.status === "DOWN" && inc.failedCheckCount > 0) {
    timeline.unshift({
      at: inc.lastCheck.at,
      level: "ERROR",
      type: "STILL_FAILING",
      message: `ยังล้มเหลว (รอบที่ ${inc.failedCheckCount})`,
      detail: "Incident เดิมยังเปิดอยู่ — ไม่ส่งอีเมลซ้ำ",
    });
  }

  // RECOVERY ที่จะถูกสร้างเมื่อ incident ปิด
  const pendingRecovery =
    // ล่มตามระบบอื่น → worker ไม่ส่ง DOWN จึงไม่ส่ง RECOVERY ด้วย
    open && inc.sendRecovery && !inc.rootCause
      ? // ส่ง RECOVERY ถึงคนที่ได้ DOWN (รวมผู้รับทุกเว็บ) — ไม่ใช่รายชื่อปัจจุบันของเว็บ
        [...new Set(inc.notifications.filter((n) => n.type === "DOWN").map((n) => n.recipient))].filter(
          (r) => !inc.notifications.some((n) => n.type === "RECOVERY" && n.recipient === r),
        )
      : [];

  const downSent = inc.notifications
    .filter((n) => n.type === "DOWN" && n.sentAt)
    .sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());
  const downAll = inc.notifications.filter((n) => n.type === "DOWN");
  const steps: IncidentStep[] = [
    {
      key: "start",
      title: "เริ่มล้มเหลว",
      at: inc.startedAt,
      state: "done",
      detail: inc.cause,
    },
    {
      key: "confirm",
      title: "ยืนยันว่าล่ม",
      at: inc.confirmedAt,
      state: "done",
      detail: "ล้มเหลวติดกันครบเกณฑ์ → เปิด Incident",
    },
    downSent.length > 0
      ? {
          key: "email",
          title: "แจ้งเตือนทางอีเมล",
          at: downSent[0]!.sentAt,
          state: downSent.length === downAll.length ? "done" : "warn",
          detail: `ส่งแล้ว ${downSent.length}/${downAll.length} ผู้รับ`,
        }
      : downAll.length > 0
        ? {
            key: "email",
            title: "แจ้งเตือนทางอีเมล",
            at: null,
            state: downAll.some((n) => n.status === "DEAD" || n.status === "FAILED") ? "warn" : "waiting",
            detail: downAll.some((n) => n.status === "DEAD" || n.status === "FAILED")
              ? "ส่งไม่สำเร็จ — ดูรายละเอียดด้านขวา"
              : "อยู่ในคิว Outbox",
          }
        : {
            key: "email",
            title: "แจ้งเตือนทางอีเมล",
            at: null,
            state: "skipped",
            detail: inc.rootCause ? `ไม่ส่งซ้ำ — ล่มตาม ${inc.rootCause.name}` : "ไม่มีผู้รับอีเมล",
          },
    !inc.ai
      ? { key: "ai", title: "AI วิเคราะห์", at: null, state: "skipped", detail: "ยังไม่ได้วิเคราะห์" }
      : aiBusy
        ? { key: "ai", title: "AI วิเคราะห์", at: null, state: "waiting", detail: "กำลังวิเคราะห์…" }
        : inc.ai.status === "DONE"
          ? {
              key: "ai",
              title: "AI วิเคราะห์",
              at: inc.ai.completedAt,
              state: "done",
              detail: "มีผลวิเคราะห์แล้ว",
            }
          : {
              key: "ai",
              title: "AI วิเคราะห์",
              at: inc.ai.completedAt,
              state: "warn",
              detail: inc.ai.status === "SKIPPED" ? "ข้ามการวิเคราะห์" : "วิเคราะห์ไม่สำเร็จ",
            },
    inc.recoveredAt && inc.closedByStop
      ? {
          key: "recover",
          title: "ปิดเพราะหยุดตรวจ",
          at: inc.recoveredAt,
          state: "skipped",
          detail: "ไม่ได้ยืนยันว่าเว็บกลับมาใช้งานได้",
        }
      : inc.recoveredAt
        ? {
            key: "recover",
            title: "กลับมาใช้งานได้",
            at: inc.recoveredAt,
            state: "done",
            detail: `ล่มรวม ${formatDuration(durationMs)}`,
          }
        : {
            key: "recover",
            title: "รอกลับมาใช้งาน",
            at: null,
            state: "active",
            detail: `ยังล่มอยู่ · ${formatDuration(durationMs)}`,
          },
  ];

  return (
    <>
      {(open || aiBusy || pmBusy) && <AutoRefresh seconds={aiBusy || pmBusy ? 10 : 30} />}
      <PageHeader
        breadcrumb={[{ label: "Incident", href: "/incidents" }, { label: `#${inc.id}` }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Incident #{inc.id} · {inc.websiteName}
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-medium ${open ? "text-down" : "text-up"}`}
            >
              <Dot tone={open ? "down" : "up"} />
              {open ? "เปิดอยู่" : "ปิดแล้ว"}
            </span>
          </span>
        }
        subtitle={<span className="font-mono">{inc.url}</span>}
        actions={
          <>
            {inc.siteArchived ? (
              <span className="self-center text-xs text-muted">เว็บนี้ถูก archive แล้ว</span>
            ) : (
              <Link href={`/websites/${inc.websiteId}`} className="btn-secondary">
                ดูเว็บไซต์
              </Link>
            )}
            {isAdmin && inc.siteActive && (
              <ActionButton
                url={`/api/websites/${inc.websiteId}/check-now`}
                refreshAfterMs={8000}
                successMessage="สั่งตรวจแล้ว"
              >
                ตรวจตอนนี้
              </ActionButton>
            )}
          </>
        }
      />

      <StatGrid className="mb-5">
        <Stat label="เริ่ม" value={formatDateTime(inc.startedAt, zone)} />
        <Stat
          label={open ? "ล่มมาแล้ว" : "ล่มรวม"}
          value={formatDuration(durationMs)}
          tone={open ? "down" : undefined}
        />
        <Stat label="ล้มเหลวติดกัน" value={`${inc.failedCheckCount} รอบ`} />
        <Stat label="สาเหตุจากผลตรวจ" mono={false} value={inc.cause} />
      </StatGrid>

      <section className="card mb-5 px-5 py-6">
        <IncidentSteps steps={steps} startedAt={inc.startedAt} zone={zone} />
      </section>

      {inc.rootCause && (
        <Link
          href={`/websites/${inc.rootCause.websiteId}`}
          className="animate-fade-up mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-info/25 bg-info-bg/60 px-4 py-3 text-sm transition-transform hover:-translate-y-0.5"
        >
          <span>
            <span className="font-semibold text-info">ล่มตามกัน: {inc.rootCause.name} ล่มอยู่ก่อน</span>
            <span className="ml-2 text-ink-soft">
              {inc.websiteName} พึ่งพา {inc.rootCause.name} (ตามแผนผังความเชื่อมโยง) จึงไม่ส่งอีเมลซ้ำ —
              แก้ที่ต้นเหตุก่อน
            </span>
          </span>
          <span className="text-info">ดูต้นเหตุ →</span>
        </Link>
      )}

      {group && (
        <section className="animate-fade-up mb-5 overflow-hidden rounded-xl border border-info/25 bg-info-bg/60">
          <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info text-white">
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="6" cy="6" r="2.5" />
                <circle cx="18" cy="6" r="2.5" />
                <circle cx="12" cy="18" r="2.5" />
                <path d="M7.8 7.8 10.6 16M16.2 7.8 13.4 16M8.5 6h7" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-info">ต้นเหตุร่วม: {group.title}</div>
              <div className="mt-0.5 text-xs text-ink-soft">{group.hint}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {group.members.map((m) => (
                  <Link
                    key={m.incidentId}
                    href={`/incidents/${m.incidentId}`}
                    className={`rounded-full px-2.5 py-1 text-xs ring-1 transition-colors ${m.incidentId === inc.id ? "bg-info text-white ring-info" : "bg-surface text-ink ring-line hover:ring-info/50"}`}
                  >
                    {m.name} · {formatTime(m.startedAt, zone)}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="stagger grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <Card
            title="วินิจฉัยตอนเกิดเหตุ"
            subtitle={
              diagnosis
                ? "ผลจากการไล่ตรวจทีละชั้นทันทีที่เปิด Incident — ไม่ต้องใช้ AI"
                : "ไล่ตรวจทีละชั้น: เน็ตของ Worker → DNS → เชื่อมต่อ → SSL → HTTP"
            }
            action={
              open && (
                <JobButton type="DIAGNOSE" payload={{ websiteId: inc.websiteId }}>
                  {diagnosis ? "วินิจฉัยอีกครั้ง" : "วินิจฉัยตอนนี้"}
                </JobButton>
              )
            }
            bodyClassName="p-4"
          >
            {diagnosis ? (
              <>
                <DiagnosisView d={diagnosis} tz={zone} />
                {diagnoses.length > 1 && (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-muted">
                      ผลวินิจฉัยครั้งถัดมา ({diagnoses.length - 1})
                    </summary>
                    <div className="mt-3 space-y-4">
                      {diagnoses.slice(1).map((d) => (
                        <DiagnosisView key={d.id} d={d} tz={zone} compact />
                      ))}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <Empty>
                {open
                  ? "กำลังวินิจฉัย… (Worker ทำอัตโนมัติภายในไม่กี่วินาที)"
                  : "ไม่มีผลวินิจฉัยของเหตุการณ์นี้"}
              </Empty>
            )}
          </Card>

          {changes.length > 0 && (
            <Card
              title="การเปลี่ยนแปลงก่อนเกิดเหตุ"
              subtitle="สิ่งที่เปลี่ยนในช่วง 72 ชั่วโมงก่อนล่ม — มักเป็นต้นเหตุ (ย้ายเซิร์ฟเวอร์, เปลี่ยน DNS, ต่ออายุใบรับรอง)"
            >
              <ChangeTimeline changes={changes} tz={zone} />
            </Card>
          )}

          <Card
            title={
              <span className="flex items-center gap-2">
                <span className="text-ai">✦</span> ผลวิเคราะห์ด้วย AI
              </span>
            }
            action={
              isAdmin && (
                <ActionButton
                  url={`/api/incidents/${inc.id}/analyze`}
                  disabled={aiBusy}
                  successMessage="ส่งเข้าคิววิเคราะห์แล้ว"
                  refreshAfterMs={10000}
                >
                  {inc.ai ? "วิเคราะห์ใหม่" : "วิเคราะห์"}
                </ActionButton>
              )
            }
          >
            {!inc.ai ? (
              <Empty>
                ยังไม่ได้วิเคราะห์ Incident นี้{isAdmin ? ' — กด "วิเคราะห์" เพื่อให้ AI สรุปจากผลตรวจ' : ""}
              </Empty>
            ) : aiBusy ? (
              <Empty>กำลังวิเคราะห์… (Worker จะประมวลผลภายในไม่กี่วินาที)</Empty>
            ) : inc.ai.status === "DONE" ? (
              <>
                <div className="space-y-4 px-4 py-4">
                  <div>
                    <h3 className="mb-1.5 text-sm font-semibold">สรุป</h3>
                    <p className="text-sm leading-relaxed">{inc.ai.summary}</p>
                  </div>
                  <List title="ข้อเท็จจริงจากผลตรวจ" items={inc.ai.facts} />
                  <List title="สาเหตุที่เป็นไปได้" items={inc.ai.possibleCauses} badge="ยังไม่ยืนยัน" />
                  <List title="ขั้นตอนตรวจสอบถัดไป" items={inc.ai.nextSteps} />
                </div>
                <div className="border-t border-ai/15 bg-ai-bg px-4 py-2.5 text-xs text-ai">
                  <div>AI ใช้ประกอบการวิเคราะห์เท่านั้น ไม่ได้เปลี่ยนสถานะเว็บไซต์</div>
                  <div className="mt-1 font-mono">
                    {inc.ai.provider} · {inc.ai.model} ·{" "}
                    {inc.ai.completedAt ? formatTime(inc.ai.completedAt, zone) : ""} · ไม่ส่ง header/cookie
                  </div>
                </div>
              </>
            ) : (
              <div className="px-4 py-4 text-sm">
                <span className="font-medium">
                  {inc.ai.status === "SKIPPED" ? "ข้ามการวิเคราะห์" : "วิเคราะห์ไม่สำเร็จ"}
                </span>
                {inc.ai.error && <p className="mt-1 text-muted">{inc.ai.error}</p>}
              </div>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-2">
                <span className="text-ai">✦</span> รายงานสรุปเหตุ (Postmortem)
              </span>
            }
            subtitle="AI ร่างจาก timeline, ผลตรวจ และเว็บที่ล่มพร้อมกัน — ตรวจทานก่อนส่งต่อ"
            action={
              <div className="flex gap-2">
                {pm?.status === "DONE" && (
                  <Link href={`/report/incidents/${inc.id}`} target="_blank" className="btn-secondary">
                    พิมพ์ / PDF
                  </Link>
                )}
                {isAdmin && (
                  <ActionButton
                    url={`/api/incidents/${inc.id}/postmortem`}
                    disabled={pmBusy}
                    successMessage="ส่งให้ AI ร่างรายงานแล้ว"
                    refreshAfterMs={12000}
                  >
                    {pm ? "ร่างใหม่" : "ร่างรายงาน"}
                  </ActionButton>
                )}
              </div>
            }
          >
            {!pm ? (
              <Empty>
                {open
                  ? "จะร่างให้อัตโนมัติเมื่อ Incident ปิด (ถ้าเปิดใช้ใน ตั้งค่า > AI)"
                  : "ยังไม่มีรายงานสรุปเหตุ"}
              </Empty>
            ) : pmBusy ? (
              <Empty>AI กำลังร่างรายงาน… (ใช้เวลาไม่เกิน 1 นาที)</Empty>
            ) : pm.status === "DONE" && pm.content ? (
              <PostmortemView content={pm.content} meta={`${pm.provider} · ${pm.model}`} />
            ) : (
              <div className="px-4 py-4 text-sm">
                <span className="font-medium">ร่างรายงานไม่สำเร็จ</span>
                {pm.error && <p className="mt-1 text-muted">{pm.error}</p>}
              </div>
            )}
          </Card>

          <Card title="บันทึกเหตุการณ์" subtitle="ใหม่สุดอยู่บน">
            {timeline.length === 0 ? (
              <Empty>ยังไม่มีเหตุการณ์</Empty>
            ) : (
              <ol className="rows-in px-4 py-4">
                {timeline.map((t, i) => (
                  <li key={i} className="relative flex gap-3 pb-4 text-sm last:pb-0">
                    <span className="num w-16 shrink-0 pt-px text-xs text-muted">
                      {formatTime(t.at, zone)}
                    </span>
                    {i < timeline.length - 1 && (
                      <span
                        aria-hidden
                        className="absolute bottom-0 left-[calc(4rem+19px)] top-5 w-px bg-line"
                      />
                    )}
                    <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-line">
                      <Dot tone={TYPE_TONE[t.type] ?? LEVEL_TONE[t.level] ?? "muted"} />
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium">{t.message}</div>
                      {t.detail && <div className="text-xs text-muted">{t.detail}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="การแจ้งเตือน" subtitle="1 รายการต่อ Incident + ประเภท + ผู้รับ — ไม่ส่งซ้ำ">
            {inc.notifications.length === 0 && pendingRecovery.length === 0 ? (
              <Empty>
                {inc.rootCause
                  ? `ไม่ส่งอีเมล — ล่มตาม ${inc.rootCause.name} (แจ้งที่ต้นเหตุแล้ว)`
                  : "ไม่มีผู้รับอีเมลสำหรับเว็บนี้"}
              </Empty>
            ) : (
              <ul className="rows-in divide-y divide-line">
                {inc.notifications.map((n) => {
                  const s = EMAIL_STATUS[n.status] ?? { label: n.status, tone: "muted" as Tone };
                  return (
                    <li key={n.id} className="flex items-start justify-between gap-2 px-4 py-2.5">
                      <div className="flex min-w-0 gap-3">
                        <span
                          className={`flex w-20 shrink-0 items-center gap-1.5 text-xs font-medium ${n.type === "DOWN" ? "text-down" : "text-info"}`}
                        >
                          <Dot tone={n.type === "DOWN" ? "down" : "info"} />
                          {n.type}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{n.recipient}</div>
                          <div className="text-xs text-muted">
                            {n.sentAt
                              ? `ส่งเมื่อ ${formatTime(n.sentAt, zone)} · ครั้งที่ ${n.attempts}`
                              : n.lastError
                                ? `${n.lastError.slice(0, 60)} · ครั้งที่ ${n.attempts}`
                                : `สร้างเมื่อ ${formatTime(n.createdAt, zone)}`}
                          </div>
                        </div>
                      </div>
                      <span className="shrink-0 text-xs">
                        <span
                          className={`inline-flex items-center gap-1 ${s.tone === "up" ? "text-up" : s.tone === "down" ? "text-down" : "text-muted"}`}
                        >
                          <Dot tone={s.tone} />
                          {s.label}
                        </span>
                      </span>
                    </li>
                  );
                })}
                {pendingRecovery.map((r) => (
                  <li key={`r-${r}`} className="flex items-start justify-between gap-2 px-4 py-2.5">
                    <div className="flex min-w-0 gap-3">
                      <span className="flex w-20 shrink-0 items-center gap-1.5 text-xs font-medium text-info">
                        <Dot tone="info" />
                        RECOVERY
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs">{r}</div>
                        <div className="text-xs text-muted">สร้างเมื่อ Incident ปิด</div>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs text-muted">
                      <Dot tone="muted" />
                      รอ
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="ผลตรวจที่เป็นหลักฐาน" subtitle="check ที่ทำให้เปิด Incident">
            {inc.evidence ? (
              <KeyValue
                rows={[
                  [
                    "Check ID",
                    <span key="i" className="num">
                      c_{inc.evidence.id}
                    </span>,
                  ],
                  [
                    "เวลา",
                    <span key="t" className="num">
                      {formatTime(inc.evidence.checkedAt, zone)}
                      {inc.evidence.finishedAt ? ` – ${formatTime(inc.evidence.finishedAt, zone)}` : ""}
                    </span>,
                  ],
                  [
                    "IP ปลายทาง",
                    <span key="ip" className="num">
                      {inc.evidence.remoteIp ?? "—"}
                    </span>,
                  ],
                  [
                    "DNS / Connect / TLS",
                    <span key="d" className="num">
                      {inc.evidence.dnsMs ?? "—"} / {inc.evidence.connectMs ?? "—"} /{" "}
                      {inc.evidence.tlsMs ?? "—"} ms
                    </span>,
                  ],
                  [
                    inc.evidence.httpStatus ? "HTTP" : "รอ response",
                    <span key="r" className={`num ${inc.evidence.httpStatus ? "" : "text-down"}`}>
                      {inc.evidence.httpStatus
                        ? `${inc.evidence.httpStatus} · ${formatMs(inc.evidence.responseTimeMs)}`
                        : inc.evidence.responseTimeMs
                          ? `> ${formatMs(inc.evidence.responseTimeMs)}`
                          : "—"}
                    </span>,
                  ],
                  [
                    "Retry",
                    <span key="re" className="num">
                      {inc.evidence.retries} ครั้ง · ล้มเหลว
                    </span>,
                  ],
                  [
                    "Error",
                    <span key="e" className="num text-xs">
                      {inc.evidence.errorMessage?.split(" · ")[0] ?? inc.evidence.errorCode ?? "—"}
                    </span>,
                  ],
                ]}
              />
            ) : (
              <Empty>ข้อมูลผลตรวจถูกลบตามนโยบาย Retention แล้ว</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
