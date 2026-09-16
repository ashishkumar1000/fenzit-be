# syntax=docker/dockerfile:1
#
# Multi-stage build for Render (runtime: docker).
#
# Bun all the way: install/build and runtime are all oven/bun (matches the
# repo's bun-only rule and packageManager field). Verified locally that the
# `bcrypt` N-API prebuild loads and hashes correctly under bun 1.3.

# ---------- build: install all deps, compile with tsc ----------
FROM oven/bun:1.3.13 AS build
WORKDIR /app

# Copy manifests + configs first so source-only changes reuse the deps layer
# (no bun.lock in the repo — deps resolve fresh at build time)
COPY package.json tsconfig.json tsconfig.build.json nest-cli.json ./
# --ignore-scripts: root "prepare: husky" would fail here (no .git in the
# image, and husky is dev-only). Build needs no lifecycle scripts, and
# tsconfig.build.json excludes scripts/ so tsconfig's explicit rootDir
# keeps the entry at dist/src/main.js.
RUN bun install --ignore-scripts

COPY src ./src
RUN bun run build

# ---------- prod-deps: runtime-only node_modules ----------
FROM oven/bun:1.3.13 AS prod-deps
WORKDIR /app
COPY package.json ./
# --ignore-scripts: same rationale as the build stage. bcrypt and the rest
# of the runtime deps ship their binaries/prebuilds inside the package, so
# no lifecycle script is needed at runtime.
RUN bun install --production --ignore-scripts

# ---------- runtime: slim bun image ----------
FROM oven/bun:1.3.13-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Render injects PORT (default 10000); main.ts binds 0.0.0.0:$PORT already.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER bun
# Informational only — Render injects PORT (default 10000) and main.ts binds it.
EXPOSE 10000
CMD ["bun", "dist/src/main.js"]