# WebMonitor

ระบบตรวจสถานะเว็บไซต์ภายในองค์กร (ใช้งานใน LAN) — ตรวจเว็บตามรอบ, บันทึกผลทุกครั้ง, เปิด/ปิด Incident อัตโนมัติ,
ส่งอีเมล DOWN/RECOVERY ครั้งเดียวต่อ Incident ต่อผู้รับ, วิเคราะห์ Incident ด้วย AI และส่งรายงานไป Google Sheets

| Workspace       | หน้าที่                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `apps/web`      | Next.js 16 (App Router) — หน้าเว็บทั้งหมด + API (Route Handlers)              |
| `apps/worker`   | process แยก รันค้าง — ตรวจเว็บ, Incident, Outbox อีเมล, AI, Sheets, retention |
| `packages/db`   | Drizzle schema, migrations, db client, helper ที่ใช้ร่วมกัน                   |
| `packages/core` | กฎสถานะ, SSRF guard, HTTP checker, mailer, AI, Sheets, zod schemas            |

## หน้าเว็บ

ภาพรวม · เว็บไซต์ (รายการ / รายละเอียด / เพิ่ม / แก้ไข + ทดสอบ URL) · Incident (รายการ / รายละเอียด + AI + timeline + Postmortem)
· ความปลอดภัย · ถาม AI · ประวัติการตรวจ (ตัวกรอง + CSV + Sheets) · สถานะระบบ
· ตั้งค่า (ค่าเริ่มต้น / SMTP / AI / ความปลอดภัย / Sheets / Retention / ผู้ใช้) · เข้าสู่ระบบ

### ความปลอดภัยและ AI

| ฟีเจอร์              | ทำงานอย่างไร                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ตรวจหน้าเว็บถูกแก้ไข | Worker เปิดหน้าเว็บด้วย Chromium จริง ถ่ายภาพเทียบกับภาพต้นแบบ และหาคำต้องสงสัย (เช่น ลิงก์พนันที่ถูกฝัง) — ทุกคำขอของ browser ผ่าน proxy ที่บล็อก IP ภายใน หน้าเว็บที่ถูกแฮกจึงยิงเข้า LAN ไม่ได้ |
| โดเมนเลียนแบบ        | ค้น Certificate Transparency (crt.sh) ทุก 12 ชม. หาโดเมนที่มีชื่อแบรนด์หรือสะกดคล้าย ซึ่งเพิ่งออกใบรับรอง SSL                                                                                      |
| คะแนนความปลอดภัย A–F | สแกนแบบ passive วันละครั้ง: security header, ใบรับรอง SSL, cookie, mixed content และไฟล์ที่ไม่ควรเปิดสาธารณะ (.env, .git ฯลฯ) — ไม่ใช่การทดสอบเจาะระบบ                                             |
| ต้นเหตุร่วม          | เว็บที่ล่มพร้อมกันถูกจัดกลุ่มตาม IP เซิร์ฟเวอร์, โดเมน, DNS หรือเครือข่าย แสดงบนหน้าภาพรวมและหน้า Incident                                                                                         |
| ถาม AI               | ถามเป็นภาษาไทยได้ AI เรียกเครื่องมือ "อ่านอย่างเดียว" เพื่อดึงข้อมูลจริง (รองรับ provider Anthropic)                                                                                               |
| Postmortem           | AI ร่างรายงานสรุปเหตุเมื่อ Incident ปิด (หรือกดเอง) — พิมพ์/บันทึกเป็น PDF ได้                                                                                                                     |

การแจ้งเตือนด้านความปลอดภัยส่งอีเมลถึงผู้รับของเว็บนั้น + "ผู้รับแจ้งเตือนด้านความปลอดภัย" ในหน้าตั้งค่า

## Deploy (Ubuntu + Docker Compose)

ต้องมีแค่ **Docker Engine + compose plugin 2.30 ขึ้นไป** (`docker compose version`) — ไม่ต้องติดตั้ง Node/pnpm บนเครื่อง

