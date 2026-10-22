// แผนผังความเชื่อมโยง: edge = [เว็บ, เว็บที่มันพึ่งพา] (isomorphic)

export type Edge = readonly [from: number, dependsOn: number];

function adjacency(edges: readonly Edge[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const [a, b] of edges) m.set(a, [...(m.get(a) ?? []), b]);
  return m;
}

/** เว็บทั้งหมดที่ id พึ่งพาทางอ้อม (ไม่รวมตัวเอง) */
export function dependenciesOf(edges: readonly Edge[], id: number): Set<number> {
  const adj = adjacency(edges);
  const seen = new Set<number>();
  const stack = [...(adj.get(id) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n) || n === id) continue;
    seen.add(n);
    stack.push(...(adj.get(n) ?? []));
  }
  return seen;
}

/** เพิ่ม from → dependsOn แล้วจะวนกลับมาหาตัวเองไหม */
export function wouldCreateCycle(edges: readonly Edge[], from: number, dependsOn: number): boolean {
  if (from === dependsOn) return true;
  return dependenciesOf(edges, dependsOn).has(from);
}

/**
 * จัดชั้นสำหรับวาดแผนผัง: ชั้น 0 = ระบบพื้นฐานที่ไม่พึ่งใคร, ชั้นสูงขึ้น = พึ่งพาชั้นก่อนหน้า
 * (longest path จากฐาน) — กันวนซ้ำด้วยการจำกัดความลึก
 */
export function layerOf(edges: readonly Edge[], ids: number[]): Map<number, number> {
  const adj = adjacency(edges);
  const memo = new Map<number, number>();
  const depth = (id: number, guard: Set<number>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (guard.has(id)) return 0;
    guard.add(id);
    const deps = adj.get(id) ?? [];
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, guard))) : 0;
    guard.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const id of ids) depth(id, new Set());
  return memo;
}

/** เว็บที่ล่มอยู่ในบรรดาสิ่งที่ id พึ่งพา (เลือกตัวที่อยู่ลึกสุด = ต้นเหตุ) */
export function rootCauseFor(edges: readonly Edge[], id: number, down: Set<number>): number | null {
  const deps = [...dependenciesOf(edges, id)].filter((d) => down.has(d));
  if (deps.length === 0) return null;
  const layers = layerOf(edges, deps);
  return deps.sort((a, b) => (layers.get(a) ?? 0) - (layers.get(b) ?? 0))[0]!;
}
