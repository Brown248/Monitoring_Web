import { formatAgo } from "@app/core";
import type { ReactNode } from "react";
import type { CurrentUser } from "@/lib/auth";
import type { WorkerHealth } from "@/lib/data/system";
import { LogoutButton } from "./client/controls";
import { NavLinks, type NavItem } from "./client/nav";
import { ThemeToggle } from "./client/theme-toggle";
import { CommandPalette, PaletteButton } from "./client/command-palette";
import { Dot } from "./ui";

/** สัญลักษณ์ S ของ SYNTECH (ไฟล์ใน public/brand) */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- โลโก้ static ขนาดเล็ก ไม่ต้องผ่าน image optimizer
    <img
      src="/brand/syntech-mark.png"
      alt="SYNTECH"
      width={size}
      height={Math.round((size * 390) / 385)}
      className="shrink-0 select-none object-contain"
      draggable={false}
    />
  );
}

/** ตัวอักษร SYNTECH — โหมดมืดเพิ่มความสว่างให้สีเขียวอ่านออกบนพื้นเข้ม */
export function Wordmark({ height = 14, className = "" }: { height?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- โลโก้ static
    <img
      src="/brand/syntech-wordmark.png"
      alt="SYNTECH"
      height={height}
      width={Math.round((height * 501) / 74)}
      className={`select-none object-contain dark:brightness-150 ${className}`}
      draggable={false}
    />
  );
}

export function AppShell({
  user,
  openIncidents,
  securityAlerts,
  worker,
  children,
}: {
  user: CurrentUser;
  openIncidents: number;
  securityAlerts: number;
  worker: WorkerHealth;
  children: ReactNode;
}) {
  const workerLabel =
    worker.health === "ok"
      ? "Worker ทำงานปกติ"
      : worker.health === "off"
        ? "ยังไม่พบ Worker"
        : "Worker ไม่ส่ง heartbeat";
  const items: NavItem[] = [
    { href: "/", label: "ภาพรวม", icon: "overview" },
    { href: "/websites", label: "เว็บไซต์", icon: "websites" },
    { href: "/map", label: "แผนผังระบบ", icon: "map" },
    { href: "/incidents", label: "Incident", icon: "incidents", badge: openIncidents },
    { href: "/security", label: "ความปลอดภัย", icon: "security", badge: securityAlerts },
    { href: "/ask", label: "ถาม AI", icon: "ask" },
    { href: "/checks", label: "ประวัติการตรวจ", icon: "checks" },
    { href: "/system", label: "สถานะระบบ", icon: "system" },
    { href: "/settings", label: "ตั้งค่า", icon: "settings" },
  ];
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-sidebar/80 px-3 py-5 backdrop-blur max-md:hidden">
        <div className="mb-7 flex items-center gap-2.5 px-2">
          <Logo size={34} />
          <div>
            <Wordmark height={15} />
            <div className="mt-1 text-xs text-muted">Web Monitor · v0.1</div>
          </div>
        </div>
        <div className="mb-4">
          <PaletteButton />
        </div>
        <NavLinks items={items} />
        <div className="mt-auto space-y-3">
          <div className="rounded-xl border border-line bg-surface/70 px-3 py-2.5 shadow-[var(--shadow-card)]">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Dot
                tone={worker.health === "ok" ? "up" : worker.health === "off" ? "muted" : "down"}
                pulse={worker.health === "ok"}
              />
              {workerLabel}
            </div>
            <div className="mt-0.5 pl-4 text-xs text-muted">
              {worker.lastSeenAt ? `heartbeat ล่าสุด ${formatAgo(worker.lastSeenAt)}` : "ยังไม่มี heartbeat"}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-deep text-xs font-semibold uppercase text-white">
                {user.username.slice(0, 1)}
              </span>
              <span className="truncate">
                {user.username}
                {user.role === "VIEWER" && <span className="block text-[11px] text-muted">ดูอย่างเดียว</span>}
              </span>
            </span>
            <LogoutButton />
          </div>
          <div className="px-1">
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {/* แถบด้านบนสำหรับจอเล็ก */}
        <div className="sticky top-0 z-20 border-b border-line bg-sidebar/85 backdrop-blur md:hidden">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="flex items-center gap-2 font-semibold">
              <Logo size={26} /> <Wordmark height={13} />
            </span>
            <span className="flex items-center gap-1">
              <PaletteButton compact />
              <ThemeToggle compact />
              <LogoutButton />
            </span>
          </div>
          <div className="px-2 pb-2">
            <NavLinks items={items} compact />
          </div>
        </div>
        <main className="mx-auto max-w-[1280px] px-4 py-7 md:px-8 md:py-9">{children}</main>
        <CommandPalette isAdmin={user.role === "ADMIN"} />
      </div>
    </div>
  );
}
