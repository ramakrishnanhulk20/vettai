FROM node:26-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --workspace packages/server --omit=dev --ignore-scripts

FROM node:26-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json ./
COPY packages/server ./packages/server
WORKDIR /repo/packages/server
EXPOSE 8788
# The same image runs both processes; the host picks which by setting VETTAI_PROCESS
# to src/treasury/index.ts on the treasury service. Unset, it runs the world.
CMD ["sh", "-c", "npx tsx ${VETTAI_PROCESS:-src/index.ts}"]
