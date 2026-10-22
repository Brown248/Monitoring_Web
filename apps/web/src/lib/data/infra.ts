import "server-only";
import os from "node:os";
import { sql } from "@app/db";
import { getDb } from "../db";
import { dependencyGraph } from "./insights";
import {
  aiHealth,
  backupHealth,
  canaryHealth,
  dbLatencyMs,
  diskUsage,
  loadSettings,
  outboxHealth,
  sheetsHealth,
  workerHealth,
  type Health,
} from "./system";

/** กล่องบนแผนผังโครงสร้างระบบ */
export type InfraKey =
  "user" | "vm" | "web" | "worker" | "db" | "sites" | "smtp" | "ai" | "sheets" | "internet" | "backup";

export interface InfraNode {
  state: Health;
  /** ค่าสั้น ๆ มุมขวาของกล่อง เช่น "200 · 284 ms" */
  value: string;
  /** ข้อความใต้ชื่อ / รายละเอียด */
  detail: string;
  /** สาเหตุเมื่อมีปัญหา (แสดงในแถบแจ้งเตือนด้านบน) */
  problem?: string;
  /** หน้าที่ไปแก้ปัญหานี้ */
  href: string;
}

export interface VmMetrics {
  /** load เฉลี่ย 1 นาที ÷ จำนวน CPU (null = OS ไม่รายงาน เช่น Windows) */
  cpuPct: number | null;
  memPct: number;
  diskPct: number | null;
  uptimeSec: number;
  cpus: number;
}

export interface InfraStatus {
  nodes: Record<InfraKey, InfraNode>;
  vm: VmMetrics;
  worker: { checksLast5m: number; heartbeatAgoSec: number | null };
  tables: Array<{ name: string; rows: number }>;
  checkedAt: Date;
}

const LABEL: Record<InfraKey, string> = {
  user: "ผู้ใช้",
  vm: "VM",
  web: "web",
  worker: "worker",
  db: "postgres",
  sites: "เว็บไซต์ที่ตรวจ",
  smtp: "SMTP",
  ai: "AI API",
  sheets: "Google Sheets",
  internet: "อินเทอร์เน็ตขาออก",
  backup: "Backup",
};
export const infraLabel = (k: InfraKey) => LABEL[k];

// เกณฑ์ของ VM — ใกล้เต็มให้เตือนก่อนระบบล่มจริง
const VM_WARN = { cpu: 90, mem: 90, disk: 85 };
const VM_ERROR = { cpu: 200, mem: 97, disk: 95 };

const TABLES = [
  "websites",
  "website_state",
  "check_results",
  "incidents",
  "notification_events",
  "ai_analyses",
  "worker_heartbeats",
];

function vmMetrics(disk: { usedBytes: number; totalBytes: number } | null): VmMetrics {
  const cpus = Math.max(1, os.cpus().length);
  const load = os.loadavg()[0] ?? 0;
  const total = os.totalmem();
  return {
    cpuPct: process.platform === "win32" ? null : Math.round((load / cpus) * 100),
    memPct: Math.round(((total - os.freemem()) / total) * 100),
    diskPct: disk && disk.totalBytes > 0 ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null,
    uptimeSec: Math.round(os.uptime()),
    cpus,
  };
}

/**
 * จำนวนแถวของตารางหลัก — ตารางเล็กนับจริง ตารางใหญ่ (เช่น check_results หลายล้านแถว)
 * ใช้ค่าประมาณจากสถิติของ Postgres เพื่อไม่ให้หน้าที่รีเฟรชทุก 15 วินาทีต้องสแกนทั้งตาราง
 */
