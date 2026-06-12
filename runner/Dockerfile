FROM node:22-bookworm-slim

# Install useful agent tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1001 runner && \
    useradd --uid 1001 --gid runner --shell /bin/bash --create-home runner

WORKDIR /app

# Copy package files and install all deps (tsc is a dev dep, needed for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source, compile, then drop dev deps from the final layer
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Set workspace directory (will be a named Docker volume)
RUN mkdir -p /workspace && chown runner:runner /workspace

USER runner

# SDK session state and agent working dir both land on /workspace volume
ENV HOME=/workspace

ENTRYPOINT ["node", "dist/main.js"]
