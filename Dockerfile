# Self-hosted sk-duty-notify: the Cloudflare Worker in src/ running on Node.js with SQLite (see server/).
#   docker build -t sk-duty-notify .
#   docker run -p 8787:8787 -v sdn-data:/data --env-file .env sk-duty-notify
ARG NODE_VERSION=24.22.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# Only the bundler is needed to build; the Cloudflare toolchain (wrangler, workerd, vitest) stays out of the image.
ARG ESBUILD_VERSION=0.28.2
RUN npm install -g esbuild@${ESBUILD_VERSION}
# Runtime dependencies only (nodemailer), bundled into dist/server.mjs below.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
RUN esbuild server/main.ts --bundle --platform=node --format=esm --target=node24 --outfile=dist/server.mjs --sourcemap \
      "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY public ./public
COPY migrations ./migrations
COPY LICENSE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.mjs"]

LABEL org.opencontainers.image.title="sk-duty-notify" \
      org.opencontainers.image.description="Duty-roster notices (LINE + email) with GPS-verified check-in" \
      org.opencontainers.image.version="1.1.0" \
      org.opencontainers.image.licenses="MIT"
