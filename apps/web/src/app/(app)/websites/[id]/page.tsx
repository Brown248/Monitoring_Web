import {
  formatDate,
  formatDuration,
  formatHm,
  formatInterval,
  formatMs,
  formatPercent,
  formatRelativeDay,
  formatTime,
  mergeRecipients,
} from "@app/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HeartbeatBars, HeartbeatLegend, heartbeatTone } from "@/components/heartbeat-bars";
import { FindingList, GradeBadge } from "@/components/security";
import { VisualCompare } from "@/components/client/visual-compare";
import { siteSecurity } from "@/lib/data/security";
import { loadSettings } from "@/lib/data/system";
import { recentHeartbeats } from "@/lib/data/heartbeats";
import { ResponseChart } from "@/components/client/response-chart";
import { detailCell, httpCell, responseCell } from "@/components/check-cells";
import { ActionButton, AutoRefresh, JobButton } from "@/components/client/controls";
import {
  Card,
  Dot,
  Empty,
  KeyValue,
  PageHeader,
  Segments,
  Stat,
  StatGrid,
  StatusLabel,
} from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { CHART_RANGES, responseSeries, websiteDetail, type ChartRange } from "@/lib/data/websites";
import { tz } from "@/lib/env";
import { SiteIcon } from "@/components/client/site-icon";
import { requestNow } from "@/lib/time";
import { ChangeTimeline, DiagnosisView, JourneyRuns } from "@/components/insights";
import { DependencyPicker, JourneyPanel } from "@/components/client/insight-panels";
import {
  anomalyState,
  dependencyGraph,
  fingerprintTakenAt,
  journeyInfo,
  latestDiagnosis,
  openOperationalAlerts,
  siteChangeList,
} from "@/lib/data/insights";
import { parseId as parseIdParam } from "@/lib/params";

export const metadata: Metadata = { title: "รายละเอียดเว็บไซต์" };
export const dynamic = "force-dynamic";

