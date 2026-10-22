// โค้ดใน page.evaluate() รันใน browser → ต้องใช้ type ของ DOM
/// <reference lib="dom" />
import { isIP } from "node:net";
import {
  baseDomain,
  JOURNEY_ACTION_LABEL,
  SECRET_PREFIX,
  secretDomainEnvNames,
  secretEnvName,
} from "@app/core";
import { USER_AGENT } from "@app/core/server";
import { journeyRuns, logEvent, securityAlerts, sql, type JourneyStep } from "@app/db";
import type { Browser, Page } from "playwright-core";
import type { WorkerContext } from "../context";
import { isChallengeTitle, prepareContext, withBrowser, withDeadline, withTimeout } from "./visual";

const STEP_TIMEOUT_MS = 15_000;
const BATCH = 2;
/** ล้มเหลวติดกันกี่ครั้งถึงแจ้งเตือน (กันเน็ตกระตุกครั้งเดียว) */
const FAIL_ALERT_AFTER = 2;

export interface JourneyResult {
  ok: boolean;
  durationMs: number;
  stepMs: number[];
  failedStep: number | null;
  error: string | null;
  screenshot: Buffer | null;
}

type SecretResolver = (name: string) => string | undefined;

const envSecrets: SecretResolver = (name) => process.env[secretEnvName(name)];

/** โดเมนที่ผูกกับ secret (จาก .env) — คืน [] ถ้ายังไม่ได้ผูก */
export const envSecretDomains = (name: string): string[] => {
  for (const key of secretDomainEnvNames(name)) {
    const v = process.env[key];
    if (v?.trim())
      return v
        .split(",")
        .map((d) => hostDomain(`https://${d.trim().replace(/^https?:\/\//i, "")}`))
        .filter((d): d is string => d !== null);
  }
  return [];
};

function describe(step: JourneyStep): string {
  const what = step.action === "goto" || step.action.startsWith("expect") ? step.value : step.selector;
  return `${JOURNEY_ACTION_LABEL[step.action]}${what && !what.startsWith(SECRET_PREFIX) ? ` "${what.slice(0, 80)}"` : ""}`;
}

/** แปลง error ของ Playwright เป็นภาษาคน (และไม่มีค่า secret หลุดออกไป) */
function explain(err: unknown, step: JourneyStep, secrets: string[]): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (/Timeout \d+ms exceeded|TimeoutError/i.test(msg)) {
    msg =
      step.action === "expectText"
        ? `ไม่พบข้อความ "${step.value}" ภายใน ${STEP_TIMEOUT_MS / 1000} วินาที`
        : step.action === "goto"
          ? `เปิดหน้าไม่สำเร็จภายใน 30 วินาที`
          : `ไม่พบ ${step.selector} ภายใน ${STEP_TIMEOUT_MS / 1000} วินาที`;
  } else {
    msg = msg.split("\n")[0]!.replace(/^(page|locator)\.\w+: /, "");
  }
  // ปิดทั้งค่าปกติและแบบที่ถูก encode ใน URL (Playwright ใส่ URL ลงข้อความ error)
  for (const s of secrets)
    for (const form of new Set([s, encodeURIComponent(s), encodeURI(s)]))
      if (form.length >= 3) msg = msg.split(form).join("***");
  return msg.slice(0, 400);
}

async function isChallenge(page: Page): Promise<boolean> {
  // page.title() ไม่มี timeout — หน้าเว็บที่ JavaScript วนไม่จบจะค้างตลอด
  const title = await withTimeout(page.title(), 5_000, "");
  return isChallengeTitle(title);
}

/** โดเมนหลักของ URL (sso.example.co.th → example.co.th) · IP ใช้ทั้งก้อน */
function hostDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return isIP(host) ? host : baseDomain(host);
  } catch {
    return null;
  }
}

async function runStep(
  page: Page,
  step: JourneyStep,
  value: string | undefined,
  /** ตรวจโดเมนของหน้าซ้ำก่อนและหลังกรอกค่าลับ (หน้าอาจ redirect ไประหว่างตรวจครั้งแรกกับการกรอกจริง) */
  guard?: () => void,
): Promise<void> {
  switch (step.action) {
    case "goto": {
      const res = await page.goto(value!, { waitUntil: "load", timeout: 30_000 });
      for (let i = 0; i < 6 && (await isChallenge(page)); i++) await page.waitForTimeout(1_500);
      if (await isChallenge(page))
        throw new Error("เว็บมีระบบกันบอทขวางอยู่ — อนุญาต IP ของ Worker ในระบบกันบอท");
      if (res && res.status() >= 400) throw new Error(`หน้าเว็บตอบ HTTP ${res.status()}`);
      return;
    }
    case "fill": {
      const target = page.locator(step.selector!).first();
      await target.waitFor({ state: "visible" });
      guard?.();
      await target.fill(value ?? "");
      guard?.();
      return;
    }
    case "click":
      await page.locator(step.selector!).first().click();
      // ให้เวลาหน้าเปลี่ยน (submit form / SPA navigation)
      await page.waitForLoadState("load").catch(() => {});
      return;
    case "waitFor":
      await page.locator(step.selector!).first().waitFor({ state: "visible" });
      return;
    case "expectText":
      await page.getByText(value!, { exact: false }).first().waitFor({ state: "visible" });
      return;
    case "expectNoText": {
      await page.waitForTimeout(1_000);
      const visible = await page
        .getByText(value!, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) throw new Error(`พบข้อความ "${value}" ซึ่งไม่ควรมี`);
      return;
    }
  }
}

