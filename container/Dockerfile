# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

# Build stage: compile instacart-pp-cli from source.
# Pinned to a specific upstream pseudo-version so rebuilds are reproducible.
# Bump intentionally by updating both the FROM tag and the @<version>.
FROM golang:1.26.3 AS instacart-builder
RUN go install github.com/mvanhorn/printing-press-library/library/commerce/instacart/cmd/instacart-pp-cli@v0.0.0-20260518162642-aacb20640a09

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install gsuite-mcp (Gmail, Calendar, Contacts, Tasks MCP server)
RUN curl -fsSL https://github.com/2389-research/gsuite-mcp/releases/download/v1.4.2/gsuite-mcp_1.4.2_linux_arm64.tar.gz | tar xz -C /usr/local/bin gsuite-mcp && chmod +x /usr/local/bin/gsuite-mcp

# Install msgvault (local email/message archive with MCP server)
RUN curl -fsSL -L https://github.com/wesm/msgvault/releases/download/v0.12.1/msgvault_0.12.1_linux_arm64.tar.gz | tar xz -C /usr/local/bin msgvault && chmod +x /usr/local/bin/msgvault

# Install instacart-pp-cli (built in instacart-builder stage)
COPY --from=instacart-builder /go/bin/instacart-pp-cli /usr/local/bin/instacart-pp-cli

# Install amazon-pp-cli (cross-compiled on host for linux/arm64 — personal build,
# not yet pushed upstream so no go install path). State lives under XDG default
# ($HOME/.config/amazon-pp-cli); the host's Application Support dir is mounted
# in at that path by src/container-runner.ts (mirrors the instacart pattern).
COPY amazon-pp-cli /usr/local/bin/amazon-pp-cli
RUN chmod +x /usr/local/bin/amazon-pp-cli

# Headless-browser helper for cart view + checkout (avoids Amazon's robot-check
# on the static-HTTP place-order endpoint). Shells out from amazon-pp-cli.
# Playwright is installed in a sibling node_modules so the ESM `import` in
# amazon-checkout.mjs resolves locally. Skip the bundled chromium download —
# we reuse the apt-installed chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
RUN mkdir -p /usr/local/lib/amazon-pp-cli
COPY amazon-checkout.mjs /usr/local/lib/amazon-pp-cli/amazon-checkout.mjs
RUN chmod +x /usr/local/lib/amazon-pp-cli/amazon-checkout.mjs
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN cd /usr/local/lib/amazon-pp-cli && npm init -y >/dev/null && npm install playwright --no-audit --no-fund

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Apple Container only supports directory mounts (VirtioFS), so .env cannot be
# shadowed with a host-side /dev/null file mount. Instead the entrypoint starts
# as root, uses mount --bind to shadow .env, then drops to the host user via setpriv.
RUN printf '#!/bin/bash\nset -e\n\n# Shadow .env so the agent cannot read host secrets (requires root)\nif [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then\n  mount --bind /dev/null /workspace/project/.env\nfi\n\n# Compile agent-runner\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\n\n# Capture stdin (secrets JSON) to temp file\ncat > /tmp/input.json\n\n# Drop privileges if running as root (main-group containers)\nif [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then\n  chown "$RUN_UID:$RUN_GID" /tmp/input.json /tmp/dist\n  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node /tmp/dist/index.js < /tmp/input.json\nfi\n\nexec node /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
