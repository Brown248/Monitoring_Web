// กฎการวินิจฉัย (isomorphic, ไม่มี I/O) — รับ "ข้อเท็จจริง" ที่ worker เก็บมา แล้วสรุปว่าพังที่ชั้นไหน

export type DiagnosisLayer =
  | "worker-network"
  | "dns"
  | "dns-internal"
  | "blocked"
  | "server-refused"
  | "network"
  | "tls"
  | "app-timeout"
  | "cdn-origin"
  | "app"
  | "access"
  | "path"
  | "slow"
  | "ok";

export interface DiagnosisFacts {
  scheme: "http" | "https";
  host: string;
  port: number;
  canaryFailing: boolean;
  dnsSystem: { addresses: string[]; error: string | null };
  dnsPublic: { addresses: string[]; error: string | null; resolver: string | null };
  /** IP ที่เคยใช้งานได้ล่าสุด (จากผลตรวจก่อนล่ม) */
  lastGoodIp: string | null;
  privateIp: boolean;
  tcp: { ok: boolean; error: string | null; ms: number | null } | null;
  tls: { ok: boolean; authError: string | null; daysLeft: number | null; error: string | null } | null;
  http: {
    status: number | null;
    ms: number | null;
    server: string | null;
    cdn: string | null;
    error: string | null;
  } | null;
  slowMs: number;
}

export interface DiagnosisVerdict {
  layer: DiagnosisLayer;
  /** down = ใช้งานไม่ได้, warn = ใช้ได้แต่มีปัญหา, ok = ปกติ */
  severity: "down" | "warn" | "ok";
  title: string;
  explanation: string;
  actions: string[];
  /** ชั้นที่ผ่านแล้ว (ใช้แสดงว่า "ส่วนนี้ปกติ") */
  healthy: string[];
}

/** ความหมายของ error 52x/530 จาก Cloudflare — ฝั่ง Cloudflare ปกติ แต่ติดต่อเซิร์ฟเวอร์ต้นทางไม่ได้ */
export const CLOUDFLARE_ORIGIN_ERRORS: Record<number, { title: string; why: string; fix: string[] }> = {
  520: {
    title: "เซิร์ฟเวอร์ต้นทางตอบกลับผิดรูปแบบ",
    why: "Cloudflare ติดต่อเซิร์ฟเวอร์ได้ แต่ได้คำตอบว่างหรือผิดรูปแบบ (เช่น แอป crash ระหว่างตอบ)",
    fix: ["ดู log ของ web server/แอปช่วงเวลาที่ล่ม", "ตรวจว่า header ที่แอปส่งไม่ใหญ่เกินกำหนด"],
  },
  521: {
    title: "เซิร์ฟเวอร์ต้นทางปฏิเสธการเชื่อมต่อ",
    why: "Cloudflare ต่อไปที่เซิร์ฟเวอร์แล้วถูกปฏิเสธ — web server (nginx/apache/แอป) มักหยุดทำงาน",
    fix: [
      "ตรวจว่า web server ทำงานอยู่ (systemctl status / docker ps)",
      "ตรวจ firewall ว่าไม่ได้บล็อก IP ของ Cloudflare",
    ],
  },
  522: {
    title: "Cloudflare ติดต่อเซิร์ฟเวอร์ต้นทางไม่ทันเวลา",
    why: "เซิร์ฟเวอร์อาจดับ, โหลดเต็ม หรือ firewall ทิ้งแพ็กเก็ตจาก Cloudflare",
    fix: [
      "ตรวจว่าเซิร์ฟเวอร์เปิดอยู่และ ping ได้",
      "ตรวจ CPU/RAM ของเซิร์ฟเวอร์",
      "ตรวจ firewall/security group",
    ],
  },
  523: {
    title: "Cloudflare หาเส้นทางไปเซิร์ฟเวอร์ต้นทางไม่เจอ",
    why: "IP ต้นทางใน DNS ของ Cloudflare อาจผิด หรือเครือข่ายของเซิร์ฟเวอร์ขาด",
    fix: ["ตรวจ A record ในหน้า DNS ของ Cloudflare ว่าชี้ IP ถูกต้อง", "ตรวจการเชื่อมต่อเน็ตของเซิร์ฟเวอร์"],
  },
  524: {
    title: "เซิร์ฟเวอร์ต้นทางตอบช้าเกิน 100 วินาที",
    why: "เชื่อมต่อได้แต่แอปประมวลผลนานเกิน (query ช้า, งานค้าง)",
    fix: ["ตรวจ query/งานที่ใช้เวลานานในแอป", "ตรวจโหลดของฐานข้อมูล"],
  },
  525: {
    title: "SSL ระหว่าง Cloudflare กับเซิร์ฟเวอร์ต้นทางล้มเหลว",
    why: "เซิร์ฟเวอร์ต้นทางไม่ได้ตั้ง SSL หรือตั้งไม่ตรงกับโหมด SSL ของ Cloudflare",
    fix: ["ตรวจใบรับรองบนเซิร์ฟเวอร์ต้นทาง", "ตรวจโหมด SSL/TLS ใน Cloudflare (Full / Full strict)"],
  },
  526: {
    title: "ใบรับรองของเซิร์ฟเวอร์ต้นทางไม่ถูกต้อง",
    why: "โหมด Full (strict) ต้องการใบรับรองที่ถูกต้องบนต้นทาง แต่ใบรับรองหมดอายุหรือไม่ตรงโดเมน",
    fix: ["ต่ออายุ/ติดตั้งใบรับรองบนต้นทาง (หรือใช้ Cloudflare Origin Certificate)"],
  },
  530: {
    title: "Cloudflare เชื่อมต่อเซิร์ฟเวอร์ต้นทางไม่ได้ (มักเป็น Cloudflare Tunnel หลุด)",
    why: "ถ้าใช้ Cloudflare Tunnel (cloudflared) แปลว่า tunnel ไม่ได้เชื่อมต่อ หรือ DNS ของต้นทางผิด (error 1033/1016)",
    fix: [
      "ตรวจว่า cloudflared ทำงานอยู่บนเครื่องต้นทาง (systemctl status cloudflared / docker ps)",
      "ดูสถานะ tunnel ใน Cloudflare Zero Trust → Networks → Tunnels",
      "ถ้าไม่ได้ใช้ tunnel: ตรวจ DNS ของต้นทางใน Cloudflare",
    ],
  },
};