export interface JourneyOptions {
  /** โดเมนที่อนุญาตให้กรอกค่า secret (โดเมนของเว็บที่ทดสอบ) — ไม่ระบุ = ไม่จำกัด (ใช้ในเทสต์) */
  allowedDomains?: string[];
  /** โดเมนที่ secret แต่ละตัวผูกไว้ (ใน .env) — ตั้งไว้ = secret ที่ไม่ได้ผูก หรือผูกกับเว็บอื่น ใช้ไม่ได้ */
  secretDomains?: (name: string) => string[];
  /** เวลารวมสูงสุดของทั้ง journey */
  deadlineMs?: number;
}

/**
 * รันขั้นตอนทั้งหมดด้วย browser จริง — ค่า secret:ชื่อ อ่านจาก .env ของ Worker (ไม่อยู่ใน DB/หน้าเว็บ)
 * ล้มเหลวที่ขั้นไหน หยุดทันทีและถ่ายภาพหน้าจอไว้ดู
 * - กรอกค่า secret ได้เฉพาะบนโดเมนของเว็บที่ทดสอบ (ถูก redirect ไปโดเมนอื่น = ไม่ส่งรหัสผ่านให้)
 * - มีเวลารวมสูงสุด: หน้าเว็บค้าง (JavaScript วนไม่จบ) → ปิดทิ้ง Worker ไปต่อได้
 */
