"use client";

import { CHECK_INTERVAL_OPTIONS, formatInterval, maxRoundSeconds } from "@app/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api, ApiError } from "./fetch";
import { Switch } from "./switch";
import { EmailListInput } from "./email-list-input";
import { toast } from "./toast";
import { useUnsavedWarning } from "./use-unsaved";

export interface WebsiteFormValues {
  name: string;
  url: string;
  enabled: boolean;
  checkIntervalSeconds: number;
  timeoutSeconds: number;
  retryCount: number;
  retryDelaySeconds: number;
  confirmDownCount: number;
  confirmRecoveryCount: number;
  upStatusCodes: string;
  degradedThresholdMs: number | null;
  treatAuthAsUp: boolean;
  followRedirects: boolean;
  alertEmails: string[];
  sendRecovery: boolean;
  aiAutoAnalyze: boolean;
}

interface TestStep {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

const REJECT_EXAMPLES = [
  ["http://169.254.169.254/latest/meta-data", "Metadata endpoint (link-local)"],
  ["http://192.168.1.10:8080", "IP ในเครือข่ายภายใน"],
  ["https://admin:secret@site.example.com", "มี username/password ใน URL"],
  ["ftp://files.example.com", "Scheme ที่ไม่รองรับ"],
];

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5 animate-fade-up">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function WebsiteForm({
  mode,
  websiteId,
  initial,
  version,
  timeZoneNow,
}: {
  mode: "create" | "edit";
  websiteId?: number;
  initial: WebsiteFormValues;
  /** updated_at ตอนเปิดฟอร์ม (โหมดแก้ไข) — กันบันทึกทับการแก้ไขของคนอื่น */
  version?: string;
  timeZoneNow?: string;
}) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [degradedText, setDegradedText] = useState(initial.degradedThresholdMs?.toString() ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{
    busy: boolean;
    result?: { ok: boolean; steps: TestStep[]; testedAt: string };
    error?: string;
  }>({ busy: false });

  useUnsavedWarning(
    !saving &&
      (JSON.stringify(v) !== JSON.stringify(initial) ||
        degradedText !== (initial.degradedThresholdMs?.toString() ?? "")),
  );

  const set = <K extends keyof WebsiteFormValues>(k: K, value: WebsiteFormValues[K]) =>
    setV((s) => ({ ...s, [k]: value }));
  const num = (k: keyof WebsiteFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    set(k, Number(e.target.value) as never);

  const roundMax = maxRoundSeconds(v);
  const roundOk = roundMax < v.checkIntervalSeconds;
  const fastestIncidentMin = Math.round((v.checkIntervalSeconds * v.confirmDownCount) / 60);

  function payload() {
    return {
      ...v,
      degradedThresholdMs: degradedText.trim() === "" ? null : Number(degradedText),
    };
  }

  async function runTest() {
    setTest({ busy: true });
    try {
      const result = await api<{ ok: boolean; steps: TestStep[]; testedAt: string }>(
        "/api/websites/test-url",
        "POST",
        {
          url: v.url,
          timeoutSeconds: v.timeoutSeconds,
          followRedirects: v.followRedirects,
          upStatusCodes: v.upStatusCodes,
          treatAuthAsUp: v.treatAuthAsUp,
        },
      );
      setTest({ busy: false, result });
      toast(
        result.ok ? "success" : "error",
        result.ok ? "URL ผ่านการทดสอบ" : "URL ไม่ผ่านบางข้อ",
        result.ok ? "บันทึกได้" : "ดูรายละเอียดด้านขวา",
      );
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      setTest({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      if (mode === "create") {
        const res = await api<{ id: number }>("/api/websites", "POST", payload());
        toast("success", "เพิ่มเว็บไซต์แล้ว", "Worker จะเริ่มตรวจภายในไม่กี่วินาที");
        router.push(`/websites/${res.id}`);
      } else {
        await api(
          `/api/websites/${websiteId}`,
          "PATCH",
          payload(),
          version ? { "x-base-version": version } : undefined,
        );
        toast("success", "บันทึกการเปลี่ยนแปลงแล้ว");
        router.push(`/websites/${websiteId}`);
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      setFormError(err instanceof Error ? err.message : String(err));
      toast("error", "บันทึกไม่สำเร็จ", err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  const err = (k: string) => (errors[k] ? <p className="field-error">{errors[k]}</p> : null);
  const fmtTestTime = (iso: string) =>
    new Intl.DateTimeFormat("th-TH-u-ca-gregory-nu-latn", {
      timeZone: timeZoneNow,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <form onSubmit={save} className="space-y-4">
        <Section
          title="ข้อมูลพื้นฐาน"
          right={
            <span className="flex items-center gap-2 text-sm">
              เปิดการตรวจ
              <Switch on={v.enabled} onToggle={() => set("enabled", !v.enabled)} label="เปิดการตรวจ" />
            </span>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block font-medium" htmlFor="name">
                ชื่อเว็บไซต์
              </label>
              <input
                id="name"
                value={v.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="เช่น ระบบจองห้องประชุม"
                required
                maxLength={200}
              />
              {err("name")}
            </div>
            <div>
              <label className="mb-1.5 block font-medium" htmlFor="url">
                URL ที่จะตรวจ
              </label>
              <div className="flex gap-2">
                <input
                  id="url"
                  value={v.url}
                  onChange={(e) => {
                    set("url", e.target.value);
                    // ผลทดสอบเป็นของ URL เดิม — เปลี่ยน URL แล้วต้องทดสอบใหม่
                    if (test.result || test.error) setTest({ busy: false });
                  }}
                  placeholder="https://"
                  required
                  inputMode="url"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={runTest}
                  disabled={test.busy || !v.url}
                >
                  {test.busy ? "กำลังทดสอบ…" : "ทดสอบ URL"}
                </button>
              </div>
              {err("url")}
              <p className="hint">
                รองรับ http/https เท่านั้น · ห้ามมี username/password ใน URL · ระบบจะตรวจ IP
                ปลายทางทุกครั้งที่เชื่อมต่อ
              </p>
            </div>
          </div>
        </Section>

        <Section title="รอบตรวจและ Retry">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block font-medium">รอบตรวจ</label>
              <select value={v.checkIntervalSeconds} onChange={num("checkIntervalSeconds")}>
                {CHECK_INTERVAL_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {formatInterval(s)}
                  </option>
                ))}
              </select>
              {err("checkIntervalSeconds")}
            </div>
            <div>
              <label className="mb-1.5 block font-medium">Timeout ต่อคำขอ (วินาที)</label>
              <input
                type="number"
                min={1}
                max={60}
                value={v.timeoutSeconds}
                onChange={num("timeoutSeconds")}
              />
              {err("timeoutSeconds")}
            </div>
            <div>
              <label className="mb-1.5 block font-medium">Retry ภายในรอบ (ครั้ง)</label>
              <input type="number" min={0} max={5} value={v.retryCount} onChange={num("retryCount")} />
              {err("retryCount")}
            </div>
            <div>
              <label className="mb-1.5 block font-medium">รอระหว่าง Retry (วินาที)</label>
              <input
                type="number"
                min={0}
                max={30}
                value={v.retryDelaySeconds}
                onChange={num("retryDelaySeconds")}
              />
              {err("retryDelaySeconds")}
            </div>
            <div>
              <label className="mb-1.5 block font-medium">ยืนยัน DOWN เมื่อล้มเหลวติดกัน (รอบ)</label>
              <input
                type="number"
                min={1}
                max={10}
                value={v.confirmDownCount}
                onChange={num("confirmDownCount")}
              />
              {err("confirmDownCount")}
            </div>
            <div>
              <label className="mb-1.5 block font-medium">ยืนยัน Recovery เมื่อสำเร็จติดกัน (รอบ)</label>
              <input
                type="number"
                min={1}
                max={10}
                value={v.confirmRecoveryCount}
                onChange={num("confirmRecoveryCount")}
              />
              {err("confirmRecoveryCount")}
            </div>
          </div>
          <div
            className={`mt-4 rounded-md border px-3 py-2.5 text-sm ${roundOk ? "border-up/20 bg-up-bg text-up" : "border-down/30 bg-down-bg text-down"}`}
          >
            เวลาสูงสุดต่อรอบ ≈ {v.timeoutSeconds} × {v.retryCount + 1} + {v.retryDelaySeconds} ×{" "}
            {v.retryCount} = <b>{roundMax} วินาที</b>
            {roundOk
              ? ` — น้อยกว่ารอบตรวจ ${formatInterval(v.checkIntervalSeconds)} ✓ · เว็บจะเปิด Incident ได้เร็วสุดราว ${fastestIncidentMin} นาทีหลังเริ่มล่ม`
              : ` — มากกว่าหรือเท่ากับรอบตรวจ ${formatInterval(v.checkIntervalSeconds)} ✗ ลด Timeout/Retry หรือเพิ่มรอบตรวจ`}
          </div>
        </Section>

        <Section title="เกณฑ์ตัดสินสถานะ">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block font-medium">HTTP status ที่ถือว่า UP</label>
              <input value={v.upStatusCodes} onChange={(e) => set("upStatusCodes", e.target.value)} />
              {err("upStatusCodes")}
              <p className="hint">คั่นด้วยจุลภาค เช่น 200-299, 401</p>
            </div>
            <div>
              <label className="mb-1.5 block font-medium">แจ้ง DEGRADED เมื่อตอบช้ากว่า (ms)</label>
              <input
                type="number"
                min={100}
                max={60000}
                value={degradedText}
                onChange={(e) => setDegradedText(e.target.value)}
                placeholder="ไม่ระบุ = ไม่ตรวจ"
              />
              {err("degradedThresholdMs")}
              <p className="hint">ไม่เปิด Incident · แสดงบน Dashboard เท่านั้น</p>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={v.treatAuthAsUp}
                onChange={(e) => set("treatAuthAsUp", e.target.checked)}
              />
              <span>
                ถือว่า 401 / 403 เป็น UP<span className="hint block">สำหรับ URL ที่ต้อง Login อยู่แล้ว</span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={v.followRedirects}
                onChange={(e) => set("followRedirects", e.target.checked)}
              />
              <span>
                ตาม Redirect สูงสุด 3 hop
                <span className="hint block">ตรวจ IP ปลายทางซ้ำทุก hop · ปฏิเสธ Redirect ไป IP ภายใน</span>
              </span>
            </label>
          </div>
        </Section>

        <Section title="การแจ้งเตือน">
          <label className="mb-1.5 block font-medium">ผู้รับแจ้งเตือนของเว็บนี้</label>
          <EmailListInput
            value={v.alertEmails}
            onChange={(x) => set("alertEmails", x)}
            placeholder="ผู้ดูแลเว็บนี้ เช่น owner@syntechnology.com"
          />
          <p className="hint">
            นอกจากรายชื่อนี้ “ผู้รับแจ้งเตือนทุกเว็บ” ในหน้าตั้งค่า (ส่วนอีเมล) ได้รับด้วยเสมอ —
            อีเมลซ้ำส่งครั้งเดียว
          </p>
          {Object.entries(errors)
            .filter(([k]) => k.startsWith("alertEmails"))
            .slice(0, 1)
            .map(([k, m]) => (
              <p key={k} className="field-error">
                {m}
              </p>
            ))}
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={v.sendRecovery}
                onChange={(e) => set("sendRecovery", e.target.checked)}
              />
              ส่ง Recovery Alert เมื่อกลับมาปกติ
            </label>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={v.aiAutoAnalyze}
                onChange={(e) => set("aiAutoAnalyze", e.target.checked)}
              />
              <span>
                ให้ AI วิเคราะห์อัตโนมัติเมื่อเปิด Incident
                <span className="hint block">
                  ปิดไว้ได้ แล้วกดวิเคราะห์เองในหน้า Incident เพื่อประหยัดค่าใช้จ่าย
                </span>
              </span>
            </label>
          </div>
        </Section>

        {formError && (
          <div className="rounded-md border border-down/30 bg-down-bg px-3 py-2 text-sm text-down">
            {formError}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Link href={mode === "edit" ? `/websites/${websiteId}` : "/websites"} className="btn-secondary">
            ยกเลิก
          </Link>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "กำลังบันทึก…" : mode === "create" ? "เพิ่มและเริ่มตรวจ" : "บันทึกการเปลี่ยนแปลง"}
          </button>
        </div>
      </form>

      <aside className="space-y-4">
        <div className="card">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">{test.result ? "ผลทดสอบ URL" : "ทดสอบก่อนบันทึก"}</h2>
            {test.result && (
              <span className="num text-xs text-muted">{fmtTestTime(test.result.testedAt)}</span>
            )}
          </div>
          {test.result ? (
            <>
              <ul key={test.result.testedAt} className="rows-in divide-y divide-line">
                {test.result.steps.map((s) => (
                  <li key={s.key} className="flex gap-2.5 px-4 py-2.5">
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${s.ok ? "bg-up-bg text-up" : "bg-down-bg text-down"}`}
                    >
                      {s.ok ? "✓" : "✕"}
                    </span>
                    <div>
                      <div className="text-sm font-medium">{s.label}</div>
                      <div className="font-mono text-xs text-muted">{s.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
              <div
                className={`px-4 py-2.5 text-xs font-medium ${test.result.ok ? "bg-up-bg text-up" : "bg-down-bg text-down"}`}
              >
                {test.result.ok ? "ผ่านทุกข้อ · บันทึกได้" : "ไม่ผ่านบางข้อ · ตรวจ URL อีกครั้ง"}
              </div>
            </>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">
              {test.error ??
                'กด "ทดสอบ URL" เพื่อตรวจรูปแบบ, DNS, IP ปลายทาง และลองยิง request จริงหนึ่งครั้ง บันทึกได้เมื่อผ่านการตรวจความปลอดภัย'}
            </p>
          )}
        </div>
        <div className="card">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">
            ตัวอย่าง URL ที่ระบบจะปฏิเสธ
          </h2>
          <ul className="divide-y divide-line">
            {REJECT_EXAMPLES.map(([url, why]) => (
              <li key={url} className="px-4 py-2.5">
                <div className="break-all font-mono text-xs text-down">{url}</div>
                <div className="text-xs text-muted">{why}</div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
