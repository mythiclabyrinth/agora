# Headless agora-server image (used by Railway; see railway.json).
#
# The server keeps everything — config.json (admin key), agora.db, uploaded
# files — under /data, so mount a persistent volume there or state is lost on
# every deploy.

FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# agora-core include_str!s the notification label vocabulary that mobile also
# registers, so Rust and TypeScript cannot drift. Copied narrowly: the whole
# packages/ tree would rebuild this layer on any unrelated TypeScript edit.
COPY packages/core/src/notifications ./packages/core/src/notifications
RUN cargo build --release -p agora-server

# The web UI is built from source (web/ + packages/core), never committed.
# scripts/ + docs/ feed the web build's docs step (scripts/build-docs.mjs
# renders docs/*.md into dist/docs, served by the server at /docs/).
FROM node:22-bookworm-slim AS web-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY web ./web
COPY scripts ./scripts
COPY docs ./docs
RUN npm ci --no-audit --no-fund && npm run build -w web

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/agora-server /usr/local/bin/agora-server
COPY --from=web-build /src/web/dist /app/ui

# Accept connections from the platform's proxy; Railway injects PORT itself.
ENV AGORA_BIND=0.0.0.0
EXPOSE 4470
# No VOLUME directive: Railway rejects it ("use Railway Volumes"). Attach a
# Railway volume mounted at /data instead so state survives redeploys.

CMD ["agora-server", "--data-dir", "/data", "--ui-dir", "/app/ui"]
