"use client";

import {
  CHECK_INTERVAL_OPTIONS,
  formatInterval,
  formatNumber,
  type SettingsKey,
  type SettingsMap,
} from "@app/core";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { JobButton } from "@/components/client/controls";
import { api, ApiError } from "@/components/client/fetch";
import { EmailListInput } from "@/components/client/email-list-input";
import { toast } from "@/components/client/toast";

interface Secrets {
  smtpPassword: boolean;
  aiKey: boolean;
  aiBaseUrl: string | null;
  serviceAccount: boolean;
  serviceAccountEmail: string | null;
}
interface Usage {
  aiCalls: number;
  sheetsLastSync: string | null;
  sheetsLastStatus: "SUCCESS" | "FAILED" | null;
  websites: number;
  checksPerDay: number;
}
interface UserRow {
  id: number;
  username: string;
  role: "ADMIN" | "VIEWER";
  isActive: boolean;
  locked: boolean;
  lastLogin: string;
}

const SECTIONS = [
  ["defaults", "ค่าเริ่มต้นการตรวจ"],
  ["smtp", "อีเมล (SMTP)"],
  ["ai", "AI"],
  ["security", "ความปลอดภัย"],
  ["insights", "วินิจฉัยและเตือนล่วงหน้า"],
  ["sheets", "Google Sheets"],
  ["retention", "การเก็บข้อมูล"],
  ["users", "ผู้ใช้งาน"],
] as const;

function Panel({
  id,
  title,
  subtitle,
  status,
  children,
  footer,
}: {
  id: string;
  title: string;
  subtitle: string;
  status?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section id={id} className="card scroll-mt-6">
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        {status}
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && (
        <div className="flex flex-wrap items-start justify-end gap-2 border-t border-line px-5 py-3">
          {footer}
        </div>
      )}
    </section>
  );
}

function SecretNote({ name, present, extra }: { name: string; present: boolean; extra?: ReactNode }) {
  return (
    <div className="mt-4 rounded-md border border-line bg-canvas px-3 py-2 text-xs">
      <span className={present ? "text-up" : "text-warn"}>● {present ? "พบค่า" : "ไม่พบค่า"}</span>{" "}
      <code className="font-mono">{name}</code>{" "}
      <span className="text-muted">
        {present
          ? "ตั้งค่าใน .env · ไม่แสดงและแก้จากหน้าเว็บ"
          : "ตั้งค่าใน .env บนเซิร์ฟเวอร์ แล้วรีสตาร์ท container"}
      </span>
      {extra && <span className="text-muted"> · {extra}</span>}
    </div>
  );
}

function Field({
  label,
  children,
  error,
  hint,
}: {
  label: string;
  children: ReactNode;
  error?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block font-medium">{label}</label>
      {children}
      {error && <p className="field-error">{error}</p>}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

function useSave<K extends SettingsKey>(key: K, initial: SettingsMap[K], initialVersion?: string) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  // updated_at ตอนเปิดหน้า — server ปฏิเสธถ้ามีคนอื่นบันทึกหมวดนี้ไปก่อน (ไม่เขียนทับกัน)
  const version = useRef(initialVersion);
  const [state, setState] = useState<{
    busy: boolean;
    msg?: string;
    ok?: boolean;
    fields?: Record<string, string>;
  }>({ busy: false });
  const set = <F extends keyof SettingsMap[K]>(f: F, v: SettingsMap[K][F]) =>
    setValue((s) => ({ ...s, [f]: v }));
  async function save() {
    setState({ busy: true });
    try {
      const res = await api<{ version: string | null }>(`/api/settings/${key}`, "PUT", value, {
        "x-base-version": version.current ?? "none",
      });
      version.current = res.version ?? undefined;
      setState({ busy: false, ok: true });
      toast("success", "บันทึกการตั้งค่าแล้ว");
      router.refresh();
    } catch (err) {
      setState({ busy: false, ok: false, fields: err instanceof ApiError ? err.fields : undefined });
      toast("error", "บันทึกไม่สำเร็จ", err instanceof Error ? err.message : String(err));
    }
  }
  return { value, set, save, state };
}

function SaveButton({
  state,
  onClick,
  disabled,
}: {
  state: { busy: boolean; msg?: string; ok?: boolean };
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="btn-primary" onClick={onClick} disabled={state.busy || disabled}>
      {state.busy ? "กำลังบันทึก…" : "บันทึก"}
    </button>
  );
}

function TestButton({
  url,
  body,
  children,
  disabled,
}: {
  url: string;
  body?: unknown;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn-secondary"
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ message: string }>(url, "POST", body);
          toast("success", "ทดสอบสำเร็จ", r.message);
        } catch (err) {
          toast("error", "ทดสอบไม่ผ่าน", err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "กำลังทดสอบ…" : children}
    </button>
  );
}

const int = (v: string) => (v === "" ? 0 : Number(v));

