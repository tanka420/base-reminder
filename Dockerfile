###############################################################################
# Stage 1: deps — install production + dev dependencies
###############################################################################
FROM node:24-alpine AS deps

WORKDIR /app

# Copy manifests only (layer cache for npm install)
COPY package.json package-lock.json ./

# Install ALL dependencies (including dev, needed for tsc)
RUN npm ci --ignore-scripts

###############################################################################
# Stage 2: build — compile TypeScript
###############################################################################
FROM deps AS build

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

# Compile production source (excludes test files)
RUN npx tsc --project tsconfig.build.json

# Prune dev dependencies so runtime only receives production modules
RUN npm prune --omit=dev --ignore-scripts

###############################################################################
# Stage 3: runtime — minimal production image
###############################################################################
FROM node:24-alpine AS runtime

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy production deps only
COPY --from=build /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Copy compiled output
COPY --from=build /app/dist ./dist

# Copy migration SQL files (needed at runtime)
COPY src/db/migrations ./dist/src/db/migrations

USER appuser

# Health endpoint (localhost-bound by default — not exposed externally)
EXPOSE 3000

# Graceful stop
STOPSIGNAL SIGTERM

CMD ["node", "dist/src/index.js"]
