# Astra render worker: CPU Blender 5.2.2 behind a small authenticated HTTP API
# (server.mjs). Build context = this directory (ops/render-worker). No secret
# is baked in: ASTRA_WORKER_SECRET arrives at runtime from the compose file.

# ---- fetch: the official Blender archive, checked against the pinned SHA256
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS blender
# Same archive and checksum as scripts/astra-blender-snapshot.mjs (official blender-5.2.2.sha256).
ARG BLENDER_VERSION=5.2.2
ARG BLENDER_SHA256=84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    curl --fail --location --proto '=https' --tlsv1.2 --max-time 1200 --max-filesize 629145600 \
      --output /tmp/blender.tar.xz "https://download.blender.org/release/Blender5.2/blender-${BLENDER_VERSION}-linux-x64.tar.xz"; \
    echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum --check --strict -; \
    mkdir -p /opt/astra-blender; \
    tar --extract --xz --file /tmp/blender.tar.xz --directory /opt/astra-blender --strip-components 1 --no-same-owner; \
    rm /tmp/blender.tar.xz

# ---- run
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
# python3 runs the app's launcher (run.py); the libraries are the snapshot's
# list (scripts/astra-blender-snapshot.mjs) plus libxext6 and libxxf86vm1.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 libx11-6 libxi6 libxfixes3 libxrender1 libxrandr2 libxcursor1 libxinerama1 \
      libsm6 libice6 libxkbcommon0 libgomp1 libgl1 libegl1 libxext6 libxxf86vm1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=blender /opt/astra-blender /opt/astra-blender
# Offline CPU render, .blend save and GLB export, once, at build time.
COPY build-check.py /tmp/build-check.py
RUN /opt/astra-blender/blender --background --factory-startup --disable-autoexec --python-exit-code 1 --threads 2 \
      --python /tmp/build-check.py > /tmp/build-check.log 2>&1 \
      || { tail -n 40 /tmp/build-check.log; exit 1; }; \
    grep -q ASTRA_RENDER_WORKER_BUILD_CHECK_PASSED /tmp/build-check.log \
 && rm -rf /tmp/build-check.py /tmp/build-check.log /root/.config /root/.cache

# Non-root user. Its home is the session root, so anything Blender writes
# there is wiped with the session. /vercel/sandbox and /tmp are tmpfs mounts
# owned by this uid (compose.yaml); the rest of the filesystem is read-only.
RUN groupadd --system --gid 10001 render \
 && useradd --system --uid 10001 --gid render --home-dir /vercel/sandbox --no-create-home --shell /usr/sbin/nologin render \
 && mkdir -p /vercel/sandbox \
 && chown render:render /vercel/sandbox \
 && chmod 0700 /vercel/sandbox
WORKDIR /app
COPY server.mjs /app/server.mjs
ENV NODE_ENV=production \
    PORT=8790 \
    ASTRA_WORKER_CONTAINER=1
USER 10001:10001
# Internal network only; compose publishes no port.
EXPOSE 8790
# Alive = answers an unauthenticated request with 401. Runs with an empty
# environment (env -i) so the check itself never carries the secret.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/bin/env", "-i", "/usr/local/bin/node", "-e", "fetch('http://127.0.0.1:8790/v1/sessions').then(r=>process.exit(r.status===401?0:1),()=>process.exit(1))"]
CMD ["node", "/app/server.mjs"]
