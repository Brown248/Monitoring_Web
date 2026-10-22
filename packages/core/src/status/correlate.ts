export interface OutageInput {
  incidentId: number;
  websiteId: number;
  name: string;
  url: string;
  startedAt: Date;
  recoveredAt: Date | null;
  errorCode: string | null;
  /** IP ปลายทางล่าสุดที่เคยต่อได้ (จากผลตรวจก่อนล่ม) */
  remoteIp: string | null;
}

export type OutageGroupKind = "server" | "domain" | "dns" | "burst";

export interface OutageGroup {
  kind: OutageGroupKind;
  /** สิ่งที่เว็บในกลุ่มมีร่วมกัน เช่น IP หรือโดเมน */
  shared: string;
  title: string;
  hint: string;
  members: OutageInput[];
  startedAt: Date;
}

const WINDOW_MS = 10 * 60_000;

/** โดเมนหลักแบบคร่าว ๆ (รองรับ .co.th / .ac.th / .go.th / .or.th ฯลฯ) */
/**
 * โดเมนที่ให้ "คนละเจ้าของ" ใช้ subdomain ร่วมกัน (ส่วน private ของ Public Suffix List ที่พบบ่อย)
 * alice.github.io กับ bob.github.io เป็นคนละเว็บ — ต้องไม่ถือว่าเป็นโดเมนเดียวกัน
 */
const SHARED_SUFFIXES = [
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "azurestaticapps.net",
  "cloudfront.net",
  "appspot.com",
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "onrender.com",
  "fly.dev",
  "railway.app",
  "ngrok.io",
  "ngrok-free.app",
  "s3.amazonaws.com",
];

export function baseDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const suffix of SHARED_SUFFIXES) {
    if (host === suffix) return host;
    if (host.endsWith(`.${suffix}`)) {
      const label = host
        .slice(0, -suffix.length - 1)
        .split(".")
        .pop()!;
      return `${label}.${suffix}`;
    }
  }
  const parts = host.split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2]!;
  const twoLevel =
    parts[parts.length - 1]!.length === 2 &&
    ["co", "ac", "go", "or", "in", "net", "com", "org", "mi"].includes(sld);
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

function overlaps(a: OutageInput, b: OutageInput): boolean {
  return Math.abs(a.startedAt.getTime() - b.startedAt.getTime()) <= WINDOW_MS;
}

/** แบ่งกลุ่มจากลำดับเวลา: เว็บที่เริ่มล่มห่างกันไม่เกิน 10 นาทีอยู่กลุ่มเดียวกัน */
function clusters(list: OutageInput[]): OutageInput[][] {
  const sorted = [...list].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const out: OutageInput[][] = [];
  for (const o of sorted) {
    const last = out[out.length - 1];
    if (last && overlaps(last[last.length - 1]!, o)) last.push(o);
    else out.push([o]);
  }
  return out;
}

function uniqueSites(members: OutageInput[]): OutageInput[] {
  const seen = new Set<number>();
  return members.filter((m) => !seen.has(m.websiteId) && seen.add(m.websiteId));
}

/**
 * หาต้นเหตุร่วมของเว็บที่ล่มพร้อมกัน — เรียงความเฉพาะเจาะจง: เซิร์ฟเวอร์เดียวกัน > โดเมนเดียวกัน > DNS > ล่มพร้อมกันหลายเว็บ
 * เว็บหนึ่งอยู่ได้แค่กลุ่มเดียว (กลุ่มที่เฉพาะเจาะจงที่สุด)
 */
export function correlateOutages(
  outages: OutageInput[],
  opts: { canaryFailing?: boolean } = {},
): OutageGroup[] {
  const groups: OutageGroup[] = [];
  const claimed = new Set<number>();
  const take = (
    kind: OutageGroupKind,
    shared: string,
    members: OutageInput[],
    title: string,
    hint: string,
  ) => {
    const m = uniqueSites(members.filter((x) => !claimed.has(x.incidentId)));
    if (m.length < 2) return;
    for (const x of m) claimed.add(x.incidentId);
    groups.push({ kind, shared, title, hint, members: m, startedAt: m[0]!.startedAt });
  };

  const byKey = (key: (o: OutageInput) => string | null) => {
    const map = new Map<string, OutageInput[]>();
    for (const o of outages) {
      const k = key(o);
      if (!k) continue;
      map.set(k, [...(map.get(k) ?? []), o]);
    }
    return map;
  };

  for (const [ip, list] of byKey((o) => o.remoteIp)) {
    for (const c of clusters(list)) {
      take(
        "server",
        ip,
        c,
        `${uniqueSites(c).length} เว็บล่มพร้อมกัน — อยู่บนเซิร์ฟเวอร์ ${ip} เดียวกัน`,
        "น่าจะเป็นปัญหาที่เซิร์ฟเวอร์/โฮสต์ร่วม (เครื่องดับ, web server ล่ม, ไฟร์วอลล์) มากกว่าที่ตัวเว็บแต่ละเว็บ",
      );
    }
  }
  for (const [domain, list] of byKey((o) => {
    try {
      return baseDomain(new URL(o.url).hostname);
    } catch {
      return null;
    }
  })) {
    for (const c of clusters(list)) {
      take(
        "domain",
        domain,
        c,
        `${uniqueSites(c).length} เว็บใต้โดเมน ${domain} ล่มพร้อมกัน`,
        "ตรวจ DNS ของโดเมน, ใบรับรอง wildcard, load balancer หรือ reverse proxy ที่ใช้ร่วมกัน",
      );
    }
  }
  const dns = outages.filter((o) => o.errorCode === "DNS");
  for (const c of clusters(dns)) {
    if (uniqueSites(c).length >= 3)
      take(
        "dns",
        "DNS",
        c,
        `${uniqueSites(c).length} เว็บ resolve DNS ไม่ได้พร้อมกัน`,
        "น่าจะเป็นปัญหา DNS resolver ของเครือข่าย Worker หรือผู้ให้บริการ DNS ที่ใช้ร่วมกัน",
      );
  }
  for (const c of clusters(outages)) {
    if (uniqueSites(c.filter((x) => !claimed.has(x.incidentId))).length >= 3)
      take(
        "burst",
        "network",
        c,
        `${uniqueSites(c).length} เว็บล่มในช่วง 10 นาทีเดียวกัน`,
        opts.canaryFailing
          ? "Canary ก็ล้มเหลวด้วย — น่าจะเป็นอินเทอร์เน็ตขาออกของเครื่อง Worker/บริษัท ไม่ใช่ตัวเว็บ"
          : "เว็บไม่ได้อยู่เซิร์ฟเวอร์เดียวกัน — ตรวจเครือข่ายภายใน, ISP หรือผู้ให้บริการ CDN/โฮสติ้งที่ใช้ร่วมกัน",
      );
  }
  return groups.sort((a, b) => b.members.length - a.members.length);
}
