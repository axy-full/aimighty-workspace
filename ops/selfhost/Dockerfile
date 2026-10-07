# Particl self-hosted image (Coolify "Dockerfile" build pack). Build context = repo root.
# Not used by Vercel. Standalone output is switched on here by NEXT_OUTPUT only.

# ---- deps: npm ci, plus the postinstall that copies the PDF and OCR workers into public/vendor
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# package.json depends on a local tarball under public/open-source
COPY public/open-source ./public/open-source
COPY scripts/copy-pdf-worker.mjs scripts/copy-ocr-worker.mjs ./scripts/
# npm ci runs "postinstall" (copy-pdf-worker + copy-ocr-worker) which fills public/vendor
RUN npm ci --no-audit --no-fund

# ---- build
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/public/vendor ./public/vendor
COPY . .
# NEXT_PUBLIC_* values are baked in at build time: tick "Build Variable" on
# NEXT_PUBLIC_APP_URL and NEXT_PUBLIC_VAPID_PUBLIC_KEY in the platform.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG SOURCE_COMMIT=unknown
RUN npm run build

# ---- run
FROM node:24-bookworm-slim AS run
WORKDIR /app
ARG SOURCE_COMMIT=unknown
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    GIT_COMMIT_SHA=${SOURCE_COMMIT}
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --home /app app \
 && mkdir -p /app/.data && chown app:app /app/.data
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# Scheduled task script (see docs/selfhost-test.md): node:slim has no curl, so it uses node's fetch.
COPY --chown=app:app ops/selfhost/cron-sync.mjs ./cron-sync.mjs
USER app
EXPOSE 3000
# /api/health answers 200 {"ok":true,...} when the database is reachable; 503 otherwise.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
