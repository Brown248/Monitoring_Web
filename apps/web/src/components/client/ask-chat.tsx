"use client";

import { normalizeChatHistory } from "@app/core";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./fetch";

/** ตรงกับ schema ของ /api/ask */
const MIN_QUESTION = 2;

interface Turn {
  role: "user" | "assistant";
  text: string;
  toolsUsed?: string[];
  error?: boolean;
}

const TOOL_LABEL: Record<string, string> = {
  list_websites: "รายชื่อเว็บ",
  get_uptime: "Uptime",
  list_incidents: "Incident",
  get_response_stats: "Response time",
  get_outage_groups: "ต้นเหตุร่วม",
  get_security_overview: "ความปลอดภัย",
  get_system_status: "สถานะระบบ",
};

const SUGGESTIONS = [
  "เดือนนี้เว็บไหนล่มบ่อยที่สุด และล่มรวมนานเท่าไร",
  "เมื่อวานมีเหตุการณ์อะไรบ้าง",
  "เว็บไหนตอบช้าที่สุดใน 24 ชั่วโมงที่ผ่านมา",
  "สรุปความปลอดภัยของเว็บทั้งหมด มีอะไรที่ต้องแก้ด่วน",
  "ใบรับรอง SSL ของเว็บไหนใกล้หมดอายุ",
];

// ---------- markdown แบบย่อ (ตัวหนา, `code`, หัวข้อ, รายการ, ตาราง) — สร้างเป็น React element ไม่ใช้ innerHTML ----------
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith("**") ? (
        <strong key={i++} className="font-semibold">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <code key={i++} className="rounded bg-sidebar px-1 py-px font-mono text-[0.85em]">
          {tok.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const cells = lines[i]!.trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={blocks.length} className="my-2 overflow-x-auto rounded-lg ring-1 ring-line">
          <table className="w-full text-xs">
            {head && (
              <thead className="bg-sidebar">
                <tr>
                  {head.map((h, j) => (
                    <th key={j} className="px-2.5 py-1.5 text-left font-semibold">
                      {inline(h)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody className="divide-y divide-line">
              {body.map((r, k) => (
                <tr key={k}>
                  {r.map((c, j) => (
                    <td key={j} className="px-2.5 py-1.5">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag
          key={blocks.length}
          className={`my-1.5 space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}
        >
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <p key={blocks.length} className="mt-3 font-semibold first:mt-0">
          {inline(h[1]!)}
        </p>,
      );
    } else if (line.trim()) {
      blocks.push(
        <p key={blocks.length} className="my-1.5 first:mt-0 last:mb-0">
          {inline(line)}
        </p>,
      );
    }
    i++;
  }
  return <>{blocks}</>;
}

/** แชทถามข้อมูลการตรวจเว็บด้วยภาษาธรรมชาติ */
export function AskChat({ ready, reason }: { ready: boolean; reason?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function ask(question: string) {
    const text = question.trim();
    if (text.length < MIN_QUESTION || busy) return;
    const history = normalizeChatHistory(turns);
    setTurns((t) => [...t, { role: "user", text }]);
    setQ("");
    setBusy(true);
    try {
      const r = await api<{ answer: string; toolsUsed: string[] }>("/api/ask", "POST", {
        question: text,
        history,
      });
      setTurns((t) => [...t, { role: "assistant", text: r.answer, toolsUsed: r.toolsUsed }]);
    } catch (err) {
      setTurns((t) => [
        ...t,
        { role: "assistant", text: err instanceof Error ? err.message : "เกิดข้อผิดพลาด", error: true },
      ]);
      // ส่งไม่สำเร็จ (หมดเวลาเข้าสู่ระบบ/ครบโควตา/เน็ตหลุด) → คืนคำถามไว้ในช่อง ไม่ต้องพิมพ์ใหม่
      setQ((cur) => cur || text);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  return (
    <div className="card flex min-h-[calc(100vh-220px)] flex-col overflow-hidden">
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-6 md:px-8">
        {turns.length === 0 && (
          <div className="animate-fade-up mx-auto max-w-xl py-6 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-ai to-brand-deep text-2xl text-white shadow-[var(--shadow-lift)]">
              ✦
            </span>
            <h2 className="mt-4 text-lg font-semibold tracking-tight">ถามอะไรก็ได้เกี่ยวกับเว็บที่เฝ้าดู</h2>
            <p className="mt-1 text-sm text-muted">
              AI ตอบจากข้อมูลจริงในระบบ (ผลตรวจ, Incident, ความปลอดภัย) และอ่านได้อย่างเดียว —
              เปลี่ยนแปลงอะไรไม่ได้
            </p>
            {ready ? (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void ask(s)}
                    className="rounded-full bg-sidebar px-3 py-1.5 text-xs text-ink-soft ring-1 ring-line transition-all hover:-translate-y-px hover:bg-surface hover:ring-line-strong"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-5 rounded-lg bg-warn-bg px-4 py-3 text-sm text-warn">{reason}</p>
            )}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="animate-fade-up flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-surface">
                {t.text}
              </div>
            </div>
          ) : (
            <div key={i} className="animate-fade-up flex gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm text-white ${t.error ? "bg-down" : "bg-gradient-to-br from-ai to-brand-deep"}`}
              >
                {t.error ? "!" : "✦"}
              </span>
              <div className="min-w-0 max-w-[85%]">
                <div
                  className={`rounded-2xl rounded-tl-md px-4 py-3 text-sm leading-relaxed ring-1 ${t.error ? "bg-down-bg text-down ring-down/20" : "bg-surface ring-line"}`}
                >
                  {t.error ? t.text : <Markdown text={t.text} />}
                </div>
                {t.toolsUsed && t.toolsUsed.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                    ข้อมูลจาก:
                    {t.toolsUsed.map((name) => (
                      <Fragment key={name}>
                        <span className="rounded-full bg-sidebar px-2 py-0.5 ring-1 ring-line">
                          {TOOL_LABEL[name] ?? name}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-ai to-brand-deep text-sm text-white">
              ✦
            </span>
            <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-md bg-surface px-4 py-3 ring-1 ring-line">
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted"
                  style={{ animationDelay: `${d * 140}ms` }}
                />
              ))}
              <span className="ml-2 text-xs text-muted">กำลังค้นข้อมูล…</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form
        className="border-t border-line bg-canvas/60 p-3 md:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl bg-surface p-1.5 ring-1 ring-line focus-within:ring-ink/40">
          <textarea
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(q);
              }
            }}
            rows={1}
            maxLength={1000}
            disabled={!ready}
            placeholder={
              ready ? "พิมพ์คำถาม… (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)" : "ยังไม่ได้ตั้งค่า AI"
            }
            className="max-h-40 min-h-10 flex-1 resize-none rounded-lg border-0 bg-transparent px-2.5 py-2 text-sm shadow-none outline-none focus-visible:outline-none"
          />
          <button
            type="submit"
            className="btn-primary h-10"
            disabled={!ready || busy || q.trim().length < MIN_QUESTION}
          >
            ส่ง
          </button>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            className="mt-2 text-xs text-muted hover:text-ink disabled:opacity-40"
            // กำลังรอคำตอบ → ห้ามล้าง (คำตอบที่มาทีหลังจะโผล่ในบทสนทนาใหม่โดยไม่มีคำถาม)
            disabled={busy}
            onClick={() => setTurns([])}
          >
            เริ่มบทสนทนาใหม่
          </button>
        )}
      </form>
    </div>
  );
}
