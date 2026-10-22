"use client";

import {
  JOURNEY_ACTION_LABEL,
  JOURNEY_ACTIONS,
  loginTemplate,
  secretsUsed,
  type JourneyAction,
  type JourneyInput,
} from "@app/core";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "./fetch";
import { Spinner } from "./controls";
import { Switch } from "./switch";
import { useUnsavedWarning } from "./use-unsaved";
import { toast } from "./toast";

type Step = JourneyInput["steps"][number];

const NEEDS: Record<JourneyAction, { selector: boolean; value: boolean; valueHint: string }> = {
  goto: { selector: false, value: true, valueHint: "https://…" },
  fill: { selector: true, value: true, valueHint: "ค่าที่จะกรอก หรือ secret:ชื่อ" },
  click: { selector: true, value: false, valueHint: "" },
  waitFor: { selector: true, value: false, valueHint: "" },
  expectText: { selector: false, value: true, valueHint: "ข้อความที่ต้องเห็น" },
  expectNoText: { selector: false, value: true, valueHint: "ข้อความที่ต้องไม่เห็น เช่น Error" },
};

/** แก้ขั้นตอนทดสอบใช้งานจริง (เช่น เปิดหน้า login → กรอก → กด → ต้องเห็น dashboard) */
export function JourneyEditor({
  websiteId,
  url,
  initial,
  version,
  onClose,
}: {
  websiteId: number;
  url: string;
  initial: JourneyInput | null;
  version: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [interval, setIntervalMin] = useState<JourneyInput["intervalMinutes"]>(
    initial?.intervalMinutes ?? 15,
  );
  const [steps, setSteps] = useState<Step[]>(
    initial?.steps ?? [
      { action: "goto", value: url },
      { action: "expectText", value: "" },
    ],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [snapshot] = useState(() => JSON.stringify({ enabled, interval, steps }));
  useUnsavedWarning(!saved && JSON.stringify({ enabled, interval, steps }) !== snapshot);
  const secrets = secretsUsed(steps);
  // secret ต้องผูกกับโดเมนของเว็บนี้ใน .env (กันเว็บอื่นดึงรหัสไปใช้) — JOURNEY_<ส่วนหน้า>_DOMAIN
  const domainVars = [...new Set(secrets.map((s) => `${s.split("_").slice(0, 2).join("_")}_DOMAIN`))];
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "โดเมนของเว็บ";
    }
  })();

  const update = (i: number, patch: Partial<Step>) =>
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // error ผูกกับลำดับขั้นตอน (steps.2.value) — สลับ/ลบขั้นแล้ว error เดิมจะไปโผล่ผิดแถว จึงล้างทิ้ง
  const move = (i: number, d: -1 | 1) => {
    setErrors({});
    setSteps((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  };

  async function save() {
    setBusy(true);
    setErrors({});
    try {
      const clean = steps.map((s) => {
        const need = NEEDS[s.action];
        return {
          action: s.action,
          ...(need.selector ? { selector: s.selector?.trim() ?? "" } : {}),
          ...(need.value ? { value: s.value ?? "" } : {}),
        };
      });
      const res = await api<{ message: string }>(
        `/api/websites/${websiteId}/journey`,
        "PUT",
        { enabled, intervalMinutes: interval, steps: clean },
        { "x-base-version": version ?? "none" },
      );
      setSaved(true);
      toast("success", res.message);
      router.refresh();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      toast("error", "บันทึกไม่สำเร็จ", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const fieldErr = (i: number, f: "selector" | "value") => errors[`steps.${i}.${f}`];

  return (
    <div className="space-y-4" data-editing>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <label className="flex items-center gap-2">
          <Switch on={enabled} onToggle={() => setEnabled((v) => !v)} label="เปิดการทดสอบ" />
          เปิดการทดสอบตามรอบ
        </label>
        <label className="flex items-center gap-2">
          ทดสอบทุก
          <select
            value={interval}
            onChange={(e) => setIntervalMin(Number(e.target.value) as JourneyInput["intervalMinutes"])}
            className="w-auto"
          >
            {[5, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} นาที
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => {
            if (steps.length > 2 && !window.confirm("แทนที่ขั้นตอนทั้งหมดด้วยแม่แบบฟอร์ม Login?")) return;
            setErrors({});
            setSteps(loginTemplate(url));
          }}
        >
          ใช้แม่แบบ “ฟอร์ม Login”
        </button>
      </div>

      <ol className="space-y-2">
        {steps.map((s, i) => {
          const need = NEEDS[s.action];
          return (
            <li key={i} className="rounded-xl border border-line bg-canvas/50 p-3">
              <div className="flex flex-wrap items-start gap-2">
                <span className="num mt-2 w-6 shrink-0 text-center text-xs font-semibold text-muted">
                  {i + 1}
                </span>
                <select
                  aria-label={`ขั้นที่ ${i + 1} ทำอะไร`}
                  value={s.action}
                  onChange={(e) => update(i, { action: e.target.value as JourneyAction })}
                  className="w-40 shrink-0"
                >
                  {JOURNEY_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {JOURNEY_ACTION_LABEL[a]}
                    </option>
                  ))}
                </select>
                <div className="grid min-w-[12rem] flex-1 gap-2 sm:grid-cols-2">
                  {need.selector && (
                    <div className={need.value ? "" : "sm:col-span-2"}>
                      <input
                        aria-label="CSS selector"
                        className="font-mono text-xs"
                        placeholder={'CSS selector เช่น input[name="email"]'}
                        value={s.selector ?? ""}
                        onChange={(e) => update(i, { selector: e.target.value })}
                      />
                      {fieldErr(i, "selector") && <p className="field-error">{fieldErr(i, "selector")}</p>}
                    </div>
                  )}
                  {need.value && (
                    <div className={need.selector ? "" : "sm:col-span-2"}>
                      <input
                        aria-label="ค่า"
                        className={
                          s.action === "goto" || s.value?.startsWith("secret:") ? "font-mono text-xs" : ""
                        }
                        placeholder={need.valueHint}
                        value={s.value ?? ""}
                        onChange={(e) => update(i, { value: e.target.value })}
                      />
                      {fieldErr(i, "value") && <p className="field-error">{fieldErr(i, "value")}</p>}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="btn-ghost px-2"
                    aria-label="เลื่อนขึ้น"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn-ghost px-2"
                    aria-label="เลื่อนลง"
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn-ghost px-2 text-down"
                    aria-label="ลบขั้นตอน"
                    disabled={steps.length === 1}
                    onClick={() => {
                      setErrors({});
                      setSteps((x) => x.filter((_, j) => j !== i));
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="btn-secondary"
          disabled={steps.length >= 25}
          onClick={() => setSteps((s) => [...s, { action: "click", selector: "" }])}
        >
          + เพิ่มขั้นตอน
        </button>
        {errors.steps && <p className="field-error">{errors.steps}</p>}
      </div>

      <div className="rounded-lg bg-info-bg px-3 py-2.5 text-xs leading-relaxed text-info">
        <b>รหัสผ่านไม่ถูกเก็บในระบบ:</b> ใส่ <code className="font-mono">secret:ชื่อ</code> แทนค่าจริง
        แล้วตั้งค่าจริงใน <code className="font-mono">.env</code> ของ Worker
        {secrets.length > 0 ? (
          <>
            {" "}
            — ต้องตั้ง:{" "}
            {secrets.map((s) => (
              <code key={s} className="mr-1 rounded bg-surface px-1 font-mono">
                {s}
              </code>
            ))}
            และผูกกับเว็บนี้:{" "}
            {domainVars.map((d) => (
              <code key={d} className="mr-1 rounded bg-surface px-1 font-mono">
                {d}={host}
              </code>
            ))}
            แล้วรีสตาร์ท Worker · แนะนำให้ใช้บัญชีสำหรับทดสอบโดยเฉพาะ (สิทธิ์อ่านอย่างเดียว)
          </>
        ) : (
          " เช่น secret:CRM_PASS → JOURNEY_CRM_PASS และผูกโดเมนด้วย JOURNEY_CRM_DOMAIN"
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          ยกเลิก
        </button>
        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
          {busy && <Spinner />}
          บันทึก
        </button>
      </div>
    </div>
  );
}
