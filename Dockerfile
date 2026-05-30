FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY packages/knowledge-contracts/package.json packages/knowledge-contracts/package.json
COPY services/knowledge/package.json services/knowledge/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY services services
RUN pnpm prisma:generate
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/knowledge-contracts /app/packages/knowledge-contracts
COPY --from=build /app/services/knowledge /app/services/knowledge
COPY --from=build /app/node_modules /app/node_modules
EXPOSE 8080
CMD ["pnpm", "start"]
