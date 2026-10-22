#!/usr/bin/env bash
# Backup PostgreSQL ผ่าน docker compose แล้วบันทึกผลลงตาราง backup_runs (แสดงบนหน้า "สถานะระบบ")
# ใช้กับ cron บน host (สคริปต์เขียน log เอง ไม่ต้อง redirect):
#   0 3 * * * /opt/monitoring-web/scripts/backup-db.sh
# log อยู่ที่ $BACKUP_DIR/backup.log (หมุนไฟล์เองเมื่อเกิน 1 MB)
set -euo pipefail
# ไฟล์ backup มีข้อมูลทั้งฐาน (รวม hash รหัสผ่าน) — ให้เจ้าของอ่านได้คนเดียว
umask 077

cd "$(dirname "$0")/.."

# อ่านเฉพาะบรรทัด BACKUP_* จาก .env แบบข้อความล้วน — ไม่ source ทั้งไฟล์
# (ค่าอื่นเช่น JSON ของ Google / รหัส SMTP มีอักขระที่ bash ตีความได้ ทำให้สคริปต์ล้มก่อน backup)
# ชื่อผู้ใช้/ฐานข้อมูลอ่านจาก env ของ container postgres เอง
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^(BACKUP_[A-Z_]+)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    # ค่าที่ตั้งไว้ใน environment ของ cron มาก่อน .env
    [[ -n "${!key:-}" ]] || printf -v "$key" '%s' "$val"
  done <.env
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COPY_TO="${BACKUP_COPY_TO:-}"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || KEEP_DAYS=14
mkdir -p "$BACKUP_DIR"
LOG="$BACKUP_DIR/backup.log"
if [[ -f "$LOG" ]] && (($(stat -c %s "$LOG") > 1048576)); then mv -f "$LOG" "$LOG.1"; fi
# ทุกข้อความไปทั้ง log และหน้าจอ (เวลารันเอง)
exec > >(tee -a "$LOG") 2>&1

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
compose() { docker compose "$@"; }
psql_exec() {
  compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt' <<<"$1"
}
sql_quote() { printf "%s" "$1" | sed "s/'/''/g"; }

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FILE="$BACKUP_DIR/monitor-$(date +%Y%m%d-%H%M%S).dump"
DEST="${BACKUP_DESTINATION:-$(realpath -m "$BACKUP_DIR")}"
[[ -n "$COPY_TO" && -z "${BACKUP_DESTINATION:-}" ]] && DEST="$(realpath -m "$BACKUP_DIR") + $COPY_TO"

record() { # ok size message
  local size="${2:-NULL}"
  psql_exec "INSERT INTO backup_runs (started_at, finished_at, ok, size_bytes, destination, message)
             VALUES ('$STARTED', now(), $1, $size, '$(sql_quote "$DEST")', '$(sql_quote "$3")')" ||
    log "WARN: บันทึกผลลงฐานข้อมูลไม่ได้ (postgres ไม่ทำงาน?)"
}

KEEP_FILE=false
fail() {
  $KEEP_FILE || rm -f "$FILE"
  log "backup FAILED: $1"
  record false NULL "$1"
  exit 1
}
trap 'fail "สคริปต์หยุดกลางคัน (บรรทัด $LINENO)"' ERR

log "backup start → $FILE"
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$FILE" ||
  fail "pg_dump ล้มเหลว (ตรวจว่า docker compose / postgres ทำงานอยู่)"
SIZE="$(stat -c %s "$FILE")"
((SIZE > 0)) || fail "ไฟล์ backup ว่างเปล่า"
# ตรวจว่าไฟล์อ่านกลับได้จริง (สารบัญของ dump ครบ) ก่อนนับว่าสำเร็จ
TABLES="$(compose exec -T postgres pg_restore -l <"$FILE" | grep -c ' TABLE DATA ' || true)"
((TABLES > 0)) || fail "ไฟล์ backup อ่านกลับไม่ได้ (pg_restore -l ไม่พบข้อมูลตาราง)"
MESSAGE="$(basename "$FILE") · ${TABLES} ตาราง"
KEEP_FILE=true # ไฟล์ในเครื่องใช้ได้แล้ว — คัดลอกไปที่อื่นไม่สำเร็จก็ไม่ลบ

# คัดลอกไปที่อื่น (คนละดิสก์/คนละเครื่อง) — ดิสก์เสียทีเดียวจะไม่เสียทั้งฐานข้อมูลและ backup
if [[ -n "$COPY_TO" ]]; then
  if [[ "$COPY_TO" == /* ]]; then
    { mkdir -p "$COPY_TO" && cp "$FILE" "$COPY_TO/"; } || fail "backup สำเร็จในเครื่อง แต่คัดลอกไป $COPY_TO ไม่สำเร็จ"
    find "$COPY_TO" -maxdepth 1 -name 'monitor-*.dump' -type f -mtime +"$KEEP_DAYS" -delete || true
  else
    # user@host:/path — ต้องตั้ง SSH key ไว้ก่อน (BatchMode = ไม่ถามรหัสผ่าน)
    scp -q -o BatchMode=yes -o ConnectTimeout=20 "$FILE" "$COPY_TO/" ||
      fail "backup สำเร็จในเครื่อง แต่คัดลอกไป $COPY_TO ไม่สำเร็จ"
  fi
  MESSAGE="$MESSAGE · คัดลอกไป $COPY_TO แล้ว"
fi

trap - ERR
record true "$SIZE" "$MESSAGE"
log "backup ok: $FILE ($SIZE bytes, $TABLES tables)"

# ลบไฟล์เก่ากว่า KEEP_DAYS วัน (เฉพาะในเครื่อง — ปลายทาง scp ให้ลบด้วย cron ของเครื่องนั้น)
find "$BACKUP_DIR" -maxdepth 1 -name 'monitor-*.dump' -type f -mtime +"$KEEP_DAYS" -delete

# วิธี restore ดูที่ README.md หัวข้อ "Backup และการกู้คืน"
