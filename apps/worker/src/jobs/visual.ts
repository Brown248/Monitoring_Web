// โค้ดใน page.evaluate() รันใน browser → ต้องใช้ type ของ DOM
/// <reference lib="dom" />
import { existsSync } from "node:fs";
import { startGuardedProxy, USER_AGENT } from "@app/core/server";
import { and, eq, logEvent, securityAlerts, setState, sql, visualSnapshots } from "@app/db";
import type { Browser, BrowserContext } from "playwright-core";
import type { WorkerContext } from "../context";

const VIEWPORT = { width: 1366, height: 900 };

/**
 * tsx/esbuild (keepNames — ตอนรัน `pnpm dev:worker`) แทรก __name(...) ในฟังก์ชันที่ส่งเข้า page.evaluate
 * แต่ใน browser ไม่มี __name → ReferenceError · เป็น string จึงไม่ถูกแปลงซ้ำ
 */
export const EVAL_SHIM = "globalThis.__name ??= (fn) => fn;";

/** ใส่ shim ให้ทุกหน้าใน context (รวมหน้าที่เปิดภายหลังและหลังเปลี่ยนหน้า) */
export async function prepareContext(context: BrowserContext): Promise<BrowserContext> {
  await context.addInitScript({ content: EVAL_SHIM });
  return context;
}

/**
 * คำสั่งบางตัวของ Playwright (page.title, page.evaluate) ไม่มี timeout — ถ้าหน้าเว็บมี JavaScript วนไม่จบ
 * จะรอตลอดไป → ให้ค่า fallback เมื่อเกินเวลา
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms))),
  ]).finally(() => clearTimeout(timer));
}

/** เกินเวลา → เรียก onTimeout (เช่น ปิด browser ทิ้ง) แล้ว reject — งานที่ค้างจะไม่ทำให้ Worker หยุดทั้งลูป */
export function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => unknown,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void Promise.resolve()
          .then(onTimeout)
          .catch(() => {});
        reject(new Error(message));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
const BATCH = 2;

/** หา Chromium/Chrome/Edge ที่มีในเครื่อง (Docker ติดตั้ง /usr/bin/chromium ให้) */
export function findChromium(envPath: string | undefined): string | null {
  const candidates = [
    envPath,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p): p is string => Boolean(p) && existsSync(p!)) ?? null;
}

interface Capture {
  png: Buffer;
  title: string;
  /** ข้อความที่มองเห็น + HTML ทั้งหน้า (lowercase) สำหรับหาคำต้องห้าม — รวมลิงก์ที่ถูกซ่อนไว้ */
  haystack: string;
  blocked: string[];
}

/**
 * เปิดหน้าเว็บด้วย headless browser — ทุกคำขอบังคับผ่าน guarded proxy (บล็อก IP ภายใน)
 * ปิด service worker / download / WebRTC และหยุด animation ก่อนถ่ายภาพ
 */
