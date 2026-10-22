export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  /** คำตอบที่เป็นข้อความ error (ไม่ใช่คำตอบจริงของ AI) */
  error?: boolean;
}

/** ความยาวสูงสุดต่อข้อความที่ส่งกลับไปเป็นบริบท — คำตอบยาว (ตาราง) ไม่ทำให้คำถามถัดไปถูกปฏิเสธ */
export const CHAT_HISTORY_MAX_CHARS = 4_000;
export const CHAT_HISTORY_MAX_TURNS = 10;

/**
 * เตรียมประวัติแชทสำหรับส่งให้ AI:
 * - เก็บเฉพาะคู่ "คำถาม → คำตอบสำเร็จ" (คำถามที่ได้ error ทิ้งทั้งคู่ — ไม่มี user ติดกันสองข้อความ)
 * - เริ่มด้วยคำถามของผู้ใช้เสมอ (API ของ model บังคับ) และเก็บแค่ maxTurns ข้อความล่าสุด
 * - ตัดข้อความที่ยาวเกิน maxChars
 */
export function normalizeChatHistory(
  turns: readonly ChatTurn[],
  maxTurns = CHAT_HISTORY_MAX_TURNS,
  maxChars = CHAT_HISTORY_MAX_CHARS,
): Array<{ role: "user" | "assistant"; text: string }> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < turns.length - 1; i++) {
    const q = turns[i]!;
    const a = turns[i + 1]!;
    if (
      q.role === "user" &&
      !q.error &&
      a.role === "assistant" &&
      !a.error &&
      q.text.trim() &&
      a.text.trim()
    ) {
      pairs.push([q.text, a.text]);
      i++;
    }
  }
  const cut = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars)}… (ตัดทอน)` : s);
  return pairs.slice(-Math.max(0, Math.floor(maxTurns / 2))).flatMap(([q, a]) => [
    { role: "user" as const, text: cut(q) },
    { role: "assistant" as const, text: cut(a) },
  ]);
}
