FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
# Dive review checks out the pull request's head commit with git.
RUN apk add --no-cache git
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
# Let the app drain running review jobs on SIGTERM (src/instrumentation.ts).
ENV NEXT_MANUAL_SIG_HANDLE=true

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
