#!/usr/bin/env bash
# อัปเดตอัตโนมัติบน server — ตั้ง cron ทุก 5 นาที (ดู README):
#   1) git pull (เฉพาะ fast-forward) — ได้ docker-compose.yml / สคริปต์ / รายชื่อเว็บรุ่นล่าสุด
#   2) ดึง image รุ่นล่าสุดจาก GitHub Packages (CI build ให้หลังเทสต์ผ่านเท่านั้น)
#   3) มีรุ่นใหม่ → docker compose up -d (ปรับฐานข้อมูลให้เองก่อนเว็บ/Worker เริ่ม)
#   4) รอ web + worker healthy — ไม่ healthy ภายใน 3 นาที → ย้อนกลับรุ่นเดิม และจำรุ่นที่เสียไว้ไม่ให้ลองซ้ำ
# log: logs/auto-update.log (หมุนไฟล์เมื่อเกิน 1 MB) · รันซ้อนกันไม่ได้ (flock)
set -Eeuo pipefail

main() {
  cd "$(dirname "$(readlink -f "$0")")/.."
  umask 077
  mkdir -p logs
  local log_file=logs/auto-update.log
  exec 9>logs/.auto-update.lock
  flock -n 9 || exit 0 # รอบก่อนยังทำงานอยู่
  if [[ -f $log_file && $(stat -c %s "$log_file") -gt 1048576 ]]; then mv -f "$log_file" "$log_file.1"; fi
  log() { echo "$(date '+%F %T') $*" >>"$log_file"; }
  trap 'log "ERROR: คำสั่งล้มเหลวที่บรรทัด $LINENO"' ERR

  # 1) โค้ด/คอนฟิก
  local head_before head_after
  head_before=$(git rev-parse HEAD 2>/dev/null || echo none)
  if git fetch -q origin 2>>"$log_file"; then
    git merge -q --ff-only '@{u}' 2>>"$log_file" ||
      log "WARN: git pull ไม่ได้ (มีไฟล์ที่แก้ในเครื่อง?) — ใช้ไฟล์เดิม ส่วน image ยังอัปเดตตามปกติ"
  else
    log "WARN: ติดต่อ GitHub ไม่ได้ (git fetch)"
  fi
  head_after=$(git rev-parse HEAD 2>/dev/null || echo none)

  # 2) image
  local web_img worker_img old_web old_worker new_web new_worker
  web_img=$(docker compose config --images | grep -- '-web:' | head -1)
  worker_img=$(docker compose config --images | grep -- '-worker:' | head -1)
  old_web=$(docker image inspect -f '{{.Id}}' "$web_img" 2>/dev/null || true)
  old_worker=$(docker image inspect -f '{{.Id}}' "$worker_img" 2>/dev/null || true)
  if ! docker compose pull -q web worker migrate 2>>"$log_file"; then
    log "ERROR: ดึง image ไม่ได้ — ตรวจ docker login ghcr.io (token หมดอายุ?) / อินเทอร์เน็ต"
    exit 1
  fi
  new_web=$(docker image inspect -f '{{.Id}}' "$web_img")
  new_worker=$(docker image inspect -f '{{.Id}}' "$worker_img")

  if [[ $new_web == "$old_web" && $new_worker == "$old_worker" && $head_before == "$head_after" ]]; then
    exit 0 # ไม่มีอะไรใหม่
  fi
  # รุ่นที่เคยย้อนกลับไปแล้ว — ไม่ลองซ้ำทุก 5 นาที (รอ commit ใหม่)
  if [[ -f logs/.bad-images && $head_before == "$head_after" ]] &&
    grep -qx "$new_web $new_worker" logs/.bad-images; then
    exit 0
  fi

  log "อัปเดต: commit ${head_before:0:7} → ${head_after:0:7} · web ${old_web:7:12} → ${new_web:7:12} · worker ${old_worker:7:12} → ${new_worker:7:12}"
  docker compose up -d --remove-orphans >>"$log_file" 2>&1 || true

  # 3) รอ healthy
  local i web_state worker_state
  for i in $(seq 1 36); do
    sleep 5
    web_state=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q web)" 2>/dev/null || echo missing)
    worker_state=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q worker)" 2>/dev/null || echo missing)
    if [[ $web_state == healthy && $worker_state == healthy ]]; then
      log "สำเร็จ: web และ worker healthy (${i}×5 วินาที)"
      docker image prune -f >/dev/null 2>&1 || true
      return 0
    fi
  done

  # 4) ย้อนกลับ
  log "ล้มเหลว: web=$web_state worker=$worker_state หลัง 3 นาที — ย้อนกลับรุ่นเดิม"
  echo "$new_web $new_worker" >>logs/.bad-images
  if [[ -n $old_web && -n $old_worker ]]; then
    docker tag "$old_web" "$web_img"
    docker tag "$old_worker" "$worker_img"
    docker compose up -d >>"$log_file" 2>&1 || true
    log "ย้อนกลับแล้ว — ดูสาเหตุด้วย: docker compose logs --tail=200 web worker"
  else
    log "ไม่มีรุ่นเดิมให้ย้อนกลับ (ติดตั้งครั้งแรก) — ดู docker compose logs web worker"
  fi
  exit 1
}

# อ่านทั้งไฟล์ก่อนรัน — git pull แก้สคริปต์นี้ระหว่างทำงานได้โดยไม่พัง
main "$@"
exit
