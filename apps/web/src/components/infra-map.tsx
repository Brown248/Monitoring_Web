import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { Health } from "@/lib/data/system";
import type { InfraKey, InfraStatus } from "@/lib/data/infra";
import { FitCanvas } from "./client/fit-canvas";

/** แผนผังโครงสร้างระบบแบบสด — ตำแหน่งตามแบบ (ผืนผ้าใบ 1680 × 872 แล้วย่อให้พอดีจอ) */
const W = 1680;
const H = 872;

const C = {
  user: "var(--im-blue)",
  worker: "var(--im-green)",
  read: "var(--im-amber)",
  misc: "var(--im-gray)",
};

type EdgeState = "flow" | "stopped" | "idle";

const ICON: Record<string, ReactNode> = {
  user: (
    <>
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
      <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" />
    </>
  ),
  web: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 8h18" />
      <path d="M8 21h8" />
    </>
  ),
  worker: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  db: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  sites: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  smtp: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  ai: <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />,
  sheets: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 9h16M4 15h16M10 3v18" />
    </>
  ),
  internet: (
    <>
      <path d="M5 12.5a10 10 0 0 1 14 0" />
      <path d="M8.5 16a5 5 0 0 1 7 0" />
      <path d="M2 9a15 15 0 0 1 20 0" />
      <circle cx="12" cy="19.5" r="1" />
    </>
  ),
  backup: <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />,
  volume: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 12h.01M11 12h6" />
    </>
  ),
};

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON[name]}
    </svg>
  );
}

const STATE_TEXT: Record<Health, string> = { ok: "ปกติ", warn: "เตือน", error: "มีปัญหา", off: "ปิด" };

function Node({
  k,
  s,
  box,
  title,
  sub,
  tone,
  ext,
  ring,
  tag,
  children,
}: {
  k: InfraKey;
  s: InfraStatus;
  box: [number, number, number, number];
  title: string;
  sub?: string;
  tone: string;
  ext?: boolean;
  /** วงแหวนเขียวเมื่อทำงาน (worker) */
  ring?: boolean;
  tag?: ReactNode;
  children?: ReactNode;
}) {
  const n = s.nodes[k];
  const [left, top, width, height] = box;
  return (
    <Link
      href={n.href}
      className={`im-node is-${n.state}${ext ? " ext" : ""}${ring ? " live-ring" : ""}`}
      style={{ left, top, width, height, "--tone": tone } as CSSProperties}
      title={n.problem ?? `${title} · ${STATE_TEXT[n.state]} — กดเพื่อดูรายละเอียด`}
    >
      <div className="im-nh">
        <span className="im-ico">
          <Icon name={k} />
        </span>
        <span className="im-nt">
          <b>{title}</b>
          <small>{sub ?? n.detail}</small>
        </span>
        {tag ?? <span className="im-val">{n.value}</span>}
      </div>
      {children}
    </Link>
  );
}

interface EdgeDef {
  d: string;
  color: string;
  state: EdgeState;
  packets?: number;
  dur?: number;
  delay?: number;
}

/** เส้นทางข้อมูล: ไหล = ทำงานปกติ · แดงนิ่ง = ขาด · เทา = ยังไม่ได้ใช้ */
function EdgeLines({ edges }: { edges: EdgeDef[] }) {
  return (
    <svg className="im-lines" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      {edges.map((e) => (
        <path key={`b${e.d}`} d={e.d} className="im-base" />
      ))}
      {edges.map((e) =>
        e.state === "flow" ? (
          <path key={`f${e.d}`} d={e.d} className="im-fl" stroke={e.color} />
        ) : e.state === "stopped" ? (
          <path key={`s${e.d}`} d={e.d} className="im-stop" />
        ) : null,
      )}
    </svg>
  );
}

function Packets({ edges }: { edges: EdgeDef[] }) {
  return edges
    .filter((e) => e.state === "flow")
    .flatMap((e) => {
      const count = e.packets ?? 1;
      const dur = e.dur ?? 2;
      return Array.from({ length: count }, (_, i) => (
        <div
          key={`${e.d}${i}`}
          className="im-pk"
          style={
            {
              offsetPath: `path('${e.d}')`,
              "--c": e.color,
              animationDuration: `${dur}s`,
              animationDelay: `${(e.delay ?? 0) + (i * dur) / count}s`,
            } as CSSProperties
          }
        />
      ));
    });
}

function Meter({
  label,
  pct,
  warn,
  error,
}: {
  label: string;
  pct: number | null;
  warn: number;
  error: number;
}) {
  const tone = pct === null ? "off" : pct >= error ? "error" : pct >= warn ? "warn" : "ok";
  return (
    <span
      className={`im-meter is-${tone}`}
      title={pct === null ? `${label}: ระบบปฏิบัติการไม่รายงาน` : undefined}
    >
      <span className="mono">{label}</span>
      <span className="im-meter-bar">
        <i style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </span>
      <b className="mono">{pct === null ? "—" : `${pct}%`}</b>
    </span>
  );
}

