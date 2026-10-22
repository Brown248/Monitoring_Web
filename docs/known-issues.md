# Edge case — สถานะ

ตรวจรอบที่ 3 เมื่อ 22 ต.ค. 2026 · **แก้ครบทุกข้อแล้ว** (รอบ 2 ก็แก้ครบแล้ว) พร้อมชุดทดสอบ
(unit + integration กับ PostgreSQL จริง `TEST_DATABASE_URL=…/monitor_test` — 220 ข้อ + ทดสอบผ่านหน้าเว็บ production build)

---

## ต้องทำเองหลังอัปเดตโค้ดรอบนี้

1. `pnpm db:migrate` (ตอนนี้รันผ่าน Worker แล้ว) — บน Docker ไม่ต้องทำเอง: service `migrate` รันให้ก่อน web/worker เริ่ม
2. รีสตาร์ท `pnpm dev:web` และ Worker (หรือ `docker compose up -d --build`) — โค้ดใน `packages/` ไม่ hot-reload
3. `.env` ค่าใหม่:
   - `SMTP_ALLOWED_HOST` — host ของ SMTP ที่อนุญาต (เช่น `smtp.gmail.com`) กันคนแก้หน้าตั้งค่าแล้วส่งรหัสผ่านไป server อื่น
   - `JOURNEY_<ชื่อ>_DOMAIN=โดเมน` — ทุก secret ของการทดสอบใช้งานจริง (`JOURNEY_<ชื่อ>_…`) ต้องผูกโดเมนที่อนุญาต
     (หน้าแก้ขั้นตอนจะบอกชื่อตัวแปรที่ต้องตั้ง)
   - `WEB_BIND` (ไม่บังคับ) — เช่น `127.0.0.1` ถ้ามี reverse proxy อยู่เครื่องเดียวกัน
4. Docker Compose ต้องเป็นเวอร์ชัน ≥ 2.30 (ใช้ `env_file` แบบ `format: raw`) · `chmod 600 .env`
5. สร้างผู้ใช้บน Docker: `docker compose run --rm worker node dist/create-user.cjs` (ดู README)
6. Backup: `chmod +x scripts/backup-db.sh && ./scripts/backup-db.sh` ครั้งแรก แล้วตั้ง cron ตาม README
7. ถ้ามี reverse proxy (nginx/Caddy/Cloudflare Tunnel) หน้าเว็บ ตั้ง `TRUST_PROXY_HOPS` = จำนวนชั้นของ proxy

## ข้อจำกัดที่เหลือ (รู้แล้ว ยอมรับได้)

- หน้าแผนผังระบบแสดงปัญหาของ VM ได้เฉพาะตอนที่ VM ยังทำงาน (ทรัพยากรใกล้เต็ม/ส่วนใดส่วนหนึ่งพัง) — ถ้า VM หรือ Proxmox ดับทั้งเครื่อง
  หน้าเว็บก็เปิดไม่ได้ ต้องใช้ตัวเฝ้าจากเครื่องอื่น (เช่น healthchecks.io หรือ uptime monitor ภายนอก) ถ้าต้องการรู้กรณีนี้
- `scripts/backup-db.sh` และ `docker-compose.yml` ทดสอบบน Windows ด้วย docker จำลอง / `docker compose config` — ควรลองรันจริงบน VM 1 ครั้ง
- เตือน "ยังไม่บันทึก" ทำงานตอนปิดแท็บ/รีโหลดเท่านั้น — กดลิงก์ภายในเว็บไม่มีกล่องเตือน (App Router ไม่มีวิธีหยุดการเปลี่ยนหน้า)
- ชีต Check History แบ่งเป็นรายเดือนแล้ว ("Check History YYYY-MM") — ชีตเดิมก่อนรอบนี้ยังอยู่ ลบเองได้ถ้าไม่ใช้
- ชีต Check History ที่สร้างก่อนรอบ 2 ไม่มีหัวคอลัมน์ "Check #" (คอลัมน์ H)
- ตรวจโดเมนเลียนแบบ: crt.sh ค้นด้วยข้อความตรงตัว จึงเจอเฉพาะใบรับรองที่มีชื่อแบรนด์แบบปกติอยู่ด้วย
- การนับโควตา AI ไม่นับครั้งที่ SDK ลองใหม่เองเมื่อ 429/5xx (ผู้ให้บริการไม่คิดเงินคำขอที่ล้มเหลว)
- เว็บที่ `redirect()` ในหน้าที่มี loading จะตอบ 200 แล้วให้เบราว์เซอร์ย้ายหน้าเอง (พฤติกรรม streaming ของ Next 16 — ผู้ใช้ไปถึงหน้าถูกต้อง)

## ตรวจแล้วปลอดภัย

favicon อันตราย (SVG สคริปต์) รันไม่ได้ · แชต AI ไม่มี XSS · กันสูตรทั้ง CSV และ Sheets · อีเมล escape ค่า · ไม่มี deadlock ในการใช้งานปกติ · connection ฐานข้อมูลพอ · Worker เริ่มก่อน migration ออกอย่างปลอดภัย
· ปลอม X-Forwarded-For หลบการจำกัดการเดารหัสไม่ได้ · `?next=` หลัง login รับเฉพาะ path ภายใน (รวมกรณี Tab/แบ็กสแลช)
· ผู้ดูแล 2 คนบันทึกพร้อมกัน (เว็บ/การตั้งค่า/journey/dependencies) → คนหลังได้ 409 ไม่ทับกัน · request ใหญ่เกิน → 413
· URL ที่ส่งให้ AI ตัด query/รหัสผ่านทิ้ง
