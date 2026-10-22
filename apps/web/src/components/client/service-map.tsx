"use client";

import { dependenciesOf, layerOf, type Edge } from "@app/core";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SiteIcon } from "./site-icon";

export interface MapNodeProps {
  id: number;
  name: string;
  enabled: boolean;
  status: "UP" | "DOWN" | "UNKNOWN" | "PENDING";
  failing: boolean;
  rootCauseId: number | null;
}

const COL_W = 250;
const NODE_W = 196;
const NODE_H = 48;
const ROW_H = 68;
const PAD = 16;

type Tone = "down" | "warn" | "up" | "muted";

function toneOf(n: MapNodeProps): Tone {
  if (!n.enabled) return "muted";
  if (n.status === "DOWN") return "down";
  if (n.failing) return "warn";
  if (n.status === "UP") return "up";
  return "muted";
}

const RING: Record<Tone, string> = {
  down: "ring-down/60 bg-down-bg",
  warn: "ring-warn/60 bg-warn-bg",
  up: "ring-up/30 bg-surface",
  muted: "ring-line-strong bg-surface opacity-70",
};
const DOT: Record<Tone, string> = { down: "bg-down", warn: "bg-warn", up: "bg-up", muted: "bg-subtle" };
const STROKE: Record<Tone, string> = {
  down: "var(--color-down)",
  warn: "var(--color-warn)",
  up: "var(--color-line-strong)",
  muted: "var(--color-line-strong)",
};

/**
 * แผนผังความเชื่อมโยง: คอลัมน์ซ้าย = ระบบพื้นฐาน (ไม่พึ่งใคร) → ขวา = ระบบที่พึ่งพาชั้นก่อนหน้า
 * ชี้ที่เว็บเพื่อไฮไลต์สายที่เกี่ยวข้องทั้งหมด (พึ่งพาใคร / ใครพึ่งพามัน)
 */
