# Remotion export worker: our own export templates rendered on CPU (headless Chromium + FFmpeg)
# behind a small authenticated HTTP API (server.mjs). No secret is baked in:
# REMOTION_WORKER_SECRET arrives at runtime from the compose file.
#
# Build context = the REPOSITORY ROOT (compose.yaml sets `context: ../..`), because the
# compositions live in /remotion. Dockerfile.dockerignore (next to this file) keeps the context
# down to /remotion and this folder. Nothing is fetched at runtime: the compositions are bundled
# here, at build time, and the worker never loads code later.

# ---- build: install, type-check nothing, bundle the compositions and the export command
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /src/remotion
COPY remotion/package.json remotion/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY remotion/ ./
RUN npm run bundle

# ---- runtime dependencies only, plus the pinned Chrome Headless Shell
# `npm ci` installs the exact versions in remotion/package-lock.json (remotion and
# @remotion/renderer 4.0.530). Remotion pins the Chrome build for each of its releases, so the
# browser version follows the lockfile; it is downloaded once, here, into node_modules/.remotion.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime-deps
WORKDIR /opt/remotion
COPY remotion/package.json remotion/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && node --input-type=module -e "const { ensureBrowser } = await import('@remotion/renderer'); await ensureBrowser({ chromeMode: 'headless-shell' });" \
 && test -x node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell

# ---- the relay (compose.yaml builds this stage for `remotion-relay`, `target: relay`): a small TCP forwarder that holds no
# secret and is the only thing on both the internal network and the platform's. Same file as the Astra relay
# (ops/render-worker/relay.mjs); it forwards port 8081 to remotion-1:8790 and nothing else.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS relay
RUN groupadd --system --gid 10001 relay \
 && useradd --system --uid 10001 --gid relay --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin relay
WORKDIR /app
COPY ops/render-worker/relay.mjs /app/relay.mjs
COPY ops/render-worker/check-relay.mjs /app/check-relay.mjs
USER 10001:10001
EXPOSE 8081
CMD ["node", "/app/relay.mjs"]

# ---- run (the default target: the worker)
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
# Libraries Chrome Headless Shell needs on bookworm (Remotion's list), and a base set of fonts for
# text outside the bundled typeface's Latin range. FFmpeg and ffprobe ship inside @remotion/compositor.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 \
      libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 libxext6 libx11-6 \
      fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
# package.json too: Remotion looks for its browser by walking up to the nearest package.json, so without one it would look
# in the wrong place and try to download. The worker does not rely on that: REMOTION_BROWSER_EXECUTABLE names the exact file.
COPY --from=runtime-deps /opt/remotion/package.json /opt/remotion/package.json
COPY --from=runtime-deps /opt/remotion/node_modules /opt/remotion/node_modules
COPY --from=build /src/remotion/build/cli.mjs /opt/remotion/cli.mjs
COPY --from=build /src/remotion/build/bundle /opt/remotion/bundle
COPY ops/remotion-worker/server.mjs /app/server.mjs
# The egress check the worker runs before it listens, and the one the owner runs in a terminal (the same file as the Astra worker's):
# they hold no secret and read none. See README.md, Verify step 1.
COPY ops/render-worker/check-egress.mjs /app/check-egress.mjs

# Non-root user. Its home is the session root, so anything Chrome writes there is wiped with the
# session. /vercel/sandbox and /tmp are tmpfs mounts owned by this uid (compose.yaml); the rest
# of the filesystem is read-only. The mount point must exist and belong to the user.
RUN groupadd --system --gid 10001 remotion \
 && useradd --system --uid 10001 --gid remotion --home-dir /vercel/sandbox --no-create-home --shell /usr/sbin/nologin remotion \
 && mkdir -p /vercel/sandbox \
 && chown remotion:remotion /vercel/sandbox \
 && chmod 0700 /vercel/sandbox
ENV NODE_ENV=production \
    PORT=8790 \
    REMOTION_WORKER_CONTAINER=1 \
    REMOTION_BUNDLE_DIR=/opt/remotion/bundle \
    REMOTION_RUNTIME_DIR=/opt/remotion \
    REMOTION_BROWSER_EXECUTABLE=/opt/remotion/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell \
    REMOTION_CONCURRENCY=2 \
    REMOTION_MAX_SECONDS=120

# A tiny render at build time, as the runtime user and through the very command the worker runs:
# a 2-second sample at 192x108 (video and one still), checked with the bundled ffprobe. A missing
# library or a broken bundle fails the build here, not in production. Costs nothing, uses no media.
USER 10001:10001
RUN test -x "$REMOTION_BROWSER_EXECUTABLE"
RUN set -eu; \
    d=/tmp/build-check; mkdir -p "$d/output"; cd "$d"; \
    printf '%s' '{"version":1,"composition":"fixture-clip","props":{"aspect":"16:9","fps":30,"scale":0.1,"durationSeconds":2,"label":"BUILD"},"output":{"video":true,"stills":[30]}}' > spec.json; \
    REMOTION_CONCURRENCY=1 /usr/local/bin/node /opt/remotion/cli.mjs > out.log 2>&1 || { tail -n 40 out.log; exit 1; }; \
    /opt/remotion/node_modules/@remotion/compositor-linux-x64-gnu/ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 output/export.mp4 | tee probe.txt; \
    grep -q '^h264,192,108$' probe.txt; \
    head -c 8 output/still-30.png | od -An -tx1 | grep -q '89 50 4e 47'; \
    cd /; rm -rf "$d"

WORKDIR /app
# Internal network only; compose publishes no port.
EXPOSE 8790
# Alive = answers an unauthenticated request with 401. Runs with an empty
# environment (env -i) so the check itself never carries the secret.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/bin/env", "-i", "/usr/local/bin/node", "-e", "fetch('http://127.0.0.1:8790/v1/sessions').then(r=>process.exit(r.status===401?0:1),()=>process.exit(1))"]
CMD ["node", "/app/server.mjs"]
