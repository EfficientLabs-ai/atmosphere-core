# Stage 1: Dependency Builder
FROM node:20-alpine AS builder

# Add standard build dependencies for native Node modules if needed
RUN apk add --no-cache python3 make g++

WORKDIR /usr/src/app

# Copy package manifests and workspaces config
COPY package.json package-lock.json ./
COPY packages/atmos-core/package.json ./packages/atmos-core/
COPY packages/maximus-telemetry/package.json ./packages/maximus-telemetry/

# Install production dependencies only, including workspace packages
RUN npm ci --omit=dev --workspace=packages/maximus-telemetry --workspace=packages/atmos-core --cache /tmp/empty-cache && rm -rf /tmp/empty-cache

# Copy source code files
COPY packages/atmos-core/ ./packages/atmos-core/
COPY packages/maximus-telemetry/ ./packages/maximus-telemetry/

# Stage 2: Optimized Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

# Configure Node environment variables for production performance optimization
ENV NODE_ENV=production \
    PORT=4000 \
    NODE_OPTIONS="--max-old-space-size=512 --enable-source-maps"

# Run as non-privileged system user for enhanced container security
USER node

# Copy dependencies and application source from the builder stage
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/package.json ./package.json
COPY --from=builder --chown=node:node /usr/src/app/packages/atmos-core ./packages/atmos-core
COPY --from=builder --chown=node:node /usr/src/app/packages/maximus-telemetry ./packages/maximus-telemetry

# Expose port for the Telemetry service RPC/HTTP communications
EXPOSE 4000

WORKDIR /app/packages/maximus-telemetry

# Start telemetry service using direct node call to save process overhead and handle signals correctly
CMD ["node", "telemetry.js"]
