# -- build stage --
FROM node:20-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# -- production stage --
FROM node:20-slim

# Build tools for node-pty native module
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential python3 git && \
    rm -rf /var/lib/apt/lists/*

# Install agent CLIs globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/

# Workspace volume mount point
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/index.js"]