export function InfraMap({ s }: { s: InfraStatus }) {
  const n = s.nodes;
  const bad = (k: InfraKey) => n[k].state === "error";
  const workerUp = n.worker.state === "ok";
  const dbUp = !bad("db");
  // เส้นออกจาก worker: worker ต้องทำงาน และปลายทางต้องไม่พัง (ยังไม่ตั้งค่า = เส้นเทานิ่ง)
  const out = (k: InfraKey): EdgeState =>
    !workerUp || bad(k) ? "stopped" : n[k].state === "off" ? "idle" : "flow";
  const wdb: EdgeState = workerUp && dbUp ? "flow" : "stopped";
  const cycle = `ตรวจ 5 นาทีล่าสุด ${s.worker.checksLast5m.toLocaleString("en-US")} ครั้ง`;

  const edges: EdgeDef[] = [
    { d: "M 304 240 C 372 240 372 220 440 220", color: C.user, state: "flow", packets: 2 },
    { d: "M 590 304 L 590 420", color: C.user, state: dbUp ? "flow" : "stopped", dur: 1.6, delay: 0.5 },
    { d: "M 986 304 L 986 420", color: C.worker, state: wdb, dur: 1.4 },
    { d: "M 1010 420 L 1010 304", color: C.read, state: wdb, dur: 1.4, delay: 0.7 },
    {
      d: "M 1144 156 C 1200 156 1230 120 1288 120",
      color: C.worker,
      state: out("sites"),
      packets: 2,
      dur: 2.2,
    },
    {
      d: "M 1144 188 C 1200 188 1230 244 1288 244",
      color: C.worker,
      state: out("smtp"),
      dur: 2.2,
      delay: 0.4,
    },
    { d: "M 1144 220 C 1200 220 1230 368 1288 368", color: C.worker, state: out("ai"), dur: 2.2, delay: 0.8 },
    {
      d: "M 1144 252 C 1200 252 1230 492 1288 492",
      color: C.worker,
      state: out("sheets"),
      dur: 2.2,
      delay: 1.2,
    },
    {
      d: "M 1144 284 C 1200 284 1230 616 1288 616",
      color: C.worker,
      state: out("internet"),
      dur: 2.2,
      delay: 1.6,
    },
    {
      d: "M 976 572 L 976 604",
      color: C.misc,
      state: bad("backup") || !dbUp ? "stopped" : n.backup.state === "off" ? "idle" : "flow",
      dur: 1.8,
    },
  ];

  return (
    <FitCanvas width={W} height={H}>
      <div className="im-root">
        <div className="im-zone" style={{ left: 48, top: 20, width: 280, height: 680 }} />
        <Link
          href="/system"
          className={`im-zone vm is-${n.vm.state}`}
          style={{ left: 376, top: 20, width: 816, height: 680 }}
          title={n.vm.problem ?? "VM · กดเพื่อดูสถานะระบบ"}
        />
        <div className="im-zone dk" style={{ left: 408, top: 80, width: 752, height: 596 }} />
        <div className="im-zone" style={{ left: 1240, top: 20, width: 392, height: 680 }} />
        <div className="im-zh" style={{ left: 72, top: 40 }}>
          <span>01</span>LAN · ผู้ใช้
        </div>
        <div className="im-zh" style={{ left: 400, top: 40 }}>
          <span>02</span>UBUNTU VM · PROXMOX
          {n.vm.state !== "ok" && <em className={`im-badge is-${n.vm.state}`}>{STATE_TEXT[n.vm.state]}</em>}
        </div>
        <div className="im-vm" style={{ left: 700, top: 32, width: 470 }}>
          <Meter label="CPU" pct={s.vm.cpuPct} warn={90} error={200} />
          <Meter label="RAM" pct={s.vm.memPct} warn={90} error={97} />
          <Meter label="DISK" pct={s.vm.diskPct} warn={85} error={95} />
        </div>
        <div className="im-zh sm" style={{ left: 432, top: 96 }}>
          docker compose · restart: unless-stopped · {n.vm.value}
        </div>
        <div className="im-zh" style={{ left: 1264, top: 40 }}>
          <span>03</span>INTERNET · ขาออก
        </div>

        <EdgeLines edges={edges} />
        <Packets edges={edges} />

        <Node
          k="user"
          s={s}
          box={[72, 156, 232, 160]}
          title="ผู้ดูแลระบบ"
          sub="Browser · LAN"
          tone="var(--color-muted)"
        >
          <div className="im-nb">{n.user.detail}</div>
          <div className="im-chips">
            <span>Login</span>
            <span>argon2</span>
          </div>
        </Node>
        <Node
          k="web"
          s={s}
          box={[440, 136, 300, 168]}
          title="web"
          sub="Next.js · App Router"
          tone={C.user}
          tag={<span className="im-tag blue">:3000</span>}
        >
          <div className="im-nb">{n.web.detail}</div>
          <div className="im-chips">
            <span>Route Handlers</span>
            <span>zod</span>
            <span>{n.web.value}</span>
          </div>
        </Node>
        <Node
          k="worker"
          s={s}
          box={[828, 136, 316, 168]}
          title="worker"
          tone={C.worker}
          ring
          tag={
            workerUp ? (
              <span className="im-tag live">● LIVE</span>
            ) : (
              <span className="im-tag dead">● {n.worker.value}</span>
            )
          }
        >
          <div className="im-nb">
            <span className="im-bar">
              <i />
            </span>
            <span className="mono im-small">
              {workerUp
                ? `${cycle} · heartbeat ${s.worker.heartbeatAgoSec ?? 0}s ที่แล้ว`
                : (n.worker.problem ?? n.worker.detail)}
            </span>
          </div>
          <div className="im-chips">
            <span>undici</span>
            <span>SKIP LOCKED</span>
            <span>outbox</span>
          </div>
        </Node>
        <Node
          k="db"
          s={s}
          box={[440, 420, 704, 152]}
          title="postgres"
          tone={C.read}
          tag={<span className="im-tag amber">{n.db.value}</span>}
        >
          <div className="im-tbls">
            {s.tables.length
              ? s.tables.map((t) => (
                  <span key={t.name}>
                    {t.name}
                    <b>
                      {t.rows >= 1_000_000
                        ? `${(t.rows / 1_000_000).toFixed(1)}M`
                        : t.rows >= 1000
                          ? `${(t.rows / 1000).toFixed(1)}k`
                          : t.rows}
                    </b>
                  </span>
                ))
              : n.db.problem}
          </div>
        </Node>

        <Node
          k="sites"
          s={s}
          box={[1288, 68, 320, 104]}
          title="เว็บไซต์ที่ตรวจ"
          tone="var(--color-muted)"
          ext
        />
        <Node k="smtp" s={s} box={[1288, 192, 320, 104]} title="SMTP" tone="var(--color-muted)" ext />
        <Node k="ai" s={s} box={[1288, 316, 320, 104]} title="AI API" tone="var(--color-muted)" ext />
        <Node
          k="sheets"
          s={s}
          box={[1288, 440, 320, 104]}
          title="Google Sheets"
          tone="var(--color-muted)"
          ext
        />
        <Node
          k="internet"
          s={s}
          box={[1288, 564, 320, 104]}
          title="อินเทอร์เน็ตขาออก"
          tone="var(--color-muted)"
          ext
        />

        <div className="im-mini col" style={{ left: 72, top: 364, width: 232 }}>
          <b>firewall · LAN เท่านั้น</b>
          <span>
            เปิดเฉพาะพอร์ต web ให้วง LAN
            <br />
            ไม่เปิด Dashboard สู่ Internet
          </span>
        </div>
        <div className="im-mini col" style={{ left: 72, top: 492, width: 232 }}>
          <b>ไม่ต้องเปิดเว็บค้าง</b>
          <span>
            การตรวจทำโดย worker
            <br />
            ปิด browser ได้ตลอด
          </span>
        </div>
        <div className="im-mini" style={{ left: 440, top: 604, width: 336 }}>
          <Icon name="volume" size={16} />
          <b>volume</b> pgdata · อยู่รอดแม้สร้าง container ใหม่
        </div>
        <Link
          href={n.backup.href}
          className={`im-mini im-link is-${n.backup.state}`}
          style={{ left: 808, top: 604, width: 336 }}
          title={n.backup.problem ?? "Backup ฐานข้อมูล"}
        >
          <Icon name="backup" size={16} />
          <b>pg_dump</b> ทุกคืน · <span className="im-val">{n.backup.value}</span>
        </Link>

        <span className="im-pill blue" style={{ left: 336, top: 192 }}>
          HTTPS
        </span>
        <span className="im-pill blue" style={{ left: 604, top: 350 }}>
          SQL
        </span>
        <span className="im-pill green" style={{ left: 790, top: 350 }}>
          claim job · write result
        </span>

        <div className={`im-tl${workerUp ? "" : " paused"}`}>
          <div className="im-tlh">
            <b>วงจรการตรวจ</b>
            <span className="mono">{workerUp ? "ตามรอบของแต่ละเว็บ" : "หยุดอยู่ — worker ไม่ทำงาน"}</span>
          </div>
          <div className="im-track">
            <i />
          </div>
          <div className="im-steps">
            {[
              ["ดึงงาน", "SELECT … SKIP LOCKED"],
              ["ตรวจ", "HTTP + retry + timeout"],
              ["บันทึก", "check_results"],
              ["ตัดสินสถานะ", "เปิด / ปิด Incident"],
              ["แจ้งเตือน", "ส่งจาก outbox"],
            ].map(([t, d], i) => (
              <div key={t} className="im-step" style={{ animationDelay: `${i * 2}s` }}>
                <span className="n">{i + 1}</span>
                <span>
                  <b>{t}</b>
                  <small className="mono">{d}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </FitCanvas>
  );
}