export async function capture(browser: Browser, url: string): Promise<Capture> {
  const context = await prepareContext(
    await browser.newContext({
      viewport: VIEWPORT,
      // UA แบบ Chrome ปกติ + ระบุตัวตนท้ายสตริง — UA ของ headless มักโดนระบบกันบอทขวางทันที
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split(".")[0]}.0.0.0 Safari/537.36 ${USER_AGENT.split(" ")[0]} (visual-check)`,
      serviceWorkers: "block",
      acceptDownloads: false,
      locale: "th-TH",
      timezoneId: "Asia/Bangkok",
    }),
  );
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const response = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    // หน้า error/ปิดปรับปรุง (4xx/5xx) ไม่ใช่หน้าเว็บจริง — ห้ามเป็นภาพต้นแบบหรือถูกเทียบ
    const status = response?.status() ?? 0;
    if (status >= 400)
      throw new Error(
        `HTTP_ERROR: หน้าเว็บตอบ HTTP ${status} — ไม่ถ่ายภาพ/ไม่เทียบกับต้นแบบจนกว่าเว็บจะกลับมาปกติ`,
      );
    await page.waitForTimeout(2_500);
    // หน้ากันบอท (Cloudflare/SiteGround ฯลฯ) มักผ่านเองในไม่กี่วินาที → รอสูงสุด ~12 วินาที
    for (let i = 0; i < 8 && (await isChallenge(page)); i++) await page.waitForTimeout(1_500);
    if (await isChallenge(page)) {
      throw new Error(
        "BOT_CHALLENGE: เว็บมีระบบกันบอท (bot protection) ขวางการถ่ายภาพ — อนุญาต IP ของ Worker ในระบบกันบอทถ้าต้องการใช้ฟีเจอร์นี้",
      );
    }
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
    });
    await page.waitForTimeout(300);
    const png = await page.screenshot({ type: "png", fullPage: false });
    const title = (await withTimeout(page.title(), 5_000, "")).slice(0, 300);
    const haystack = await withTimeout(
      page.evaluate(() => {
        const visible = document.body?.innerText ?? "";
        const html = document.documentElement.outerHTML.slice(0, 2_000_000);
        return `${visible}\n${html}`.toLowerCase();
      }),
      10_000,
      "",
    );
    return { png, title, haystack, blocked: [] };
  } finally {
    await withTimeout(context.close(), 10_000, undefined);
  }
}

/**
 * หน้าคั่นของระบบกันบอท/ตรวจสอบผู้ใช้ — ไม่ใช่หน้าเว็บจริง ห้ามใช้เป็นภาพต้นแบบ
 * title: ต้อง "ขึ้นต้น" ด้วยวลีของหน้าคั่นและสั้น (เว็บปกติชื่อ "Website Security Check Tool" ไม่นับ)
 */
const CHALLENGE_TITLE =
  /^\s*(just a moment|one moment,? please|attention required|checking your browser|security check|are you a robot|human verification|verify(ing)? you are (a )?human|ddos-guard|please wait\b)/i;
/** เนื้อหา: ใช้เฉพาะหน้าที่ข้อความสั้นมาก (หน้าคั่น) และวลีที่เจาะจงกับหน้าคั่น */
const CHALLENGE_TEXT =
  /checking your browser|please wait while your request is being verified|verify(ing)? you are (a )?human|ddos protection by|are you a robot|complete the security check|enable javascript and cookies to continue|press (and|&) hold/i;

export function isChallengeTitle(title: string): boolean {
  return title.length <= 80 && CHALLENGE_TITLE.test(title);
}

export function isChallengeContent(title: string, text: string): boolean {
  return isChallengeTitle(title) || (text.trim().length < 600 && CHALLENGE_TEXT.test(text));
}

async function isChallenge(page: import("playwright-core").Page): Promise<boolean> {
  const title = await withTimeout(page.title(), 5_000, "");
  const text = await withTimeout(
    page.evaluate(() => (document.body?.innerText ?? "").slice(0, 2_000)),
    5_000,
    "",
  );
  return isChallengeContent(title, text);
}

/** เทียบภาพใน browser เอง (canvas) — ได้สัดส่วนพิกเซลที่ต่าง + ภาพไฮไลต์สีแดง โดยไม่ต้องพึ่ง library รูปภาพ */
export async function diffImages(
  browser: Browser,
  baseline: Buffer,
  latest: Buffer,
): Promise<{ ratio: number; png: Buffer }> {
  const context = await prepareContext(await browser.newContext({ viewport: VIEWPORT }));
  try {
    const page = await context.newPage();
    // หน้า about:blank แรกเปิดก่อน init script → ใส่ shim เองอีกครั้ง
    await page.evaluate(EVAL_SHIM);
    const result = await page.evaluate(
      async ({ a, b, w, h }) => {
        const load = (src: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("decode failed"));
            img.src = src;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const read = (img: HTMLImageElement) => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const g = c.getContext("2d")!;
          g.drawImage(img, 0, 0, w, h);
          return g.getImageData(0, 0, w, h);
        };
        const da = read(ia);
        const db = read(ib);
        const out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        const g = out.getContext("2d")!;
        const od = g.createImageData(w, h);
        let changed = 0;
        for (let i = 0; i < da.data.length; i += 4) {
          const d =
            Math.abs(da.data[i]! - db.data[i]!) +
            Math.abs(da.data[i + 1]! - db.data[i + 1]!) +
            Math.abs(da.data[i + 2]! - db.data[i + 2]!);
          // ภาพล่าสุดแบบจาง + ส่วนที่เปลี่ยนเป็นสีแดง
          const gray = (db.data[i]! + db.data[i + 1]! + db.data[i + 2]!) / 3;
          if (d > 60) {
            changed++;
            od.data[i] = 230;
            od.data[i + 1] = 40;
            od.data[i + 2] = 40;
          } else {
            od.data[i] = od.data[i + 1] = od.data[i + 2] = 200 + gray * 0.2;
          }
          od.data[i + 3] = 255;
        }
        g.putImageData(od, 0, 0);
        return { ratio: changed / (w * h), dataUrl: out.toDataURL("image/png") };
      },
      {
        a: `data:image/png;base64,${baseline.toString("base64")}`,
        b: `data:image/png;base64,${latest.toString("base64")}`,
        w: VIEWPORT.width,
        h: VIEWPORT.height,
      },
    );
    return { ratio: result.ratio, png: Buffer.from(result.dataUrl.split(",")[1]!, "base64") };
  } finally {
    await context.close();
  }
}

export function findKeywords(haystack: string, keywords: string[]): string[] {
  return keywords.filter((k) => haystack.includes(k.toLowerCase()));
}

async function upsertSnapshot(
  ctx: WorkerContext,
  websiteId: number,
  kind: "baseline" | "latest" | "diff",
  values: Partial<typeof visualSnapshots.$inferInsert>,
) {
  const row = { websiteId, kind, capturedAt: new Date(), ...values };
  await ctx.db
    .insert(visualSnapshots)
    .values(row)
    .onConflictDoUpdate({ target: [visualSnapshots.websiteId, visualSnapshots.kind], set: row });
}

/** แจ้งซ้ำเรื่องเดิมได้อีกครั้งหลังรับทราบไปแล้วกี่ชั่วโมง (เปลี่ยนแล้วไม่กด "ยอมรับต้นแบบ" = เตือนวันละครั้ง ไม่ใช่ทุกรอบ) */
const REALERT_AFTER_ACK_HOURS = 24;

/**
 * สร้าง alert ถ้ายังไม่มีเรื่องเดียวกันที่เปิดค้าง หรือเพิ่งรับทราบภายใน 24 ชม.
 * ตรวจ+สร้างในทรานแซกชันเดียวภายใต้ advisory lock — ถ่ายภาพตามรอบกับปุ่ม "ถ่ายภาพตอนนี้" ชนกันก็ไม่ได้ alert ซ้ำ
 */
export async function raiseAlertOnce(
  ctx: WorkerContext,
  alert: typeof securityAlerts.$inferInsert & { websiteId: number },
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`alert:${alert.websiteId}:${alert.type}`}))`,
    );
    const dup = await tx.execute(sql`
      SELECT 1 FROM security_alerts
      WHERE website_id = ${alert.websiteId} AND type = ${alert.type}
        AND (acknowledged_at IS NULL
             OR acknowledged_at > now() - make_interval(hours => ${REALERT_AFTER_ACK_HOURS}))
      LIMIT 1
    `);
    if (dup.rows.length > 0) return false;
    await tx.insert(securityAlerts).values(alert);
    return true;
  });
}