ติดตั้ง Docker จากแหล่งของ Docker เอง (แพ็กเกจ `docker.io` / `docker-compose-v2` ของ Ubuntu มักเก่ากว่า 2.30 — ใช้ไม่ได้):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker   # ใช้ docker ได้โดยไม่ต้อง sudo
docker compose version                           # ต้อง ≥ 2.30
```

```bash
sudo timedatectl set-timezone Asia/Bangkok   # เวลาของ cron (backup) และ log ตรงกับเวลาไทย
git clone <repo> ~/monitoring-web && cd ~/monitoring-web
cp .env.example .env && chmod 600 .env       # .env มีรหัสผ่านทุกตัว — ให้เจ้าของอ่านได้คนเดียว
nano .env    # POSTGRES_PASSWORD (openssl rand -hex 24), APP_BASE_URL = ที่อยู่ของเครื่องนี้ เช่น http://192.168.1.50:3000
docker compose up -d --build                 # migrate ฐานข้อมูลให้อัตโนมัติก่อนเว็บ/Worker เริ่ม
docker compose run --rm worker node dist/create-user.cjs --username admin --role admin   # ถามรหัสผ่าน (≥ 8 ตัว)
docker compose run --rm worker node dist/import-sites.cjs   # นำเข้ารายชื่อเว็บ + ค่าตั้งจาก deploy/sites.json (รันซ้ำได้)
docker compose ps                            # web, worker, postgres = healthy · migrate = exited (0)
curl -s localhost:3000/api/health            # ต้องเห็น "database":"ok"
```

เปิด `APP_BASE_URL` → เข้าสู่ระบบ → **ตั้งค่า**: กรอก SMTP (รหัสผ่านอยู่ใน `.env` → `SMTP_PASSWORD`), เพิ่ม **ผู้รับแจ้งเตือนทุกเว็บ** แล้วกด "ส่งอีเมลทดสอบ" →
**เว็บไซต์ → + เพิ่มเว็บไซต์** (กด "ทดสอบ URL" ก่อนบันทึก)

รายชื่อเว็บใน `deploy/sites.json` ส่งออกจากเครื่อง dev ด้วย `pnpm sites:export` — มีเว็บ, ความเชื่อมโยง, การทดสอบใช้งานจริง
และค่าตั้งที่ไม่ใช่ความลับ (ไม่มีรหัสผ่าน/ประวัติ/ภาพต้นแบบ) · เว็บที่ URL มีอยู่แล้วจะข้าม · ค่าตั้งที่ server บันทึกไว้แล้วไม่ถูกทับ
(`--overwrite-settings` ถ้าต้องการ) · ดูผลก่อนด้วย `--dry-run` · **ไฟล์นี้มีอีเมลผู้รับ — ใช้กับ repo แบบ Private**

อัปเดตรอบถัดไป (migrate ให้เองทุกครั้ง):

```bash
git pull && docker compose up -d --build && docker image prune -f   # prune = ลบ image รุ่นเก่าที่ค้าง ไม่ให้ดิสก์เต็ม
```

ข้อควรรู้เรื่อง `.env`

- ค่าใน `.env` ถูกอ่าน**ตรงตัว** ไม่ต้องใส่เครื่องหมายคำพูด (ใส่ = เครื่องหมายคำพูดกลายเป็นส่วนหนึ่งของค่า) · `$` และ `#` ในรหัสผ่านใช้ได้
- `POSTGRES_PASSWORD` ใช้เฉพาะตัวอักษร/ตัวเลข (อยู่ใน URL ของฐานข้อมูล) · มีผลแค่ตอนสร้างฐานข้อมูลครั้งแรก
  — จะเปลี่ยนภายหลัง: `docker compose exec postgres psql -U monitor -c "ALTER USER monitor PASSWORD 'ใหม่'"` แล้วค่อยแก้ `.env` และ `docker compose up -d`
- `GOOGLE_SERVICE_ACCOUNT_JSON` แนะนำแบบ base64 (`base64 -w0 key.json`) — JSON ทั้งก้อนในบรรทัดเดียวก็ได้
- มี reverse proxy (nginx/Caddy/Cloudflare Tunnel) หน้าเว็บ → ตั้ง `TRUST_PROXY_HOPS` และ `WEB_BIND=127.0.0.1`
- build ครั้งแรกต้องออกอินเทอร์เน็ตได้ (โหลด package, Chromium และฟอนต์ของ Google Fonts)
- `DATABASE_URL` ใช้เฉพาะเครื่อง dev — บน Docker ไม่ต้องแก้ (compose ต่อ URL ไปที่ container postgres เอง)
- **firewall**: พอร์ตที่ Docker เปิด (`WEB_PORT`) ข้ามกฎ `ufw` — ถ้าจะจำกัดให้เฉพาะวง LAN ทำที่ firewall ของ Proxmox/เราเตอร์
  หรือตั้ง `WEB_BIND` เป็น IP ของ VM ในวง LAN
- หน้า **แผนผังระบบ** อ่าน CPU/RAM/ดิสก์ของ VM เอง (ไม่ต้องตั้งค่าเพิ่ม) — เตือนเหลืองเมื่อ RAM ≥ 90% หรือดิสก์ ≥ 85%, แดงเมื่อ RAM ≥ 97% หรือดิสก์ ≥ 95%

เครื่อง dev (Windows/ไม่มี Docker): `pnpm install` → `pnpm dev:db` → `pnpm db:migrate` → `pnpm user:create -- --username admin`

ฐานข้อมูล dev เก็บที่ `../monitoring-web-dev-db` นอกโฟลเดอร์โปรเจกต์ (ถ้าอยู่ข้างใน `next dev` จะรีโหลดหน้าวนไม่หยุด)

### Secret (อยู่ใน `.env` เท่านั้น — หน้าเว็บแสดงแค่ "พบค่า/ไม่พบค่า")

