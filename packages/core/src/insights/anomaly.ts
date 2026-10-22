// ตรวจพฤติกรรมผิดปกติเทียบกับค่าปกติของเว็บเอง (isomorphic, ไม่มี I/O)

export interface AnomalyBaseline {
  /** ค่ากลาง response (ms) ของช่วงเวลาเดียวกันของวันในอดีต */
  median: number | null;
  p90: number | null;
  /** จำนวนผลตรวจที่ใช้คำนวณ */
  samples: number;
  /** สัดส่วนผลตรวจที่ "ไม่นิ่ง" (DOWN หรือ UP หลัง retry) ในอดีต */
  flakyRate: number;
}

export interface AnomalyRecent {
  /** response ของผลตรวจ UP ล่าสุด (เก่า → ใหม่) */
  upMs: number[];
  /** ผลตรวจทั้งหมดในชั่วโมงล่าสุด */
  total: number;
  /** ผลตรวจที่ DOWN หรือ UP หลัง retry ในชั่วโมงล่าสุด */
  flaky: number;
}

export type Sensitivity = "low" | "normal" | "high";

export interface Anomaly {
  kind: "slow" | "unstable";
  title: string;
  detail: string;
  /** ช้ากว่าปกติกี่เท่า / สัดส่วนที่ไม่นิ่ง */
  factor: number;
}

const FACTOR: Record<Sensitivity, number> = { low: 4, normal: 2.5, high: 1.8 };
const FLAKY: Record<Sensitivity, number> = { low: 0.5, normal: 0.3, high: 0.2 };

export const MIN_BASELINE_SAMPLES = 30;

export function isLearning(b: AnomalyBaseline): boolean {
  return b.samples < MIN_BASELINE_SAMPLES || b.median === null;
}

/**
 * ช้าผิดปกติ: ผลตรวจล่าสุด 3 ใน 4 ครั้งช้ากว่า "ปกติของช่วงเวลานี้" × factor (และช้ากว่าปกติอย่างน้อย 800 ms)
 * ไม่นิ่งผิดปกติ: ชั่วโมงล่าสุดล้มเหลว/ต้อง retry บ่อยกว่าเกณฑ์ ทั้งที่ปกติแทบไม่เกิด
 */
export function detectAnomalies(b: AnomalyBaseline, r: AnomalyRecent, sensitivity: Sensitivity): Anomaly[] {
  if (isLearning(b)) return [];
  const out: Anomaly[] = [];
  const median = b.median!;
  const threshold = Math.max(median * FACTOR[sensitivity], (b.p90 ?? median) * 1.5, median + 800);
  const last = r.upMs.slice(-4);
  const slow = last.filter((ms) => ms > threshold);
  if (last.length >= 3 && slow.length >= 3) {
    const recentMedian = [...last].sort((a, c) => a - c)[Math.floor(last.length / 2)]!;
    const factor = recentMedian / median;
    out.push({
      kind: "slow",
      title: `ช้ากว่าปกติ ${factor.toFixed(1)} เท่า`,
      detail: `ผลตรวจล่าสุด ${slow.length}/${last.length} ครั้งช้ากว่า ${Math.round(threshold)} ms (ปกติช่วงเวลานี้ ~${Math.round(median)} ms)`,
      factor,
    });
  }
  if (r.total >= 6) {
    const rate = r.flaky / r.total;
    if (rate >= FLAKY[sensitivity] && rate >= b.flakyRate * 3 + 0.05) {
      out.push({
        kind: "unstable",
        title: "เริ่มไม่เสถียร",
        detail: `ชั่วโมงล่าสุดล้มเหลวหรือต้อง retry ${r.flaky}/${r.total} ครั้ง (ปกติ ${Math.round(b.flakyRate * 100)}%) — อาจกำลังจะล่ม`,
        factor: rate,
      });
    }
  }
  return out;
}