export default async function WebsiteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  // id นอกช่วง int4 / ไม่ใช่จำนวนเต็ม → 404 (ไม่ใช่ error 500 จากฐานข้อมูล)
  const id = parseIdParam((await params).id);
  const sp = await searchParams;
  if (id === undefined) notFound();
  const zone = tz();
  // Object.hasOwn: ?range=toString / constructor ไม่ใช่ช่วงเวลา
  const range: ChartRange =
    sp.range && Object.hasOwn(CHART_RANGES, sp.range) ? (sp.range as ChartRange) : "6h";
  const settings = await loadSettings();
  const [d, series, beatsMap, sec, diagnosis, changes, fpAt, journey, graph, anomaly, opAlerts] =
    await Promise.all([
      websiteDetail(id),
      responseSeries(id, range),
      recentHeartbeats([id], settings.check_defaults.slowThresholdMs),
      siteSecurity(id),
      latestDiagnosis(id),
      siteChangeList(id),
      fingerprintTakenAt(id),
      journeyInfo(id),
      dependencyGraph(),
      anomalyState(),
      openOperationalAlerts(id),
    ]);
  const beats = beatsMap.get(id);
  if (!d || d.site.archivedAt) notFound();
  const { site, state } = d;
  const isAdmin = user.role === "ADMIN";
  const nowMs = requestNow();
  const dependsOn = graph.edges.filter(([a]) => a === id).map(([, b]) => b);
  const dependents = graph.edges.filter(([, b]) => b === id).map(([a]) => a);
  const nodeName = new Map(graph.nodes.map((n) => [n.id, n]));
  const learn = anomaly?.sites[String(id)];

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        breadcrumb={[{ label: "เว็บไซต์", href: "/websites" }, { label: site.name }]}
        title={
          <span className="flex items-center gap-3">
            <SiteIcon id={site.id} name={site.name} size={36} />
            {site.name}
            <StatusLabel status={!state?.lastCheckedAt ? "PENDING" : state.status} enabled={site.enabled} />
          </span>
        }
        subtitle={
          <>
            <div className="font-mono text-sm">{site.url}</div>
            <div className="mt-1 text-xs">
              ตรวจล่าสุด {state?.lastCheckedAt ? formatTime(state.lastCheckedAt, zone) : "—"}
              {site.enabled && state ? ` · รอบถัดไป ${formatTime(state.nextCheckAt, zone)}` : ""} · ตรวจทุก{" "}
              {formatInterval(site.checkIntervalSeconds)}
            </div>
          </>
        }
        actions={
          isAdmin && (
            <>
              <ActionButton
                url={`/api/websites/${site.id}/check-now`}
                variant="primary"
                refreshAfterMs={8000}
                successMessage="สั่งตรวจแล้ว — ผลจะขึ้นภายในไม่กี่วินาที"
                disabled={!site.enabled}
              >
                ตรวจตอนนี้
              </ActionButton>
              <Link href={`/websites/${site.id}/edit`} className="btn-secondary">
                แก้ไข
              </Link>
              <ActionButton url={`/api/websites/${site.id}/enabled`} body={{ enabled: !site.enabled }}>
                {site.enabled ? "ปิดการตรวจ" : "เปิดการตรวจ"}
              </ActionButton>
            </>
          )
        }
      />

      {d.openIncident && (
        <Link
          href={`/incidents/${d.openIncident.id}`}
          className="banner-alert mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-down/25 bg-gradient-to-r from-down-bg to-surface px-4 py-3 text-sm text-down transition-transform hover:-translate-y-0.5"
        >
          <span className="font-semibold">
            Incident #{d.openIncident.id} เปิดอยู่ · ล่มมาแล้ว{" "}
            {formatDuration(nowMs - d.openIncident.startedAt.getTime())} (ตั้งแต่{" "}
            {formatHm(d.openIncident.startedAt, zone)})
          </span>
          <span>
            {d.openIncident.cause} ติดกัน {d.openIncident.failedCheckCount} รอบ ·{" "}
            {d.openIncident.emailed ? "แจ้งอีเมลแล้ว" : "ยังไม่ได้ส่งอีเมล"} · ดูรายละเอียด →
          </span>
        </Link>
      )}

      {opAlerts.map((a) => (
        <div
          key={a.id}
          className="mb-5 rounded-xl border border-warn/25 bg-gradient-to-r from-warn-bg to-surface px-4 py-3 text-sm"
        >
          <div className="font-semibold text-warn">
            {a.type === "JOURNEY_FAILED" ? "ทดสอบใช้งานจริงไม่ผ่าน" : "เตือนล่วงหน้า"} · {a.title}
          </div>
          {a.detail && <div className="mt-0.5 text-ink-soft">{a.detail}</div>}
          <div className="mt-0.5 text-xs text-muted">
            ตั้งแต่ {formatTime(a.createdAt, zone)} · ระบบจะปิดการแจ้งเตือนนี้เองเมื่อกลับมาปกติ
          </div>
        </div>
      ))}

      <StatGrid className="mb-5">
        <Stat
          label="Uptime 24 ชม."
          value={formatPercent(d.uptime24h)}
          tone={d.uptime24h !== null && d.uptime24h < 0.99 ? "down" : undefined}
          sub={`ล่มรวม ${formatDuration(d.downtime24Seconds * 1000)}`}
        />
        <Stat label="Uptime 7 วัน" value={formatPercent(d.uptime7d)} sub={`${d.incidents7d} Incident`} />
        <Stat label="Uptime 30 วัน" value={formatPercent(d.uptime30d)} sub={`${d.incidents30d} Incident`} />
        <Stat label="Response เฉลี่ย 24 ชม." value={formatMs(d.avg24)} sub={`p95 ${formatMs(d.p95_24)}`} />
      </StatGrid>

      <Card
        className="mb-5"
        title="Response time"
        subtitle="ทุกผลตรวจ · แท่งสีแดง = ตรวจไม่สำเร็จ"
        action={
          <Segments
            items={(["6h", "24h", "7d"] as const).map((r) => ({
              label: r === "6h" ? "6 ชม." : r === "24h" ? "24 ชม." : "7 วัน",
              href: `/websites/${site.id}?range=${r}`,
              active: range === r,
            }))}
          />
        }
        bodyClassName="px-4 py-3"
      >
        <ResponseChart
          points={series.map((p) => ({ ...p, t: p.t.toISOString() }))}
          tz={zone}
          multiDay={range === "7d"}
        />
      </Card>

      <Card
        className="mb-5 overflow-visible!"
        title={
          <span className="flex items-center gap-2">
            <span className="dot-ping inline-block h-2 w-2 rounded-full bg-brand" />
            สถานะแบบเรียลไทม์
            {beats && beats.uptime !== null && (
              <span className={`num text-base font-semibold ${heartbeatTone(beats)}`}>
                {formatPercent(beats.uptime)}
              </span>
            )}
            {beats && beats.slowRatio > 0 && (
              <span className="num rounded-full bg-warn-bg px-2 py-0.5 text-xs font-medium text-warn">
                ช้า {Math.round(beats.slowRatio * 100)}%
              </span>
            )}
          </span>
        }
        subtitle={`1 เส้น = ผลตรวจ 1 ครั้ง (ล่าสุด ${beats?.beats.length ?? 0} ครั้ง) · ชี้ที่เส้นเพื่อดูรายละเอียด`}
        action={<HeartbeatLegend slowMs={beats?.slowMs ?? settings.check_defaults.slowThresholdMs} />}
        bodyClassName="px-4 pb-3 pt-5"
      >
        <HeartbeatBars data={beats} tz={zone} height="h-10" />
        <div className="mt-1.5 flex justify-between text-[11px] text-muted">
          <span>{beats?.beats[0] ? formatTime(beats.beats[0].at, zone) : ""}</span>
          <span>ล่าสุด</span>
        </div>
      </Card>

      <section
        id="diagnosis"
        className="stagger mb-5 grid scroll-mt-6 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]"
      >
        <Card
          title="วินิจฉัยปัญหา"
          subtitle="ไล่ตรวจทีละชั้น: เน็ตของ Worker → DNS → เชื่อมต่อ → SSL → HTTP แล้วบอกว่าใครต้องแก้อะไร"
          action={
            <JobButton type="DIAGNOSE" payload={{ websiteId: site.id }}>
              วินิจฉัยตอนนี้
            </JobButton>
          }
          bodyClassName="p-4"
        >
          {diagnosis ? (
            <DiagnosisView d={diagnosis} tz={zone} />
          ) : (
            <Empty>ยังไม่เคยวินิจฉัย — ระบบจะวินิจฉัยให้อัตโนมัติเมื่อเว็บล่ม หรือกด “วินิจฉัยตอนนี้”</Empty>
          )}
        </Card>

        <Card title="ความเชื่อมโยงและพฤติกรรมปกติ">
          <div className="space-y-4 p-4 text-sm">
            <div>
              <div className="mb-1.5 text-xs font-semibold text-muted">เว็บนี้พึ่งพา</div>
              <DependencyPicker
                websiteId={site.id}
                options={graph.nodes.filter((n) => n.id !== site.id).map((n) => ({ id: n.id, name: n.name }))}
                selected={dependsOn}
                isAdmin={isAdmin}
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-subtle">
                ถ้าระบบที่พึ่งพาล่มอยู่ก่อน ระบบจะบันทึก Incident ว่า “ล่มตามกัน” และไม่ส่งอีเมลซ้ำ
              </p>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-semibold text-muted">ระบบที่พึ่งพาเว็บนี้</div>
              {dependents.length === 0 ? (
                <span className="text-xs text-muted">ไม่มี</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {dependents.map((x) => (
                    <Link
                      key={x}
                      href={`/websites/${x}`}
                      className="rounded-full bg-sidebar px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ring-line hover:bg-brand-bg hover:text-brand-deep"
                    >
                      {nodeName.get(x)?.name ?? `#${x}`}
                    </Link>
                  ))}
                </div>
              )}
              <Link href={`/map?focus=${site.id}`} className="link mt-2 inline-block text-xs">
                ดูแผนผังทั้งหมด →
              </Link>
            </div>
            <div className="border-t border-line pt-3">
              <div className="mb-1 text-xs font-semibold text-muted">ตรวจจับความผิดปกติล่วงหน้า</div>
              {!settings.insights.anomalyEnabled ? (
                <span className="text-xs text-muted">ปิดอยู่ (เปิดได้ในหน้าตั้งค่า)</span>
              ) : !learn ? (
                <span className="text-xs text-muted">รอ Worker คำนวณรอบแรก</span>
              ) : learn.learning ? (
                <span className="text-xs text-muted">
                  กำลังเรียนรู้พฤติกรรมปกติ ({Math.min(learn.samples, 30)}/30 ผลตรวจ)
                </span>
              ) : (
                <span className="text-xs">
                  ปกติช่วงเวลานี้ตอบ ~<b className="num">{formatMs(learn.median)}</b>
                  <span className="text-muted">
                    {" "}
                    · เรียนรู้จาก {learn.samples.toLocaleString("th-TH")} ผลตรวจ
                  </span>
                  {learn.active.length > 0 && (
                    <span className="ml-1 font-semibold text-warn">· ผิดปกติอยู่ตอนนี้</span>
                  )}
                </span>
              )}
            </div>
          </div>
        </Card>
      </section>

      <section className="stagger mb-5 grid items-start gap-5 lg:grid-cols-2">
        <Card
          title="ทดสอบใช้งานจริง (Synthetic)"
          subtitle={
            journey
              ? `${journey.steps.length} ขั้นตอน · ทุก ${journey.intervalMinutes} นาที${journey.enabled ? "" : " · ปิดอยู่"}${settings.insights.journeysEnabled ? "" : " · ปิดทั้งระบบในหน้าตั้งค่า"}`
              : "เปิดเว็บด้วย browser จริง กรอก/คลิกตามขั้นตอน แล้วตรวจว่าใช้งานได้จริง เช่น login ผ่าน"
          }
          bodyClassName="p-4"
        >
          <JourneyPanel
            websiteId={site.id}
            url={site.url}
            isAdmin={isAdmin}
            version={journey ? journey.updatedAt.toISOString() : null}
            initial={
              journey
                ? {
                    enabled: journey.enabled,
                    intervalMinutes: journey.intervalMinutes as 5 | 15 | 30 | 60,
                    steps: journey.steps,
                  }
                : null
            }
          >
            {journey && journey.runs.length > 0 ? (
              <JourneyRuns
                websiteId={site.id}
                runs={journey.runs}
                steps={journey.steps}
                tz={zone}
                canViewScreenshot={isAdmin}
              />
            ) : journey ? (
              <p className="text-sm text-muted">ยังไม่ได้ทดสอบ — Worker จะทดสอบในรอบถัดไป</p>
            ) : (
              <p className="text-sm text-muted">
                Uptime บอกแค่ว่าหน้าเว็บตอบ — แต่ถ้า login เสียหรือฐานข้อมูลล่ม หน้าเว็บก็ยังตอบ 200 ได้
                การทดสอบนี้จับปัญหาแบบนั้น
              </p>
            )}
          </JourneyPanel>
        </Card>

        <Card
          title="การเปลี่ยนแปลงของเว็บ"
          subtitle={
            settings.insights.fingerprintMinutes === 0
              ? "ปิดการติดตามอยู่ (เปิดได้ในหน้าตั้งค่า)"
              : `ติดตาม IP, DNS, ใบรับรอง, server, CMS ทุก ${settings.insights.fingerprintMinutes} นาที${fpAt ? ` · ล่าสุด ${formatTime(fpAt, zone)}` : ""}`
          }
          bodyClassName="max-h-[420px] overflow-y-auto"
        >
          {changes.length === 0 ? (
            <Empty>{fpAt ? "ยังไม่พบการเปลี่ยนแปลง" : "กำลังเก็บข้อมูลรอบแรก"}</Empty>
          ) : (
            <ChangeTimeline changes={changes} tz={zone} />
          )}
        </Card>
      </section>

      <div className="stagger mb-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_330px]">
        <Card
          title="ผลตรวจล่าสุด"
          action={
            <Link className="link" href={`/checks?websiteId=${site.id}`}>
              ดูทั้งหมด
            </Link>
          }
        >
          {d.recentChecks.length === 0 ? (
            <Empty>ยังไม่มีผลตรวจ — Worker จะตรวจภายในรอบถัดไป</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <th className="th">เวลา</th>
                    <th className="th">ผล</th>
                    <th className="th">HTTP</th>
                    <th className="th">Response</th>
                    <th className="th">Retry</th>
                    <th className="th">รายละเอียด</th>
                  </tr>
                </thead>
                <tbody className="rows-in divide-y divide-line">
                  {d.recentChecks.map((c) => (
                    <tr key={c.id} className="row">
                      <td className="td num">{formatTime(c.checkedAt, zone)}</td>
                      <td className="td">
                        <StatusLabel status={c.status} degraded={c.degraded} />
                      </td>
                      <td className="td num">{httpCell(c)}</td>
                      <td className="td num">{responseCell(c)}</td>
                      <td className="td num">
                        {c.status === "UP" ? c.retries : `${c.retries}/${site.retryCount}`}
                      </td>
                      <td className="td text-muted">{detailCell(c, site.degradedThresholdMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="การตั้งค่าการตรวจ"
          action={
            isAdmin && (
              <Link className="link" href={`/websites/${site.id}/edit`}>
                แก้ไข
              </Link>
            )
          }
        >
          <KeyValue
            rows={[
              ["รอบตรวจ", formatInterval(site.checkIntervalSeconds)],
              ["Timeout", `${Math.round(site.timeoutMs / 1000)} วินาที`],
              ["Retry", `${site.retryCount} ครั้ง · รอ ${Math.round(site.retryDelayMs / 1000)} วินาที`],
              ["ยืนยัน DOWN", `ล้มเหลวติดกัน ${site.confirmDownCount} รอบ`],
              ["ยืนยัน Recovery", `สำเร็จติดกัน ${site.confirmRecoveryCount} รอบ`],
              ["Status ที่ถือว่า UP", site.upStatusCodes + (site.treatAuthAsUp ? ", 401, 403" : "")],
              ["Redirect", site.followRedirects ? `สูงสุด ${site.maxRedirects} hop` : "ไม่ตาม"],
              [
                "DEGRADED เมื่อช้ากว่า",
                site.degradedThresholdMs ? formatMs(site.degradedThresholdMs) : "ไม่ตรวจ",
              ],
              [
                "ผู้รับอีเมล",
                `${mergeRecipients(site.alertEmails, settings.smtp.alertEmails).length} คน${
                  settings.smtp.alertEmails.length
                    ? ` (รวมผู้รับทุกเว็บ ${settings.smtp.alertEmails.length})`
                    : ""
                }`,
              ],
            ]}
          />
        </Card>
      </div>

      <section
        id="security"
        className="stagger mb-5 grid scroll-mt-6 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]"
      >
        <Card
          title="หน้าเว็บเทียบกับภาพต้นแบบ"
          subtitle={
            !settings.security.visualEnabled
              ? "ปิดการตรวจด้วยภาพอยู่ (เปิดได้ในหน้าตั้งค่า)"
              : sec.visual.latestAt
                ? `ถ่ายล่าสุด ${formatTime(sec.visual.latestAt, zone)}${sec.visual.baselineAt ? ` · ต้นแบบจาก ${formatRelativeDay(sec.visual.baselineAt, zone)}` : ""}`
                : "ยังไม่ได้ถ่ายภาพ — Worker จะถ่ายเมื่อเว็บ UP"
          }
          action={
            isAdmin && (
              <div className="flex gap-2">
                <JobButton type="VISUAL_CAPTURE" payload={{ websiteId: site.id }}>
                  ถ่ายภาพตอนนี้
                </JobButton>
                {sec.visual.hasLatest && (sec.visual.diffPct ?? 0) > 0 && (
                  <ActionButton
                    url="/api/security/visual-accept"
                    body={{ websiteId: site.id }}
                    confirm="ใช้หน้าเว็บปัจจุบันเป็นภาพต้นแบบใหม่? (ใช้เมื่อเว็บเปลี่ยนดีไซน์ตามปกติ)"
                  >
                    ตั้งเป็นต้นแบบ
                  </ActionButton>
                )}
              </div>
            )
          }
          bodyClassName="p-4"
        >
          {sec.visual.error && (
            <p className="mb-3 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">
              ถ่ายภาพไม่สำเร็จ: {sec.visual.error}
            </p>
          )}
          {sec.visual.keywords.length > 0 && (
            <p className="mb-3 rounded-lg bg-down-bg px-3 py-2 text-sm font-medium text-down">
              พบคำต้องสงสัยในหน้าเว็บ: {sec.visual.keywords.join(", ")} — ตรวจว่าเว็บถูกฝังลิงก์/ถูกแฮกหรือไม่
            </p>
          )}
          {sec.visual.hasBaseline && sec.visual.hasLatest ? (
            <>
              <VisualCompare
                websiteId={site.id}
                hasDiff={sec.visual.hasDiff}
                version={String(sec.visual.latestAt?.getTime() ?? 0)}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>{sec.visual.pageTitle ? `หัวข้อหน้า: ${sec.visual.pageTitle}` : ""}</span>
                <span
                  className={`num font-semibold ${(sec.visual.diffPct ?? 0) >= settings.security.visualThresholdPct ? "text-down" : "text-up"}`}
                >
                  ต่างจากต้นแบบ {sec.visual.diffPct ?? 0}% (เกณฑ์ {settings.security.visualThresholdPct}%)
                </span>
              </div>
            </>
          ) : (
            <Empty>ยังไม่มีภาพหน้าเว็บ</Empty>
          )}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-3">
              <GradeBadge grade={sec.scan?.grade ?? null} size={34} />
              <span>
                ความปลอดภัย
                <span className="mt-0.5 block text-xs font-normal text-muted">
                  {sec.scan?.score !== null && sec.scan?.score !== undefined
                    ? `${sec.scan.score}/100 · สแกน ${formatRelativeDay(sec.scan.scannedAt, zone)}`
                    : sec.scan?.error
                      ? `สแกนไม่สำเร็จ: ${sec.scan.error.slice(0, 80)}`
                      : "ยังไม่ได้สแกน"}
                </span>
              </span>
            </span>
          }
          action={
            isAdmin && (
              <JobButton type="SECURITY_SCAN" payload={{ websiteId: site.id }}>
                สแกนตอนนี้
              </JobButton>
            )
          }
        >
          {sec.scan && !sec.scan.error ? (
            <>
              {sec.scan.tlsValidTo && (
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs">
                  <span className="text-muted">ใบรับรอง SSL หมดอายุ</span>
                  <span className="num font-medium">
                    {formatDate(sec.scan.tlsValidTo, zone)} ·{" "}
                    {Math.floor((sec.scan.tlsValidTo.getTime() - nowMs) / 86_400_000)} วัน
                  </span>
                </div>
              )}
              <FindingList findings={sec.scan.findings} />
            </>
          ) : (
            <Empty>สแกนแบบ passive: header, SSL และไฟล์ที่ไม่ควรเปิดสาธารณะ — วันละครั้ง</Empty>
          )}
        </Card>
      </section>

      <Card
        title="Incident ของเว็บนี้"
        action={
          <Link className="link" href={`/incidents?websiteId=${site.id}`}>
            ดูทั้งหมด
          </Link>
        }
      >
        {d.incidents.length === 0 ? (
          <Empty>ยังไม่เคยมี Incident</Empty>
        ) : (
          <ul className="rows-in divide-y divide-line">
            {d.incidents.map((i) => (
              <li key={i.id}>
                <Link
                  href={`/incidents/${i.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-canvas/70"
                >
                  <span className="num w-12 text-muted">#{i.id}</span>
                  <span
                    className={`flex w-20 items-center gap-1.5 ${i.recoveredAt ? "text-up" : "text-down"}`}
                  >
                    <Dot tone={i.recoveredAt ? "up" : "down"} />
                    {i.recoveredAt ? "ปิดแล้ว" : "เปิดอยู่"}
                  </span>
                  <span className="flex-1">
                    {formatRelativeDay(i.startedAt, zone)} –{" "}
                    {i.recoveredAt ? formatHm(i.recoveredAt, zone) : "ตอนนี้"}
                  </span>
                  <span className="text-muted">{i.cause}</span>
                  <span className="num w-24 text-right font-semibold">
                    {formatDuration((i.recoveredAt ?? new Date()).getTime() - i.startedAt.getTime())}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