function codeName(error: string | null): string {
  if (!error) return "";
  return error.split(/[\s:]/)[0] ?? error;
}

/** สรุปผลวินิจฉัยจากข้อเท็จจริง — เรียงกฎจากชั้นล่างสุด (เน็ต/DNS) ขึ้นไปชั้นบน (แอป) */
export function diagnoseVerdict(f: DiagnosisFacts): DiagnosisVerdict {
  const healthy: string[] = [];
  const ipNote =
    f.lastGoodIp && f.dnsSystem.addresses.length > 0 && !f.dnsSystem.addresses.includes(f.lastGoodIp)
      ? ` · IP เปลี่ยนจาก ${f.lastGoodIp} เป็น ${f.dnsSystem.addresses.slice(0, 2).join(", ")}`
      : "";

  if (f.canaryFailing) {
    return {
      layer: "worker-network",
      severity: "down",
      title: "เน็ตขาออกของเครื่อง Worker มีปัญหา — ไม่ใช่ตัวเว็บ",
      explanation:
        "เว็บอ้างอิงภายนอก (canary) ก็เข้าไม่ได้เช่นกัน ผลตรวจช่วงนี้จึงยังสรุปไม่ได้ว่าเว็บล่มจริง",
      actions: ["ตรวจอินเทอร์เน็ต/เราเตอร์/ไฟร์วอลล์ของเครื่องที่รัน Worker", "ตรวจ DNS ของเครื่อง Worker"],
      healthy,
    };
  }

  const sysFail = Boolean(f.dnsSystem.error) || f.dnsSystem.addresses.length === 0;
  const pubFail = Boolean(f.dnsPublic.error) || f.dnsPublic.addresses.length === 0;
  if (sysFail && pubFail) {
    const nx = /ENOTFOUND|NXDOMAIN|ENODATA/i.test(`${f.dnsSystem.error} ${f.dnsPublic.error}`);
    return {
      layer: "dns",
      severity: "down",
      title: nx ? `โดเมน ${f.host} หา IP ไม่เจอจากทุก DNS` : `DNS ของ ${f.host} ไม่ตอบ`,
      explanation: nx
        ? "ทั้ง DNS ของเครือข่ายและ DNS สาธารณะ (1.1.1.1/8.8.8.8) ตอบว่าไม่มี record นี้ — โดเมนอาจหมดอายุ, record ถูกลบ หรือ nameserver ผิด"
        : "ถาม DNS แล้วไม่ได้คำตอบ — nameserver ของโดเมนอาจล่ม",
      actions: [
        "ตรวจวันหมดอายุของโดเมนกับผู้ให้บริการจดโดเมน",
        "ตรวจ A/CNAME record ในหน้าจัดการ DNS",
        "ตรวจว่า nameserver (NS) ของโดเมนยังถูกต้อง",
      ],
      healthy,
    };
  }
  if (sysFail && !pubFail) {
    return {
      layer: "dns-internal",
      severity: "warn",
      title: "DNS ของเครือข่าย Worker มีปัญหา (DNS สาธารณะยังปกติ)",
      explanation: `DNS สาธารณะ (${f.dnsPublic.resolver ?? "1.1.1.1"}) ตอบ ${f.dnsPublic.addresses.slice(0, 2).join(", ")} แต่ DNS ของเครื่อง Worker ตอบไม่ได้ — ผู้ใช้ภายนอกอาจยังเข้าเว็บได้`,
      actions: ["ตรวจ DNS server ของเครือข่ายภายใน/ของเครื่อง Worker", "ล้าง DNS cache"],
      healthy,
    };
  }
  healthy.push(`DNS ปกติ (${f.dnsSystem.addresses.slice(0, 2).join(", ")})`);

  if (f.privateIp) {
    return {
      layer: "blocked",
      severity: "warn",
      title: "โดเมนชี้ไปที่ IP ภายใน — ระบบไม่เชื่อมต่อเพื่อความปลอดภัย",
      explanation: `${f.host} resolve เป็น IP ภายในองค์กร ระบบป้องกัน SSRF จึงไม่ตรวจต่อ`,
      actions: [
        "ถ้าเป็นเว็บภายในที่ต้องการตรวจ ให้ผู้ดูแลระบบเพิ่มในรายการที่อนุญาต",
        "ถ้าไม่ควรเป็น IP ภายใน ให้ตรวจ DNS",
      ],
      healthy,
    };
  }

  if (f.tcp && !f.tcp.ok) {
    const refused = /ECONNREFUSED/i.test(f.tcp.error ?? "");
    return refused
      ? {
          layer: "server-refused",
          severity: "down",
          title: `เซิร์ฟเวอร์ปฏิเสธการเชื่อมต่อพอร์ต ${f.port}`,
          explanation: `เครื่องปลายทางเปิดอยู่ แต่ไม่มีโปรแกรมรอรับที่พอร์ต ${f.port} — web server หรือแอปหยุดทำงาน${ipNote}`,
          actions: [
            "ตรวจว่า web server/แอปทำงานอยู่ (systemctl status nginx / docker ps)",
            "ดู log ล่าสุดของแอปว่าหยุดเพราะอะไร",
            `ตรวจว่าแอปยัง listen พอร์ต ${f.port}`,
          ],
          healthy,
        }
      : {
          layer: "network",
          severity: "down",
          title: `เชื่อมต่อพอร์ต ${f.port} ไม่ได้ภายในเวลา`,
          explanation: `ส่งคำขอเชื่อมต่อแล้วไม่มีการตอบ — เครื่องปลายทางอาจดับ, ไฟร์วอลล์ทิ้งแพ็กเก็ต หรือ IP ไม่ถูกต้อง${ipNote}`,
          actions: [
            "ตรวจว่าเครื่องเซิร์ฟเวอร์เปิดอยู่ (ping/console ของผู้ให้บริการ)",
            "ตรวจไฟร์วอลล์/security group ว่าเปิดพอร์ตนี้",
            ipNote ? "IP เปลี่ยนจากเดิม — ตรวจว่า DNS ชี้ถูกเครื่อง" : "ตรวจว่า DNS ชี้ IP ถูกต้อง",
          ],
          healthy,
        };
  }
  if (f.tcp?.ok) healthy.push(`เชื่อมต่อพอร์ต ${f.port} ได้${f.tcp.ms !== null ? ` (${f.tcp.ms} ms)` : ""}`);

  if (f.scheme === "https" && f.tls) {
    if (!f.tls.ok || f.tls.authError || (f.tls.daysLeft !== null && f.tls.daysLeft < 0)) {
      const expired = (f.tls.daysLeft ?? 1) < 0 || /EXPIRED/i.test(f.tls.authError ?? "");
      return {
        layer: "tls",
        severity: "down",
        title: expired ? "ใบรับรอง SSL หมดอายุแล้ว" : "ใบรับรอง SSL ไม่ถูกต้อง",
        explanation: expired
          ? "browser ของผู้ใช้จะขึ้นหน้าเตือนความปลอดภัยและเข้าเว็บไม่ได้"
          : `TLS handshake ไม่ผ่าน: ${f.tls.authError ?? f.tls.error ?? "ไม่ทราบสาเหตุ"}`,
        actions: expired
          ? ["ต่ออายุใบรับรองทันที แล้วเปิด auto-renew (เช่น certbot)"]
          : ["ตรวจว่าใบรับรองออกให้โดเมนนี้และติดตั้ง chain ครบ", "ตรวจด้วย SSL Labs หรือ openssl s_client"],
        healthy,
      };
    }
    healthy.push(`SSL ปกติ${f.tls.daysLeft !== null ? ` (หมดอายุอีก ${f.tls.daysLeft} วัน)` : ""}`);
  }

  if (!f.http || f.http.status === null) {
    return {
      layer: "app-timeout",
      severity: "down",
      title: "เชื่อมต่อได้ แต่เซิร์ฟเวอร์ไม่ตอบคำขอ HTTP",
      explanation: `เปิดการเชื่อมต่อสำเร็จแต่ไม่ได้รับคำตอบ (${codeName(f.http?.error ?? null) || "timeout"}) — แอปค้าง, worker ของแอปเต็ม หรือโหลดสูงมาก`,
      actions: ["ตรวจ CPU/RAM และจำนวน process/thread ของแอป", "restart แอปถ้าค้าง แล้วเก็บ log ไว้หาสาเหตุ"],
      healthy,
    };
  }

  const status = f.http.status;
  const cf = f.http.cdn === "cloudflare";
  if (cf && (CLOUDFLARE_ORIGIN_ERRORS[status] || (status >= 520 && status <= 530))) {
    const info = CLOUDFLARE_ORIGIN_ERRORS[status] ?? {
      title: "Cloudflare ติดต่อเซิร์ฟเวอร์ต้นทางไม่ได้",
      why: `Cloudflare ตอบ ${status} แทนเซิร์ฟเวอร์ต้นทาง`,
      fix: ["ตรวจเซิร์ฟเวอร์ต้นทาง"],
    };
    healthy.push("Cloudflare (CDN) ทำงานปกติ");
    return {
      layer: "cdn-origin",
      severity: "down",
      title: `HTTP ${status}: ${info.title}`,
      explanation: `ปัญหาอยู่ที่เซิร์ฟเวอร์ต้นทาง ไม่ใช่โดเมนหรือ Cloudflare — ${info.why}`,
      actions: info.fix,
      healthy,
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    const proxy = f.http.server ? ` (${f.http.server})` : "";
    const what =
      status === 502
        ? "reverse proxy ตอบได้ แต่ส่งต่อไปที่แอปด้านหลังไม่สำเร็จ (Bad Gateway)"
        : status === 503
          ? "เซิร์ฟเวอร์แจ้งว่าไม่พร้อมให้บริการ — อาจปิดปรับปรุง, โหลดเต็ม หรือไม่มี instance ของแอปทำงาน"
          : "reverse proxy รอคำตอบจากแอปด้านหลังนานเกิน (Gateway Timeout)";
    return {
      layer: "app",
      severity: "down",
      title: `HTTP ${status}: แอปด้านหลัง web server มีปัญหา`,
      explanation: `${what}${proxy}`,
      actions: [
        "ตรวจว่าแอป (Node/PHP-FPM/Java ฯลฯ) ทำงานอยู่และฟังพอร์ตที่ proxy ชี้ไป",
        "ดู error log ของ nginx/apache และของแอป",
        status === 504 ? "ตรวจ query หรืองานที่ใช้เวลานาน" : "restart แอปถ้าหยุดทำงาน",
      ],
      healthy: [...healthy, "web server/reverse proxy ตอบได้"],
    };
  }
  if (status >= 500) {
    return {
      layer: "app",
      severity: "down",
      title: `HTTP ${status}: แอปเกิดข้อผิดพลาดภายใน`,
      explanation: "เว็บเซิร์ฟเวอร์ทำงาน แต่โค้ดของแอปเกิด error ระหว่างประมวลผล",
      actions: [
        "ดู error log ของแอปช่วงเวลาที่ล่ม",
        "ตรวจว่ามีการ deploy หรือเปลี่ยนค่าก่อนหน้านี้ไหม",
        "ตรวจการเชื่อมต่อฐานข้อมูล",
      ],
      healthy: [...healthy, "web server ตอบได้"],
    };
  }
  if (status === 401 || status === 403) {
    return {
      layer: "access",
      severity: "warn",
      title: `HTTP ${status}: ถูกปฏิเสธการเข้าถึง`,
      explanation:
        "เว็บตอบได้แต่ไม่ยอมให้เข้าถึง — อาจเพิ่งเปิดระบบล็อกอิน, WAF/ระบบกันบอทบล็อก IP ของ Worker หรือสิทธิ์ไฟล์ผิด",
      actions: [
        "ถ้าตั้งใจให้ต้องล็อกอิน ให้ติ๊ก 'ถือว่า 401/403 = UP' ในการตั้งค่าเว็บ",
        "ตรวจกฎ WAF/firewall ว่าไม่ได้บล็อก IP ของเครื่อง Worker",
      ],
      healthy: [...healthy, "เว็บตอบได้"],
    };
  }
  if (status === 404 || status === 410) {
    return {
      layer: "path",
      severity: "warn",
      title: `HTTP ${status}: ไม่พบหน้าที่ตรวจ`,
      explanation: "เว็บทำงาน แต่ URL ที่ตั้งไว้ไม่มีอยู่แล้ว — อาจย้ายหน้า/เปลี่ยน route หลัง deploy",
      actions: ["ตรวจว่า URL ในการตั้งค่าเว็บยังถูกต้อง", "ตรวจ route/rewrite rule ของ web server"],
      healthy: [...healthy, "เว็บตอบได้"],
    };
  }
  if (status >= 400) {
    return {
      layer: "app",
      severity: "warn",
      title: `HTTP ${status}: เว็บตอบด้วย error ฝั่งคำขอ`,
      explanation: "เว็บทำงานแต่ไม่รับคำขอแบบที่ระบบตรวจส่งไป",
      actions: ["ตรวจการตั้งค่า URL และ Status ที่ถือว่า UP"],
      healthy: [...healthy, "เว็บตอบได้"],
    };
  }
  healthy.push(`HTTP ${status}`);
  if (f.http.ms !== null && f.http.ms > f.slowMs) {
    return {
      layer: "slow",
      severity: "warn",
      title: `เว็บใช้งานได้ แต่ตอบช้า (${(f.http.ms / 1000).toFixed(1)} วินาที)`,
      explanation: `ช้ากว่าเกณฑ์ ${(f.slowMs / 1000).toFixed(1)} วินาที — ผู้ใช้จะรู้สึกว่าเว็บช้า`,
      actions: ["ตรวจโหลดของเซิร์ฟเวอร์/ฐานข้อมูล", "ตรวจ cache และขนาดหน้าเว็บ"],
      healthy,
    };
  }
  return {
    layer: "ok",
    severity: "ok",
    title: "ตอนนี้ทุกชั้นทำงานปกติ",
    explanation: `ปัญหาอาจหายไปเองแล้ว หรือเกิดเป็นช่วง ๆ${ipNote}`,
    actions: ["ดูไทม์ไลน์การเปลี่ยนแปลงและผลตรวจย้อนหลังช่วงที่ล่ม"],
    healthy,
  };
}