/** ตรวจหน้าเว็บหนึ่งเว็บ: ถ่ายภาพ → เทียบต้นแบบ → หาคำต้องห้าม → สร้าง alert ถ้าผิดปกติ */
async function checkWebsite(
  ctx: WorkerContext,
  browser: Browser,
  site: { id: number; name: string; url: string },
  cancelled: () => boolean = () => false,
): Promise<string> {
  const { security } = await ctx.settings();
  let shot: Capture;
  try {
    shot = await capture(browser, site.url);
  } catch (err) {
    if (cancelled()) return "ยกเลิก (เกินเวลา)";
    const message = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 300) : String(err);
    if (message.startsWith("BOT_CHALLENGE") || message.startsWith("HTTP_ERROR")) {
      // ภาพล่าสุด/ภาพเทียบเดิมไม่ตรงกับตอนนี้แล้ว → ล้าง เหลือข้อความอธิบาย
      // แต่ "ไม่ลบภาพต้นแบบ" — เจอหน้ากันบอทครั้งเดียวไม่ควรทำให้ต้นแบบที่ยอมรับไว้หายไป
      await ctx.db
        .delete(visualSnapshots)
        .where(and(eq(visualSnapshots.websiteId, site.id), sql`${visualSnapshots.kind} <> 'baseline'`));
      await upsertSnapshot(ctx, site.id, "latest", {
        image: null,
        diffRatio: null,
        error: message.replace(/^(BOT_CHALLENGE|HTTP_ERROR): /, ""),
      });
    } else {
      await upsertSnapshot(ctx, site.id, "latest", { error: message });
    }
    return `ถ่ายภาพไม่สำเร็จ: ${message}`;
  }
  if (cancelled()) return "ยกเลิก (เกินเวลา)";
  const keywords = findKeywords(shot.haystack, security.defaceKeywords);
  const [baseline] = await ctx.db
    .select()
    .from(visualSnapshots)
    .where(and(eq(visualSnapshots.websiteId, site.id), eq(visualSnapshots.kind, "baseline")));

  // ไม่มีต้นแบบ หรือต้นแบบเดิมเป็นหน้ากันบอท (บันทึกไว้ก่อนมีการตรวจนี้) → ใช้ภาพนี้เป็นต้นแบบใหม่
  if (!baseline?.image || isChallengeTitle(baseline.pageTitle ?? "")) {
    // ครั้งแรก = ต้นแบบ (คำที่มีอยู่แล้วในต้นแบบจะไม่ถูกนับว่าผิดปกติภายหลัง)
    await upsertSnapshot(ctx, site.id, "baseline", {
      image: shot.png,
      keywords,
      pageTitle: shot.title,
      error: null,
    });
    await upsertSnapshot(ctx, site.id, "latest", {
      image: shot.png,
      keywords,
      pageTitle: shot.title,
      diffRatio: 0,
      error: null,
    });
    return "บันทึกภาพต้นแบบแล้ว";
  }

  const { ratio, png } = await diffImages(browser, baseline.image, shot.png);
  if (cancelled()) return "ยกเลิก (เกินเวลา)";
  await upsertSnapshot(ctx, site.id, "latest", {
    image: shot.png,
    keywords,
    pageTitle: shot.title,
    diffRatio: ratio,
    error: null,
  });
  await upsertSnapshot(ctx, site.id, "diff", { image: png, diffRatio: ratio });

  const known = new Set(baseline.keywords ?? []);
  const newKeywords = keywords.filter((k) => !known.has(k));
  const pct = Math.round(ratio * 1000) / 10;
  if (
    newKeywords.length > 0 &&
    (await raiseAlertOnce(ctx, {
      websiteId: site.id,
      type: "DEFACE_KEYWORD",
      severity: "high",
      title: `พบคำต้องสงสัยในหน้าเว็บ ${site.name}: ${newKeywords.slice(0, 3).join(", ")}`,
      detail: { keywords: newKeywords, diffPct: pct, pageTitle: shot.title, url: site.url },
    }))
  ) {
    await logEvent(ctx.db, {
      type: "DEFACE_KEYWORD",
      level: "ERROR",
      websiteId: site.id,
      message: `หน้าเว็บ ${site.name} มีคำต้องสงสัย (อาจถูกแฮกฝังลิงก์)`,
      detail: newKeywords.join(", "),
    });
  }
  if (
    pct >= security.visualThresholdPct &&
    (await raiseAlertOnce(ctx, {
      websiteId: site.id,
      type: "VISUAL_CHANGE",
      severity: pct >= 60 ? "high" : "medium",
      title: `หน้าเว็บ ${site.name} เปลี่ยนไป ${pct}% จากภาพต้นแบบ`,
      detail: {
        diffPct: pct,
        thresholdPct: security.visualThresholdPct,
        pageTitle: shot.title,
        url: site.url,
      },
    }))
  ) {
    await logEvent(ctx.db, {
      type: "VISUAL_CHANGE",
      level: "WARN",
      websiteId: site.id,
      message: `หน้าเว็บ ${site.name} เปลี่ยนไป ${pct}% จากภาพต้นแบบ`,
    });
  }
  return `เทียบภาพแล้ว · ต่างจากต้นแบบ ${pct}%${keywords.length ? ` · พบคำ ${keywords.join(", ")}` : ""}`;
}

