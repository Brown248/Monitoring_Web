import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ActionButton } from "@/components/client/controls";
import { WebsiteForm } from "@/components/client/website-form";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getWebsite } from "@/lib/data/websites";
import { tz } from "@/lib/env";
import { parseId as parseIdParam } from "@/lib/params";

export const metadata: Metadata = { title: "แก้ไขเว็บไซต์" };
export const dynamic = "force-dynamic";

export default async function EditWebsitePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const raw = (await params).id;
  const id = parseIdParam(raw);
  if (user.role !== "ADMIN") redirect(`/websites/${encodeURIComponent(raw)}`);
  const w = id !== undefined ? await getWebsite(id) : null;
  if (!w || w.archivedAt) notFound();
  return (
    <>
      <PageHeader
        title="แก้ไขเว็บไซต์"
        subtitle="ฟอร์มเดียวกันใช้ตอนเพิ่มเว็บไซต์ใหม่ (ไม่มีส่วน Archive)"
        breadcrumb={[
          { label: "เว็บไซต์", href: "/websites" },
          { label: w.name, href: `/websites/${w.id}` },
          { label: "แก้ไข" },
        ]}
      />
      <WebsiteForm
        mode="edit"
        websiteId={w.id}
        version={w.updatedAt.toISOString()}
        timeZoneNow={tz()}
        initial={{
          name: w.name,
          url: w.url,
          enabled: w.enabled,
          checkIntervalSeconds: w.checkIntervalSeconds,
          timeoutSeconds: Math.round(w.timeoutMs / 1000),
          retryCount: w.retryCount,
          retryDelaySeconds: Math.round(w.retryDelayMs / 1000),
          confirmDownCount: w.confirmDownCount,
          confirmRecoveryCount: w.confirmRecoveryCount,
          upStatusCodes: w.upStatusCodes,
          degradedThresholdMs: w.degradedThresholdMs,
          treatAuthAsUp: w.treatAuthAsUp,
          followRedirects: w.followRedirects,
          alertEmails: w.alertEmails,
          sendRecovery: w.sendRecovery,
          aiAutoAnalyze: w.aiAutoAnalyze,
        }}
      />
      <section className="mt-5 max-w-[calc(100%-360px)] rounded-lg border border-down/30 bg-surface p-5 max-lg:max-w-full">
        <h2 className="text-sm font-semibold text-down">Archive เว็บไซต์</h2>
        <p className="mt-2 text-sm text-muted">
          หยุดตรวจและซ่อนจากรายการ ประวัติการตรวจและ Incident เดิมยังเก็บไว้ตามนโยบาย Retention
        </p>
        <div className="mt-3">
          <ActionButton
            url={`/api/websites/${w.id}/archive`}
            variant="danger"
            confirm={`Archive "${w.name}"? เว็บนี้จะหยุดตรวจและหายจากรายการ`}
            redirectTo="/websites"
          >
            Archive เว็บไซต์นี้
          </ActionButton>
        </div>
      </section>
    </>
  );
}
