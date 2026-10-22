import { sql } from "@app/db";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { openSecurityAlertCount } from "@/lib/data/security";
import { workerHealth } from "@/lib/data/system";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [open, worker, security] = await Promise.all([
    getDb().execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM incidents WHERE recovered_at IS NULL`),
    workerHealth(),
    openSecurityAlertCount(),
  ]);
  return (
    <AppShell
      user={user}
      openIncidents={Number(open.rows[0]?.n ?? 0)}
      securityAlerts={security}
      worker={worker}
    >
      {children}
    </AppShell>
  );
}