| ตัวแปร                        | ใช้ทำอะไร                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `SMTP_PASSWORD`               | รหัสผ่าน SMTP                                                                      |
| `AI_API_KEY`                  | API key ของ provider ที่เลือก (Anthropic หรือ OpenAI-compatible)                   |
| `AI_BASE_URL`                 | (ถ้าใช้) OpenAI-compatible endpoint อื่น                                           |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON ของ service account (บรรทัดเดียวหรือ base64) — แชร์ชีตให้อีเมลนั้นเป็น Editor |

### Backup และการกู้คืน

```bash
bash scripts/backup-db.sh     # ลองรันเองครั้งแรก — ต้องขึ้น "backup ok"
crontab -e                    # 0 3 * * * bash /home/<ผู้ใช้>/monitoring-web/scripts/backup-db.sh
```

- สคริปต์สร้างโฟลเดอร์ `backups/` และเขียน log เอง (`backups/backup.log` หมุนไฟล์เมื่อเกิน 1 MB) — ไม่ต้อง redirect ใน cron
- อ่านเฉพาะค่า `BACKUP_*` จาก `.env` (ค่าอื่นที่มีอักขระพิเศษ เช่น JSON ของ Google ไม่ทำให้สคริปต์ล้ม)
- ตรวจไฟล์ด้วย `pg_restore -l` ก่อนนับว่าสำเร็จ · ตั้ง `BACKUP_COPY_TO` เพื่อคัดลอกไปอีกดิสก์/อีกเครื่อง
- ผลแสดงบนหน้า "สถานะระบบ" และหน้าภาพรวม — **เตือนถ้าไม่มี backup สำเร็จเกิน 36 ชั่วโมง** หรือครั้งล่าสุดล้มเหลว

กู้คืน (ทดสอบกับฐานข้อมูลใหม่ก่อนทุกครั้ง — อย่าทับฐานข้อมูลจริงจนกว่าจะแน่ใจ):

```bash
# 1) กู้ลงฐานข้อมูลทดสอบ แล้วเปิดดูว่าข้อมูลครบ
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" monitor_restore_test'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d monitor_restore_test --no-owner --exit-on-error' < backups/monitor-YYYYMMDD-HHMMSS.dump

# 2) กู้จริง: หยุด web/worker ก่อน แล้วสร้างฐานข้อมูลใหม่จาก backup
docker compose stop web worker
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < backups/monitor-YYYYMMDD-HHMMSS.dump
docker compose start web worker
```

## กฎการทำงานหลัก

- **ตรวจ**: undici + custom `connect.lookup` ตรวจ IP ปลายทางทุกครั้งที่เชื่อมต่อ (กัน SSRF/DNS rebinding), ตาม redirect แบบ manual
  และตรวจทุก hop, timeout ต่อคำขอ, retry ภายในรอบ
- **สถานะ**: สำเร็จครั้งใดครั้งหนึ่งในรอบ = UP (ช้ากว่าเกณฑ์ = DEGRADED แสดงอย่างเดียว) · ล้มเหลวทุกครั้ง = DOWN ·
  ปลายทางเป็น IP ภายใน หรือ error เครือข่ายขณะ canary ล้มเหลว = UNKNOWN (ไม่นับ)
- **Incident**: DOWN ติดกันครบเกณฑ์ → เปิด (partial unique index กันเปิดซ้ำ) · UP ติดกันครบเกณฑ์ → ปิด
- **อีเมล**: สร้างงานใน Outbox ในทรานแซกชันเดียวกับการเปิด/ปิด Incident · unique (incident, ประเภท, ผู้รับ) กันส่งซ้ำ ·
  retry แบบ backoff สูงสุด 12 ครั้ง (ราว 16 ชม.) · RECOVERY รอให้ DOWN ส่งก่อน
- **Worker**: ดึงงานด้วย `FOR UPDATE SKIP LOCKED` + เลื่อน `next_check_at` เป็น lease, heartbeat ทุก 30 วินาที
- **Retention**: ล้างข้อมูลเก่าทุกวัน 03:30 ตามค่าที่ตั้งในหน้าตั้งค่า (สรุปรายวันเก็บนานกว่าผลตรวจละเอียด)

## Dev

```bash
pnpm install
docker compose up -d postgres && pnpm db:migrate
pnpm dev:web          # http://localhost:3000
pnpm dev:worker
pnpm typecheck && pnpm lint && pnpm test
# integration test กับ PostgreSQL จริง (ฐานข้อมูลแยก — ข้อมูลจะถูกล้าง)
TEST_DATABASE_URL=postgres://monitor:<pw>@127.0.0.1:5432/monitor_test pnpm test
```

TypeScript ล็อกที่ 6.0.3 และ ESLint ที่ 9.39.5 เพราะ typescript-eslint / plugin ของ Next ยังไม่รองรับ TS 7 / ESLint 10