export function ServiceMap({
  nodes,
  edges,
  focus,
}: {
  nodes: MapNodeProps[];
  edges: Edge[];
  focus: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const active = hover ?? focus;

  const layout = useMemo(() => {
    const linked = new Set(edges.flat());
    const graphNodes = nodes.filter((n) => linked.has(n.id));
    const layers = layerOf(
      edges,
      graphNodes.map((n) => n.id),
    );
    const cols: number[][] = [];
    for (const n of graphNodes) (cols[layers.get(n.id) ?? 0] ??= []).push(n.id);
    // เรียงในคอลัมน์ตามตำแหน่งเฉลี่ยของสิ่งที่พึ่งพา (ลดเส้นตัดกัน)
    const rowOf = new Map<number, number>();
    cols.forEach((col, ci) => {
      if (ci > 0) {
        const score = (id: number) => {
          const deps = edges.filter(([a]) => a === id).map(([, b]) => rowOf.get(b) ?? 0);
          return deps.length ? deps.reduce((s, x) => s + x, 0) / deps.length : 0;
        };
        col.sort((a, b) => score(a) - score(b));
      }
      col.forEach((id, ri) => rowOf.set(id, ri));
    });
    const maxRows = Math.max(1, ...cols.map((c) => c?.length ?? 0));
    const pos = new Map<number, { x: number; y: number }>();
    cols.forEach((col, ci) =>
      col?.forEach((id, ri) => {
        // จัดคอลัมน์ที่สั้นกว่าให้อยู่กลาง
        const offset = ((maxRows - col.length) * ROW_H) / 2;
        pos.set(id, { x: PAD + ci * COL_W, y: PAD + offset + ri * ROW_H });
      }),
    );
    return {
      pos,
      width: PAD * 2 + Math.max(0, cols.length - 1) * COL_W + NODE_W,
      height: PAD * 2 + maxRows * ROW_H - (ROW_H - NODE_H),
      columns: cols.length,
      isolated: nodes.filter((n) => !linked.has(n.id)),
    };
  }, [nodes, edges]);

  const related = useMemo(() => {
    if (active === null) return null;
    const up = dependenciesOf(edges, active);
    const reversed: Edge[] = edges.map(([a, b]) => [b, a] as const);
    const down = dependenciesOf(reversed, active);
    return new Set([active, ...up, ...down]);
  }, [active, edges]);

  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="space-y-5">
      {edges.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-canvas/40">
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
              <defs>
                <marker
                  id="map-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0 0 10 5 0 10z" fill="var(--color-subtle)" />
                </marker>
              </defs>
              {edges.map(([from, to]) => {
                const a = layout.pos.get(from);
                const b = layout.pos.get(to);
                const dep = byId.get(to);
                if (!a || !b || !dep) return null;
                // เส้นจากขอบซ้ายของผู้พึ่งพา → ขอบขวาของระบบที่ถูกพึ่งพา
                const x1 = a.x;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x + NODE_W;
                const y2 = b.y + NODE_H / 2;
                const mx = (x1 + x2) / 2;
                const on = related ? related.has(from) && related.has(to) : true;
                const tone = toneOf(dep);
                return (
                  <path
                    key={`${from}-${to}`}
                    d={`M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2 + 4} ${y2}`}
                    fill="none"
                    stroke={STROKE[tone]}
                    strokeWidth={tone === "down" || tone === "warn" ? 2.2 : 1.6}
                    strokeDasharray={tone === "down" ? "6 4" : undefined}
                    markerEnd="url(#map-arrow)"
                    className="transition-opacity duration-200"
                    opacity={on ? 1 : 0.12}
                  />
                );
              })}
            </svg>
            {[...layout.pos.entries()].map(([id, p]) => {
              const n = byId.get(id)!;
              const tone = toneOf(n);
              const dim = related !== null && !related.has(id);
              return (
                <Link
                  key={id}
                  href={`/websites/${id}`}
                  onMouseEnter={() => setHover(id)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(id)}
                  onBlur={() => setHover(null)}
                  className={`absolute flex items-center gap-2 rounded-xl px-3 shadow-sm ring-1 transition-[opacity,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md ${RING[tone]} ${dim ? "opacity-25" : ""} ${id === focus ? "outline-2 outline-offset-2 outline-brand" : ""}`}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                >
                  <SiteIcon id={id} name={n.name} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium leading-tight">{n.name}</span>
                    <span className="block truncate text-[11px] leading-tight text-muted">
                      {!n.enabled
                        ? "ปิดการตรวจ"
                        : n.status === "DOWN"
                          ? n.rootCauseId
                            ? `ล่มตาม ${byId.get(n.rootCauseId)?.name ?? "ระบบอื่น"}`
                            : "ล่ม"
                          : n.failing
                            ? "เริ่มล้มเหลว"
                            : n.status === "UP"
                              ? "ปกติ"
                              : n.status === "PENDING"
                                ? "รอตรวจรอบแรก"
                                : "ไม่ทราบสถานะ"}
                    </span>
                  </span>
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[tone]} ${tone === "down" ? "dot-ping" : ""}`}
                  />
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {layout.isolated.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold text-muted">
            ยังไม่ได้เชื่อมโยง ({layout.isolated.length}) — ตั้งได้ที่หน้าเว็บไซต์ › “เว็บนี้พึ่งพา”
          </div>
          <div className="flex flex-wrap gap-2">
            {layout.isolated.map((n) => {
              const tone = toneOf(n);
              return (
                <Link
                  key={n.id}
                  href={`/websites/${n.id}`}
                  className={`flex items-center gap-2 rounded-full py-1 pl-1.5 pr-3 text-xs ring-1 transition-colors hover:ring-brand/50 ${RING[tone]}`}
                >
                  <SiteIcon id={n.id} name={n.name} size={18} />
                  {n.name}
                  <span className={`h-2 w-2 rounded-full ${DOT[tone]}`} />
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
