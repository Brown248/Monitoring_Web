import { count, users } from "@app/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo, Wordmark } from "@/components/app-shell";
import { getCurrentUser, safeNext } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ThemeToggle } from "@/components/client/theme-toggle";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "เข้าสู่ระบบ" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  if (await getCurrentUser()) redirect(next);
  const [{ n }] = (await getDb().select({ n: count() }).from(users)) as [{ n: number }];
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-12">
      {/* พื้นหลังเคลื่อนไหวเบา ๆ */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="animate-float absolute -left-24 -top-24 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div
          className="animate-float absolute -bottom-32 -right-16 h-[28rem] w-[28rem] rounded-full bg-info/15 blur-3xl"
          style={{ animationDelay: "-3s" }}
        />
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "radial-gradient(color-mix(in oklab, var(--color-ink) 9%, transparent) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          }}
        />
      </div>
      <div className="absolute right-4 top-4 z-10">
        <ThemeToggle />
      </div>
      <div className="animate-pop relative">
        <Logo size={72} />
      </div>
      <div className="animate-fade-up relative mt-4" style={{ animationDelay: "30ms" }}>
        <Wordmark height={26} />
      </div>
      <h1 className="animate-fade-up relative mt-5 text-2xl font-semibold tracking-tight">
        เข้าสู่ระบบ Web Monitor
      </h1>
      <p className="animate-fade-up relative mt-1 text-sm text-muted" style={{ animationDelay: "60ms" }}>
        ระบบตรวจสถานะเว็บไซต์ภายในองค์กร
      </p>
      <div
        className="animate-fade-up relative mt-7 w-full max-w-sm rounded-2xl border border-line bg-surface/85 p-6 shadow-[var(--shadow-lift)] backdrop-blur"
        style={{ animationDelay: "120ms" }}
      >
        {n === 0 ? (
          <div className="space-y-3 text-sm">
            <p className="font-medium">ยังไม่มีผู้ใช้ในระบบ</p>
            <p className="text-muted">สร้างผู้ดูแลระบบคนแรกบนเซิร์ฟเวอร์ด้วยคำสั่ง:</p>
            <pre className="overflow-x-auto rounded-md bg-sidebar p-3 font-mono text-xs">
              {"pnpm user:create -- --username admin --role admin"}
            </pre>
          </div>
        ) : (
          <LoginForm next={next} />
        )}
      </div>
      <p className="animate-fade-up relative mt-5 text-xs text-muted" style={{ animationDelay: "180ms" }}>
        ใช้ได้เฉพาะในเครือข่าย LAN · ลืมรหัสผ่าน ติดต่อผู้ดูแลระบบ
      </p>
    </div>
  );
}