let warnedMissing = false;
/** เปิด browser ไม่ขึ้น (เช่น chromium แบบ snap บน Ubuntu / library ไม่ครบ) → พัก 15 นาทีก่อนลองใหม่ */
let launchFailedAt = 0;
const LAUNCH_RETRY_MS = 15 * 60_000;

export async function withBrowser<T>(
  ctx: WorkerContext,
  /**
   * cancelled() = เกินเส้นตายแล้ว (browser ถูกปิด) — งานที่ยังวิ่งอยู่ต้องหยุดและ "ไม่เขียนผล" ลงฐานข้อมูล
   * (ไม่งั้นบันทึก error "browser closed" ทับผลจริง และแจ้งเตือนว่าล้มเหลวหลอก ๆ)
   */
  fn: (browser: Browser, cancelled: () => boolean) => Promise<T>,
  /** เส้นตายของทั้งรอบ — เกินแล้วปิด browser ทิ้ง (คำสั่งที่ค้างจะ error ออกมาเอง) */
  deadlineMs = 300_000,
): Promise<T | null> {
  const executablePath = findChromium(ctx.env.CHROMIUM_PATH);
  if (!executablePath) {
    if (!warnedMissing) {
      ctx.log.warn("visual check skipped: no Chromium/Chrome/Edge found (set CHROMIUM_PATH)");
      warnedMissing = true;
    }
    await setState(ctx.db, "visual", { available: false, checkedAt: new Date().toISOString() });
    return null;
  }
  if (Date.now() - launchFailedAt < LAUNCH_RETRY_MS) return null;
  const proxy = await startGuardedProxy();
  const { chromium } = await import("playwright-core");
  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: [
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-first-run",
        "--dns-prefetch-disable",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-features=WebRtcHideLocalIpsWithMdns,MediaRouter",
      ],
    });
  } catch (err) {
    // เดิม: proxy ที่เปิดไว้ไม่ถูกปิด (รั่วทุกรอบ) และไม่มีอะไรบอกว่าการตรวจด้วยภาพ/Journey หยุดทำงาน
    await proxy.close().catch(() => undefined);
    launchFailedAt = Date.now();
    const message = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
    ctx.log.error("browser launch failed", { executablePath, error: message });
    await setState(ctx.db, "visual", {
      available: false,
      browser: executablePath,
      error: message,
      checkedAt: new Date().toISOString(),
    });
    return null;
  }
  launchFailedAt = 0;
  let timedOut = false;
  try {
    const result = await withDeadline(
      fn(browser, () => timedOut),
      deadlineMs,
      () => {
        timedOut = true;
        return browser.close();
      },
      `browser ทำงานเกิน ${Math.round(deadlineMs / 60_000)} นาที — หน้าเว็บอาจค้าง จึงปิด browser`,
    );
    await setState(ctx.db, "visual", {
      available: true,
      browser: executablePath,
      checkedAt: new Date().toISOString(),
      blocked: proxy.blocked.slice(0, 10),
    });
    return result;
  } finally {
    // close เองก็อาจค้างได้ถ้า process ผิดปกติ → ไม่รอเกิน 15 วินาที
    await withTimeout(browser.close(), 15_000, undefined);
    await proxy.close();
  }
}

