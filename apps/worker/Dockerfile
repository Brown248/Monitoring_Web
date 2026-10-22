# syntax=docker/dockerfile:1
FROM node:24-slim AS base
RUN npm install -g pnpm@12.14.0
WORKDIR /repo

FROM base AS build
# copy manifest ก่อน เพื่อให้ layer ของ install ถูก cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter "@app/worker..."
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/worker apps/worker
RUN pnpm --filter @app/worker build

# bundle รวมทุก dependency แล้ว ยกเว้น playwright-core (มีไฟล์ประกอบ) และ argon2 (native module) — ติดตั้งแยก
# dist/ มี 3 คำสั่ง: index.cjs (Worker), migrate.cjs (ปรับฐานข้อมูล), create-user.cjs (สร้าง/รีเซ็ตผู้ใช้)
FROM node:24-slim AS runtime
ENV NODE_ENV=production
# Chromium สำหรับตรวจหน้าเว็บด้วยภาพ + ฟอนต์ไทย/อีโมจิให้หน้าเว็บไทยแสดงถูกต้องในภาพ
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-thai-tlwg fonts-noto-core fonts-noto-color-emoji ca-certificates \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build /repo/apps/worker/package.json /tmp/worker-package.json
RUN npm install --omit=dev --no-save --no-package-lock \
    "playwright-core@$(node -p "require('/tmp/worker-package.json').dependencies['playwright-core']")" \
    "argon2@$(node -p "require('/tmp/worker-package.json').dependencies['argon2']")" \
  && chown -R node:node /app
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
USER node
CMD ["node", "--enable-source-maps", "dist/index.cjs"]
