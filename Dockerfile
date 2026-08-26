# KoinMix miner — production image.
#
# Builds only the miner. The demo terminal in web/ is a static site and deploys
# separately (see "Deployment" in README.md), which is why web/ is excluded by
# .dockerignore rather than built here.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Runtime dependencies ─────────────────────────────────────────────────────
# A separate stage so devDependencies (typescript, vitest, tsx) never reach the
# final image.
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LOG_PRETTY=false

WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# REQUIRED, and easy to miss: src/http/routes/health.ts resolves the miner
# descriptor at ../../../telegraph/koinmix.yaml, which from dist/http/routes/
# lands at the image root — OUTSIDE dist/. Omitting this directory does not
# break the build or the price routes; it breaks GET /telegraph/koinmix.yaml,
# which is the route a Telegraph node fetches to verify the on-chain hash.
COPY telegraph ./telegraph

# Run unprivileged. The node images ship a `node` user for exactly this.
USER node

EXPOSE 8080

# Uses the miner's own readiness semantics: /healthz answers 503 while no
# provider is active, so a miner that boots but cannot serve is reported
# unhealthy rather than merely alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