/** รอบตามตาราง: เว็บที่ UP และถึงเวลาถ่ายภาพใหม่ ทีละไม่กี่เว็บ */
export async function runVisualChecks(ctx: WorkerContext): Promise<void> {
  const { security } = await ctx.settings();
  if (!security.visualEnabled) return;
  const due = await ctx.db.execute<{ id: number; name: string; url: string }>(sql`
    SELECT w.id, w.name, w.url
    FROM websites w
    JOIN website_state s ON s.website_id = w.id
    LEFT JOIN visual_snapshots v ON v.website_id = w.id AND v.kind = 'latest'
    WHERE w.enabled AND w.archived_at IS NULL AND s.status = 'UP' AND s.last_checked_at IS NOT NULL
      AND (v.captured_at IS NULL OR v.captured_at < now() - make_interval(mins => ${security.visualIntervalMinutes}))
    ORDER BY v.captured_at NULLS FIRST, w.id
    LIMIT ${BATCH}
  `);
  if (due.rows.length === 0) return;
  await withBrowser(ctx, async (browser, cancelled) => {
    for (const site of due.rows) {
      if (cancelled()) return;
      const msg = await checkWebsite(ctx, browser, { ...site, id: Number(site.id) }, cancelled);
      ctx.log.info("visual check", { websiteId: Number(site.id), result: msg });
    }
  });
}

/** สั่งจากหน้าเว็บ (ปุ่ม "ถ่ายภาพตอนนี้") */
export async function runVisualCheckNow(ctx: WorkerContext, websiteId: number): Promise<string> {
  const [site] = (
    await ctx.db.execute<{ id: number; name: string; url: string; status: string | null }>(
      sql`SELECT w.id, w.name, w.url, s.status FROM websites w LEFT JOIN website_state s ON s.website_id = w.id
          WHERE w.id = ${websiteId} AND w.archived_at IS NULL`,
    )
  ).rows;
  if (!site) throw new Error("ไม่พบเว็บไซต์");
  // ถ่ายตอนเว็บล่ม = ได้หน้า error (ถ้ายังไม่มีต้นแบบจะกลายเป็นต้นแบบผิด ๆ)
  if (site.status === "DOWN") throw new Error("เว็บกำลังล่มอยู่ — ถ่ายภาพได้หลังเว็บกลับมาปกติ");
  const r = await withBrowser(ctx, (browser, cancelled) =>
    checkWebsite(ctx, browser, { ...site, id: Number(site.id) }, cancelled),
  );
  if (r === null)
    throw new Error(
      "เปิด Chromium บนเครื่อง Worker ไม่ได้ — ดูรายละเอียดที่หน้าความปลอดภัย (ตั้ง CHROMIUM_PATH)",
    );
  return r;
}
