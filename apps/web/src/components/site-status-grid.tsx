import { formatMs } from "@app/core";
import Link from "next/link";
import type { SiteStatusItem } from "@/lib/data/websites";
import { SiteIcon } from "./client/site-icon";
import { cx } from "./ui";

type Key = "UP" | "FAILING" | "DOWN" | "UNKNOWN" | "PENDING";

const DOT: Record<Key, string> = {
  UP: "bg-brand",
  FAILING: "bg-warn",
  DOWN: "bg-down",
  UNKNOWN: "bg-unknown",
  PENDING: "bg-info",
};
const LABEL: Record<Key, string> = {
  UP: "ปกติ",
  FAILING: "กำลังล้มเหลว",
  DOWN: "ล่ม",
  UNKNOWN: "ไม่ทราบ",
  PENDING: "รอตรวจ",
};

const keyOf = (s: SiteStatusItem): Key => (s.failing && s.status !== "DOWN" ? "FAILING" : s.status);

/** ไอคอนของทุกเว็บพร้อมจุดสถานะ — มีข้อมูลให้เห็นตั้งแต่ตรวจครั้งแรก */
export function SiteStatusGrid({ sites, max = 24 }: { sites: SiteStatusItem[]; max?: number }) {
  const shown = sites.slice(0, max);
  const rest = sites.length - shown.length;
  const counts: Record<Key, number> = { UP: 0, FAILING: 0, DOWN: 0, UNKNOWN: 0, PENDING: 0 };
  for (const s of sites) counts[keyOf(s)]++;
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {shown.map((s, i) => {
          const k = keyOf(s);
          return (
            <Link
              key={s.id}
              href={`/websites/${s.id}`}
              className="group animate-pop relative rounded-lg"
              style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}
              aria-label={`${s.name} · ${LABEL[k]}`}
            >
              <SiteIcon
                id={s.id}
                name={s.name}
                size={32}
                className={cx(
                  "transition-transform duration-200 group-hover:-translate-y-0.5",
                  (k === "DOWN" || k === "FAILING") && "ring-2",
                  k === "DOWN" && "ring-down/70",
                  k === "FAILING" && "ring-warn/70",
                )}
              />
              <span
                className={cx(
                  // มุมขวาบน — มุมขวาล่างเป็นที่ของ favicon ดวงเล็ก (กรณีไอคอนซ้ำ)
                  "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface",
                  DOT[k],
                  (k === "DOWN" || k === "FAILING") && "dot-ping",
                )}
              />
              <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2.5 w-max max-w-52 -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-xs text-surface opacity-0 shadow-[var(--shadow-lift)] transition-opacity duration-150 group-hover:opacity-100"
              >
                <span className="block truncate font-medium">{s.name}</span>
                <span className="flex items-center gap-1.5 opacity-80">
                  <span className={cx("h-1.5 w-1.5 rounded-full", DOT[k])} />
                  {LABEL[k]}
                  {k === "UP" && s.responseMs !== null && ` · ${formatMs(s.responseMs)}`}
                </span>
              </span>
            </Link>
          );
        })}
        {rest > 0 && (
          <Link
            href="/websites"
            className="flex h-8 items-center rounded-lg bg-sidebar px-2 text-xs font-medium text-muted ring-1 ring-line hover:text-ink"
          >
            +{rest}
          </Link>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {(Object.keys(LABEL) as Key[])
          .filter((k) => counts[k])
          .map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={cx("h-2 w-2 rounded-full", DOT[k])} />
              {LABEL[k]} <span className="num text-ink">{counts[k]}</span>
            </span>
          ))}
      </div>
    </div>
  );
}
