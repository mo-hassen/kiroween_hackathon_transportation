# syntax=docker/dockerfile:1.7
# Multi-stage build: `migrator` runs `prisma migrate deploy` as a one-shot job;
# `runtime` is the API image (production dependencies only, non-root).

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

FROM deps AS migrator
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
# Runtime data files (common-password list for the password policy).
COPY --chown=root:root assets ./assets
COPY --chown=root:root package.json ./
# Application files are owned by root and read-only for the runtime user.
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/main.api.js"]