export async function executeJourney(
  browser: Browser,
  steps: JourneyStep[],
  resolveSecret: SecretResolver = envSecrets,
  opts: JourneyOptions = {},
): Promise<JourneyResult> {
  const started = performance.now();
  const stepMs: number[] = [];
  const secrets: string[] = [];
  const deadlineMs = opts.deadlineMs ?? steps.length * 20_000 + 45_000;
  let current = 0;
  const context = await prepareContext(
    await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split(".")[0]}.0.0.0 Safari/537.36 ${USER_AGENT.split(" ")[0]} (journey)`,
      serviceWorkers: "block",
      acceptDownloads: false,
      locale: "th-TH",
      timezoneId: "Asia/Bangkok",
    }),
  );
  const fail = (i: number, step: JourneyStep, error: string, screenshot: Buffer | null): JourneyResult => ({
    ok: false,
    durationMs: Math.round(performance.now() - started),
    stepMs,
    failedStep: i,
    error: `ขั้นที่ ${i + 1} (${describe(step)}): ${error}`,
    screenshot,
  });

  const run = async (): Promise<JourneyResult> => {
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    for (let i = 0; i < steps.length; i++) {
      current = i;
      const step = steps[i]!;
      const t0 = performance.now();
      let guard: (() => void) | undefined;
      try {
        let value = step.value;
        if (value?.startsWith(SECRET_PREFIX)) {
          const name = value.slice(SECRET_PREFIX.length);
          value = resolveSecret(name);
          if (value === undefined || value === "")
            throw new Error(`ไม่พบตัวแปร ${secretEnvName(name)} ใน .env ของ Worker`);
          secrets.push(value);
          // secret ต้องผูกกับโดเมนใน .env — ผู้ดูแลเว็บตั้ง journey บนเว็บของตัวเองเพื่อดึงรหัสของเว็บอื่นไม่ได้
          const bound = opts.secretDomains?.(name);
          if (bound && bound.length === 0)
            throw new Error(
              `${secretEnvName(name)} ยังไม่ได้ระบุว่าใช้กับเว็บไหน — ตั้ง ${secretDomainEnvNames(name).at(-1)}=โดเมนของเว็บ ใน .env ของ Worker`,
            );
          // ไม่ส่งค่าลับให้เว็บอื่น (ตั้งขั้นตอนผิด/ถูก redirect ออกไปนอกโดเมนของเว็บที่ทดสอบ)
          const isGoto = step.action === "goto";
          const secretValue = value;
          guard = () => {
            const here = hostDomain(isGoto ? secretValue : page.url());
            if (opts.allowedDomains && (!here || !opts.allowedDomains.includes(here)))
              throw new Error(
                `ไม่กรอกค่าลับบนโดเมน ${here ?? "ที่ไม่รู้จัก"} — ใช้ได้เฉพาะ ${opts.allowedDomains.join(", ")}`,
              );
            if (bound && (!here || !bound.includes(here)))
              throw new Error(
                `${secretEnvName(name)} ผูกไว้กับ ${bound.join(", ")} — ไม่กรอกบนโดเมน ${here ?? "ที่ไม่รู้จัก"}`,
              );
          };
          guard();
        }
        await runStep(page, step, value, guard);
        stepMs.push(Math.round(performance.now() - t0));
      } catch (err) {
        const screenshot = await page
          .screenshot({ type: "jpeg", quality: 60, fullPage: false })
          .catch(() => null);
        return fail(i, step, explain(err, step, secrets), screenshot);
      }
    }
    return {
      ok: true,
      durationMs: Math.round(performance.now() - started),
      stepMs,
      failedStep: null,
      error: null,
      screenshot: null,
    };
  };

  try {
    return await withDeadline(run(), deadlineMs, () => context.close(), "deadline");
  } catch {
    const step = steps[current]!;
    return fail(
      current,
      step,
      `หน้าเว็บค้าง/ทำงานเกิน ${Math.round(deadlineMs / 1000)} วินาที — ยกเลิกการทดสอบ`,
      null,
    );
  } finally {
    await withTimeout(context.close(), 10_000, undefined);
  }
}

type DueJourney = {
  website_id: number;
  name: string;
  url: string;
  steps: JourneyStep[];
};

/** แจ้งเตือนซ้ำได้ไม่ถี่กว่านี้ (กรณีกด "รับทราบ" แล้วแต่ยังไม่ผ่าน) */
const REALERT_HOURS = 6;
/** เว็บที่กำลังทดสอบอยู่ในเครื่องนี้ — ไม่ให้รอบตามตารางกับปุ่ม "ทดสอบตอนนี้" รันซ้อนกัน */
const running = new Set<number>();

const optionsFor = (j: DueJourney): JourneyOptions => {
  const d = hostDomain(j.url);
  return { allowedDomains: d ? [d] : [], secretDomains: envSecretDomains };
};

async function recordRun(ctx: WorkerContext, j: DueJourney, r: JourneyResult): Promise<void> {
  const websiteId = Number(j.website_id);
  // ภาพหน้าจอเก็บเฉพาะครั้งแรกของปัญหาเดิม (ขั้น/ข้อความเดียวกับครั้งก่อน = ภาพแทบเหมือนเดิม) — ไม่ให้ DB โตเร็ว
  let screenshot = r.screenshot;
  if (screenshot) {
    const [prev] = (
      await ctx.db.execute<{ ok: boolean; failed_step: number | null; error: string | null }>(sql`
        SELECT ok, failed_step, error FROM journey_runs WHERE website_id = ${websiteId} ORDER BY started_at DESC LIMIT 1
      `)
    ).rows;
    if (prev && !prev.ok && prev.failed_step === r.failedStep && prev.error === r.error) screenshot = null;
  }
  await ctx.db.insert(journeyRuns).values({
    websiteId,
    ok: r.ok,
    durationMs: r.durationMs,
    failedStep: r.failedStep,
    error: r.error,
    stepMs: r.stepMs,
    screenshot,
  });
  const recent = await ctx.db.execute<{ ok: boolean }>(sql`
    SELECT ok FROM journey_runs WHERE website_id = ${websiteId} ORDER BY started_at DESC LIMIT ${FAIL_ALERT_AFTER}
  `);
  const [openAlert] = (
    await ctx.db.execute<{ id: number }>(sql`
      SELECT id FROM security_alerts
      WHERE website_id = ${websiteId} AND type = 'JOURNEY_FAILED' AND acknowledged_at IS NULL LIMIT 1
    `)
  ).rows;
  // กด "รับทราบ" แล้วแต่ยังไม่ผ่าน → ไม่เตือนซ้ำทุกรอบ (ซ้ำได้หลัง REALERT_HOURS)
  const [recentAlert] = (
    await ctx.db.execute<{ id: number }>(sql`
      SELECT id FROM security_alerts
      WHERE website_id = ${websiteId} AND type = 'JOURNEY_FAILED'
        AND created_at > now() - make_interval(hours => ${REALERT_HOURS})
        AND NOT coalesce((detail->>'autoResolved')::boolean, false)
      LIMIT 1
    `)
  ).rows;
  const failingStreak = recent.rows.length >= FAIL_ALERT_AFTER && recent.rows.every((x) => !x.ok);
  if (failingStreak && !openAlert && !recentAlert) {
    await ctx.db.insert(securityAlerts).values({
      websiteId,
      type: "JOURNEY_FAILED",
      severity: "high",
      title: `${j.name}: ทดสอบใช้งานจริงไม่ผ่าน`,
      detail: { detail: r.error, failedStep: r.failedStep },
    });
    await logEvent(ctx.db, {
      type: "JOURNEY_FAILED",
      level: "ERROR",
      websiteId,
      message: `${j.name} ทดสอบใช้งานจริงไม่ผ่าน ${FAIL_ALERT_AFTER} ครั้งติด`,
      detail: r.error,
    });
  } else if (r.ok && openAlert) {
    await ctx.db.execute(sql`
      UPDATE security_alerts
      SET acknowledged_at = now(), detail = coalesce(detail, '{}'::jsonb) || '{"autoResolved": true}'::jsonb
      WHERE id = ${Number(openAlert.id)}
    `);
    await logEvent(ctx.db, {
      type: "JOURNEY_RECOVERED",
      level: "SUCCESS",
      websiteId,
      message: `${j.name} ทดสอบใช้งานจริงผ่านแล้ว`,
    });
  }
}

/** รอบตามตาราง: journey ที่ถึงเวลา ทีละไม่กี่เว็บ */
export async function runJourneys(ctx: WorkerContext): Promise<void> {
  const { insights } = await ctx.settings();
  if (!insights.journeysEnabled) {
    await ctx.db.execute(sql`
      UPDATE security_alerts SET acknowledged_at = now() WHERE type = 'JOURNEY_FAILED' AND acknowledged_at IS NULL
    `);
    return;
  }
  const due = await ctx.db.execute<DueJourney>(sql`
    SELECT j.website_id, w.name, w.url, j.steps
    FROM journeys j
    JOIN websites w ON w.id = j.website_id
    LEFT JOIN LATERAL (
      SELECT started_at FROM journey_runs r WHERE r.website_id = j.website_id ORDER BY started_at DESC LIMIT 1
    ) last ON true
    WHERE j.enabled AND w.enabled AND w.archived_at IS NULL
      AND (last.started_at IS NULL OR last.started_at < now() - make_interval(mins => j.interval_minutes))
    ORDER BY last.started_at NULLS FIRST
    LIMIT ${BATCH}
  `);
  if (due.rows.length === 0) return;
  const todo = due.rows.filter((j) => !running.has(Number(j.website_id)));
  if (todo.length === 0) return;
  todo.forEach((j) => running.add(Number(j.website_id)));
  try {
    await withBrowser(
      ctx,
      async (browser, cancelled) => {
        for (const j of todo) {
          if (cancelled()) return;
          const r = await executeJourney(browser, j.steps, undefined, optionsFor(j));
          // เกินเส้นตายรวม = browser ถูกปิด ผลนี้คือ "browser closed" ไม่ใช่เว็บเสีย — ไม่บันทึก/ไม่แจ้งเตือน
          if (cancelled()) return;
          await recordRun(ctx, j, r);
          ctx.log.info("journey", { websiteId: Number(j.website_id), ok: r.ok, ms: r.durationMs });
        }
      },
      // เส้นตายรวม = ผลรวมของแต่ละ journey + เผื่อเปิด browser
      todo.reduce((s, j) => s + j.steps.length * 20_000 + 60_000, 30_000),
    );
  } finally {
    todo.forEach((j) => running.delete(Number(j.website_id)));
  }
}

/** สั่งจากหน้าเว็บ (ปุ่ม "ทดสอบตอนนี้") */
export async function runJourneyNow(ctx: WorkerContext, websiteId: number): Promise<string> {
  const [j] = (
    await ctx.db.execute<DueJourney>(sql`
      SELECT j.website_id, w.name, w.url, j.steps FROM journeys j JOIN websites w ON w.id = j.website_id
      WHERE j.website_id = ${websiteId} AND w.archived_at IS NULL
    `)
  ).rows;
  if (!j) throw new Error("เว็บนี้ยังไม่ได้ตั้งค่าการทดสอบใช้งานจริง");
  if (running.has(websiteId)) throw new Error("กำลังทดสอบเว็บนี้อยู่แล้ว — รอผลรอบนี้สักครู่");
  running.add(websiteId);
  let r: JourneyResult | null;
  try {
    r = await withBrowser(
      ctx,
      (browser) => executeJourney(browser, j.steps, undefined, optionsFor(j)),
      j.steps.length * 20_000 + 90_000,
    );
    if (r) await recordRun(ctx, j, r);
  } finally {
    running.delete(websiteId);
  }
  if (r === null)
    throw new Error(
      "เปิด Chromium บนเครื่อง Worker ไม่ได้ — ดูรายละเอียดที่หน้าความปลอดภัย (ตั้ง CHROMIUM_PATH)",
    );
  return r.ok ? `ผ่านทุกขั้นตอน (${(r.durationMs / 1000).toFixed(1)} วินาที)` : `ไม่ผ่าน — ${r.error}`;
}
