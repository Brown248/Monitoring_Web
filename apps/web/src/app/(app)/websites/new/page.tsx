import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WebsiteForm } from "@/components/client/website-form";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { loadSettings } from "@/lib/data/system";
import { tz } from "@/lib/env";

export const metadata: Metadata = { title: "เพิ่มเว็บไซต์" };
export const dynamic = "force-dynamic";

export default async function NewWebsitePage() {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/websites");
  const { check_defaults: d } = await loadSettings();
  return (
    <>
      <PageHeader
        title="เพิ่มเว็บไซต์"
        subtitle="ค่ารอบตรวจ, Timeout และ Retry ดึงจากค่าเริ่มต้นในหน้าตั้งค่า แก้ทีหลังได้"
        breadcrumb={[{ label: "เว็บไซต์", href: "/websites" }, { label: "เพิ่มเว็บไซต์" }]}
      />
      <WebsiteForm
        mode="create"
        timeZoneNow={tz()}
        initial={{
          name: "",
          url: "",
          enabled: true,
          checkIntervalSeconds: d.checkIntervalSeconds,
          timeoutSeconds: d.timeoutSeconds,
          retryCount: d.retryCount,
          retryDelaySeconds: d.retryDelaySeconds,
          confirmDownCount: d.confirmDownCount,
          confirmRecoveryCount: d.confirmRecoveryCount,
          upStatusCodes: "200-399",
          degradedThresholdMs: 1500,
          treatAuthAsUp: false,
          followRedirects: true,
          alertEmails: [],
          sendRecovery: true,
          aiAutoAnalyze: true,
        }}
      />
    </>
  );
}
