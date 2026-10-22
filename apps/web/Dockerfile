# syntax=docker/dockerfile:1
FROM node:24-slim AS base
RUN npm install -g pnpm@12.14.0
WORKDIR /repo

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# copy manifest ก่อน เพื่อให้ layer ของ install ถูก cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter "@app/web..."
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/web apps/web
RUN pnpm --filter @app/web build

FROM node:24-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /repo/apps/web/peer-ip.mjs ./apps/web/peer-ip.mjs
USER node
EXPOSE 3000
# peer-ip.mjs: ต่อ IP จริงของผู้เชื่อมต่อท้าย X-Forwarded-For (กันปลอม IP หลบการจำกัดการเดารหัสผ่าน)
CMD ["node", "--import", "./apps/web/peer-ip.mjs", "apps/web/server.js"]
