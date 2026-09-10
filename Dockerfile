# ---- Stage 1: Build ----
FROM node:20-alpine AS build

# better-sqlite3 needs build tools for its native addon
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Backend dependencies
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci

# Frontend dependencies
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

# Copy source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Build backend (tsc) and strip dev dependencies from node_modules so the
# runtime image never ships typescript/vitest/etc.
RUN cd backend && npm run build && npm prune --omit=dev

# Build frontend
RUN cd frontend && npx vite build

# ---- Stage 2: Runtime ----
FROM node:20-alpine

# better-sqlite3 native addon needs libstdc++ at runtime
RUN apk add --no-cache libstdc++

WORKDIR /app

# Copy backend runtime files (node_modules already pruned of dev deps)
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/package.json ./backend/

# Copy frontend built assets
COPY --from=build /app/frontend/dist ./frontend/dist

# Run as the unprivileged `node` user (uid 1000) instead of root.
RUN mkdir -p /app/backend/data && chown -R node:node /app
USER node

EXPOSE 3001

# Liveness probe against the existing health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

WORKDIR /app/backend
CMD ["node", "dist/index.js"]
