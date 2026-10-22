import type { Metadata } from "next";
import { AutoRefresh } from "@/components/client/controls";
import Link from "next/link";
import { ServiceMap } from "@/components/client/service-map";
import { InfraMap } from "@/components/infra-map";
import { Card, Empty, PageHeader, Pill } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { infraLabel, infraStatus, type InfraKey } from "@/lib/data/infra";
import { dependencyGraph } from "@/lib/data/insights";
import { tz } from "@/lib/env";

export const metadata: Metadata = { title: "แผนผังระบบ" };
export const dynamic = "force-dynamic";

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser();
  const focusRaw = Number((await searchParams).focus);
  const [{ nodes, edges }, infra] = await Promise.all([dependencyGraph(), infraStatus()]);
  // ปัญหาของตัวระบบ: แดงก่อนเหลือง
  const problems = (Object.keys(infra.nodes) as InfraKey[])
    .map((k) => ({ k, ...infra.nodes[k] }))
    .filter((p) => p.problem && (p.state === "error" || p.state === "warn"))
    .sort((a, b) => (a.state === b.state ? 0 : a.state === "error" ? -1 : 1));
  const checkedAt = new Intl.DateTimeFormat("th-TH", {
    timeZone: tz(),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(infra.checkedAt);
  const focus = Number.isInteger(focusRaw) && nodes.some((n) => n.id === focusRaw) ? focusRaw : null;

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title="แผนผังระบบ"
        subtitle="ข้อมูลไหลจากซ้ายไปขวา · สถานะสดทุก 15 วินาที — กล่องไหนมีปัญหาจะเปลี่ยนสีและเส้นหยุดไหล กดกล่องเพื่อไปแก้"
      />

      {problems.length > 0 ? (
        <div
          role="alert"
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            problems.some((p) => p.state === "error")
              ? "border-down/30 bg-gradient-to-r from-down-bg to-surface"
              : "border-warn/30 bg-gradient-to-r from-warn-bg to-surface"
          }`}
        >
          <div className="mb-1.5 font-semibold">
            <span className={problems.some((p) => p.state === "error") ? "text-down" : "text-warn"}>
              ระบบมีปัญหา {problems.length} จุด
            </span>
          </div>
          <ul className="space-y-1">
            {problems.map((p) => (
              <li key={p.k} className="flex flex-wrap items-baseline gap-x-2">
                <span className={`font-medium ${p.state === "error" ? "text-down" : "text-warn"}`}>
                  ● {infraLabel(p.k)}
                </span>
                <span className="text-ink-soft">{p.problem}</span>
                <Link href={p.href} className="text-xs font-medium text-info hover:underline">
                  ไปแก้ →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-up/25 bg-gradient-to-r from-up-bg to-surface px-4 py-2.5 text-sm">
          <span className="font-semibold text-up">● ทุกส่วนทำงานปกติ</span>
          <span className="text-muted">ตรวจล่าสุด {checkedAt}</span>
        </div>
      )}

      <Card
        title="โครงสร้างระบบ"
        subtitle={`สถานะสด · ${checkedAt}`}
        action={
          <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted xl:flex">
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block h-[3px] w-4 rounded bg-[#2563eb]" />
              ผู้ใช้ผ่าน web
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block h-[3px] w-4 rounded bg-[#16a34a]" />
              งานของ worker
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block h-[3px] w-4 rounded bg-[#d97706]" />
              อ่านงานจาก DB
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block h-[3px] w-4 rounded border-t-2 border-dashed border-down" />
              ขาด / มีปัญหา
            </span>
          </div>
        }
        className="mb-5"
        bodyClassName="p-3"
      >
        <InfraMap s={infra} />
      </Card>

      <Card
        title="ความเชื่อมโยงระหว่างเว็บ"
        subtitle={`${edges.length} เส้น · ${nodes.length} เว็บไซต์`}
        action={
          <div className="flex flex-wrap gap-1.5">
            <Pill tone="up">ปกติ</Pill>
            <Pill tone="warn">เริ่มล้มเหลว</Pill>
            <Pill tone="down">ล่ม</Pill>
            <Pill tone="muted">ปิด/ยังไม่ตรวจ</Pill>
          </div>
        }
        bodyClassName="p-4"
      >
        {nodes.length === 0 ? (
          <Empty icon="inbox">ยังไม่มีเว็บไซต์</Empty>
        ) : (
          <>
            {edges.length === 0 && (
              <div className="mb-5 rounded-lg bg-info-bg px-4 py-3 text-sm text-info">
                <b>ยังไม่ได้ตั้งความเชื่อมโยง</b> — เปิดหน้าเว็บไซต์แล้วเลือก “เว็บนี้พึ่งพา” เช่น CRM พึ่งพา
                JIG API · เมื่อ API ล่ม ระบบจะรู้ว่า CRM “ล่มตามกัน” และส่งอีเมลเฉพาะต้นเหตุ ไม่ส่งซ้ำทุกระบบ
              </div>
            )}
            <ServiceMap nodes={nodes} edges={edges} focus={focus} />
          </>
        )}
      </Card>
    </>
  );
}