export function SettingsClient({
  isAdmin,
  meId,
  settings,
  versions,
  secrets,
  usage,
  users,
}: {
  isAdmin: boolean;
  meId: number;
  settings: SettingsMap;
  versions: Record<string, string>;
  secrets: Secrets;
  usage: Usage;
  users: UserRow[];
}) {
  const ro = !isAdmin;
  const defaults = useSave("check_defaults", settings.check_defaults, versions.check_defaults);
  const smtp = useSave("smtp", settings.smtp, versions.smtp);
  const ai = useSave("ai", settings.ai, versions.ai);
  const sheets = useSave("sheets", settings.sheets, versions.sheets);
  const retention = useSave("retention", settings.retention, versions.retention);
  const security = useSave("security", settings.security, versions.security);
  const insights = useSave("insights", settings.insights, versions.insights);
  const [testTo, setTestTo] = useState("");
  const fe = (s: { state: { fields?: Record<string, string> } }, k: string) => s.state.fields?.[k];
  const estRows = Math.round(usage.checksPerDay * retention.value.checksDays);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-5">
        <h1 className="text-xl font-semibold">ตั้งค่า</h1>
        <p className="mt-1 text-sm text-muted">
          รหัสผ่านและ API key เก็บใน .env บนเซิร์ฟเวอร์เท่านั้น หน้านี้แสดงแค่ว่าตั้งค่าไว้แล้วหรือยัง
        </p>
        {ro && (
          <p className="mt-2 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">
            บัญชีของคุณเป็นแบบดูอย่างเดียว — แก้ไขการตั้งค่าไม่ได้
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-sidebar"
            >
              {label}
            </a>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        <Panel
          id="defaults"
          title="ค่าเริ่มต้นการตรวจ"
          subtitle="ใช้กับเว็บไซต์ที่เพิ่มใหม่ · แต่ละเว็บปรับเองได้ · ตรวจพร้อมกันสูงสุด ใช้กับ Worker ทั้งระบบ"
          footer={!ro && <SaveButton state={defaults.state} onClick={defaults.save} />}
        >
          <fieldset disabled={ro} className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
            <Field label="รอบตรวจ">
              <select
                value={defaults.value.checkIntervalSeconds}
                onChange={(e) => defaults.set("checkIntervalSeconds", int(e.target.value))}
              >
                {CHECK_INTERVAL_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {formatInterval(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Timeout (วินาที)" error={fe(defaults, "timeoutSeconds")}>
              <input
                type="number"
                min={1}
                max={60}
                value={defaults.value.timeoutSeconds}
                onChange={(e) => defaults.set("timeoutSeconds", int(e.target.value))}
              />
            </Field>
            <Field label="Retry ภายในรอบ" error={fe(defaults, "retryCount")}>
              <input
                type="number"
                min={0}
                max={5}
                value={defaults.value.retryCount}
                onChange={(e) => defaults.set("retryCount", int(e.target.value))}
              />
            </Field>
            <Field label="รอระหว่าง Retry (วินาที)" error={fe(defaults, "retryDelaySeconds")}>
              <input
                type="number"
                min={0}
                max={30}
                value={defaults.value.retryDelaySeconds}
                onChange={(e) => defaults.set("retryDelaySeconds", int(e.target.value))}
              />
            </Field>
            <Field label="ยืนยัน DOWN (รอบติดกัน)" error={fe(defaults, "confirmDownCount")}>
              <input
                type="number"
                min={1}
                max={10}
                value={defaults.value.confirmDownCount}
                onChange={(e) => defaults.set("confirmDownCount", int(e.target.value))}
              />
            </Field>
            <Field label="ยืนยัน Recovery (รอบติดกัน)" error={fe(defaults, "confirmRecoveryCount")}>
              <input
                type="number"
                min={1}
                max={10}
                value={defaults.value.confirmRecoveryCount}
                onChange={(e) => defaults.set("confirmRecoveryCount", int(e.target.value))}
              />
            </Field>
            <Field label="ตรวจพร้อมกันสูงสุด" error={fe(defaults, "concurrency")}>
              <input
                type="number"
                min={1}
                max={50}
                value={defaults.value.concurrency}
                onChange={(e) => defaults.set("concurrency", int(e.target.value))}
              />
            </Field>
            <Field
              label='ถือว่า "ช้า" เมื่อเกิน (ms)'
              error={fe(defaults, "slowThresholdMs")}
              hint="ใช้กับแถบเรียลไทม์และ % ช้า · เว็บที่ตั้งเกณฑ์ DEGRADED เองจะใช้ค่าของเว็บนั้น"
            >
              <input
                type="number"
                min={200}
                max={60000}
                step={100}
                value={defaults.value.slowThresholdMs}
                onChange={(e) => defaults.set("slowThresholdMs", int(e.target.value))}
              />
            </Field>
          </fieldset>
        </Panel>

        <Panel
          id="smtp"
          title="อีเมล (SMTP)"
          subtitle="ใช้ส่งแจ้งเตือนเว็บล่ม · กลับมาใช้งานได้ · ความปลอดภัย"
          status={
            <span className={`text-xs ${settings.smtp.host ? "text-up" : "text-warn"}`}>
              ● {settings.smtp.host ? "ตั้งค่าแล้ว" : "ยังไม่ได้ตั้งค่า"}
            </span>
          }
          footer={
            !ro && (
              <>
                <input
                  className="max-w-56"
                  type="email"
                  placeholder="อีเมลผู้รับทดสอบ"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
                <TestButton
                  url="/api/settings/smtp/test"
                  body={{ to: testTo, smtp: smtp.value }}
                  disabled={!testTo}
                >
                  ส่งอีเมลทดสอบ
                </TestButton>
                <SaveButton state={smtp.state} onClick={smtp.save} />
              </>
            )
          }
        >
          <fieldset disabled={ro} className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
            <Field label="SMTP host" error={fe(smtp, "host")}>
              <input
                value={smtp.value.host}
                onChange={(e) => smtp.set("host", e.target.value)}
                placeholder="smtp.example.com"
              />
            </Field>
            <Field label="Port" error={fe(smtp, "port")}>
              <input
                type="number"
                value={smtp.value.port}
                onChange={(e) => smtp.set("port", int(e.target.value))}
              />
            </Field>
            <Field label="การเข้ารหัส">
              <select
                value={smtp.value.security}
                onChange={(e) => smtp.set("security", e.target.value as SettingsMap["smtp"]["security"])}
              >
                <option value="STARTTLS">STARTTLS</option>
                <option value="SSL">SSL/TLS</option>
                <option value="NONE">ไม่เข้ารหัส</option>
              </select>
            </Field>
            <Field label="Username" error={fe(smtp, "username")}>
              <input
                value={smtp.value.username}
                onChange={(e) => smtp.set("username", e.target.value)}
                placeholder="monitor@example.com"
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="ผู้ส่ง (From) — ใส่แค่ชื่อได้ ระบบจะใช้อีเมลจากช่องชื่อผู้ใช้"
                error={fe(smtp, "from")}
              >
                <input
                  value={smtp.value.from}
                  onChange={(e) => smtp.set("from", e.target.value)}
                  placeholder="SYNTECH Web Monitor <monitor@example.com>"
                />
              </Field>
            </div>
            <div className="sm:col-span-2 md:col-span-4">
              <Field
                label="ผู้รับแจ้งเตือนทุกเว็บ"
                error={listError(smtp.state.fields, "alertEmails")}
                hint="ได้รับแจ้งเตือนเว็บล่ม · กลับมาใช้งานได้ · ความปลอดภัย ของทุกเว็บ — รวมกับผู้รับที่ตั้งไว้ในแต่ละเว็บ (อีเมลซ้ำส่งครั้งเดียว) · กดบันทึกหลังเพิ่ม"
              >
                <EmailListInput
                  value={smtp.value.alertEmails}
                  onChange={(x) => smtp.set("alertEmails", x)}
                  disabled={ro}
                  placeholder="it-team@syntechnology.com"
                />
              </Field>
            </div>
          </fieldset>
          <SecretNote name="SMTP_PASSWORD" present={secrets.smtpPassword} />
        </Panel>

        <Panel
          id="ai"
          title="AI Incident Analysis"
          subtitle="AI ช่วยสรุป ไม่มีสิทธิ์เปลี่ยนสถานะเว็บไซต์"
          status={
            <span
              className={`text-xs ${settings.ai.provider !== "none" && secrets.aiKey ? "text-up" : "text-muted"}`}
            >
              ● {settings.ai.provider === "none" ? "ปิดใช้งาน" : secrets.aiKey ? "พร้อม" : "ไม่พบ API key"}
            </span>
          }
          footer={
            !ro && (
              <>
                <TestButton url="/api/settings/ai/test" body={ai.value}>
                  ทดสอบการเชื่อมต่อ
                </TestButton>
                <SaveButton state={ai.state} onClick={ai.save} />
              </>
            )
          }
        >
          <fieldset disabled={ro} className="grid gap-4 md:grid-cols-3">
            <Field label="Provider">
              <select
                value={ai.value.provider}
                onChange={(e) => ai.set("provider", e.target.value as SettingsMap["ai"]["provider"])}
              >
                <option value="none">ปิดใช้งาน</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="gemini">Google (Gemini)</option>
                <option value="openai">OpenAI / OpenAI-compatible</option>
              </select>
            </Field>
            <Field
              label="Model"
              error={fe(ai, "model")}
              hint={
                ai.value.provider === "anthropic"
                  ? "เว้นว่าง = claude-opus-5-5"
                  : ai.value.provider === "gemini"
                    ? "เว้นว่าง = gemini-2.5-flash"
                    : ai.value.provider === "openai"
                      ? "ต้องระบุชื่อรุ่น"
                      : undefined
              }
            >
              <input
                value={ai.value.model}
                onChange={(e) => ai.set("model", e.target.value)}
                placeholder={
                  ai.value.provider === "anthropic"
                    ? "claude-opus-5-5"
                    : ai.value.provider === "gemini"
                      ? "gemini-2.5-flash"
                      : "[ชื่อรุ่น]"
                }
              />
            </Field>
            <Field label="จำกัดการเรียกต่อเดือน" error={fe(ai, "monthlyLimit")} hint="0 = ไม่จำกัด">
              <input
                type="number"
                min={0}
                value={ai.value.monthlyLimit}
                onChange={(e) => ai.set("monthlyLimit", int(e.target.value))}
              />
            </Field>
          </fieldset>
          <fieldset disabled={ro} className="mt-4 space-y-3">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ai.value.autoAnalyze}
                onChange={(e) => ai.set("autoAnalyze", e.target.checked)}
              />
              <span>
                วิเคราะห์อัตโนมัติเมื่อเปิด Incident
                <span className="hint block">ถ้าปิด ต้องกด &quot;วิเคราะห์&quot; เองในหน้า Incident</span>
              </span>
            </label>
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={ai.value.thai}
                onChange={(e) => ai.set("thai", e.target.checked)}
              />
              ตอบเป็นภาษาไทย
            </label>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ai.value.autoPostmortem}
                onChange={(e) => ai.set("autoPostmortem", e.target.checked)}
              />
              <span>
                ร่างรายงานสรุปเหตุ (Postmortem) อัตโนมัติเมื่อ Incident ปิด
                <span className="hint block">
                  เฉพาะ Incident ที่ล่มนานอย่างน้อยตามที่กำหนด · กดร่างเองได้เสมอในหน้า Incident
                </span>
              </span>
            </label>
            <div className="max-w-xs pl-6">
              <Field label="ล่มนานอย่างน้อย (นาที)" error={fe(ai, "postmortemMinMinutes")}>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={ai.value.postmortemMinMinutes}
                  disabled={!ai.value.autoPostmortem}
                  onChange={(e) => ai.set("postmortemMinMinutes", int(e.target.value))}
                />
              </Field>
            </div>
          </fieldset>
          <SecretNote
            name="AI_API_KEY"
            present={secrets.aiKey}
            extra={`ใช้ไปเดือนนี้ ${usage.aiCalls}${ai.value.monthlyLimit ? ` / ${ai.value.monthlyLimit}` : ""} ครั้ง${secrets.aiBaseUrl ? ` · AI_BASE_URL ${secrets.aiBaseUrl}` : ""}`}
          />
        </Panel>

        <SecurityPanel ro={ro} s={security} fe={(k) => fe(security, k)} />

        <InsightsPanel ro={ro} s={insights} />

        <Panel
          id="sheets"
          title="Google Sheets"
          subtitle="ปลายทางรายงานเท่านั้น · ข้อมูลหลักอยู่ใน PostgreSQL"
          status={
            usage.sheetsLastSync && (
              <span className={`text-xs ${usage.sheetsLastStatus === "FAILED" ? "text-down" : "text-up"}`}>
                ● Sync ล่าสุด {usage.sheetsLastSync}
              </span>
            )
          }
          footer={
            !ro && (
              <>
                <JobButton
                  type="SHEETS_SYNC"
                  disabled={!secrets.serviceAccount || !settings.sheets.spreadsheetId}
                >
                  Sync ตอนนี้
                </JobButton>
                <SaveButton state={sheets.state} onClick={sheets.save} />
              </>
            )
          }
        >
          <fieldset disabled={ro} className="space-y-4">
            <Field
              label="Spreadsheet ID"
              error={fe(sheets, "spreadsheetId")}
              hint="ส่วนของ URL ระหว่าง /d/ และ /edit"
            >
              <input
                value={sheets.value.spreadsheetId}
                onChange={(e) => sheets.set("spreadsheetId", e.target.value)}
                placeholder="[Spreadsheet ID]"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <Field label="รอบการ Sync">
                <select
                  value={sheets.value.interval}
                  onChange={(e) =>
                    sheets.set("interval", e.target.value as SettingsMap["sheets"]["interval"])
                  }
                >
                  <option value="hourly">ทุกชั่วโมง</option>
                  <option value="daily">วันละครั้ง</option>
                  <option value="manual">กดเองเท่านั้น</option>
                </select>
              </Field>
              <Field label="ชีตสำหรับ Incident" error={fe(sheets, "incidentSheet")}>
                <input
                  value={sheets.value.incidentSheet}
                  onChange={(e) => sheets.set("incidentSheet", e.target.value)}
                />
              </Field>
              <Field label="ชีตสำหรับ Uptime รายวัน" error={fe(sheets, "uptimeSheet")}>
                <input
                  value={sheets.value.uptimeSheet}
                  onChange={(e) => sheets.set("uptimeSheet", e.target.value)}
                />
              </Field>
              <Field
                label="ชีตสำหรับ Check History"
                error={fe(sheets, "checksSheet")}
                hint="แยกชีตรายเดือนอัตโนมัติ เช่น “Check History 2026-10” (Google จำกัด 10 ล้านเซลล์ต่อไฟล์)"
              >
                <input
                  value={sheets.value.checksSheet}
                  onChange={(e) => sheets.set("checksSheet", e.target.value)}
                />
              </Field>
            </div>
            <div>
              <div className="mb-2 font-medium">ข้อมูลที่ส่ง</div>
              <div className="space-y-2">
                <label className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={sheets.value.sendIncidents}
                    onChange={(e) => sheets.set("sendIncidents", e.target.checked)}
                  />
                  Incident (เปิด/ปิด, ระยะเวลา, สาเหตุ)
                </label>
                <label className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={sheets.value.sendDailyUptime}
                    onChange={(e) => sheets.set("sendDailyUptime", e.target.checked)}
                  />
                  สรุป Uptime รายวันของแต่ละเว็บ
                </label>
                <label className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={sheets.value.sendChecks}
                    onChange={(e) => sheets.set("sendChecks", e.target.checked)}
                  />
                  Check History ทุกแถว <span className="text-xs text-muted">(ไม่แนะนำ — ชีตจะเต็มเร็ว)</span>
                </label>
              </div>
            </div>
          </fieldset>
          <SecretNote
            name="GOOGLE_SERVICE_ACCOUNT_JSON"
            present={secrets.serviceAccount}
            extra={
              secrets.serviceAccountEmail
                ? `แชร์ชีตให้ ${secrets.serviceAccountEmail} (Editor) ด้วย`
                : "แชร์ชีตให้อีเมลของ service account ด้วย"
            }
          />
        </Panel>

        <Panel
          id="retention"
          title="การเก็บข้อมูล"
          subtitle="ลดขนาดฐานข้อมูลโดยไม่เสียภาพรวมย้อนหลัง"
          footer={!ro && <SaveButton state={retention.state} onClick={retention.save} />}
        >
          <fieldset disabled={ro} className="grid gap-4 md:grid-cols-3">
            <Field label="ผลตรวจแบบละเอียด">
              <select
                value={retention.value.checksDays}
                onChange={(e) =>
                  retention.set("checksDays", int(e.target.value) as SettingsMap["retention"]["checksDays"])
                }
              >
                {[30, 60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} วัน
                  </option>
                ))}
              </select>
            </Field>
            <Field label="สรุปรายวัน">
              <select
                value={retention.value.dailySummaryDays}
                onChange={(e) =>
                  retention.set(
                    "dailySummaryDays",
                    int(e.target.value) as SettingsMap["retention"]["dailySummaryDays"],
                  )
                }
              >
                <option value={365}>1 ปี</option>
                <option value={730}>2 ปี</option>
                <option value={1825}>5 ปี</option>
                <option value={0}>เก็บตลอด</option>
              </select>
            </Field>
            <Field label="Incident และการแจ้งเตือน">
              <select
                value={retention.value.incidentDays}
                onChange={(e) =>
                  retention.set(
                    "incidentDays",
                    int(e.target.value) as SettingsMap["retention"]["incidentDays"],
                  )
                }
              >
                <option value={365}>1 ปี</option>
                <option value={730}>2 ปี</option>
                <option value={0}>เก็บตลอด</option>
              </select>
            </Field>
          </fieldset>
          <p className="mt-3 text-xs text-muted">
            ล้างข้อมูลเก่าทุกวันเวลา 03:30 · ประมาณการ: {usage.websites} เว็บ × รอบตรวจปัจจุบัน ×{" "}
            {retention.value.checksDays} วัน ≈ {formatNumber(estRows)} แถว
          </p>
        </Panel>

        <UsersPanel isAdmin={isAdmin} meId={meId} users={users} />
      </div>
    </div>
  );
}

