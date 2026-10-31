FROM node:22-bookworm AS dependencies
WORKDIR /app
ENV CI=true
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/platform/package.json apps/platform/package.json
COPY apps/connector/package.json apps/connector/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/agent-adapters/package.json packages/agent-adapters/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build

FROM node:22-bookworm AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN corepack enable
COPY --from=build /app /app

EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @seam/platform start"]