async function tableRows(): Promise<Array<{ name: string; rows: number }>> {
  const db = getDb();
  const est = await db.execute<{ name: string; est: string }>(sql`
    SELECT c.relname AS name, c.reltuples::bigint::text AS est
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname IN (${sql.join(
      TABLES.map((t) => sql`${t}`),
      sql`, `,
    )})
  `);
  const byName = new Map(est.rows.map((r) => [r.name, Number(r.est)]));
  return Promise.all(
    TABLES.filter((t) => byName.has(t)).map(async (name) => {
      const e = byName.get(name)!;
      if (e >= 100_000) return { name, rows: e };
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.identifier(name)}`);
      return { name, rows: Number(r.rows[0]?.n ?? 0) };
    }),
  );
}

const settled = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/**
 * สถานะสดของทุกส่วนในระบบ สำหรับแผนผังโครงสร้าง
 * แต่ละส่วนดึงแยกกัน — ส่วนใดพังจะแสดงเป็นปัญหาของส่วนนั้น ไม่ทำให้ทั้งหน้าล่ม
 */
export async function infraStatus(): Promise<InfraStatus> {
  const settings = await loadSettings();
  const [workerR, latencyR, canaryR, outboxR, aiR, sheetsR, backupR, diskR, graphR, tablesR, sitesR] =
    await Promise.allSettled([
      workerHealth(),
      dbLatencyMs(),
      canaryHealth(),
      outboxHealth(settings),
      aiHealth(settings),
      sheetsHealth(settings),
      backupHealth(),
      diskUsage(),
      dependencyGraph(),
      tableRows(),
      getDb().execute<{ avg_ms: string | null }>(sql`
        SELECT round(avg(response_time_ms) FILTER (WHERE status = 'UP'))::text AS avg_ms
        FROM check_results WHERE checked_at >= now() - interval '10 minutes'
      `),
    ]);

  const worker = settled(workerR);
  const latency = settled(latencyR);
  const canary = settled(canaryR);
  const outbox = settled(outboxR);
  const ai = settled(aiR);
  const sheets = settled(sheetsR);
  const backup = settled(backupR);
  const graph = settled(graphR);
  const sitesAgg = settled(sitesR)?.rows[0] ?? null;
  const vm = vmMetrics(settled(diskR));
  const dbOk = latency !== null;

  const nodes = {} as Record<InfraKey, InfraNode>;

  nodes.user = { state: "ok", value: "LAN", detail: "เปิด Dashboard · จัดการเว็บ · ดู Incident", href: "/" };
  nodes.web = {
    state: "ok",
    value: `Node ${process.versions.node.split(".")[0]}`,
    detail: "Dashboard + API · ทุก route ผ่าน auth และ validate ด้วย zod",
    href: "/system",
  };

  // VM: วัดจากเครื่องที่เว็บรันอยู่ (container เห็นค่าของ VM)
  const vmErr: string[] = [];
  const vmWarn: string[] = [];
  const judge = (name: string, v: number | null, w: number, e: number) => {
    if (v === null) return;
    if (v >= e) vmErr.push(`${name} ${v}%`);
    else if (v >= w) vmWarn.push(`${name} ${v}%`);
  };
  judge("CPU load", vm.cpuPct, VM_WARN.cpu, VM_ERROR.cpu);
  judge("RAM", vm.memPct, VM_WARN.mem, VM_ERROR.mem);
  judge("ดิสก์", vm.diskPct, VM_WARN.disk, VM_ERROR.disk);
  nodes.vm = {
    state: vmErr.length ? "error" : vmWarn.length ? "warn" : "ok",
    value:
      vm.uptimeSec >= 86_400
        ? `up ${Math.floor(vm.uptimeSec / 86_400)} วัน`
        : `up ${Math.floor(vm.uptimeSec / 3600)} ชม. ${Math.floor((vm.uptimeSec % 3600) / 60)} นาที`,
    detail: `${vm.cpus} CPU`,
    problem: vmErr.length
      ? `ทรัพยากรใกล้หมด: ${vmErr.join(", ")}`
      : vmWarn.length
        ? `ทรัพยากรเริ่มสูง: ${vmWarn.join(", ")}`
        : undefined,
    href: "/system",
  };

  nodes.db = dbOk
    ? {
        state: latency > 500 ? "warn" : "ok",
        value: `${latency} ms`,
        detail: "Source of Truth · Drizzle migrations",
        problem: latency > 500 ? `ฐานข้อมูลตอบช้า (${latency} ms)` : undefined,
        href: "/system",
      }
    : {
        state: "error",
        value: "ติดต่อไม่ได้",
        detail: "Source of Truth",
        problem: "เชื่อมต่อฐานข้อมูลไม่ได้",
        href: "/system",
      };

  const hbAgo = worker?.lastSeenAt ? Math.round((Date.now() - worker.lastSeenAt.getTime()) / 1000) : null;
  nodes.worker =
    !worker || worker.health === "off"
      ? {
          state: dbOk ? "error" : "off",
          value: "ไม่พบ",
          detail: "ยังไม่เคยส่ง heartbeat",
          problem: dbOk ? "Worker ยังไม่ทำงาน — ระบบไม่ได้ตรวจเว็บ" : undefined,
          href: "/system",
        }
      : worker.health === "error"
        ? {
            state: "error",
            value: "ขาดการติดต่อ",
            detail: `heartbeat ล่าสุด ${hbAgo ?? "?"} วินาทีที่แล้ว`,
            problem: "Worker หยุดทำงาน — ระบบไม่ได้ตรวจเว็บ ไม่ส่งแจ้งเตือน",
            href: "/system",
          }
        : { state: "ok", value: "LIVE", detail: "Node.js · process แยก", href: "/system" };

  // เว็บที่ตรวจ
  if (graph) {
    const active = graph.nodes.filter((n) => n.enabled);
    const down = active.filter((n) => n.status === "DOWN");
    const roots = down.filter((n) => n.rootCauseId === null);
    const failing = active.filter((n) => n.failing);
    const up = active.filter((n) => n.status === "UP").length;
    const ms = sitesAgg?.avg_ms ? Number(sitesAgg.avg_ms) : null;
    nodes.sites = {
      state: down.length ? "error" : failing.length ? "warn" : active.length ? "ok" : "off",
      value: active.length ? `${up}/${active.length} ปกติ` : "ยังไม่มีเว็บ",
      detail: ms !== null ? `HTTP check · เฉลี่ย ${ms} ms` : "HTTP check · SSRF guard",
      problem: down.length
        ? `ล่ม ${down.length} เว็บ${roots.length ? ` — ต้นเหตุ: ${roots.map((r) => r.name).join(", ")}` : ""}`
        : failing.length
          ? `เริ่มล้มเหลว: ${failing.map((f) => f.name).join(", ")}`
          : undefined,
      href: down.length ? "/incidents" : "/websites",
    };
  } else nodes.sites = { state: "off", value: "—", detail: "HTTP check", href: "/websites" };

  nodes.smtp = !outbox
    ? { state: "off", value: "—", detail: "DOWN / RECOVERY alert", href: "/settings#smtp" }
    : !outbox.smtpConfigured
      ? { state: "off", value: "ยังไม่ตั้งค่า", detail: "DOWN / RECOVERY alert", href: "/settings#smtp" }
      : {
          state: outbox.dead > 0 ? "error" : outbox.failed > 0 ? "warn" : "ok",
          value:
            outbox.pending + outbox.failed > 0
              ? `คิว ${outbox.pending + outbox.failed}`
              : outbox.sent24h
                ? `ส่ง ${outbox.sent24h} ฉบับ/วัน`
                : "พร้อม",
          detail: "DOWN / RECOVERY alert",
          problem:
            outbox.dead > 0
              ? `ส่งอีเมลไม่สำเร็จถาวร ${outbox.dead} ฉบับ`
              : outbox.failed > 0
                ? `ส่งอีเมลไม่สำเร็จ ${outbox.failed} ฉบับ (กำลังลองใหม่)`
                : undefined,
          href: outbox.dead + outbox.failed > 0 ? "/system" : "/settings#smtp",
        };

  const aiRecentFail = ai?.lastFailureAt && Date.now() - ai.lastFailureAt.getTime() < 3_600_000;
  nodes.ai = !ai
    ? { state: "off", value: "—", detail: "วิเคราะห์ Incident", href: "/settings#ai" }
    : ai.health === "off"
      ? { state: "off", value: "ปิด", detail: "วิเคราะห์ Incident", href: "/settings#ai" }
      : {
          state: ai.health === "warn" || aiRecentFail ? "warn" : "ok",
          value: ai.running ? `กำลังวิเคราะห์ ${ai.running}` : `${ai.callsThisMonth} ครั้ง/เดือน`,
          detail: ai.model || "วิเคราะห์ Incident",
          problem:
            ai.health === "warn"
              ? "AI ตั้งค่าไม่ครบหรือใช้ครบโควตาเดือนนี้"
              : aiRecentFail
                ? `เรียก AI ล้มเหลวล่าสุด${ai.lastFailureError ? `: ${ai.lastFailureError.slice(0, 80)}` : ""}`
                : undefined,
          href: "/settings#ai",
        };

  nodes.sheets = !sheets
    ? { state: "off", value: "—", detail: "รายงานอัตโนมัติ", href: "/settings#sheets" }
    : !sheets.configured
      ? { state: "off", value: "ยังไม่ตั้งค่า", detail: "รายงานอัตโนมัติ", href: "/settings#sheets" }
      : {
          state: sheets.lastStatus === "FAILED" ? "warn" : "ok",
          value: sheets.lastSyncAt
            ? sheets.lastSyncAt.toLocaleTimeString("th-TH", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })
            : "รอ sync",
          detail: "รายงานอัตโนมัติ",
          problem: sheets.lastStatus === "FAILED" ? "sync Google Sheets ล่าสุดล้มเหลว" : undefined,
          href: "/settings#sheets",
        };

  nodes.internet = !canary
    ? { state: "off", value: "—", detail: "Canary check", href: "/system" }
    : {
        state: canary.health,
        value:
          canary.health === "off"
            ? "ยังไม่มีผล"
            : `${canary.targets.filter((t) => t.ok).length}/${canary.targets.length} ผ่าน`,
        detail: "Canary · เช็คว่า VM ออกเน็ตได้",
        problem:
          canary.health === "error"
            ? "VM ออกอินเทอร์เน็ตไม่ได้ — ผลตรวจเว็บช่วงนี้อาจไม่ถูกต้อง"
            : canary.health === "warn"
              ? "ออกอินเทอร์เน็ตได้บางปลายทาง"
              : undefined,
        href: "/system",
      };

  nodes.backup = !backup
    ? { state: "off", value: "—", detail: "pg_dump", href: "/system" }
    : {
        state: backup.health,
        value: backup.lastOkAt
          ? `${Math.round((Date.now() - backup.lastOkAt.getTime()) / 3_600_000)} ชม.ที่แล้ว`
          : "ยังไม่เคย",
        detail: "pg_dump ทุกคืน",
        problem: backup.health === "ok" ? undefined : backup.detail,
        href: "/system",
      };

  return {
    nodes,
    vm,
    worker: {
      checksLast5m: worker?.checksLast5m ?? 0,
      heartbeatAgoSec: hbAgo,
    },
    tables: settled(tablesR) ?? [],
    checkedAt: new Date(),
  };
}
