import { formatDateTime, formatDuration } from "../format";
import type { MailMessage } from "./mailer";

export interface IncidentEmailData {
  incidentId: number;
  websiteName: string;
  url: string;
  cause: string;
  startedAt: Date;
  confirmedAt: Date;
  recoveredAt?: Date | null;
  appBaseUrl: string;
  timeZone: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const baseUrl = (u: string) => u.replace(/\/$/, "");
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

// ---------- ชิ้นส่วนอีเมล ----------
// อีเมลต้องใช้ table + inline style เท่านั้น (Outlook/Gmail ตัด <style>, flex, grid ทิ้ง)

const FONT =
  "'IBM Plex Sans Thai','Sarabun','Noto Sans Thai','Leelawadee UI','Segoe UI',Tahoma,Arial,sans-serif";
const MONO = "'IBM Plex Mono',Consolas,'Courier New',monospace";
const INK = "#17151a";
const MUTED = "#75706a";
const LINE = "#ebe8e1";
const CANVAS = "#f4f2ed";
const BRAND = "#10b981";

interface Theme {
  /** สีหลักของเหตุการณ์ */
  accent: string;
  /** พื้นอ่อนของสีหลัก */
  soft: string;
  /** สีตัวหนังสือบนพื้นอ่อน */
  deep: string;
  /** สัญลักษณ์ในวงกลม */
  icon: string;
  /** ป้ายสถานะ เช่น "ล่ม" */
  badge: string;
}

const THEME = {
  down: { accent: "#dc2626", soft: "#fdecec", deep: "#991b1b", icon: "!", badge: "ล่ม · DOWN" },
  up: {
    accent: "#16a34a",
    soft: "#e8f7ee",
    deep: "#166534",
    icon: "&#10003;",
    badge: "กลับมาแล้ว · RECOVERED",
  },
  test: { accent: BRAND, soft: "#e7f8f0", deep: "#047857", icon: "&#10003;", badge: "ทดสอบ · TEST" },
  high: { accent: "#dc2626", soft: "#fdecec", deep: "#991b1b", icon: "!", badge: "ความเสี่ยงสูง" },
  medium: { accent: "#d97706", soft: "#fdf3e3", deep: "#92400e", icon: "!", badge: "ควรตรวจสอบ" },
  low: { accent: "#2563eb", soft: "#edf1ff", deep: "#1e40af", icon: "i", badge: "แจ้งให้ทราบ" },
} satisfies Record<string, Theme>;

interface Fact {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
}

interface Stat {
  label: string;
  value: string;
}

interface LayoutInput {
  /** ข้อความตัวอย่างที่แสดงในรายการกล่องจดหมาย (ไม่แสดงในตัวเมล) */
  preheader: string;
  theme: Theme;
  title: string;
  /** ท้ายหัวเรื่องที่ห้ามตัดบรรทัดกลางคำ เช่น "ใช้งานไม่ได้" */
  titleSuffix?: string;
  subtitle?: string;
  stats?: Stat[];
  facts: Fact[];
  /** กล่องข้อความเน้น (เช่น "อีเมลนี้ส่งช้า เว็บกลับมาแล้ว") */
  notice?: { text: string; theme: Theme };
  cta: { href: string; label: string };
  footer: string;
  appBaseUrl: string;
}

function factRows(facts: Fact[]): string {
  return facts
    .map((f, i) => {
      const border = i === facts.length - 1 ? "" : `border-bottom:1px solid ${LINE};`;
      const value = f.href
        ? `<a href="${esc(f.href)}" style="color:#1d4ed8;text-decoration:none;word-break:break-all">${esc(f.value)}</a>`
        : esc(f.value);
      return `<tr>
<td valign="top" style="${border}padding:11px 16px 11px 0;width:30%;min-width:96px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};white-space:nowrap">${esc(f.label)}</td>
<td valign="top" style="${border}padding:11px 0;font-family:${f.mono ? MONO : FONT};font-size:14px;line-height:20px;color:${INK};font-weight:500;word-break:break-word">${value}</td>
</tr>`;
    })
    .join("");
}

function statCells(stats: Stat[], t: Theme): string {
  const w = Math.floor(100 / stats.length);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 24px">
<tr>${stats
    .map(
      (s, i) => `<td width="${w}%" valign="top" style="${i ? "padding-left:10px;" : ""}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.soft};border-radius:12px">
<tr><td style="padding:14px 16px">
<div style="font-family:${FONT};font-size:12px;line-height:18px;color:${t.deep};opacity:.85">${esc(s.label)}</div>
<div style="font-family:${FONT};font-size:20px;line-height:28px;font-weight:700;color:${t.deep};margin-top:2px">${esc(s.value)}</div>
</td></tr></table></td>`,
    )
    .join("")}</tr></table>`;
}

function layout(d: LayoutInput): string {
  const t = d.theme;
  const notice = d.notice
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
<tr><td style="background:${d.notice.theme.soft};border-left:4px solid ${d.notice.theme.accent};border-radius:8px;padding:12px 16px;font-family:${FONT};font-size:14px;line-height:22px;color:${d.notice.theme.deep}">${esc(d.notice.text)}</td></tr></table>`
    : "";
  return `<!doctype html>
<html lang="th" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(d.title)}${d.titleSuffix ? ` ${esc(d.titleSuffix)}` : ""}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(d.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS}">
<tr><td align="center" style="padding:28px 12px 36px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">

<!-- แบรนด์ -->
<tr><td style="padding:0 4px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="width:28px;height:28px;background:${BRAND};border-radius:8px;text-align:center;vertical-align:middle;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff">S</td>
<td style="padding-left:10px;font-family:${FONT};font-size:14px;font-weight:700;color:${INK};letter-spacing:.2px">SYNTECH <span style="font-weight:500;color:${MUTED}">Web Monitor</span></td>
</tr></table>
</td></tr>

<!-- การ์ด -->
<tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="height:6px;background:${t.accent};line-height:6px;font-size:0;border-radius:16px 16px 0 0">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 8px">

<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr>
<td style="width:44px;height:44px;border-radius:22px;background:${t.soft};text-align:center;vertical-align:middle;font-family:${FONT};font-size:22px;font-weight:700;color:${t.accent}">${t.icon}</td>
<td style="padding-left:12px;vertical-align:middle">
<span style="display:inline-block;background:${t.soft};color:${t.deep};font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.3px;padding:4px 10px;border-radius:999px">${esc(t.badge)}</span>
</td></tr></table>

<h1 style="margin:0 0 6px;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;color:${INK}">${esc(d.title)}${d.titleSuffix ? ` <span style="white-space:nowrap">${esc(d.titleSuffix)}</span>` : ""}</h1>
${d.subtitle ? `<p style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:24px;color:${MUTED}">${esc(d.subtitle)}</p>` : `<div style="height:18px;line-height:18px;font-size:0">&nbsp;</div>`}

${notice}
${d.stats?.length ? statCells(d.stats, t) : ""}

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${LINE}">
${factRows(d.facts)}
</table>

<!-- ปุ่ม -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 28px"><tr>
<td style="background:${INK};border-radius:10px">
<a href="${esc(d.cta.href)}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${esc(d.cta.label)} &rarr;</a>
</td></tr></table>

</td></tr>
</table>
</td></tr>

<!-- ท้ายเมล -->
<tr><td style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:19px;color:#a8a29b;text-align:center">
${esc(d.footer)}<br>
ส่งอัตโนมัติจาก SYNTECH Web Monitor · <a href="${esc(baseUrl(d.appBaseUrl))}" style="color:#a8a29b">${esc(hostOf(d.appBaseUrl))}</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

const plain = (title: string, facts: Fact[], link: string, extra: string[] = []) =>
  [title, "", ...extra, ...facts.map((f) => `${f.label}: ${f.value}`), "", `รายละเอียด: ${link}`].join("\n");

// ---------- อีเมลแต่ละแบบ ----------

export function buildDownEmail(d: IncidentEmailData): MailMessage & { to: "" } {
  const link = `${baseUrl(d.appBaseUrl)}/incidents/${d.incidentId}`;
  const facts: Fact[] = [
    { label: "URL", value: d.url, href: d.url },
    { label: "เริ่มล้มเหลว", value: formatDateTime(d.startedAt, d.timeZone) },
    { label: "ยืนยันว่าล่ม", value: formatDateTime(d.confirmedAt, d.timeZone) },
    { label: "Incident", value: `#${d.incidentId}`, mono: true },
  ];
  // ส่งช้า (SMTP ขัดข้อง) จนเว็บกลับมาแล้ว → บอกตรง ๆ ไม่ให้ผู้รับรีบไปแก้ทั้งที่ปกติแล้ว
  const late = d.recoveredAt
    ? `อีเมลนี้ส่งช้า — เว็บกลับมาใช้งานได้แล้วเมื่อ ${formatDateTime(d.recoveredAt, d.timeZone)}`
    : null;
  const subject = `🔴 [DOWN] ${d.websiteName} — ${d.cause}${d.recoveredAt ? " (กลับมาแล้ว)" : ""}`;
  return {
    to: "",
    subject,
    text: plain(`${d.websiteName} ใช้งานไม่ได้ (Incident #${d.incidentId})`, facts, link, [
      `สาเหตุ: ${d.cause}`,
      ...(late ? [late] : []),
      "",
    ]),
    html: layout({
      preheader: `${d.websiteName} ใช้งานไม่ได้ — ${d.cause}`,
      theme: THEME.down,
      title: d.websiteName,
      titleSuffix: "ใช้งานไม่ได้",
      subtitle: d.cause,
      notice: late ? { text: late, theme: THEME.up } : undefined,
      facts,
      cta: { href: link, label: `เปิด Incident #${d.incidentId}` },
      footer: "อีเมลนี้ส่งครั้งเดียวต่อ Incident — เมื่อเว็บกลับมา ระบบจะแจ้งอีกครั้ง",
      appBaseUrl: d.appBaseUrl,
    }),
  };
}

export function buildRecoveryEmail(d: IncidentEmailData): MailMessage & { to: "" } {
  const link = `${baseUrl(d.appBaseUrl)}/incidents/${d.incidentId}`;
  const recovered = d.recoveredAt ?? new Date();
  const duration = formatDuration(recovered.getTime() - d.startedAt.getTime());
  const facts: Fact[] = [
    { label: "URL", value: d.url, href: d.url },
    { label: "สาเหตุเดิม", value: d.cause },
    { label: "เริ่มล้มเหลว", value: formatDateTime(d.startedAt, d.timeZone) },
    { label: "Incident", value: `#${d.incidentId}`, mono: true },
  ];
  return {
    to: "",
    subject: `✅ [RECOVERY] ${d.websiteName} กลับมาใช้งานได้ (ล่ม ${duration})`,
    text: plain(`${d.websiteName} กลับมาใช้งานได้แล้ว (Incident #${d.incidentId})`, facts, link, [
      `ล่มรวม: ${duration}`,
      `กลับมาเมื่อ: ${formatDateTime(recovered, d.timeZone)}`,
      "",
    ]),
    html: layout({
      preheader: `${d.websiteName} กลับมาใช้งานได้แล้ว — ล่มรวม ${duration}`,
      theme: THEME.up,
      title: d.websiteName,
      titleSuffix: "กลับมาใช้งานได้แล้ว",
      subtitle: "ระบบตรวจซ้ำแล้วว่าตอบสนองปกติต่อเนื่อง",
      stats: [
        { label: "ล่มรวม", value: duration },
        { label: "กลับมาเมื่อ", value: formatDateTime(recovered, d.timeZone) },
      ],
      facts,
      cta: { href: link, label: "ดูสรุปเหตุการณ์" },
      footer: "เหตุการณ์นี้ปิดแล้ว — ไม่ต้องดำเนินการเพิ่ม",
      appBaseUrl: d.appBaseUrl,
    }),
  };
}

export function buildTestEmail(appBaseUrl: string): MailMessage & { to: "" } {
  const facts: Fact[] = [
    { label: "สถานะ", value: "ส่งอีเมลได้ — ตั้งค่า SMTP ถูกต้อง" },
    { label: "ระบบ", value: baseUrl(appBaseUrl), href: baseUrl(appBaseUrl) },
    { label: "ที่จะได้รับ", value: "แจ้งเตือนเว็บล่ม · เว็บกลับมา · ความปลอดภัย" },
  ];
  return {
    to: "",
    subject: "[WebMonitor] อีเมลทดสอบ — ตั้งค่าเรียบร้อย",
    text: `นี่คืออีเมลทดสอบจาก SYNTECH Web Monitor (${appBaseUrl}) — ถ้าได้รับแปลว่าตั้งค่า SMTP ถูกต้อง`,
    html: layout({
      preheader: "ตั้งค่าอีเมลเรียบร้อย — ระบบพร้อมส่งแจ้งเตือนแล้ว",
      theme: THEME.test,
      title: "ตั้งค่าอีเมลเรียบร้อย",
      subtitle: "ถ้าคุณเห็นอีเมลนี้ แปลว่าระบบพร้อมส่งแจ้งเตือนถึงคุณแล้ว",
      facts,
      cta: { href: baseUrl(appBaseUrl), label: "เปิด Web Monitor" },
      footer: "อีเมลทดสอบจากหน้าตั้งค่า — ส่งเฉพาะเมื่อมีผู้ดูแลกดทดสอบ",
      appBaseUrl,
    }),
  };
}

export interface SecurityAlertEmailData {
  alertId: number;
  type: string;
  severity: string;
  title: string;
  websiteName: string | null;
  url: string | null;
  createdAt: Date;
  details: Array<[string, string]>;
  appBaseUrl: string;
  timeZone: string;
  websiteId?: number | null;
}

const ALERT_TYPE_LABEL: Record<string, string> = {
  VISUAL_CHANGE: "หน้าเว็บเปลี่ยนไปจากต้นแบบ",
  DEFACE_KEYWORD: "พบคำต้องสงสัยในหน้าเว็บ",
  LOOKALIKE_DOMAIN: "พบโดเมนเลียนแบบ",
  SECURITY_FINDING: "พบปัญหาความปลอดภัย",
  SITE_CHANGE: "การตั้งค่าสำคัญของเว็บเปลี่ยน",
  ANOMALY_SLOW: "เว็บช้าผิดปกติ (เตือนล่วงหน้า)",
  ANOMALY_UNSTABLE: "เว็บเริ่มไม่เสถียร (เตือนล่วงหน้า)",
  JOURNEY_FAILED: "ทดสอบใช้งานจริงไม่ผ่าน",
};

/** แจ้งเตือนเชิงการทำงาน (ไม่ใช่ความปลอดภัย) — ลิงก์ไปหน้าเว็บไซต์นั้นแทนหน้าความปลอดภัย */
export const OPERATIONAL_ALERT_TYPES = ["ANOMALY_SLOW", "ANOMALY_UNSTABLE", "JOURNEY_FAILED"] as const;

export function buildSecurityAlertEmail(d: SecurityAlertEmailData): MailMessage & { to: "" } {
  const base = baseUrl(d.appBaseUrl);
  const operational = (OPERATIONAL_ALERT_TYPES as readonly string[]).includes(d.type);
  const link = d.websiteId && operational ? `${base}/websites/${d.websiteId}` : `${base}/security`;
  const theme = d.severity === "high" ? THEME.high : d.severity === "medium" ? THEME.medium : THEME.low;
  const typeLabel = ALERT_TYPE_LABEL[d.type] ?? d.type;
  const facts: Fact[] = [
    ...(d.websiteName ? [{ label: "เว็บไซต์", value: d.websiteName }] : []),
    ...(d.url ? [{ label: "URL", value: d.url, href: d.url }] : []),
    { label: "พบเมื่อ", value: formatDateTime(d.createdAt, d.timeZone) },
    ...d.details.map(([label, value]) => ({ label, value })),
  ];
  const tag = operational ? "[ALERT]" : "[SECURITY]";
  const icon = d.severity === "high" ? "🔴" : "⚠️";
  return {
    to: "",
    subject: `${icon} ${tag} ${d.title}`,
    text: plain(d.title, facts, link, [`ประเภท: ${typeLabel}`, ""]),
    html: layout({
      preheader: `${typeLabel}${d.websiteName ? ` — ${d.websiteName}` : ""}`,
      theme,
      title: d.title,
      subtitle: typeLabel,
      facts,
      cta: { href: link, label: operational ? "เปิดหน้าเว็บไซต์" : "เปิดหน้าความปลอดภัย" },
      footer: operational
        ? "แจ้งเตือนล่วงหน้า ส่งครั้งเดียวต่อเหตุการณ์"
        : "แจ้งเตือนด้านความปลอดภัย ส่งครั้งเดียวต่อเหตุการณ์ — ถ้าเป็นการเปลี่ยนแปลงที่ตั้งใจ กดยอมรับได้ในหน้าความปลอดภัย",
      appBaseUrl: d.appBaseUrl,
    }),
  };
}