function UsersPanel({ isAdmin, meId, users }: { isAdmin: boolean; meId: number; users: UserRow[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", role: "VIEWER" as "ADMIN" | "VIEWER" });
  const [editing, setEditing] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ role: "ADMIN" | "VIEWER"; isActive: boolean; password: string }>({
    role: "VIEWER",
    isActive: true,
    password: "",
  });
  const [pw, setPw] = useState<{ open: boolean; current: string; next: string }>({
    open: false,
    current: "",
    next: "",
  });

  // error ของแต่ละฟอร์มแยกกัน (ฟอร์มเพิ่มผู้ใช้กับฟอร์มแก้ไขมีช่อง password เหมือนกัน)
  type Scope = "add" | "edit" | "pw" | "unlock";
  const [err, setErr] = useState<{ scope: Scope; fields: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState<Scope | null>(null);
  const fields = (scope: Scope) => (err?.scope === scope ? err.fields : {});

  async function run(scope: Scope, fn: () => Promise<unknown>, okText: string) {
    if (busy) return false; // กดซ้ำระหว่างรอ → ไม่ส่งคำขอซ้ำ
    setErr(null);
    setBusy(scope);
    try {
      await fn();
      toast("success", okText);
      router.refresh();
      return true;
    } catch (e) {
      toast("error", "ทำรายการไม่สำเร็จ", e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.fields) setErr({ scope, fields: e.fields });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      id="users"
      title="ผู้ใช้งาน"
      subtitle="เข้าใช้ได้เฉพาะใน LAN · รหัสผ่านเก็บแบบ argon2"
      status={
        isAdmin && (
          <button className="btn-secondary" onClick={() => setAdding((a) => !a)}>
            + เพิ่มผู้ใช้
          </button>
        )
      }
    >
      {adding && (
        <div className="mb-4 grid gap-3 rounded-md border border-line bg-canvas p-3 sm:grid-cols-[1fr_1fr_160px_auto]">
          <Field label="ชื่อผู้ใช้" error={fields("add").username}>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="รหัสผ่าน (≥ 8 ตัว)" error={fields("add").password}>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label="สิทธิ์">
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as "ADMIN" | "VIEWER" })}
            >
              <option value="VIEWER">ดูอย่างเดียว</option>
              <option value="ADMIN">Admin</option>
            </select>
          </Field>
          <div className="flex items-end">
            <button
              className="btn-primary"
              disabled={busy !== null}
              onClick={async () => {
                if (
                  await run("add", () => api("/api/users", "POST", form), `เพิ่มผู้ใช้ ${form.username} แล้ว`)
                ) {
                  setForm({ username: "", password: "", role: "VIEWER" });
                  setAdding(false);
                }
              }}
            >
              {busy === "add" ? "กำลังเพิ่ม…" : "เพิ่ม"}
            </button>
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-canvas/60">
            <tr>
              <th className="th">ชื่อผู้ใช้</th>
              <th className="th">สิทธิ์</th>
              <th className="th">เข้าใช้ล่าสุด</th>
              <th className="th text-right">การจัดการ</th>
            </tr>
          </thead>
          <tbody className="rows-in divide-y divide-line">
            {users.map((u) => (
              <tr key={u.id} className={u.isActive ? "" : "opacity-60"}>
                <td className="td font-medium">
                  {u.username}
                  {u.id === meId && <span className="ml-1 text-xs font-normal text-muted">(คุณ)</span>}
                  {!u.isActive && <span className="ml-1 text-xs font-normal text-down">ปิดใช้งาน</span>}
                  {u.locked && <span className="ml-1 text-xs font-normal text-warn">ถูกล็อก</span>}
                </td>
                <td className="td">
                  <span className={u.role === "ADMIN" ? "text-info" : "text-unknown"}>
                    ● {u.role === "ADMIN" ? "Admin" : "ดูอย่างเดียว"}
                  </span>
                </td>
                <td className="td num text-muted">{u.lastLogin}</td>
                <td className="td text-right">
                  {u.id === meId ? (
                    <button
                      className="btn-secondary"
                      onClick={() => setPw({ open: !pw.open, current: "", next: "" })}
                    >
                      เปลี่ยนรหัสผ่าน
                    </button>
                  ) : (
                    isAdmin && (
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          setEditing(editing === u.id ? null : u.id);
                          setEdit({ role: u.role, isActive: u.isActive, password: "" });
                          setErr(null);
                        }}
                      >
                        แก้ไข
                      </button>
                    )
                  )}
                  {isAdmin && u.locked && u.id !== meId && (
                    <button
                      className="btn-secondary ml-2"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(
                          "unlock",
                          () => api(`/api/users/${u.id}`, "PATCH", { unlock: true }),
                          "ปลดล็อกแล้ว",
                        )
                      }
                    >
                      ปลดล็อก
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pw.open && (
        <div className="mt-3 grid gap-3 rounded-md border border-line bg-canvas p-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="รหัสผ่านปัจจุบัน" error={fields("pw").currentPassword}>
            <input
              type="password"
              value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })}
              autoComplete="current-password"
            />
          </Field>
          <Field label="รหัสผ่านใหม่ (≥ 8 ตัว)" error={fields("pw").newPassword}>
            <input
              type="password"
              value={pw.next}
              onChange={(e) => setPw({ ...pw, next: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <div className="flex items-end">
            <button
              className="btn-primary"
              disabled={busy !== null}
              onClick={async () => {
                if (
                  await run(
                    "pw",
                    () =>
                      api("/api/users/me/password", "POST", {
                        currentPassword: pw.current,
                        newPassword: pw.next,
                      }),
                    "เปลี่ยนรหัสผ่านแล้ว",
                  )
                )
                  setPw({ open: false, current: "", next: "" });
              }}
            >
              {busy === "pw" ? "กำลังบันทึก…" : "บันทึก"}
            </button>
          </div>
        </div>
      )}
      {editing !== null && (
        <div className="mt-3 grid gap-3 rounded-md border border-line bg-canvas p-3 sm:grid-cols-[160px_1fr_auto_auto]">
          <Field label="สิทธิ์">
            <select
              value={edit.role}
              onChange={(e) => setEdit({ ...edit, role: e.target.value as "ADMIN" | "VIEWER" })}
            >
              <option value="VIEWER">ดูอย่างเดียว</option>
              <option value="ADMIN">Admin</option>
            </select>
          </Field>
          <Field label="ตั้งรหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)" error={fields("edit").password}>
            <input
              type="password"
              value={edit.password}
              onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <label className="flex items-end gap-2 pb-2.5">
            <input
              type="checkbox"
              checked={edit.isActive}
              onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })}
            />{" "}
            เปิดใช้งาน
          </label>
          <div className="flex items-end">
            <button
              className="btn-primary"
              disabled={busy !== null}
              onClick={async () => {
                const body: Record<string, unknown> = { role: edit.role, isActive: edit.isActive };
                if (edit.password) body.password = edit.password;
                if (await run("edit", () => api(`/api/users/${editing}`, "PATCH", body), "บันทึกผู้ใช้แล้ว"))
                  setEditing(null);
              }}
            >
              {busy === "edit" ? "กำลังบันทึก…" : "บันทึก"}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** error ของรายการ (zod รายงานเป็น "alertEmails" หรือ "alertEmails.2") */
const listError = (fields: Record<string, string> | undefined, key: string) =>
  fields?.[key] ?? Object.entries(fields ?? {}).find(([k]) => k.startsWith(`${key}.`))?.[1];

/** รายการคั่นด้วยบรรทัดใหม่หรือ comma ↔ array */
const toList = (v: string) =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function ListInput({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  rows?: number;
}) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <textarea
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(toList(e.target.value));
      }}
    />
  );
}

