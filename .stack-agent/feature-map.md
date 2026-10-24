# Feature map

Where each thing a user does lives in the code, so an agent goes straight to it from a vague report ("the export button does nothing", a screenshot). `node .stack-agent/bin/feature-map.mjs` fails when the map and the code disagree.

- **Where**: one or more places, separated by commas: a repo path, `path:line`, or `path#text`, where text must appear in that file (a selector, a flag, a menu label, a function name). Use `#text` for anything that would break a user's path if it were renamed.
- **How a user reaches it**: the screen and the clicks, the command and its flags, or the call a consumer makes.
- **Check**: the names of the checks in `.stack-agent/verify.json` that exercise it, separated by commas, or `-`.

To add rows, start from `node .stack-agent/bin/feature-map.mjs --draft` (one row per verify check), and leave `TODO` where a human should look.

| Feature | Where | How a user reaches it | Check |
| --- | --- | --- | --- |
| เข้าสู่ระบบ | apps/web/src/app/login/login-form.tsx#name="password", apps/web/src/app/api/auth/login/route.ts#export const POST, apps/web/src/lib/auth.ts#export async function login( | เปิดหน้าใดก็ได้โดยยังไม่มี session → หน้า /login → กรอกชื่อผู้ใช้/รหัสผ่าน → เข้าสู่ระบบ | login-page, admin-adds-website |
| ทุกหน้าและ API ต้อง login ก่อน | apps/web/src/proxy.ts#wm_session, apps/web/src/lib/api.ts#export async function requireApi | เปิด /websites โดยไม่มี cookie → ถูกพาไป /login · เรียก API โดยไม่มี cookie → 401 | dashboard-requires-login, api-requires-login |
| เพิ่มเว็บไซต์ | apps/web/src/components/client/website-form.tsx, apps/web/src/app/api/websites/route.ts#createWebsite, apps/web/src/lib/websites.ts#export async function createWebsite, packages/core/src/schemas/website.ts#websiteFormSchema | เมนู เว็บไซต์ → + เพิ่มเว็บไซต์ → กรอกฟอร์ม → บันทึก (Admin เท่านั้น) | admin-adds-website |
| กันเพิ่ม URL ที่ชี้เข้า LAN (SSRF) | packages/core/src/ssrf/validate-url.ts#export function checkTargetUrl, packages/core/src/server/guarded-lookup.ts#export function createGuardedLookup | เพิ่มเว็บที่ URL เป็น IP ภายใน เช่น http://127.0.0.1/ → ฟอร์มขึ้น error | admin-adds-website |
| รายการเว็บไซต์ | apps/web/src/app/(app)/websites/page.tsx#WebsitesPage | เมนู เว็บไซต์ | admin-adds-website |
| ตรวจว่าเว็บและฐานข้อมูลพร้อม | apps/web/src/app/api/health/route.ts#export async function GET | `curl -s localhost:3000/api/health` หลัง deploy (README) และ Docker healthcheck | health |
| Incident (รายการ / รายละเอียด) | apps/web/src/app/(app)/incidents/page.tsx#IncidentsPage, apps/worker/src/jobs/checks.ts#export async function recordOutcome | เมนู Incident · Worker เปิด/ปิด Incident ตามผลตรวจ (ทดสอบใน apps/worker/src/pipeline.test.ts) | - |
| ประวัติการตรวจ + ส่งออก CSV | apps/web/src/app/(app)/checks/page.tsx#ChecksPage, apps/web/src/app/api/checks/export/route.ts#export const GET | เมนู ประวัติการตรวจ → ตัวกรอง → ส่งออก CSV | - |
| ตั้งค่า SMTP + ส่งอีเมลทดสอบ | apps/web/src/app/(app)/settings/page.tsx#SettingsPage, apps/web/src/app/api/settings/smtp/test/route.ts#export const POST | เมนู ตั้งค่า → SMTP → ส่งอีเมลทดสอบ | - |
| ถาม AI | apps/web/src/app/(app)/ask/page.tsx#AskPage, apps/web/src/app/api/ask/route.ts#export const POST | เมนู ถาม AI (ต้องตั้ง AI_API_KEY) | - |
