"use client";

import { useId, useState } from "react";

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;

/**
 * รายชื่ออีเมลแบบป้าย: พิมพ์แล้วกด Enter / "+ เพิ่ม" · วางหลายอีเมลพร้อมกันได้ (คั่นด้วย , ; หรือขึ้นบรรทัด)
 * ตรวจรูปแบบก่อนเพิ่ม ไม่รับซ้ำ · กด × เพื่อลบ
 */
export function EmailListInput({
  value,
  onChange,
  placeholder = "name@company.com",
  max = 30,
  disabled,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  max?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const id = useId();

  function add() {
    const parts = text
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    const bad = parts.filter((p) => !EMAIL.test(p));
    if (bad.length) {
      setErr(`อีเมลไม่ถูกต้อง: ${bad.join(", ")}`);
      return;
    }
    const next = [...new Set([...value, ...parts])];
    if (next.length > max) {
      setErr(`เพิ่มได้สูงสุด ${max} อีเมล`);
      return;
    }
    const dup = parts.filter((p) => value.includes(p));
    setErr(dup.length && dup.length === parts.length ? "อีเมลนี้อยู่ในรายการแล้ว" : null);
    onChange(next);
    setText("");
  }

  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="รายชื่อผู้รับ">
          {value.map((email) => (
            <li
              key={email}
              className="inline-flex items-center gap-1 rounded-full bg-sidebar py-1 pl-3 pr-1 text-sm ring-1 ring-inset ring-line"
            >
              <span className="max-w-64 truncate">{email}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((x) => x !== email))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-down-bg hover:text-down disabled:pointer-events-none"
                aria-label={`ลบ ${email}`}
                title="ลบ"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          type="email"
          inputMode="email"
          autoComplete="off"
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={err ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={() => text.trim() && add()}
          className="min-w-0 flex-1"
        />
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={disabled || !text.trim()}
          onClick={add}
        >
          + เพิ่มอีเมล
        </button>
      </div>
      {err && <p className="field-error">{err}</p>}
    </div>
  );
}
