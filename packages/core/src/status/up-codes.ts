export interface StatusRange {
  from: number;
  to: number;
}

export type ParseResult = { ok: true; ranges: StatusRange[] } | { ok: false; error: string };

/** แปลงข้อความเช่น "200-299, 401" เป็นช่วง status code */
export function parseUpStatusCodes(input: string): ParseResult {
  const parts = input
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: "ต้องระบุอย่างน้อย 1 ค่า" };

  const ranges: StatusRange[] = [];
  for (const part of parts) {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
    if (!m) return { ok: false, error: `รูปแบบไม่ถูกต้อง: "${part}"` };
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 100 || to > 599 || from > to) return { ok: false, error: `ช่วงไม่ถูกต้อง: "${part}"` };
    ranges.push({ from, to });
  }
  return { ok: true, ranges };
}

export function isUpStatus(status: number, ranges: StatusRange[], treatAuthAsUp: boolean): boolean {
  if (treatAuthAsUp && (status === 401 || status === 403)) return true;
  return ranges.some((r) => status >= r.from && status <= r.to);
}
