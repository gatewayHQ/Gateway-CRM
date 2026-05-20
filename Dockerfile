# Multi-stage build for the Gateway CRM frontend.
# Vercel is the primary host, but this Dockerfile lets us run the SPA on any
# container platform (Fly.io, Render, Cloud Run, ECS, on-prem) as a fallback /
# disaster-recovery target.

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps with a frozen lockfile for reproducible builds
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Build the SPA
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Drop privileges — run nginx as a non-root user
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# SPA fallback + cache headers handled by nginx.conf
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8080/healthz || exit 1

USER app
CMD ["nginx", "-g", "daemon off;"]
