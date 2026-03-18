# ============================================================
# Multi-stage Dockerfile — Restaurant SaaS
# ============================================================

# Stage 1: Base dependencies
FROM node:20-alpine AS base
WORKDIR /app

# Install system deps
RUN apk add --no-cache \
    curl \
    dumb-init \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Stage 2: Development
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY . .
EXPOSE 5000
CMD ["npm", "run", "dev"]

# Stage 3: Production build
FROM base AS build
ENV NODE_ENV=production
RUN npm ci --only=production && \
    npm cache clean --force

# Stage 4: Production final
FROM node:20-alpine AS production

# Security: run as non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Install runtime deps only
RUN apk add --no-cache curl dumb-init

# Copy from build stage
COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs . .

# Create logs directory
RUN mkdir -p logs && chown nodejs:nodejs logs

# Switch to non-root user
USER nodejs

# Metadata
LABEL maintainer="Restaurant SaaS"
LABEL version="1.0.0"
LABEL description="Enterprise Restaurant SaaS Backend"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT:-5000}/health || exit 1

EXPOSE 5000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