function InsightsPanel({ ro, s }: { ro: boolean; s: ReturnType<typeof useSave<"insights">> }) {
  const v = s.value;
  const check = (k: "autoDiagnose" | "anomalyEnabled" | "journeysEnabled", title: string, hint: string) => (
    <label className="flex items-start gap-2.5">
      <input type="checkbox" className="mt-0.5" checked={v[k]} onChange={(e) => s.set(k, e.target.checked)} />
      <span>
        <span className="font-medium">{title}</span>
        <span className="hint block">{hint}</span>
      </span>
    </label>
  );
  return (
    <Panel
      id="insights"
      title="วินิจฉัยและเตือนล่วงหน้า"
      subtitle="บอกสาเหตุเมื่อเว็บล่ม · ติดตามการเปลี่ยนแปลง · เตือนก่อนล่มจริง · ทดสอบใช้งานจริงด้วย browser"
      footer={!ro && <SaveButton state={s.state} onClick={s.save} />}
    >
      <fieldset disabled={ro} className="space-y-5">
        {check(
          "autoDiagnose",
          "วินิจฉัยอัตโนมัติเมื่อเว็บล่ม",
          "ไล่ตรวจ DNS → เชื่อมต่อ → SSL → HTTP ทันทีที่เปิด Incident แล้วสรุปว่าปัญหาอยู่ชั้นไหน ใครต้องแก้ — ไม่ใช้ AI ไม่มีค่าใช้จ่าย",
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="ติดตามการเปลี่ยนแปลงของเว็บทุก"
            hint="IP, DNS/Nameserver, ใบรับรอง SSL, server, CMS — เปลี่ยนสำคัญ (เช่น Nameserver) จะแจ้งเตือนทันที"
          >
            <select
              value={v.fingerprintMinutes}
              onChange={(e) =>
                s.set("fingerprintMinutes", int(e.target.value) as typeof v.fingerprintMinutes)
              }
            >
              <option value={0}>ปิด</option>
              <option value={15}>15 นาที</option>
              <option value={30}>30 นาที</option>
              <option value={60}>1 ชั่วโมง</option>
              <option value={180}>3 ชั่วโมง</option>
            </select>
          </Field>
        </div>

        <div>
          {check(
            "anomalyEnabled",
            "ตรวจจับความผิดปกติล่วงหน้า",
            "เรียนรู้ว่าแต่ละเว็บปกติตอบเร็วแค่ไหนในแต่ละช่วงเวลาของวัน (14 วันย้อนหลัง) แล้วเตือนเมื่อช้าผิดปกติหรือเริ่มไม่เสถียร — ก่อนล่มจริง · ต้องมีข้อมูลอย่างน้อย 30 ผลตรวจ",
          )}
          <div className="mt-3 grid gap-4 pl-6 md:grid-cols-2">
            <Field label="ความไว" hint="ไวมาก = เตือนเร็วแต่อาจเตือนบ่อย">
              <select
                value={v.anomalySensitivity}
                disabled={!v.anomalyEnabled}
                onChange={(e) => s.set("anomalySensitivity", e.target.value as typeof v.anomalySensitivity)}
              >
                <option value="low">ต่ำ — เตือนเมื่อช้ากว่าปกติ 4 เท่า</option>
                <option value="normal">ปกติ — 2.5 เท่า (แนะนำ)</option>
                <option value="high">สูง — 1.8 เท่า</option>
              </select>
            </Field>
          </div>
        </div>

        {check(
          "journeysEnabled",
          "ทดสอบใช้งานจริง (Synthetic Journey)",
          "รันขั้นตอนที่ตั้งไว้ในหน้าเว็บไซต์แต่ละเว็บ (เช่น login แล้วต้องเห็น dashboard) ด้วย browser จริง · แจ้งเตือนเมื่อไม่ผ่าน 2 ครั้งติด · ใช้ Chromium เดียวกับการตรวจด้วยภาพ",
        )}

        <p className="rounded-md border border-line bg-canvas px-3 py-2 text-xs text-muted">
          การแจ้งเตือนจากหมวดนี้ส่งถึงผู้รับของเว็บนั้น + ผู้รับด้านความปลอดภัย และปิดเองเมื่อกลับมาปกติ
        </p>
      </fieldset>
    </Panel>
  );
}

function SecurityPanel({
  ro,
  s,
  fe,
}: {
  ro: boolean;
  s: ReturnType<typeof useSave<"security">>;
  fe: (k: string) => string | undefined;
}) {
  const v = s.value;
  return (
    <Panel
      id="security"
      title="ความปลอดภัยของเว็บ"
      subtitle="ตรวจหน้าเว็บถูกแก้ไข · โดเมนเลียนแบบ · สแกนความปลอดภัยแบบ passive (ไม่ใช่การเจาะระบบ)"
      footer={!ro && <SaveButton state={s.state} onClick={s.save} />}
    >
      <fieldset disabled={ro} className="space-y-6">
        <div>
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={v.visualEnabled}
              onChange={(e) => s.set("visualEnabled", e.target.checked)}
            />
            <span>
              <span className="font-medium">ตรวจหน้าเว็บถูกแก้ไข (ถ่ายภาพด้วย browser จริง)</span>
              <span className="hint block">
                เทียบกับภาพต้นแบบและหาคำต้องสงสัย เช่น ลิงก์พนันที่ถูกฝัง · Worker ต้องมี Chromium (Docker
                ติดตั้งให้แล้ว) · ใช้ RAM เพิ่มราว 300 MB ระหว่างถ่ายภาพ
              </span>
            </span>
          </label>
          <div className="mt-3 grid gap-4 pl-6 md:grid-cols-2">
            <Field label="ถ่ายภาพทุก">
              <select
                value={v.visualIntervalMinutes}
                disabled={!v.visualEnabled}
                onChange={(e) =>
                  s.set("visualIntervalMinutes", int(e.target.value) as typeof v.visualIntervalMinutes)
                }
              >
                <option value={60}>1 ชั่วโมง</option>
                <option value={180}>3 ชั่วโมง</option>
                <option value={360}>6 ชั่วโมง</option>
                <option value={720}>12 ชั่วโมง</option>
                <option value={1440}>วันละครั้ง</option>
              </select>
            </Field>
            <Field
              label="เตือนเมื่อหน้าเว็บเปลี่ยนเกิน (%)"
              error={fe("visualThresholdPct")}
              hint="เว็บที่มีแบนเนอร์หมุน/ข่าวเปลี่ยนบ่อย ควรตั้งสูงขึ้น"
            >
              <input
                type="number"
                min={2}
                max={90}
                value={v.visualThresholdPct}
                disabled={!v.visualEnabled}
                onChange={(e) => s.set("visualThresholdPct", int(e.target.value))}
              />
            </Field>
            <div className="md:col-span-2">
              <Field
                label="คำต้องสงสัย (บรรทัดละคำ)"
                error={fe("defaceKeywords")}
                hint="ไม่สนตัวพิมพ์เล็ก/ใหญ่ · คำที่มีอยู่แล้วในภาพต้นแบบจะไม่นับ"
              >
                <ListInput value={v.defaceKeywords} onChange={(x) => s.set("defaceKeywords", x)} rows={4} />
              </Field>
            </div>
          </div>
        </div>

        <div>
          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={v.ctEnabled}
              onChange={(e) => s.set("ctEnabled", e.target.checked)}
            />
            <span>
              <span className="font-medium">เฝ้าโดเมนเลียนแบบ (Certificate Transparency)</span>
              <span className="hint block">
                ค้นทุก 12 ชม. จาก crt.sh ว่ามีใครออกใบรับรอง SSL ให้โดเมนที่มีชื่อแบรนด์หรือสะกดคล้าย
              </span>
            </span>
          </label>
          <div className="mt-3 grid gap-4 pl-6 md:grid-cols-2">
            <Field
              label="ชื่อแบรนด์ / คำค้น"
              error={fe("brandKeywords")}
              hint="อย่างน้อย 2 ตัวอักษร (แนะนำ 4 ตัวขึ้นไป — สั้นไปจะเจอโดเมนที่ไม่เกี่ยวข้องเยอะ) เช่น ชื่อบริษัทในโดเมน (mycompany)"
            >
              <ListInput
                value={v.brandKeywords}
                onChange={(x) => s.set("brandKeywords", x)}
                placeholder="mycompany"
              />
            </Field>
            <Field
              label="โดเมนของบริษัทเอง"
              error={fe("ownDomains")}
              hint="ไม่นับเป็นโดเมนปลอม รวมทุก subdomain"
            >
              <ListInput
                value={v.ownDomains}
                onChange={(x) => s.set("ownDomains", x)}
                placeholder="mycompany.co.th"
              />
            </Field>
          </div>
        </div>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={v.scanEnabled}
            onChange={(e) => s.set("scanEnabled", e.target.checked)}
          />
          <span>
            <span className="font-medium">สแกนความปลอดภัยวันละครั้ง</span>
            <span className="hint block">
              ตรวจ security header, ใบรับรอง SSL, cookie และไฟล์ที่ไม่ควรเปิดสาธารณะ (.env, .git ฯลฯ) —
              ขอหน้าเว็บราว 10 ครั้งต่อเว็บต่อวัน
            </span>
          </span>
        </label>

        <Field
          label="ผู้รับแจ้งเตือนด้านความปลอดภัยเพิ่มเติม"
          error={listError(s.state.fields, "alertEmails")}
          hint="ได้รับเฉพาะแจ้งเตือนความปลอดภัย (รวมโดเมนเลียนแบบ) ของทุกเว็บ · ผู้รับทุกเว็บในส่วนอีเมล (SMTP) ได้รับอยู่แล้ว ไม่ต้องใส่ซ้ำ"
        >
          <EmailListInput
            value={v.alertEmails}
            onChange={(x) => s.set("alertEmails", x)}
            disabled={ro}
            placeholder="it-security@syntechnology.com"
          />
        </Field>
      </fieldset>
    </Panel>
  );
}
