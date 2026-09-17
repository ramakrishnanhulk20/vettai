FROM node:26-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --workspace packages/server --omit=dev --ignore-scripts

FROM node:26-slim
WORKDIR /repo
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json ./
COPY packages/server ./packages/server
RUN chown -R node:node /repo
USER node
WORKDIR /repo/packages/server
EXPOSE 8788

# The world answers on PORT and the treasury on TREASURY_PORT, and the treasury has no public
# domain, so the check is made from inside the container either way.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD \
  sh -c 'case "$VETTAI_PROCESS" in *treasury*) port="${TREASURY_PORT:-8789}";; *) port="${PORT:-8788}";; esac; curl -fsS "http://127.0.0.1:$port/health" > /dev/null'

# Node itself is PID 1, so the host's SIGTERM reaches the shutdown handlers rather than a
# shell. The same image runs both processes; the host picks which by setting VETTAI_PROCESS
# to src/treasury/index.ts on the treasury service. Unset, it runs the world.
CMD ["node", "--import", "tsx", "src/start.ts"]
