import { describe, expect, it } from "vitest";
import { normalizeChatHistory, type ChatTurn } from "./ai-history";

const u = (text: string): ChatTurn => ({ role: "user", text });
const a = (text: string, error = false): ChatTurn => ({ role: "assistant", text, error });

describe("normalizeChatHistory", () => {
  it("drops a question whose answer was an error, so two user turns never sit together", () => {
    const h = normalizeChatHistory([u("q1"), a("a1"), u("q2"), a("โควตาหมด", true), u("q3"), a("a3")]);
    expect(h.map((t) => t.text)).toEqual(["q1", "a1", "q3", "a3"]);
  });

  it("always starts with a user turn and keeps the most recent pairs", () => {
    const turns: ChatTurn[] = [];
    for (let i = 0; i < 8; i++) turns.push(u(`q${i}`), a(`a${i}`));
    const h = normalizeChatHistory(turns, 5);
    expect(h[0]!.role).toBe("user");
    expect(h.map((t) => t.text)).toEqual(["q6", "a6", "q7", "a7"]);
  });

  it("truncates long answers instead of failing the next question", () => {
    const h = normalizeChatHistory([u("q"), a("x".repeat(20_000))]);
    expect(h[1]!.text.length).toBeLessThan(4_100);
    expect(h[1]!.text).toContain("ตัดทอน");
  });

  it("ignores a trailing unanswered question and leading assistant turns", () => {
    expect(normalizeChatHistory([a("hello"), u("q1"), a("a1"), u("pending")]).map((t) => t.text)).toEqual([
      "q1",
      "a1",
    ]);
  });
});
